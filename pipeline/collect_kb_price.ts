/**
 * KB부동산(kbland.kr) 단지별/타입별 시세 자동 수집.
 *
 * 흐름 (메모리 kb-price-api 계약):
 *   1) 통합검색 intgraSerch(SRC_HSCM) → COMPLEX_NO + BUBCODE(법정동코드) + ARNO(지번) + 좌표
 *      → bjd_code+지번 1차 매칭, 좌표 500m 2차 검증 (CLAUDE.md 좌표검증 원칙)
 *   2) complex/typInfo → 면적별 [면적일련번호, 전용면적, 세대수]
 *   3) land-price/price/BasePrcInfoNew(단지+면적일련번호) → 매매/전세 일반·상위·하위 평균가
 *
 * atype 버킷에 면적일련번호가 여럿이면 세대수 최다 평형을 대표로 1회만 시세 조회.
 * 매 건 저장(크래시 대비), rate limit sleep, exponential backoff.
 *
 * 출력:
 *   data/kb_complex_ids.json — { [name]: { complexNo, bubcode, arno, lat, lng, dist_m, matched_by, kb_name } | null }
 *                              (null = 검색했으나 매칭 실패 → 재검색 스킵)
 *   data/kb_price.json       — { "이름|atype": { sale, jeonse, sale_lo, asOf } }  (단위 만원)
 *
 * Usage:
 *   bun pipeline/collect_kb_price.ts                 # 미수집 단지만 증분
 *   bun pipeline/collect_kb_price.ts --refresh-price # 시세만 갱신(이미 매칭된 단지 전체 재조회)
 *   bun pipeline/collect_kb_price.ts --only <file>   # JSON 배열 파일의 이름만
 *   bun pipeline/collect_kb_price.ts --limit 50      # 디버그: N개만
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KB_BASE = "https://api.kbland.kr";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  Referer: "https://kbland.kr/",
  Origin: "https://kbland.kr",
  Accept: "application/json",
  webservice: "1", // map250mBlwInfoList POST에 필수
};

// sync.ts areaType()와 동일 — 전용면적 raw 기준 버킷.
function areaType(a: number): string {
  if (a >= 220) return "230";
  if (a >= 180) return "200";
  if (a >= 150) return "160";
  if (a >= 130) return "140";
  if (a >= 120) return "124";
  if (a >= 110) return "114";
  if (a >= 100) return "104";
  if (a >= 86) return "99";
  if (a >= 80) return "84";
  if (a >= 70) return "74";
  if (a >= 64) return "64";
  if (a >= 60.5) return "60";
  if (a >= 57) return "59";
  if (a >= 50) return "52";
  if (a >= 40) return "49";
  if (a >= 30) return "39";
  return "29";
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 분리 단지명 "이름(법정동)" → 검색용 base 이름
function searchKeyword(name: string): string {
  return name.replace(/\([^)]*\)\s*$/, "").trim() || name;
}

// 선두 영문/숫자 brand 토큰 제거 → 한글 코어 ("LG선릉에클라트"→"선릉에클라트").
// KB가 영문 brand를 한글로 표기(LG→엘지)해 영문 그대로면 검색 0건인 케이스 회피.
function koreanCore(name: string): string {
  const stripped = name.replace(/^[A-Za-z0-9.\-_\s]+/, "").trim();
  return stripped.length >= 2 ? stripped : name;
}

// 트레일링 "아파트"+잡토큰, 동 리스트, 숫자범위 제거.
// "삼성청담아파트"→"삼성청담", "대치우성아파트1동,2동"→"대치우성", "동현아파트1~6"→"동현"
function stripAptSuffix(name: string): string {
  const s = name.replace(/아파트.*$/, "").replace(/\d+동(\s*,\s*\d+동)*.*$/, "").replace(/\s*\d+\s*~\s*\d+\s*$/, "").trim();
  return s.length >= 2 ? s : name;
}

// 단지 검색에 시도할 키워드 변형 목록 (이름+동, 아파트제거+동, 한글코어+동, 각 단독).
// KB가 단지명을 축약/재배열("○○아파트"→"○○", 지역prefix 생략)하는 케이스 대응.
function searchKeywords(name: string, bjdong: string | null): string[] {
  const base = searchKeyword(name);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    s = s.trim().replace(/\s+/g, " ");
    if (s.length >= 2 && !seen.has(s)) { seen.add(s); out.push(s); }
  };
  const bases = [base, stripAptSuffix(base), koreanCore(base), koreanCore(stripAptSuffix(base))];
  // 동 붙인 변형 우선(순위↑), 그다음 단독
  for (const b of bases) if (bjdong) add(`${b} ${bjdong}`);
  for (const b of bases) add(b);
  return out;
}

// 단지명 비교용 정규화 (공백/구두점/영문 제거)
function normName(s: string): string {
  return s.replace(/[\s.\-_()A-Za-z0-9]/g, "");
}

// 본번만 추출 ("185-15"→"185", "산 1240"→"1240", "456번지 일원"→"456")
function bonbun(jibun: string | null | undefined): string | null {
  if (!jibun) return null;
  const m = String(jibun).match(/(\d+)/);
  return m ? m[1] : null;
}

// 본번-부번 정규화 ("185-15"→"185-15", "456번지 일원"→"456")
function normJibun(jibun: string | null | undefined): string | null {
  if (!jibun) return null;
  const m = String(jibun).match(/(\d+)(?:\s*-\s*(\d+))?/);
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

interface KbFetch<T> {
  data: T | null;
  rateLimited: boolean;
}

async function kbGet<T = any>(path: string, params: Record<string, string | number>): Promise<KbFetch<T>> {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])));
  const url = `${KB_BASE}${path}?${qs.toString()}`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (res.status === 429 || res.status === 503) return { data: null, rateLimited: true };
    if (!res.ok) return { data: null, rateLimited: false };
    const json: any = await res.json();
    return { data: (json?.dataBody?.data ?? null) as T, rateLimited: false };
  } catch {
    return { data: null, rateLimited: false };
  }
}

// 429 backoff 래퍼
async function kbGetRetry<T = any>(path: string, params: Record<string, string | number>): Promise<T | null> {
  let r = await kbGet<T>(path, params);
  let backoff = 5000;
  while (r.rateLimited && backoff <= 60000) {
    console.log(`    ⚠ rate limited — ${backoff / 1000}s 대기`);
    await sleep(backoff);
    r = await kbGet<T>(path, params);
    backoff *= 2;
  }
  return r.data;
}

async function kbPost<T = any>(path: string, body: Record<string, unknown>): Promise<KbFetch<T>> {
  try {
    const res = await fetch(`${KB_BASE}${path}`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 503) return { data: null, rateLimited: true };
    if (!res.ok) return { data: null, rateLimited: false };
    const json: any = await res.json();
    return { data: (json?.dataBody?.data ?? null) as T, rateLimited: false };
  } catch {
    return { data: null, rateLimited: false };
  }
}

// 지도 bbox 단지마커 검색의 빈 필터 필드 (실제 KB 웹 요청 본문 복제)
const EMPTY_FILTER_KEYS = ["매매시작값","매매종료값","보증금시작값","보증금종료값","월세시작값","월세종료값","면적시작값","면적종료값","준공년도시작값","준공년도종료값","방수","욕실수","세대수시작값","세대수종료값","관리비시작값","관리비종료값","용적률시작값","용적률종료값","건폐율시작값","건폐율종료값","전세가율시작값","전세가율종료값","매매전세차시작값","매매전세차종료값","월세수익률시작값","월세수익률종료값","구조","주차","엘리베이터","보안옵션","매물","융자금","옵션","점포수시작값","점포수종료값","지상층","지하층","지목","용도지역","추진현황"];

interface BboxCandidate {
  단지기본일련번호: number;
  단지명: string;
  wgs84위도: number;
  wgs84경도: number;
}

// 좌표 중심 bbox 내 아파트 단지마커 조회 (이름 무관)
async function bboxSearch(lat: number, lng: number): Promise<BboxCandidate[]> {
  const d = 0.0035; // 약 ±400m
  const body: Record<string, unknown> = {
    selectCode: "1,2,3", zoomLevel: 17,
    startLat: lat - d, startLng: lng - d, endLat: lat + d, endLng: lng + d,
    물건종류: "01", 거래유형: "1,2,3",
    분양단지구분코드: "C01", 일반분양여부: "1,0", 분양진행단계코드: "S01,S11,S12",
    webCheck: "Y", 단지묶음여부: "N",
  };
  for (const k of EMPTY_FILTER_KEYS) body[k] = "";
  let r = await kbPost<{ 단지리스트?: BboxCandidate[] }>("/land-complex/map/map250mBlwInfoList", body);
  let backoff = 5000;
  while (r.rateLimited && backoff <= 60000) {
    await sleep(backoff);
    r = await kbPost<{ 단지리스트?: BboxCandidate[] }>("/land-complex/map/map250mBlwInfoList", body);
    backoff *= 2;
  }
  return r.data?.단지리스트 ?? [];
}

// complex/main → 법정동코드 + 지번 (bbox 후보 재검증용)
async function complexAddr(complexNo: string | number): Promise<{ bubcode: string | null; jibun: string | null }> {
  const d = await kbGetRetry<any>("/land-complex/complex/main", { 단지기본일련번호: complexNo });
  if (!d) return { bubcode: null, jibun: null };
  const bon = String(d.본번지내용 ?? "").trim();
  const bu = String(d.부번지내용 ?? "").trim();
  const jibun = bon ? (bu && bu !== "0" ? `${bon}-${bu}` : bon) : null;
  return { bubcode: d.법정동코드 ?? null, jibun };
}

interface Identity {
  name: string;
  region: string;
  bjdong: string | null;
  bjd_code: string | null;
  jibun: string | null;
}

interface ComplexMatch {
  complexNo: string;
  bubcode: string | null;
  arno: string | null;
  lat: number | null;
  lng: number | null;
  dist_m: number | null;
  matched_by: string;
  kb_name: string;
}

interface KbCandidate {
  COMPLEX_NO: string;
  HSCM_NM: string;
  BUBCODE: string;
  ARNO: string;
  WGS84_LAT: string;
  WGS84_LNG: string;
}

async function searchHscm(keyword: string): Promise<KbCandidate[]> {
  const data = await kbGetRetry<{ data: { HSCM?: { data: KbCandidate[] } } }>(
    "/land-complex/serch/intgraSerch",
    { 검색설정명: "SRC_HSCM", 검색키워드: keyword, 출력갯수: 30, 페이지설정값: 1 },
  );
  return data?.data?.HSCM?.data ?? [];
}

const STRONG_SCORE = 850; // jibun 풀일치 또는 bjd+본번 → 추가 검색 불필요

// 한 후보의 매칭 점수. 채택 불가면 null.
function scoreCandidate(
  c: KbCandidate,
  id: Identity,
  centroid: { lat: number; lng: number } | null,
): { dist: number | null; by: string; score: number } | null {
  const lat = parseFloat(c.WGS84_LAT);
  const lng = parseFloat(c.WGS84_LNG);
  const dist = centroid && Number.isFinite(lat) && Number.isFinite(lng)
    ? haversine(centroid.lat, centroid.lng, lat, lng)
    : null;
  const bjdMatch = !!id.bjd_code && c.BUBCODE === id.bjd_code;
  const jibunFull = !!id.jibun && !!normJibun(c.ARNO) && normJibun(c.ARNO) === normJibun(id.jibun);
  const bonMatch = !!bonbun(id.jibun) && bonbun(c.ARNO) === bonbun(id.jibun);
  const coordOk = dist != null && dist <= 500;
  const core = normName(koreanCore(searchKeyword(id.name)));
  const kbN = normName(c.HSCM_NM);
  const nameSim = core.length >= 2 && (kbN.includes(core) || core.includes(kbN));

  // 채택: 강한 식별자 일치 또는 좌표+보조신호
  const accept =
    (bjdMatch && bonMatch) ||      // 법정동+본번
    jibunFull ||                   // 풀지번 일치 (가장 신뢰)
    (bonMatch && coordOk) ||       // 본번+좌표
    (coordOk && nameSim) ||        // 좌표+이름유사
    (dist != null && dist <= 200); // 매우 근접 (200m)
  if (!accept) return null;

  let score = 0;
  const tags: string[] = [];
  if (bjdMatch && bonMatch) { score += 1000; tags.push("bjd+jibun"); }
  else if (jibunFull) { score += 900; tags.push("jibun"); }
  else if (bjdMatch) { score += 400; tags.push("bjd"); }
  else if (bonMatch) { score += 300; tags.push("bon"); }
  if (coordOk) { score += 500 - (dist as number) / 2; tags.push("coord"); }
  if (nameSim) { score += 100; tags.push("name"); }
  return { dist, by: tags.join("+"), score };
}

// 단지 검색 + 좌표/법정동/지번 검증 매칭.
// 검색 변형: [이름+법정동, 한글코어+법정동, 이름단독]. 강매칭 나오면 조기 종료.
async function matchComplex(
  id: Identity,
  centroid: { lat: number; lng: number } | null,
): Promise<ComplexMatch | null> {
  const variants = searchKeywords(id.name, id.bjdong);

  const seen = new Set<string>();
  let best: { c: KbCandidate; dist: number | null; by: string; score: number } | null = null;

  for (const kw of variants) {
    const cands = await searchHscm(kw);
    for (const c of cands) {
      if (seen.has(c.COMPLEX_NO)) continue;
      seen.add(c.COMPLEX_NO);
      const s = scoreCandidate(c, id, centroid);
      if (s && (!best || s.score > best.score)) best = { c, ...s };
    }
    if (best && best.score >= STRONG_SCORE) break; // 충분히 강한 매칭 → 추가 검색 생략
    await sleep(300);
  }

  if (best) {
    return {
      complexNo: best.c.COMPLEX_NO,
      bubcode: best.c.BUBCODE || null,
      arno: best.c.ARNO || null,
      lat: parseFloat(best.c.WGS84_LAT) || null,
      lng: parseFloat(best.c.WGS84_LNG) || null,
      dist_m: best.dist != null ? Math.round(best.dist) : null,
      matched_by: best.by,
      kb_name: best.c.HSCM_NM,
    };
  }

  // 이름검색 실패 → 좌표 bbox fallback (KB가 단지명을 재배열/축약한 케이스).
  // 후보를 complex/main으로 법정동+지번 재검증해 오염좌표 오매칭 방지.
  if (centroid) {
    const cands = await bboxSearch(centroid.lat, centroid.lng);
    const near = cands
      .map((c) => ({ c, dist: haversine(centroid.lat, centroid.lng, c.wgs84위도, c.wgs84경도) }))
      .filter((x) => Number.isFinite(x.dist) && x.dist <= 500)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 4);
    for (const { c, dist } of near) {
      await sleep(250);
      const addr = await complexAddr(c.단지기본일련번호);
      const bjdMatch = !!id.bjd_code && addr.bubcode === id.bjd_code;
      const jibunFull = !!id.jibun && !!normJibun(addr.jibun) && normJibun(addr.jibun) === normJibun(id.jibun);
      const bonMatch = !!bonbun(id.jibun) && bonbun(addr.jibun) === bonbun(id.jibun);
      // bjd_code 있으면 법정동/풀지번 일치 필수(본번만으론 타지역 오매칭 위험), 없으면 풀지번/본번 허용
      const accept = id.bjd_code ? (bjdMatch || jibunFull) : (jibunFull || bonMatch);
      if (!accept) continue;
      return {
        complexNo: String(c.단지기본일련번호),
        bubcode: addr.bubcode,
        arno: addr.jibun,
        lat: c.wgs84위도,
        lng: c.wgs84경도,
        dist_m: Math.round(dist),
        matched_by: "bbox+" + (bjdMatch && bonMatch ? "bjd+jibun" : jibunFull ? "jibun" : bjdMatch ? "bjd" : "bon"),
        kb_name: c.단지명,
      };
    }
  }

  return null;
}

interface AreaInfo {
  면적일련번호: number;
  전용면적: string | number;
  세대수: number;
}

interface SiseRow {
  매매일반거래가?: number;
  매매상한가?: number;
  매매하한가?: number;
  전세일반거래가?: number;
  시세기준년월일?: string;
  시세제공여부?: string;
}

interface PriceEntry {
  sale: number | null;
  jeonse: number | null;
  sale_lo: number | null;
  asOf: string | null;
}

// 단지의 atype별 시세 수집. { atype: PriceEntry } 반환
async function collectComplexPrices(complexNo: string): Promise<Record<string, PriceEntry>> {
  const areas = await kbGetRetry<AreaInfo[]>("/land-complex/complex/typInfo", { 단지기본일련번호: complexNo });
  if (!Array.isArray(areas) || areas.length === 0) return {};

  // atype별로 묶고 세대수 최다 평형을 대표로
  const byAtype = new Map<string, AreaInfo[]>();
  for (const a of areas) {
    const ex = typeof a.전용면적 === "string" ? parseFloat(a.전용면적) : a.전용면적;
    if (!Number.isFinite(ex) || ex <= 0) continue;
    const at = areaType(ex);
    if (!byAtype.has(at)) byAtype.set(at, []);
    byAtype.get(at)!.push(a);
  }

  const out: Record<string, PriceEntry> = {};
  for (const [at, list] of byAtype) {
    const rep = list.sort((x, y) => (y.세대수 ?? 0) - (x.세대수 ?? 0))[0];
    await sleep(350);
    const pd = await kbGetRetry<{ 시세?: SiseRow[] }>("/land-price/price/BasePrcInfoNew", {
      단지기본일련번호: complexNo,
      면적일련번호: rep.면적일련번호,
    });
    const s = pd?.시세?.[0];
    if (!s || s.시세제공여부 !== "1") continue;
    const sale = s.매매일반거래가 && s.매매일반거래가 > 0 ? s.매매일반거래가 : null;
    const jeonse = s.전세일반거래가 && s.전세일반거래가 > 0 ? s.전세일반거래가 : null;
    if (sale == null && jeonse == null) continue;
    out[at] = {
      sale,
      jeonse,
      sale_lo: s.매매하한가 && s.매매하한가 > 0 ? s.매매하한가 : null,
      asOf: s.시세기준년월일 ? `${s.시세기준년월일.slice(0, 4)}-${s.시세기준년월일.slice(4, 6)}` : null,
    };
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const refreshPrice = args.includes("--refresh-price");
  const retryFailed = args.includes("--retry-failed"); // 매칭 실패(null) 재시도
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity;
  const onlyArg = args.indexOf("--only");
  const onlyNames = onlyArg >= 0 ? new Set<string>(JSON.parse(readFileSync(args[onlyArg + 1], "utf8"))) : null;

  const identity: Identity[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const dongCoords: Record<string, { lat: number; lng: number }[]> = existsSync(join(DATA_DIR, "dong_coords_naver.json"))
    ? await Bun.file(join(DATA_DIR, "dong_coords_naver.json")).json()
    : {};

  const idsPath = join(DATA_DIR, "kb_complex_ids.json");
  const pricePath = join(DATA_DIR, "kb_price.json");
  const ids: Record<string, ComplexMatch | null> = existsSync(idsPath) ? await Bun.file(idsPath).json() : {};
  const prices: Record<string, PriceEntry> = existsSync(pricePath) ? await Bun.file(pricePath).json() : {};

  const centroidOf = (name: string): { lat: number; lng: number } | null => {
    const dc = dongCoords[name];
    if (!Array.isArray(dc) || dc.length === 0) return null;
    return {
      lat: dc.reduce((s, c) => s + c.lat, 0) / dc.length,
      lng: dc.reduce((s, c) => s + c.lng, 0) / dc.length,
    };
  };

  let targets = identity.filter((d) => !onlyNames || onlyNames.has(d.name));
  if (retryFailed) {
    // 매칭 실패(null)만 개선된 로직으로 재시도
    targets = targets.filter((d) => ids[d.name] === null);
  } else if (!refreshPrice) {
    // 증분: 아직 검색 안 한 단지(키 부재)만. null(매칭실패)은 재검색 스킵.
    targets = targets.filter((d) => !(d.name in ids));
  }
  targets = targets.slice(0, limit);

  console.log(
    `KB시세 수집 — 대상 ${targets.length}개 (전체 ${identity.length}, 기존 매칭 ${Object.keys(ids).length}, refresh=${refreshPrice})\n`,
  );

  let matched = 0, unmatched = 0, priced = 0;
  for (let i = 0; i < targets.length; i++) {
    const id = targets[i];
    const tag = `[${i + 1}/${targets.length}] ${id.name}`;

    // 1) 매칭 (refresh-price면 기존 매칭 재사용)
    let m = ids[id.name];
    if (m === undefined || (m === null && !refreshPrice)) {
      m = await matchComplex(id, centroidOf(id.name));
      ids[id.name] = m;
      await Bun.write(idsPath, JSON.stringify(ids, null, 2));
      await sleep(400);
    }
    if (!m) { unmatched++; console.log(`${tag} → ✗ 매칭실패`); continue; }
    matched++;

    // 2) 시세 (증분: 이미 이 단지 시세 있으면 스킵, refresh면 항상)
    const hasPrice = Object.keys(prices).some((k) => k.startsWith(`${id.name}|`));
    if (hasPrice && !refreshPrice) {
      console.log(`${tag} → ${m.complexNo} (${m.matched_by}, ${m.dist_m ?? "?"}m) [시세 보유]`);
      continue;
    }
    const cp = await collectComplexPrices(m.complexNo);
    const atypes = Object.keys(cp);
    for (const at of atypes) prices[`${id.name}|${at}`] = cp[at];
    if (atypes.length > 0) priced++;
    await Bun.write(pricePath, JSON.stringify(prices, null, 2));
    console.log(`${tag} → ${m.complexNo} (${m.matched_by}, ${m.dist_m ?? "?"}m) 시세 ${atypes.length}타입`);
    await sleep(400);
  }

  await Bun.write(idsPath, JSON.stringify(ids, null, 2));
  await Bun.write(pricePath, JSON.stringify(prices, null, 2));
  console.log(
    `\n완료 — 매칭 ${matched}, 실패 ${unmatched}, 시세수집 ${priced}개 단지 | 누적 가격엔트리 ${Object.keys(prices).length}`,
  );
}

main().catch(console.error);
