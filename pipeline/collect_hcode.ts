/**
 * hcode 검증된 재수집.
 * 1. K-apt 주소 또는 jibun으로 카카오 좌표 (ground truth) 획득
 * 2. 호갱노노 검색 → 후보들의 polygon 좌표와 거리 비교
 * 3. 가장 가까운 (500m 이내) 후보만 매칭
 *
 * Usage: bun src/collect_hcode_validated.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REGION_COORDS: Record<string, [number, number]> = {
  // 경기 (key: city)
  "수원시": [127.01, 37.27], "성남시": [127.13, 37.44], "용인시": [127.10, 37.24],
  "하남시": [127.21, 37.54], "화성시": [127.05, 37.20], "안양시": [126.95, 37.39],
  // 서울 (key: "서울특별시 OO구")
  "서울특별시 종로구": [126.979, 37.573], "서울특별시 중구": [126.997, 37.564],
  "서울특별시 용산구": [126.965, 37.532], "서울특별시 성동구": [127.037, 37.563],
  "서울특별시 광진구": [127.082, 37.538], "서울특별시 동대문구": [127.040, 37.574],
  "서울특별시 중랑구": [127.093, 37.606], "서울특별시 성북구": [127.017, 37.589],
  "서울특별시 강북구": [127.025, 37.640], "서울특별시 도봉구": [127.047, 37.668],
  "서울특별시 노원구": [127.056, 37.654], "서울특별시 은평구": [126.929, 37.602],
  "서울특별시 서대문구": [126.937, 37.579], "서울특별시 마포구": [126.908, 37.566],
  "서울특별시 양천구": [126.866, 37.517], "서울특별시 강서구": [126.850, 37.551],
  "서울특별시 구로구": [126.887, 37.495], "서울특별시 금천구": [126.901, 37.457],
  "서울특별시 영등포구": [126.896, 37.526], "서울특별시 동작구": [126.940, 37.512],
  "서울특별시 관악구": [126.951, 37.478], "서울특별시 서초구": [127.033, 37.483],
  "서울특별시 강남구": [127.047, 37.517], "서울특별시 송파구": [127.106, 37.514],
  "서울특별시 강동구": [127.123, 37.530],
  // 서울 전체 fallback
  "서울특별시": [126.978, 37.566],
};

function lookupCoords(region: string): [number, number] {
  if (REGION_COORDS[region]) return REGION_COORDS[region];
  const city = region.split(" ")[0];
  if (REGION_COORDS[city]) return REGION_COORDS[city];
  return [127.05, 37.3];
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
  } catch { return null; }
}

async function searchHogangnono(query: string, x: number, y: number): Promise<any[]> {
  const url = `https://hogangnono.com/api/v2/searches/suggestions/new?query=${encodeURIComponent(query)}&x=${x}&y=${y}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    return json.data?.matched?.apt?.list ?? [];
  } catch { return []; }
}

async function fetchPolygon(hcode: string): Promise<{ lat: number; lng: number }[]> {
  try {
    const res = await fetch(`https://hogangnono.com/api/v2/apts/${hcode}/polygon`);
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    const buildings = json.data?.buildings ?? [];
    return buildings
      .filter((b: any) => b.centerWgs84?.x && b.centerWgs84?.y)
      .map((b: any) => ({ lat: b.centerWgs84.y, lng: b.centerWgs84.x }));
  } catch { return []; }
}

async function main() {
  const identity: any[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const kapt: Record<string, any> = await Bun.file(join(DATA_DIR, "kapt_info.json")).json();
  const hcodesPath = join(DATA_DIR, "hogangnono_codes.json");
  const hcodes: Record<string, string> = existsSync(hcodesPath) ? await Bun.file(hcodesPath).json() : {};

  const __only = process.env.ONLY_NAMES ? new Set(JSON.parse(require("node:fs").readFileSync(process.env.ONLY_NAMES,"utf8")) as string[]) : null;
  const targets = identity.filter((a) => !a.hcode).filter((a:any) => !__only || __only.has(a.name));
  console.log(`hcode 누락 단지: ${targets.length}`);

  let success = 0, fail = 0;

  for (let i = 0; i < targets.length; i++) {
    const apt = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${apt.name}...`);

    // 1. ground truth 좌표
    let query: string | null = null;
    const k = kapt[apt.name];
    if (k?.doroJuso) query = k.doroJuso;
    else if (k?.addr) query = k.addr;
    else if (apt.doro_juso) query = apt.doro_juso;
    else if (apt.jibun_addr) query = apt.jibun_addr;
    else if (apt.bjdong && apt.jibun) {
      const prefix = (apt.region || "").startsWith("서울") ? "" : "경기도 ";
      query = `${prefix}${apt.region || ""} ${apt.bjdong} ${apt.jibun}`;
    }

    if (!query) {
      console.log(" ✗ truth 없음");
      fail++;
      continue;
    }

    const truth = await geocode(query);
    await sleep(50);
    if (!truth) {
      console.log(" ✗ geocode 실패");
      fail++;
      continue;
    }

    // 2. 호갱노노에서 후보 검색
    const [rx, ry] = lookupCoords(apt.region || "");
    const city = (apt.region || "").split(" ")[0];

    // 검색 쿼리: 다양한 조합 시도
    const gu = (apt.region || "").split(" ")[1] || "";
    const queries: string[] = [apt.name];
    if (k?.kaptName && k.kaptName !== apt.name) queries.push(k.kaptName);
    if (apt.bjdong) queries.push(`${apt.bjdong} ${apt.name}`);
    if (gu) queries.push(`${gu} ${apt.name}`);
    if (city) queries.push(`${city.replace(/시$/, "")} ${apt.name}`);
    // 이름 변형: 괄호/공백 제거
    const cleaned = apt.name.replace(/\([^)]*\)/g, "").replace(/\s/g, "");
    if (cleaned !== apt.name && cleaned.length >= 2) queries.push(cleaned);

    let bestMatch: { hcode: string; dist: number; name: string } | null = null;
    const seen = new Set<string>();

    for (const q of queries) {
      const results = await searchHogangnono(q, rx, ry);
      await sleep(100);

      for (const r of results.slice(0, 8)) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const poly = await fetchPolygon(r.id);
        await sleep(50);
        if (poly.length === 0) continue;

        const cx = poly.reduce((s, p) => s + p.lng, 0) / poly.length;
        const cy = poly.reduce((s, p) => s + p.lat, 0) / poly.length;
        const dist = haversine(truth.lat, truth.lng, cy, cx);

        if (dist < 500 && (!bestMatch || dist < bestMatch.dist)) {
          bestMatch = { hcode: r.id, dist, name: r.name };
        }
      }
      // 좋은 매칭(<100m) 찾으면 조기 종료
      if (bestMatch && bestMatch.dist < 100) break;
    }

    if (bestMatch) {
      apt.hcode = bestMatch.hcode;
      hcodes[apt.name] = bestMatch.hcode;
      success++;
      console.log(` ✓ ${bestMatch.hcode} (${bestMatch.name}, ${Math.round(bestMatch.dist)}m)`);
    } else {
      fail++;
      console.log(" ✗ 매칭 안됨");
    }

    // 매 건 저장
    if ((i + 1) % 5 === 0 || i === targets.length - 1) {
      await Bun.write(join(DATA_DIR, "apt_identity.json"), JSON.stringify(identity, null, 2));
      await Bun.write(hcodesPath, JSON.stringify(hcodes, null, 2));
    }
  }

  await Bun.write(join(DATA_DIR, "apt_identity.json"), JSON.stringify(identity, null, 2));
  await Bun.write(hcodesPath, JSON.stringify(hcodes, null, 2));

  console.log(`\n검증 매칭: ${success}, 실패: ${fail}`);
}

main().catch(console.error);
