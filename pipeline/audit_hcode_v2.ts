/**
 * hcode v2 검증 — 단지명까지 비교.
 *
 * 절차:
 *   1. 단지마다 호갱노노 검색 (apt 이름 + 지역)
 *   2. 결과 중 ground truth (K-apt 도로명 → kakao geocode) 500m 이내 후보 추출
 *   3. 후보의 호갱노노 단지명과 우리 단지명을 비교 → 가장 유사한 후보 선택
 *   4. 선택된 후보의 hcode가 현재 매핑과 다르면 mismatch
 *
 * 기존 strict audit는 거리만 비교 → 인접 단지가 같은 hcode 매핑돼도 통과해버림.
 *
 * Usage: bun src/audit_hcode_v2.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REGION_COORDS: Record<string, [number, number]> = {
  "수원시": [127.01, 37.27], "성남시": [127.13, 37.44], "용인시": [127.10, 37.24],
  "하남시": [127.21, 37.54], "화성시": [127.05, 37.20], "안양시": [126.95, 37.39],
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
  "서울특별시": [126.978, 37.566],
};

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function normalize(s: string): string {
  return (s || "").replace(/[^가-힣A-Za-z0-9]/g, "").toLowerCase();
}

// LCS 길이 기반 유사도 (0~1)
function similarity(a: string, b: string): number {
  const A = normalize(a), B = normalize(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  // shorter included in longer
  if (A.includes(B) || B.includes(A)) return 0.9 * Math.min(A.length, B.length) / Math.max(A.length, B.length);
  // bigram Jaccard
  const grams = (s: string) => { const g = new Set<string>(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const ga = grams(A), gb = grams(B);
  let inter = 0;
  for (const x of ga) if (gb.has(x)) inter++;
  const union = ga.size + gb.size - inter;
  return union > 0 ? inter / union : 0;
}

async function geocode(query: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}&size=1`,
      { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    const d = j.documents?.[0];
    if (!d?.y || !d?.x) return null;
    return { lat: parseFloat(d.y), lng: parseFloat(d.x) };
  } catch { return null; }
}

async function searchHogangnono(query: string, x: number, y: number): Promise<any[]> {
  try {
    const res = await fetch(`https://hogangnono.com/api/v2/searches/suggestions/new?query=${encodeURIComponent(query)}&x=${x}&y=${y}`);
    if (!res.ok) return [];
    const j = (await res.json()) as any;
    return j.data?.matched?.apt?.list ?? [];
  } catch { return []; }
}

interface Identity {
  name: string; region: string; hcode: string | null;
  bjdong: string; jibun: string; jibun_addr: string | null; doro_juso: string | null;
}

async function main() {
  const identity: Identity[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const kapt: Record<string, any> = await Bun.file(join(DATA_DIR, "kapt_info.json")).json();

  const cachePath = join(DATA_DIR, "_hcode_v2_cache.json");
  let cache: {
    truths: Record<string, { lat: number; lng: number } | null>;
    searches: Record<string, any[]>;  // key: apt name (단지별 1회 검색)
  } = { truths: {}, searches: {} };
  if (existsSync(cachePath)) cache = await Bun.file(cachePath).json();

  const withHcode = identity.filter((a) => a.hcode);
  console.log(`hcode 보유: ${withHcode.length}`);

  // truth 채우기
  for (let i = 0; i < withHcode.length; i++) {
    const apt = withHcode[i];
    if (cache.truths[apt.name] !== undefined) continue;
    const k = kapt[apt.name];
    let q: string | null = null;
    if (k?.doroJuso) q = k.doroJuso;
    else if (k?.addr) q = k.addr;
    else if (apt.doro_juso) q = apt.doro_juso;
    else if (apt.jibun_addr) q = apt.jibun_addr;
    else if (apt.bjdong && apt.jibun) q = `경기도 ${apt.region || ""} ${apt.bjdong} ${apt.jibun}`;
    if (!q) { cache.truths[apt.name] = null; continue; }
    cache.truths[apt.name] = await geocode(q);
    if ((i + 1) % 100 === 0) {
      console.log(`  truth ${i + 1}/${withHcode.length}`);
      await Bun.write(cachePath, JSON.stringify(cache, null, 2));
    }
    await sleep(50);
  }
  await Bun.write(cachePath, JSON.stringify(cache, null, 2));

  // 검색 채우기 (다중 쿼리: 단지명 + K-apt addr 끝 별칭 + 도로명)
  for (let i = 0; i < withHcode.length; i++) {
    const apt = withHcode[i];
    if (cache.searches[apt.name] !== undefined) continue;
    const city = (apt.region || "").split(" ")[0];
    const [rx, ry] = REGION_COORDS[apt.region || ""] || REGION_COORDS[city] || [127.05, 37.3];

    const queries: string[] = [apt.name];
    const k = kapt[apt.name];
    // K-apt addr 끝 단지명 (예: "...영덕동 971 광교레이크스위첸")
    if (k?.addr) {
      const m = String(k.addr).match(/\s+(\S+)\s*$/);
      if (m && /[가-힣]/.test(m[1]) && normalize(m[1]) !== normalize(apt.name)) queries.push(m[1]);
    }
    // 도로명 주소
    if (k?.doroJuso) queries.push(k.doroJuso);
    if (apt.doro_juso && apt.doro_juso !== k?.doroJuso) queries.push(apt.doro_juso);

    const merged = new Map<string, any>();
    for (const q of queries) {
      const results = await searchHogangnono(q, rx, ry);
      for (const r of results.slice(0, 10)) {
        if (!merged.has(r.id)) merged.set(r.id, r);
      }
      await sleep(80);
    }
    cache.searches[apt.name] = [...merged.values()].slice(0, 20).map((r: any) => ({
      id: r.id, name: r.name, lat: r.lat, lng: r.lng, road: r.road_address, address: r.address,
    }));
    if ((i + 1) % 100 === 0) {
      console.log(`  search ${i + 1}/${withHcode.length}`);
      await Bun.write(cachePath, JSON.stringify(cache, null, 2));
    }
  }
  await Bun.write(cachePath, JSON.stringify(cache, null, 2));

  // 분석 — 주소 매칭 우선 (jibun 일치 → 정답 후보), 없으면 name+distance fallback
  interface Mismatch {
    name: string;
    current_hcode: string;
    suggested_hcode: string;
    suggested_name: string;
    confidence: "address" | "name" | "distance";
    similarity: number;
    distance_m: number;
  }
  const mismatches: Mismatch[] = [];
  const lowConfidence: { name: string; hcode: string; reason: string }[] = [];

  for (const apt of withHcode) {
    const truth = cache.truths[apt.name];
    if (!truth) continue;
    const results = (cache.searches[apt.name] ?? []) as any[];
    if (results.length === 0) {
      lowConfidence.push({ name: apt.name, hcode: apt.hcode!, reason: "검색 결과 없음" });
      continue;
    }
    // K-apt 주소에서 jibun 추출
    const k = kapt[apt.name];
    let aptJibun: string | null = null;
    if (k?.addr) {
      const m = String(k.addr).match(/(\S+동(?:\s+\S+)?)\s+(\d+(?:-\d+)?)/);
      if (m) aptJibun = `${m[1]} ${m[2]}`;
    }
    if (!aptJibun && apt.bjdong && apt.jibun) aptJibun = `${apt.bjdong} ${apt.jibun}`;

    // 후보 평가
    const ranked = results
      .filter((r: any) => r.lat && r.lng)
      .map((r: any) => ({
        id: r.id, name: r.name, addr: r.road || "",
        sim: similarity(apt.name, r.name),
        dist: haversine(truth, { lat: r.lat, lng: r.lng }),
        addrMatch: aptJibun && (r as any).address ? String((r as any).address).includes(aptJibun) : false,
      }))
      .filter((r) => r.dist < 2000);

    if (ranked.length === 0) {
      lowConfidence.push({ name: apt.name, hcode: apt.hcode!, reason: "근접 후보 없음" });
      continue;
    }

    // 1순위: address(jibun) 매칭
    const addrMatched = ranked.filter((r) => r.addrMatch);
    let top: typeof ranked[0] | undefined;
    let conf: "address" | "name" | "distance" = "distance";
    if (addrMatched.length > 0) {
      addrMatched.sort((a, b) => b.sim - a.sim || a.dist - b.dist);
      top = addrMatched[0];
      conf = "address";
    } else {
      // 2순위: name similarity 충분히 높음 (>= 0.7)
      const nameMatched = ranked.filter((r) => r.sim >= 0.7).sort((a, b) => b.sim - a.sim || a.dist - b.dist);
      if (nameMatched.length > 0) {
        top = nameMatched[0];
        conf = "name";
      } else {
        // 3순위: 거리만 (low confidence)
        ranked.sort((a, b) => a.dist - b.dist);
        top = ranked[0];
        conf = "distance";
      }
    }

    if (!top || top.id === apt.hcode) continue;

    // distance-only 매칭은 자동 수정 X (사용자 확인 필요)
    if (conf === "distance") {
      lowConfidence.push({ name: apt.name, hcode: apt.hcode!, reason: `거리 기반 후보 ${top.id} (${top.name})` });
      continue;
    }

    mismatches.push({
      name: apt.name,
      current_hcode: apt.hcode!,
      suggested_hcode: top.id,
      suggested_name: top.name,
      confidence: conf,
      similarity: Math.round(top.sim * 100) / 100,
      distance_m: Math.round(top.dist),
    });
  }

  const out = {
    summary: {
      total_with_hcode: withHcode.length,
      mismatches: mismatches.length,
      low_confidence: lowConfidence.length,
    },
    mismatches: mismatches.sort((a, b) => b.similarity - a.similarity),
    low_confidence: lowConfidence,
  };
  await Bun.write(join(DATA_DIR, "_hcode_v2_audit_result.json"), JSON.stringify(out, null, 2));

  console.log(`\n=== 결과 ===`);
  console.log(`hcode 단지: ${withHcode.length}`);
  console.log(`  단지명 매칭 mismatch: ${mismatches.length}`);
  console.log(`  low confidence: ${lowConfidence.length}`);
  if (mismatches.length > 0) {
    console.log(`\n  상위 20 mismatch:`);
    for (const m of mismatches.slice(0, 20)) {
      console.log(`    ${m.name}: ${m.current_hcode} → ${m.suggested_hcode} (${m.suggested_name}, sim ${m.similarity})`);
    }
  }
}

main().catch(console.error);
