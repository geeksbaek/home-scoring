/**
 * hcode/coords 신뢰성 전수 검사.
 * K-apt 주소(혹은 jibun)로 카카오 좌표를 ground truth로 사용.
 * dong_coords[name] 중심 좌표와 거리 비교 → 500m 이상이면 mismatch.
 *
 * Usage: bun src/audit_hcode.ts
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MismatchEntry {
  name: string;
  region: string;
  hcode: string | null;
  truth: { lat: number; lng: number; query: string };
  current: { lat: number; lng: number; dongCount: number };
  distance_m: number;
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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
  } catch {
    return null;
  }
}

async function main() {
  const identity: any[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const coords: Record<string, any[]> = await Bun.file(join(DATA_DIR, "dong_coords_naver.json")).json();
  const kapt: Record<string, any> = await Bun.file(join(DATA_DIR, "kapt_info.json")).json();

  // 재시작 지원: 기존 검사 결과 로드
  const auditPath = join(DATA_DIR, "_hcode_audit.json");
  const fs = await import("node:fs");
  let prev: any = { mismatches: [], noTruth: [], done: [] };
  if (fs.existsSync(auditPath)) {
    try { prev = await Bun.file(auditPath).json(); } catch {}
  }
  // dedupe by name
  const mmSeen = new Set<string>();
  const mismatches: MismatchEntry[] = (prev.mismatches || []).filter((m: MismatchEntry) => {
    if (mmSeen.has(m.name)) return false;
    mmSeen.add(m.name);
    return true;
  });
  const noTruth: string[] = [...new Set(prev.noTruth || [])];
  // 검사된 단지: mismatches ∪ noTruth ∪ prev.done (OK 단지)
  const done: Set<string> = new Set([
    ...(prev.done || []),
    ...mismatches.map((m: MismatchEntry) => m.name),
    ...noTruth,
  ]);
  let checked = done.size;
  let ok = checked - mismatches.length - noTruth.length;

  for (let i = 0; i < identity.length; i++) {
    const apt = identity[i];
    if (done.has(apt.name)) continue; // 이미 검사된 단지
    const c = coords[apt.name];
    if (!c || c.length === 0) continue; // coords 없는 단지는 skip

    // ground truth 주소: 우선순위 K-apt addr/doroJuso → identity jibun
    let query: string | null = null;
    const k = kapt[apt.name];
    if (k?.doroJuso) query = k.doroJuso;
    else if (k?.addr) query = k.addr;
    else if (apt.doro_juso) query = apt.doro_juso;
    else if (apt.jibun_addr) query = apt.jibun_addr;
    else if (apt.bjdong && apt.jibun) {
      const region = apt.region || "";
      query = `경기도 ${region} ${apt.bjdong} ${apt.jibun}`;
    }

    if (!query) {
      noTruth.push(apt.name);
      done.add(apt.name);
      continue;
    }

    process.stdout.write(`[${i + 1}/${identity.length}] ${apt.name}...`);
    const truth = await geocode(query);
    await sleep(50);

    if (!truth) {
      console.log(" ✗ geocode 실패");
      noTruth.push(apt.name);
      done.add(apt.name);
      continue;
    }

    // 단지 중심 좌표 (dong 평균)
    const cx = c.reduce((s, e) => s + e.lng, 0) / c.length;
    const cy = c.reduce((s, e) => s + e.lat, 0) / c.length;
    const dist = haversine(truth.lat, truth.lng, cy, cx);

    checked++;
    done.add(apt.name);
    if (dist > 500) {
      mismatches.push({
        name: apt.name,
        region: apt.region,
        hcode: apt.hcode,
        truth: { ...truth, query },
        current: { lat: cy, lng: cx, dongCount: c.length },
        distance_m: Math.round(dist),
      });
      console.log(` ⚠ ${Math.round(dist)}m`);
    } else {
      ok++;
      console.log(` ${Math.round(dist)}m ✓`);
    }

    if (checked % 10 === 0) {
      await Bun.write(auditPath, JSON.stringify({ mismatches, noTruth, done: [...done] }, null, 2));
    }
  }
  await Bun.write(auditPath, JSON.stringify({ mismatches, noTruth, done: [...done] }, null, 2));

  console.log(`\n=== 검증 결과 ===`);
  console.log(`검사: ${checked}, OK: ${ok}, 불일치: ${mismatches.length}, ground truth 없음: ${noTruth.length}`);
}

main().catch(console.error);
