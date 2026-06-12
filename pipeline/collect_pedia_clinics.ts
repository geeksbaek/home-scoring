/**
 * 소아과 거리 데이터 빌더 — pediatric_clinics.json.
 *
 * 각 단지 좌표(dong_coords_naver) 기준 Kakao 키워드 검색 "소아청소년과"+"소아과" 병합
 * (반경 2km, 없으면 5km 확장) → 가까운 5개 후보 → road_m + walk_min 추정 → top 2 채택.
 *
 * 기존에 데이터 있는 단지는 스킵. 신규 단지(예: 안양)만 채움.
 *
 * Usage: bun src/collect_pedia_clinics.ts
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Clinic {
  name: string;
  straight_m: number;
  road_m: number;
  walk_min: number;
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

const SEARCH_KEYWORDS = ["소아청소년과", "소아과"];
// 2km 내 없으면 5km까지 확장 (의왕백운밸리 등 신도시: 최근접 소아과가 2.8km+)
const SEARCH_RADII = [2000, 5000];

async function searchClinics(lat: number, lng: number): Promise<Array<{ name: string; lat: number; lng: number; distM: number }>> {
  // Kakao 카테고리 HP8(병원) + 키워드 — 키워드 검색이 정확도 높음.
  // "소아청소년과"(정식 명칭)와 "소아과"(통칭) 결과가 서로 다르게 나와 둘 다 검색 후 병합.
  for (const radius of SEARCH_RADII) {
    const out: Array<{ id: string; name: string; lat: number; lng: number; distM: number }> = [];
    for (const keyword of SEARCH_KEYWORDS) {
      const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(keyword)}&x=${lng}&y=${lat}&radius=${radius}&size=10&sort=distance`;
      const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
      if (!res.ok) continue;
      const j = await res.json() as any;
      for (const d of j.documents || []) {
        const cLat = parseFloat(d.y);
        const cLng = parseFloat(d.x);
        const distM = haversine(lat, lng, cLat, cLng);
        out.push({
          id: String(d.id ?? ""),
          name: d.place_name.replace(/\s+/g, " ").trim(),
          lat: cLat, lng: cLng, distM,
        });
      }
      await sleep(100);
    }
    out.sort((a, b) => a.distM - b.distM);
    // 중복 제거 (place id 동일 또는 이름 동일 + 200m 이내)
    const dedup: typeof out = [];
    for (const c of out) {
      if (dedup.some((d) => (c.id && d.id === c.id) || (d.name === c.name && Math.abs(d.distM - c.distM) < 200))) continue;
      dedup.push(c);
    }
    if (dedup.length > 0) return dedup.slice(0, 5);
  }
  return [];
}

async function walkRoute(fromLat: number, fromLng: number, toLat: number, toLng: number): Promise<{ road_m: number; walk_min: number } | null> {
  // Kakao Mobility 도보 경로
  const url = `https://apis-navi.kakaomobility.com/v1/waypoints/directions?origin=${fromLng},${fromLat}&destination=${toLng},${toLat}&priority=DISTANCE`;
  // Note: 도보 경로 API는 별도 — 자동차 경로로 fallback해도 walk_min은 부정확.
  // Kakao는 도보 경로 공개 API 없음 → 직선거리 × 1.3 × 12분/km 추정 사용.
  const distM = haversine(fromLat, fromLng, toLat, toLng);
  const roadM = Math.round(distM * 1.3); // 도로 보정 1.3배
  const walkMin = Math.round(roadM / 80); // 시속 4.8km = 분당 80m
  return { road_m: roadM, walk_min: walkMin };
}

async function main() {
  const existing: Record<string, Clinic[]> = await Bun.file(join(DATA_DIR, "pediatric_clinics.json")).json();
  const coords: Record<string, Array<{ dong: string; lat: number; lng: number }>> =
    await Bun.file(join(DATA_DIR, "dong_coords_naver.json")).json();
  const identity: any[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();

  const targets = identity.filter((e) => {
    if (existing[e.name] && existing[e.name].length > 0) return false;
    const c = coords[e.name];
    return c && Array.isArray(c) && c.length > 0;
  });

  console.log(`대상: ${targets.length}개 단지 (소아과 데이터 없음)\n`);

  let done = 0, saved = 0;
  for (const entry of targets) {
    const dongs = coords[entry.name];
    const lat = dongs.reduce((s, d) => s + d.lat, 0) / dongs.length;
    const lng = dongs.reduce((s, d) => s + d.lng, 0) / dongs.length;

    const clinics = await searchClinics(lat, lng);
    await sleep(150);

    if (clinics.length === 0) {
      done++;
      process.stdout.write(`[${done}/${targets.length}] ${entry.name}... 검색 결과 없음\n`);
      continue;
    }

    const enriched: Clinic[] = [];
    for (const c of clinics.slice(0, 2)) {
      const route = await walkRoute(lat, lng, c.lat, c.lng);
      if (route) {
        enriched.push({
          name: c.name,
          straight_m: c.distM,
          road_m: route.road_m,
          walk_min: route.walk_min,
        });
      }
    }

    if (enriched.length > 0) {
      existing[entry.name] = enriched;
      saved++;
      done++;
      process.stdout.write(`[${done}/${targets.length}] ${entry.name}: ${enriched.map(e => `${e.name}(${e.walk_min}분)`).join(", ")}\n`);
    } else {
      done++;
    }

    if (done % 50 === 0) {
      await Bun.write(join(DATA_DIR, "pediatric_clinics.json"), JSON.stringify(existing, null, 2));
      console.log(`  --- 중간 저장 (${saved}/${done}) ---`);
    }
  }

  await Bun.write(join(DATA_DIR, "pediatric_clinics.json"), JSON.stringify(existing, null, 2));
  console.log(`\n수집 ${saved} / 처리 ${done}`);
  console.log(`총 pediatric_clinics: ${Object.keys(existing).length}개`);
}

main().catch(console.error);
