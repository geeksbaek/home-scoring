/**
 * hcode 자체 검증 (강화).
 *  - 각 단지의 hcode polygon 중심 좌표 vs K-apt ground truth 거리 비교
 *  - 500m 초과 = mismatch
 *  - 같은 hcode를 다수 단지가 공유하는 경우(중복) 별도 표시
 *
 * 기존 audit_hcode.ts는 dong_coords와 ground truth만 비교 → hcode 잘못돼도 좌표가 다른 source로
 * 정확하게 들어와있으면 통과해버리는 결함. 이 스크립트는 hcode → polygon 직접 호출로 검증.
 *
 * Usage: bun src/audit_hcode_strict.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function geocode(query: string): Promise<{ lat: number; lng: number } | null> {
  const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}&size=1`;
  try {
    const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const doc = json.documents?.[0];
    if (!doc?.y || !doc?.x) return null;
    return { lat: parseFloat(doc.y), lng: parseFloat(doc.x) };
  } catch { return null; }
}

async function fetchPolygonCenter(hcode: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(`https://hogangnono.com/api/v2/apts/${hcode}/polygon`);
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const buildings = (json.data?.buildings ?? []).filter((b: any) => b.centerWgs84?.x && b.centerWgs84?.y);
    if (buildings.length === 0) return null;
    const lat = buildings.reduce((s: number, b: any) => s + b.centerWgs84.y, 0) / buildings.length;
    const lng = buildings.reduce((s: number, b: any) => s + b.centerWgs84.x, 0) / buildings.length;
    return { lat, lng };
  } catch { return null; }
}

interface Identity {
  name: string; region: string; hcode: string | null;
  jibun_addr: string | null; doro_juso: string | null;
  bjdong: string; jibun: string;
}

async function main() {
  const identity: Identity[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const kapt: Record<string, any> = await Bun.file(join(DATA_DIR, "kapt_info.json")).json();

  // 캐시 (재시작 지원)
  const cachePath = join(DATA_DIR, "_hcode_strict_audit.json");
  let cache: { polygons: Record<string, { lat: number; lng: number } | null>; truths: Record<string, { lat: number; lng: number } | null> } = { polygons: {}, truths: {} };
  if (existsSync(cachePath)) cache = await Bun.file(cachePath).json();

  // 1. polygon center 캐시 (hcode → center)
  const uniqueHcodes = [...new Set(identity.map((a) => a.hcode).filter(Boolean))] as string[];
  console.log(`unique hcode: ${uniqueHcodes.length}`);
  for (let i = 0; i < uniqueHcodes.length; i++) {
    const hc = uniqueHcodes[i];
    if (cache.polygons[hc] !== undefined) continue;
    process.stdout.write(`  polygon ${i + 1}/${uniqueHcodes.length} ${hc}...`);
    cache.polygons[hc] = await fetchPolygonCenter(hc);
    console.log(cache.polygons[hc] ? " ✓" : " ✗");
    await sleep(80);
    if (i % 20 === 0) await Bun.write(cachePath, JSON.stringify(cache, null, 2));
  }
  await Bun.write(cachePath, JSON.stringify(cache, null, 2));

  // 2. ground truth (단지명 → 좌표)
  const withHcode = identity.filter((a) => a.hcode);
  for (let i = 0; i < withHcode.length; i++) {
    const apt = withHcode[i];
    if (cache.truths[apt.name] !== undefined) continue;
    let q: string | null = null;
    const k = kapt[apt.name];
    if (k?.doroJuso) q = k.doroJuso;
    else if (k?.addr) q = k.addr;
    else if (apt.doro_juso) q = apt.doro_juso;
    else if (apt.jibun_addr) q = apt.jibun_addr;
    else if (apt.bjdong && apt.jibun) q = `경기도 ${apt.region || ""} ${apt.bjdong} ${apt.jibun}`;
    if (!q) { cache.truths[apt.name] = null; continue; }
    process.stdout.write(`  truth ${i + 1}/${withHcode.length} ${apt.name}...`);
    cache.truths[apt.name] = await geocode(q);
    console.log(cache.truths[apt.name] ? " ✓" : " ✗");
    await sleep(50);
    if (i % 20 === 0) await Bun.write(cachePath, JSON.stringify(cache, null, 2));
  }
  await Bun.write(cachePath, JSON.stringify(cache, null, 2));

  // 3. mismatch 분석
  interface Mismatch { name: string; hcode: string; distance_m: number; reason: string; }
  const mismatches: Mismatch[] = [];
  const noTruth: string[] = [];
  const noPolygon: string[] = [];

  for (const apt of withHcode) {
    const poly = cache.polygons[apt.hcode!];
    const truth = cache.truths[apt.name];
    if (!truth) { noTruth.push(apt.name); continue; }
    if (!poly) { noPolygon.push(apt.name); continue; }
    const dist = Math.round(haversine(poly, truth));
    if (dist > 500) {
      mismatches.push({ name: apt.name, hcode: apt.hcode!, distance_m: dist, reason: `polygon ${dist}m > 500m` });
    }
  }

  // 4. 중복 hcode (mismatch와 무관하게 보고)
  const hcGroup = new Map<string, string[]>();
  for (const apt of withHcode) {
    if (!hcGroup.has(apt.hcode!)) hcGroup.set(apt.hcode!, []);
    hcGroup.get(apt.hcode!)!.push(apt.name);
  }
  const duplicates = [...hcGroup.entries()].filter(([_, names]) => names.length > 1);

  // 결과 저장
  const out = {
    summary: {
      total_with_hcode: withHcode.length,
      mismatches: mismatches.length,
      duplicates: duplicates.length,
      no_truth: noTruth.length,
      no_polygon: noPolygon.length,
    },
    mismatches: mismatches.sort((a, b) => b.distance_m - a.distance_m),
    duplicates: duplicates.map(([hc, names]) => ({ hcode: hc, names })),
    no_truth: noTruth,
    no_polygon: noPolygon,
  };
  await Bun.write(join(DATA_DIR, "_hcode_strict_audit_result.json"), JSON.stringify(out, null, 2));

  console.log(`\n=== 결과 ===`);
  console.log(`hcode 단지: ${withHcode.length}`);
  console.log(`  거리 mismatch (>500m): ${mismatches.length}`);
  console.log(`  중복 hcode 그룹: ${duplicates.length}`);
  console.log(`  truth 없음: ${noTruth.length}`);
  console.log(`  polygon 없음: ${noPolygon.length}`);
  if (mismatches.length > 0) {
    console.log(`\n  거리 큰 순 mismatch (상위 10):`);
    for (const m of mismatches.slice(0, 10)) console.log(`    ${m.name} (${m.hcode}): ${m.distance_m}m`);
  }
  if (duplicates.length > 0) {
    console.log(`\n  중복 hcode (상위 10):`);
    for (const d of duplicates.slice(0, 10)) console.log(`    ${d[0]}: ${d[1].join(" / ")}`);
  }
}

main().catch(console.error);
