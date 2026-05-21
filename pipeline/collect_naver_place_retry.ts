/**
 * 네이버 place ID 재시도 패스.
 *
 * - home/data/apt_identity.json에서 naver_place_id === null 인 entry만 다시 시도
 * - 연속 실패 시 백오프(최대 30초) + 최대 3회 재시도
 * - 끝까지 null이면 home-scoring/data/apt_identity.json의 원본 값으로 fallback
 *
 * Usage: bun src/collect_naver_place_retry.ts
 */
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const FALLBACK_PATH = join(homedir(), "GitHub", "home-scoring", "data", "apt_identity.json");
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

async function searchNaverPlace(query: string): Promise<PlaceCandidate[] | "ratelimit"> {
  const url = `https://m.map.naver.com/search2/search.naver?query=${encodeURIComponent(query)}&sm=hty&style=v5`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)" },
  });
  if (!res.ok) {
    if (res.status === 429 || res.status === 403) return "ratelimit";
    return [];
  }
  const text = await res.text();
  if (text.includes("captcha") || text.length < 200) return "ratelimit";

  const candidates: PlaceCandidate[] = [];
  const re = /\{"id":(\d+),"name":"([^"]+)","category":"([^"]*)"[^{]*?"roadAddress":"([^"]*)"[^{]*?"latitude":([0-9.]+),"longitude":([0-9.]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, id, name, category, roadAddress, lat, lng] = m;
    if (REJECT_KEYWORDS.some((k) => name.includes(k))) continue;
    candidates.push({ id, name, category, roadAddress, lat: parseFloat(lat), lng: parseFloat(lng) });
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
  const scored = candidates.map((c) => ({
    c,
    dist: haversine(gtLat, gtLng, c.lat, c.lng),
    catOk: APT_CATEGORIES.has(c.category),
    nameMatch: c.name.replace(/\s+/g, "") === aptName.replace(/\s+/g, ""),
  }));
  const exact = scored.filter((s) => s.nameMatch && s.dist <= MAX_DIST_M);
  if (exact.length > 0) {
    exact.sort((a, b) => a.dist - b.dist);
    return exact[0].c;
  }
  const cat = scored.filter((s) => s.catOk && s.dist <= MAX_DIST_M);
  if (cat.length > 0) {
    cat.sort((a, b) => a.dist - b.dist);
    return cat[0].c;
  }
  scored.sort((a, b) => a.dist - b.dist);
  if (scored[0].dist <= 100) return scored[0].c;
  return null;
}

async function main() {
  const identityPath = join(DATA_DIR, "apt_identity.json");
  const identity: any[] = await Bun.file(identityPath).json();
  const fallback: any[] = await Bun.file(FALLBACK_PATH).json();
  const fallbackById = new Map(fallback.map((e) => [e.name, e.naver_place_id]));

  const kaptInfo: Record<string, any> = await Bun.file(join(DATA_DIR, "kapt_info.json")).json().catch(() => ({}));
  const dongCoords: Record<string, Array<{ dong: string; lat: number; lng: number }>> =
    await Bun.file(join(DATA_DIR, "dong_coords_naver.json")).json().catch(() => ({}));

  const failed = identity.filter((e) => e.naver_place_id === null);
  console.log(`재시도 대상: ${failed.length}/${identity.length}\n`);

  let recovered = 0, fallbackUsed = 0, stillNull = 0, backoffMs = 1000;

  for (let i = 0; i < failed.length; i++) {
    const entry = failed[i];
    process.stdout.write(`[${i + 1}/${failed.length}] ${entry.name}...`);

    const coords = dongCoords[entry.name];
    if (!coords || coords.length === 0) {
      // 좌표 없으면 fallback
      const fb = fallbackById.get(entry.name);
      if (fb) {
        entry.naver_place_id = fb;
        fallbackUsed++;
        console.log(` ↳ fallback ${fb} (좌표없음)`);
      } else {
        stillNull++;
        console.log(" ✗ (좌표없음, fallback도 없음)");
      }
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
    let attempts = 0;
    outer: for (let attempt = 0; attempt < 3 && !picked; attempt++) {
      for (const q of queries) {
        attempts++;
        const cands = await searchNaverPlace(q);
        if (cands === "ratelimit") {
          backoffMs = Math.min(30000, backoffMs * 2);
          process.stdout.write(` (rl ${Math.round(backoffMs / 1000)}s)`);
          await sleep(backoffMs);
          continue outer;
        }
        picked = pickBestCandidate(cands, gtLat, gtLng, entry.name);
        if (picked) break;
        await sleep(300);
      }
      if (!picked) await sleep(1000 * (attempt + 1));
    }

    if (picked) {
      entry.naver_place_id = picked.id;
      recovered++;
      console.log(` ${picked.id} (${picked.name}, ${attempts}회시도)`);
      backoffMs = Math.max(1000, backoffMs / 2);
    } else {
      // fallback
      const fb = fallbackById.get(entry.name);
      if (fb) {
        entry.naver_place_id = fb;
        fallbackUsed++;
        console.log(` ↳ fallback ${fb}`);
      } else {
        stillNull++;
        console.log(" ✗");
      }
    }

    await sleep(400);

    if ((i + 1) % 50 === 0) {
      await Bun.write(identityPath, JSON.stringify(identity, null, 2));
      console.log(`  --- 중간 저장 (복구 ${recovered} / fallback ${fallbackUsed} / 여전히 null ${stillNull}) ---`);
    }
  }

  await Bun.write(identityPath, JSON.stringify(identity, null, 2));
  console.log(`\n복구 ${recovered} / fallback ${fallbackUsed} / 여전히 null ${stillNull}`);
}

main().catch(console.error);
