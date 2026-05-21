/**
 * 아파트 단지별 API 식별자 통합 매핑 생성.
 * 각 API에서 사용하는 key/name, 주소, place ID를 하나의 파일로 정리.
 *
 * Usage:
 *   bun src/identity.ts
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const PAGES_DIR = join(ROOT, "..", "home-scoring");

const API_KEY = process.env.PUBLIC_DATA_API_KEY!;
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY!;

interface AptIdentity {
  name: string;
  region: string;
  sigungu_cd: string;
  bjdong: string;
  bjd_code: string | null;
  jibun: string;
  jibun_addr: string | null;
  doro_juso: string | null;
  kapt_code: string | null;
  kapt_name: string | null;
  hcode: string | null;
  commute_name: string | null;
  naver_place_id: string | null;
  kakao_place_id: string | null;
  beec_name: string | null;
}

// K-apt 수동 매핑 (자동 매칭 실패 케이스)
const KAPT_MANUAL: Record<string, string> = {
  "수원 SK SKY VIEW": "A44030005",
  "래미안노블클래스2단지": "A44277306",
  "시범한빛마을동탄아이파크": "A44572517",
  "동탄2하우스디더레이크": "A10027281",
  "동탄2엘에이치26단지아파트(에이65블록)": "A10027291",
  "한양수자인": "A44370704",  // 한양수자인에듀파크 (영통구 망포동)
  "시범한빛마을금호어울림": "A44579008",  // 동탄금호어울림 (반송동 82)
  "푸르지오": "A44517002",
  "더레이크시티부영1단지": "A10025885",   // 더레이크파크뷰
  "더레이크시티부영5단지": "A10025909",   // 동탄 더 레이크 팰리스
  "영통SKVIEW": "A10027563",             // 영통 SK VIEW 아파트 (망포동)
  "흥덕마을자연앤스위첸": "A44678703",    // 광교레이크스위첸 (영덕동 971)
  "시범다은마을우남퍼스트빌": "A44516011", // 시범다은마을우남퍼스트빌 (반송동)
};

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchNaverPlaceId(query: string): Promise<string | null> {
  const url = `https://m.map.naver.com/search2/search.naver?query=${encodeURIComponent(query + " 아파트")}&sm=hty&style=v5`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/place\/(\d+)/);
    return m?.[1] ?? null;
  } catch { return null; }
}

async function fetchKakaoPlaceId(query: string): Promise<string | null> {
  try {
    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query + " 아파트")}&size=1`;
    const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
    if (!res.ok) return null;
    const json = await res.json() as any;
    const doc = json.documents?.[0];
    if (!doc || !doc.category_name?.includes("아파트")) return null;
    return doc.id ?? null;
  } catch { return null; }
}

async function fetchKaptBasicAndDetail(kaptCode: string) {
  const [r1, r2] = await Promise.all([
    fetch(`https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusBassInfoV4?serviceKey=${API_KEY}&kaptCode=${kaptCode}`),
    fetch(`https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusDtlInfoV4?serviceKey=${API_KEY}&kaptCode=${kaptCode}`),
  ]);
  const j1 = await r1.json() as any;
  const j2 = await r2.json() as any;
  return { basic: j1.response?.body?.item, detail: j2.response?.body?.item };
}

async function main() {
  const dataJsonPath = join(PAGES_DIR, "public", "data.json");
  const scored: any[] = existsSync(dataJsonPath) ? await Bun.file(dataJsonPath).json() : [];
  const scoredNames = new Set<string>(scored.map((d: any) => d.name));

  // 실거래가 CSV
  const csvText = await Bun.file(join(DATA_DIR, "apt_trade_filtered.csv")).text();
  const { data: trades } = Papa.parse<Record<string, string>>(csvText.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: true });
  const tradeMap = new Map<string, { dong: string; jibun: string; regionCode: string; region: string }>();
  // r3 (2026-02-01 이후) 거래가 있는 단지 추적 (sync.ts와 동일 필터)
  const r3Names = new Set<string>();
  for (const r of trades) {
    if (!tradeMap.has(r.단지명)) tradeMap.set(r.단지명, { dong: r.법정동, jibun: r.지번, regionCode: r.지역코드, region: r.지역명 });
    if (r.거래일자 >= "2026-02-01") r3Names.add(r.단지명);
  }

  // 식별자 대상: data.json(기존 점수 부여 단지) ∪ csv r3 거래 단지 (신규 도시 부트스트랩)
  const uniqueNames = [...new Set([...scoredNames, ...r3Names])];
  console.log(`스코어링 대상: ${uniqueNames.length}개 단지 (data.json ${scoredNames.size} + r3 csv ${r3Names.size})`);

  // K-apt
  const kaptData: Record<string, any> = existsSync(join(DATA_DIR, "kapt_info.json"))
    ? await Bun.file(join(DATA_DIR, "kapt_info.json")).json() : {};

  // 수동 매핑 보충
  for (const [name, code] of Object.entries(KAPT_MANUAL)) {
    if (kaptData[name]) continue;
    console.log(`  수동 K-apt: ${name} → ${code}`);
    const { basic, detail } = await fetchKaptBasicAndDetail(code);
    await sleep(300);
    if (basic) {
      const hh = basic.kaptdaCnt || 0;
      const park = (parseInt(detail?.kaptdPcntu || "0") || 0) + (parseInt(detail?.kaptdPcnt || "0") || 0);
      kaptData[name] = {
        kaptCode: code, name, bjdCode: basic.bjdCode || "",
        addr: basic.kaptAddr || "", doroJuso: basic.doroJuso || "",
        useDate: basic.kaptUsedate || "", households: hh,
        dongCount: parseInt(basic.kaptDongCnt || "0") || 0,
        topFloor: basic.kaptTopFloor || 0, heatType: basic.codeHeatNm || "",
        structure: detail?.codeStr || "",
        parkingTotal: park, parkingPerHh: hh > 0 ? Math.round((park / hh) * 100) / 100 : 0,
        elevatorCount: detail?.kaptdEcnt || 0, cctvCount: parseInt(detail?.kaptdCccnt || "0") || 0,
        subwayLine: detail?.subwayLine || null, subwayStation: detail?.subwayStation || null,
        education: detail?.educationFacility || null, repairFund: null, energy: null,
      };
      console.log(`    ✓ ${basic.kaptName} ${hh}세대 주차${park}`);
    }
  }
  await Bun.write(join(DATA_DIR, "kapt_info.json"), JSON.stringify(kaptData, null, 2));

  // 호갱노노
  const hcodes: Record<string, string | null> = existsSync(join(DATA_DIR, "hogangnono_codes.json"))
    ? await Bun.file(join(DATA_DIR, "hogangnono_codes.json")).json() : {};
  function findHcode(name: string): string | null {
    if (name in hcodes) return hcodes[name];
    const nc = name.replace(/\s/g, "");
    for (const [k, v] of Object.entries(hcodes)) { if (v && k.replace(/\s/g, "") === nc) return v; }
    for (const [k, v] of Object.entries(hcodes)) { const kc = k.replace(/\s/g, ""); if (v && (kc.includes(nc) || nc.includes(kc))) return v; }
    return null;
  }

  // 출퇴근
  const commuteData: any[] = existsSync(join(DATA_DIR, "commute_results.json"))
    ? await Bun.file(join(DATA_DIR, "commute_results.json")).json() : [];
  const commuteNames = new Set<string>();
  for (const e of commuteData) for (const r of e.results || []) commuteNames.add(r.name);

  // BEEC 에너지효율등급
  const beecRaw: Record<string, any> = existsSync(join(DATA_DIR, "energy_grade_beec.json"))
    ? await Bun.file(join(DATA_DIR, "energy_grade_beec.json")).json() : {};
  const beecNames: Record<string, string> = {};
  for (const [k, v] of Object.entries(beecRaw)) {
    if (k.startsWith("_") || !v) continue;
    if (typeof v === "object" && v.beec_name) beecNames[k] = v.beec_name;
  }

  // 기존 identity (캐시)
  const existingPath = join(DATA_DIR, "apt_identity.json");
  const existingList: AptIdentity[] = existsSync(existingPath) ? await Bun.file(existingPath).json() : [];
  const cache = new Map(existingList.map(e => [e.name, e]));

  // 조합
  const result: AptIdentity[] = [];
  let idx = 0;

  for (const name of uniqueNames) {
    idx++;
    const trade = tradeMap.get(name);
    const kapt = kaptData[name];
    const cached = cache.get(name);

    let kaptName: string | null = null;
    if (kapt?.addr) {
      const m = kapt.addr.match(/\d+(?:-\d+)?\s+(.+?)\s*$/);
      kaptName = m?.[1]?.trim() || null;
    }

    let naverId = cached?.naver_place_id ?? null;
    let kakaoId = cached?.kakao_place_id ?? null;

    if (!naverId || !kakaoId) {
      process.stdout.write(`  [${idx}/${uniqueNames.length}] ${name}...`);
      if (!naverId) { naverId = await fetchNaverPlaceId(name); await sleep(300); }
      if (!kakaoId) { kakaoId = await fetchKakaoPlaceId(name); await sleep(200); }
      console.log(` naver:${naverId ?? "✗"} kakao:${kakaoId ?? "✗"}`);
    }

    result.push({
      name,
      region: trade?.region ?? cached?.region ?? "",
      sigungu_cd: trade?.regionCode ?? cached?.sigungu_cd ?? "",
      bjdong: trade?.dong ?? cached?.bjdong ?? "",
      bjd_code: kapt?.bjdCode ?? cached?.bjd_code ?? null,
      jibun: trade?.jibun ?? cached?.jibun ?? "",
      jibun_addr: kapt?.addr?.trim() ?? cached?.jibun_addr ?? null,
      doro_juso: kapt?.doroJuso ?? cached?.doro_juso ?? null,
      kapt_code: kapt?.kaptCode ?? cached?.kapt_code ?? null,
      kapt_name: kaptName ?? cached?.kapt_name ?? null,
      hcode: findHcode(name) ?? cached?.hcode ?? null,
      commute_name: commuteNames.has(name) ? name : cached?.commute_name ?? null,
      naver_place_id: naverId ?? cached?.naver_place_id ?? null,
      kakao_place_id: kakaoId ?? cached?.kakao_place_id ?? null,
      beec_name: beecNames[name] ?? cached?.beec_name ?? null,
    });
  }

  result.sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name));
  await Bun.write(existingPath, JSON.stringify(result, null, 2));

  const s = (key: keyof AptIdentity) => result.filter(r => r[key]).length;
  console.log(`\n저장: ${existingPath} (${result.length}개)`);
  console.log(`  K-apt: ${s("kapt_code")} | 호갱노노: ${s("hcode")} | 출퇴근: ${s("commute_name")}`);
  console.log(`  도로명: ${s("doro_juso")} | 네이버맵: ${s("naver_place_id")} | 카카오맵: ${s("kakao_place_id")}`);
}

main();
