/**
 * 네이버 지도 place ID 재수집 — 좌표 검증.
 *
 * 검색 결과 후보 중 단지 좌표(dong_coords_naver / 카카오 geocode)와
 * 가장 가까운 후보만 채택. 500m 초과·아파트 외 카테고리는 폐기.
 *
 * Usage: bun src/collect_naver_place.ts
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_DIST_M = 500;

interface PlaceCandidate {
  id: string;
  name: string;
  category: string;
  roadAddress: string;
  lat: number;
  lng: number;
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const APT_CATEGORIES = new Set(["아파트", "주상복합", "오피스텔", "주거시설", "공동주택"]);
const REJECT_KEYWORDS = ["충전", "주차장", "관리사무소", "상가", "카페", "편의점", "공원", "어린이집", "마트"];

async function searchNaverPlace(query: string): Promise<PlaceCandidate[]> {
  const url = `https://m.map.naver.com/search2/search.naver?query=${encodeURIComponent(query)}&sm=hty&style=v5`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)" },
  });
  if (!res.ok) return [];
  const text = await res.text();

  const candidates: PlaceCandidate[] = [];
  // JSON object literal 매칭: id, name, category, roadAddress, latitude, longitude
  const re = /\{"id":(\d+),"name":"([^"]+)","category":"([^"]*)"[^{]*?"roadAddress":"([^"]*)"[^{]*?"latitude":([0-9.]+),"longitude":([0-9.]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, id, name, category, roadAddress, lat, lng] = m;
    if (REJECT_KEYWORDS.some((k) => name.includes(k))) continue;
    candidates.push({
      id, name, category, roadAddress,
      lat: parseFloat(lat), lng: parseFloat(lng),
    });
  }
  return candidates;
}

function pickBestCandidate(
  candidates: PlaceCandidate[],
  gtLat: number,
  gtLng: number,
  aptName: string,
): PlaceCandidate | null {
  if (candidates.length === 0) return null;
  // 거리 + 카테고리 일치 가중치
  const scored = candidates.map((c) => ({
    c,
    dist: haversine(gtLat, gtLng, c.lat, c.lng),
    catOk: APT_CATEGORIES.has(c.category),
    nameMatch: c.name.replace(/\s+/g, "") === aptName.replace(/\s+/g, ""),
  }));
  // 1순위: 이름 정확 일치 + 거리 500m 이내
  const exact = scored.filter((s) => s.nameMatch && s.dist <= MAX_DIST_M);
  if (exact.length > 0) {
    exact.sort((a, b) => a.dist - b.dist);
    return exact[0].c;
  }
  // 2순위: 아파트 카테고리 + 500m 이내, 거리순
  const cat = scored.filter((s) => s.catOk && s.dist <= MAX_DIST_M);
  if (cat.length > 0) {
    cat.sort((a, b) => a.dist - b.dist);
    return cat[0].c;
  }
  // 3순위: 거리만 — 100m 이내(매우 가까움)면 채택, 그 외 폐기
  scored.sort((a, b) => a.dist - b.dist);
  if (scored[0].dist <= 100) return scored[0].c;
  return null;
}

async function main() {
  const identityPath = join(DATA_DIR, "apt_identity.json");
  const identity: any[] = await Bun.file(identityPath).json();
  const __only = process.env.ONLY_NAMES ? new Set(JSON.parse(require("node:fs").readFileSync(process.env.ONLY_NAMES, "utf8")) as string[]) : null;
  const kaptInfo: Record<string, any> = await Bun.file(join(DATA_DIR, "kapt_info.json")).json().catch(() => ({}));
  const dongCoords: Record<string, Array<{ dong: string; lat: number; lng: number }>> =
    await Bun.file(join(DATA_DIR, "dong_coords_naver.json")).json().catch(() => ({}));

  console.log(`네이버 place ID 재수집(좌표 검증): ${identity.length}개\n`);

  let updated = 0, unchanged = 0, failed = 0, noGt = 0;

  for (let i = 0; i < identity.length; i++) {
    const entry = identity[i];
    if (__only && !__only.has(entry.name)) continue;
    process.stdout.write(`[${i + 1}/${identity.length}] ${entry.name}...`);

    // 단지 좌표 ground truth — dong_coords 평균
    const coords = dongCoords[entry.name];
    if (!coords || coords.length === 0) {
      console.log(" ✗ (좌표 없음)");
      noGt++;
      continue;
    }
    const gtLat = coords.reduce((s, c) => s + c.lat, 0) / coords.length;
    const gtLng = coords.reduce((s, c) => s + c.lng, 0) / coords.length;

    const doroJuso = kaptInfo[entry.name]?.doroJuso || entry.doro_juso;
    const queries = [
      doroJuso ? `${doroJuso} 아파트` : null,
      `${entry.region} ${entry.bjdong} ${entry.name} 아파트`,
      `${entry.name} 아파트`,
    ].filter(Boolean) as string[];

    let picked: PlaceCandidate | null = null;
    for (const q of queries) {
      const cands = await searchNaverPlace(q);
      picked = pickBestCandidate(cands, gtLat, gtLng, entry.name);
      if (picked) break;
      await sleep(200);
    }

    if (picked) {
      const prev = entry.naver_place_id;
      entry.naver_place_id = picked.id;
      if (prev === picked.id) {
        unchanged++;
        console.log(` ${picked.id} (변경없음)`);
      } else {
        updated++;
        console.log(` ${picked.id} ← ${prev ?? "null"} (${picked.name}, ${picked.category})`);
      }
    } else {
      entry.naver_place_id = null;
      failed++;
      console.log(" ✗ (매칭 실패)");
    }

    await sleep(200);

    if ((i + 1) % 100 === 0) {
      await Bun.write(identityPath, JSON.stringify(identity, null, 2));
      console.log(`  --- 중간 저장 (변경 ${updated} / 유지 ${unchanged} / 실패 ${failed} / GT없음 ${noGt}) ---`);
    }
  }

  await Bun.write(identityPath, JSON.stringify(identity, null, 2));
  console.log(`\n변경 ${updated} / 유지 ${unchanged} / 실패 ${failed} / GT없음 ${noGt}`);
  console.log(`naver_place_id 보유: ${identity.filter((e) => e.naver_place_id).length}/${identity.length}`);
}

main().catch(console.error);
