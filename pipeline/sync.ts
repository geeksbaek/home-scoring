/**
 * 스코어링 결과를 iCloud Drive + GitHub Pages로 배포.
 *
 * Usage:
 *   bun src/sync.ts
 */

import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Trade, readCsv, mean, median, mode, groupBy } from "./csv";
import { isNonBusinessDay } from "./holidays";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const ICLOUD_DIR = join(
  homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
);
const PAGES_DIR = join(homedir(), "GitHub", "home-scoring");

const ICLOUD_FILES = ["apt_scoring_results.md"];

// ── 데이터 로더 ────────────────────────────────────────

async function loadJson<T>(name: string): Promise<T> {
  return Bun.file(join(DATA_DIR, name)).json();
}

async function loadJsonOpt<T>(name: string, fallback: T): Promise<T> {
  const path = join(DATA_DIR, name);
  if (!existsSync(path)) return fallback;
  return Bun.file(path).json();
}

// ── 타입 ───────────────────────────────────────────────

interface UnitTypeData {
  name: string;
  totalUnits: number;
  areaTypes: { area: number; count: number }[];
}

interface CommuteEntry {
  timestamp: string;
  weekday: string;
  direction: string;
  started?: string; // 측정 시작 "HH:MM"
  ended?: string; // 측정 종료 "HH:MM"
  results: { name: string; minutes: number; distance_km: number; at?: string }[];
}

interface SlopeEntry {
  diff_m: number;
  method: string;
  min_m?: number;
  max_m?: number;
  points?: number;
  dong_elevations?: { dong: number; elev: number }[];
}

interface PediaClinic {
  name: string;
  straight_m: number;
  road_m: number;
  walk_min: number;
}

// ── 헬퍼 ─────────────────────────────────────────────

interface Identity {
  name: string;
  kapt_code: string | null;
  hcode: string | null;
  [key: string]: any;
}

function getTypeUnits(info: UnitTypeData | null, atype: string): number | null {
  if (!info) return null;

  // K-apt 데이터는 면적 범위가 다름 (60/85/135㎡ 경계)
  // kaptMparea85 (stored as 75㎡) = 60~85㎡ → 우리 atype "59"(59~70), "74"(70~80), "84"(80~85) 모두 포함
  if (info.fromKapt) {
    // K-apt 범위 매핑: stored area → actual range
    // 50㎡ → ≤60 (includes our "59")
    // 75㎡ → 60~85 (includes our "59", "74", "84")
    // 100㎡ → 85~135 (includes our "84")
    // 150㎡ → 135+ (out of scope)
    // K-apt 범위: 50→≤60, 75→60~85, 100→85~135, 150→135+
    const kaptRanges: Record<string, string[]> = {
      "29": ["50"],
      "39": ["50"],
      "49": ["50"],
      "52": ["50"],
      "59": ["50"],
      "60": ["75"],
      "64": ["75"],
      "74": ["75"],
      "84": ["75", "100"],
      "99": ["100"],
      "104": ["100"],
      "114": ["100"],
      "124": ["100"],
      "140": ["150"],
      "160": ["150"],
      "200": ["150"],
      "230": ["150"],
    };
    const matchAreas = kaptRanges[atype] ?? [];
    let count = 0;
    for (const t of info.areaTypes) {
      const storedArea = String(Math.round(t.area));
      if (matchAreas.includes(storedArea)) count += t.count;
    }
    return count > 0 ? count : null;
  }

  // 건축물대장 등 정확한 면적 데이터
  let count = 0;
  for (const t of info.areaTypes) {
    const at = areaType(t.area);
    if (at === atype) count += t.count;
  }
  return count > 0 ? count : null;
}

function findByName<T>(
  data: Record<string, T>,
  name: string,
): T | null {
  if (name in data) return data[name];
  return null;
}

function areaType(a: number): string {
  // raw 면적 기준 bucket — 표시값(2자리)과 일관: 84.99/85.50 → "84", 59.99 → "59"
  // 부동산 표기상 84.x ~ 85.x는 모두 25평형(84타입)이라 86 미만은 "84"로 그룹화.
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
  if (a >= 64) return "64";   // 64~69
  if (a >= 60.5) return "60"; // 60.5~63 (60.0 거래는 사실 59.x raw, "59"로 묶음)
  if (a >= 57) return "59";   // 57~60.49
  if (a >= 50) return "52";   // 50~56
  if (a >= 40) return "49";
  if (a >= 30) return "39";
  return "29";
}

// ── 메인 로직 ──────────────────────────────────────────

// iCloud(com~apple~CloudDocs)가 오프라인/동기화 멈춤 상태면 해당 경로의 stat/copy가
// 무한 블록된다(동기 copyFileSync는 인터럽트 불가 → 전체 파이프라인 정지, launchd job이
// "실행 중"으로 걸려 다음 스케줄까지 막힘). 비핵심 미러링이므로 별도 `cp` 프로세스로 복사하고
// 타임아웃 시 kill → 블록된 자식은 고아(reparent)로 두고 우리 프로세스는 깨끗이 진행/종료한다.
async function copyFileTimeout(src: string, dst: string, ms: number): Promise<boolean> {
  const proc = Bun.spawn(["cp", "-f", src, dst], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  const outcome = await Promise.race([
    proc.exited.then((code) => (code === 0 ? "ok" : "fail")),
    new Promise<string>((r) => setTimeout(() => r("timeout"), ms)),
  ]);
  if (outcome !== "ok") { try { proc.kill(9); } catch {} }
  return outcome === "ok";
}

export async function sync() {
  // iCloud 미러링 (비핵심, 타임아웃 보호 — iCloud 응답 없어도 배포 진행)
  for (const name of ICLOUD_FILES) {
    const src = join(DATA_DIR, name);
    const dst = join(ICLOUD_DIR, name);
    if (!existsSync(src)) continue;
    const ok = await copyFileTimeout(src, dst, 10_000);
    console.log(ok ? `  ${name} → iCloud` : `  ⚠ iCloud 복사 건너뜀(${name}) — iCloud 무응답`);
  }

  // GitHub Pages
  if (existsSync(PAGES_DIR)) {
    await updatePages();
  }
}

async function updatePages() {
  const allTrades = await readCsv(join(DATA_DIR, "apt_trade_filtered.csv"));
  const df = allTrades.filter((r) => r.거래유형 !== "직거래" && r.층 !== 1); // 통계용 (clean)
  const dfAll = allTrades; // recent_trades용 (전체)
  const recent = df.filter((r) => r.거래일자 >= "2025-11-01");
  // recent_trades 배포 범위 — 프론트 추이 그래프 기간 토글(3/6/12개월) 대응용 12개월 롤링.
  const _now = new Date();
  const rtCutoff = `${_now.getFullYear() - 1}-${String(_now.getMonth() + 1).padStart(2, "0")}-01`;

  const identity = await loadJson<Identity[]>("apt_identity.json");
  const idMap = new Map(identity.map((d) => [d.name, d]));

  const unitTypes = await loadJsonOpt<Record<string, UnitTypeData>>("unit_types.json", {});
  const unitCounts = await loadJsonOpt<Record<string, { units?: number }>>("unit_counts.json", {});
  const commute = await loadJson<CommuteEntry[]>("commute_results.json");
  const slopes = await loadJson<Record<string, SlopeEntry>>("slope_results.json");
  const dongCoords = await loadJsonOpt<Record<string, { dong: string | number; lat: number; lng: number }[]>>("dong_coords_naver.json", {});
  const pedia = await loadJson<Record<string, PediaClinic[]>>("pediatric_clinics.json");
  const pediaSl = await loadJsonOpt<Record<string, (number | null)[]>>("pedia_slope.json", {});
  const kaptInfo = await loadJsonOpt<Record<string, any>>("kapt_info.json", {});
  const buildingInfo = await loadJsonOpt<Record<string, any>>("building_info.json", {});
  // 네이버 주차(세대당 주차대수 ground truth). {name: {total, perHh, cno} | null}
  const naverParking = await loadJsonOpt<Record<string, { total: number | null; perHh: number; cno: string } | null>>("naver_parking.json", {});
  const mgmtCost = await loadJsonOpt<Record<string, { year: number; summer: number; winter: number }>>("mgmt_cost.json", {});
  const naverComplex = await loadJsonOpt<Record<string, string>>("naver_complex_ids.json", {});
  // KB부동산 시세 (이름|atype → 만원). LTV는 min(매매가, KB시세) 기준이므로 프론트 기본값으로 사용.
  const kbPrice = await loadJsonOpt<Record<string, { sale: number | null; jeonse: number | null; sale_lo: number | null; asOf: string | null; cno?: string | null; ano?: number | null }>>("kb_price.json", {});
  const hgnnNames = await loadJsonOpt<Record<string, string>>("hgnn_names.json", {});
  const schoolMap = await loadJsonOpt<Record<string, string[]>>("school_map.json", {});
  const schoolViolenceFull = await loadJsonOpt<Record<string, Record<string, any>>>("school_violence_full.json", {});
  const safetyData = await loadJsonOpt<{ scores: Record<string, { foreign_rate: number; safety_grade: number; score: number }> }>("safety_scores.json", { scores: {} });
  const repairFund = await loadJsonOpt<Record<string, { balance_per_hh: number; levy_per_hh: number; reserve_rate: number | null; months_collected: number }>>("repair_fund.json", {});
  const maintHistory = await loadJsonOpt<Record<string, { items: any[]; summary: { totalCost: number; recentYear: string | null; elevatorRemaining: number | null; pipingRemaining: number | null; waterproofRemaining: number | null } }>>("maintenance_history.json", {});
  const auditHistory = await loadJsonOpt<Record<string, { audited: boolean; opinion: string | null; company: string | null; annualIncome: number | null; annualCost: number | null; netProfit: number | null; year: string }>>("audit_history.json", {});
  const lhOriginList = await loadJsonOpt<{ apt: string; lh_origin: boolean; has_conversion: boolean; lh_types: string[] }[]>("lh_origin.json", []);
  const lhOrigin = new Map(lhOriginList.map((e) => [e.apt, e]));
  // 가족 신호: 학교 학년별 + 동 인구
  const schoolGrade = await loadJsonOpt<Record<string, { total: number; lower3: number; lower3_rate: number }>>("school_grade.json", {});
  const dongPop = await loadJsonOpt<{
    byBjdong: Record<string, { tot: number; age0_9_rate: number; age30s_rate: number }>;
    byHjdong: Record<string, { tot: number; age0_9_rate: number; age30s_rate: number }>;
  }>("dong_pop.json", { byBjdong: {}, byHjdong: {} });
  const aptHjdong = await loadJsonOpt<Record<string, string>>("apt_hjdong.json", {});

  // 회계감사 의견 코드 → 라벨
  const auditOpinionLabel = (code: string | null): string | null => {
    if (!code) return null;
    const map: Record<string, string> = { "01": "적정", "02": "한정", "03": "부적정", "04": "의견거절" };
    return map[code] ?? code;
  };

  // ── 출퇴근 평균 (시간대별: 일찍=출근06:30/퇴근16:00, 늦게=출근08:00/퇴근18:00) ──
  // 측정 시각(hour)으로 슬롯을 분류한다. sleep 후 catch-up이 엉뚱한 시각에 실행되면
  // 윈도우 밖이라 자동 배제 → "06:30 출근" 버킷에 10시 측정값이 섞이지 않음.
  // 레거시 데이터(06시/16시)는 slot 필드 없이도 hour로 자동 early 분류.
  interface CommuteDetail { date: string; weekday: string; minutes: number; time: string; }
  type CommuteSlot = "early" | "late";

  const inSlotWindow = (dir: string, slot: CommuteSlot, hour: number): boolean =>
    dir === "출근"
      ? slot === "early" ? hour >= 6 && hour <= 7 : hour >= 8 && hour <= 9
      : slot === "early" ? hour >= 15 && hour <= 16 : hour >= 17 && hour <= 19;

  // 방향+슬롯 단위 집계: 날짜별 평균으로 중복 제거 후 단지별 평균/건수/상세 반환
  function aggregateCommute(dirTarget: "출근" | "퇴근", slot: CommuteSlot) {
    const all = new Map<string, number[]>();
    const byDate = new Map<string, Map<string, { weekday: string; values: number[]; times: string[] }>>();
    for (const e of commute) {
      if (!["월", "화", "수", "목", "금"].includes(e.weekday)) continue;
      // 평일이어도 공휴일(지방선거일·대체공휴일 등)은 교통 패턴이 달라 제외
      if (isNonBusinessDay(new Date(e.timestamp.split(" ")[0] + "T00:00:00"))) continue;
      if ((e.direction ?? "출근") !== dirTarget) continue;
      const hour = parseInt(e.timestamp.split(" ")[1].split(":")[0]);
      if (!inSlotWindow(dirTarget, slot, hour)) continue;
      const date = e.timestamp.split(" ")[0];
      for (const r of e.results) {
        if (!all.has(r.name)) all.set(r.name, []);
        all.get(r.name)!.push(r.minutes);
        if (!byDate.has(r.name)) byDate.set(r.name, new Map());
        const dm = byDate.get(r.name)!;
        if (!dm.has(date)) dm.set(date, { weekday: e.weekday, values: [], times: [] });
        const entry = dm.get(date)!;
        entry.values.push(r.minutes);
        // 개별 단지 실제 측정 시각(at) 우선, 없으면(구 데이터) batch 시작 시각
        entry.times.push(r.at ?? e.timestamp.split(" ")[1]);
      }
    }
    const details = new Map<string, CommuteDetail[]>();
    for (const [name, dm] of byDate) {
      const ds: CommuteDetail[] = [];
      for (const [date, { weekday, values, times }] of dm) {
        ds.push({ date, weekday, minutes: Math.round(values.reduce((a, b) => a + b, 0) / values.length), time: times[0] });
      }
      ds.sort((a, b) => a.date.localeCompare(b.date));
      details.set(name, ds);
    }
    const avg = new Map<string, number>();
    const cnt = new Map<string, number>();
    for (const [n, v] of all) { avg.set(n, Math.round(mean(v))); cnt.set(n, v.length); }
    return { avg, cnt, details };
  }

  const mEarly = aggregateCommute("출근", "early");
  const eEarly = aggregateCommute("퇴근", "early");
  const mLate = aggregateCommute("출근", "late");
  const eLate = aggregateCommute("퇴근", "late");

  // ── 스코어링 ────────────────────────────────────────

  // area type 할당
  const recentTyped = recent.map((r) => ({
    ...r,
    at: areaType(r.전용면적),
  }));
  const dfTyped = df.map((r) => ({
    ...r,
    at: areaType(r.전용면적),
  }));
  const dfAllTyped = dfAll.map((r) => ({
    ...r,
    at: areaType(r.전용면적),
  }));

  const oneMonthAgo = new Date(Date.now() - 30 * 86400_000);
  const oneMonthCutoff = `${oneMonthAgo.getFullYear()}-${String(oneMonthAgo.getMonth() + 1).padStart(2, "0")}-${String(oneMonthAgo.getDate()).padStart(2, "0")}`;

  const grouped = groupBy(recentTyped, (r) => `${r.단지명}\t${r.at}`);
  const results: any[] = [];

  for (const [key, g] of grouped) {
    const [n, atype] = key.split("\t");

    // 통계 계산 (필터 없이 전부 포함, 프론트엔드에서 동적 필터링)
    const g1m = g.filter((r) => r.거래일자 >= oneMonthCutoff);
    const avg = g1m.length > 0 ? mean(g1m.map((r) => r.금액_만원)) : mean(g.map((r) => r.금액_만원));

    const cnt = g.length;

    const full = dfTyped.filter((r) => r.단지명 === n && r.at === atype);
    const r3 = full.filter((r) => r.거래일자 >= "2026-02-01").map((r) => r.금액_만원);
    const p3 = full
      .filter((r) => r.거래일자 >= "2025-11-01" && r.거래일자 < "2026-02-01")
      .map((r) => r.금액_만원);
    if (r3.length < 1) continue; // 현재가는 필수 (최근 거래 1건 이상)

    const dong = mode(full.map((r) => r.법정동));

    // 세대수
    const inf = unitTypes[n] ?? null;
    const totalUnits = inf?.totalUnits ?? unitCounts[`${n}|${dong}`]?.units ?? null;

    const bld = mode(full.map((r) => r.건축년도));

    const r3Avg = Math.round(mean(r3));
    const p3Avg = p3.length > 0 ? Math.round(mean(p3)) : null;
    const acc = p3Avg != null ? ((r3Avg - p3Avg) / p3Avg) * 100 : null;
    const av = Math.round(median(full.map((r) => r.전용면적)) * 100) / 100;
    const reg = full[0].지역명;

    const tu = getTypeUnits(inf, atype);
    const liq = tu && tu > 0 ? (cnt / tu) * 100 : null;

    const se = findByName(slopes, n);
    const sl = se?.diff_m ?? null;
    const sm = se?.method ?? "";
    const seDongs = se?.dong_elevations ?? [];
    const pc = findByName(pedia, n);
    const p1 = pc?.[0]?.walk_min ?? null;
    const p1n = pc?.[0]?.name ?? null;
    const p2 = pc?.[1]?.walk_min ?? null;
    const p2n = pc?.[1]?.name ?? null;
    const ps = pediaSl[n] ?? [null, null];

    // 아파트 중심 좌표 (동별 좌표 평균)
    const dc = dongCoords[n];
    let aptLat: number | null = null;
    let aptLng: number | null = null;
    if (Array.isArray(dc) && dc.length > 0) {
      aptLat = Math.round((dc.reduce((s, c) => s + c.lat, 0) / dc.length) * 100000) / 100000;
      aptLng = Math.round((dc.reduce((s, c) => s + c.lng, 0) / dc.length) * 100000) / 100000;
    }

    // 최근 거래 내역 — 직거래/1층 포함 전체 (플래그로 구분)
    const fullAll = dfAllTyped.filter((r) => r.단지명 === n && r.at === atype);
    const rtRows = fullAll
      .filter((r) => r.거래일자 >= rtCutoff)
      .sort((a, b) => (b.거래일자 > a.거래일자 ? 1 : -1));
    const rt = rtRows.map((r) => ({
      date: r.거래일자.slice(0, 10),
      price: Math.round((r.금액_만원 / 10000) * 10) / 10,
      floor: r.층 || null,
      area: Math.round(r.전용면적 * 100) / 100,
      direct: r.거래유형 === "직거래" || undefined,
    }));

    // 장기 추이 — 월별 중앙값(억 1자리)+건수, clean 거래(full) 전 기간, 비어있는 달 제외.
    // [yyyymm, 억, 건수] 압축 배열. 프론트 장기 가격추이 차트 + 월별 시세 표용.
    const ltMap = new Map<string, number[]>();
    for (const r of full) {
      const ym = r.거래일자.slice(0, 7);
      let arr = ltMap.get(ym);
      if (!arr) { arr = []; ltMap.set(ym, arr); }
      arr.push(r.금액_만원);
    }
    const long_trend: [number, number, number][] = [...ltMap.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([ym, arr]) => {
        const s = arr.slice().sort((x, y) => x - y);
        const md = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
        return [Number(ym.replace("-", "")), Math.round((md / 10000) * 10) / 10, arr.length];
      });

    // 주차대수 — 건축물대장 우선. 단 건축물대장이 세대당 1대 미만(과소집계 의심)인데
    // K-apt가 현실범위(1.0~2.0대/세대)면 K-apt로 교정. 멀티단지 분할로 K-apt 합산주차가
    // 분할세대수에 나뉘어 과대(>2.0)가 되는 경우는 채택 안 함(진짜 구축 저값도 보존).
    // (네이버 주차값이 있으면 아래에서 최우선 사용.)
    const bestParking = (() => {
      const bp = buildingInfo[n]?.parking;
      const kp = kaptInfo[n]?.parkingTotal;
      let best = bp != null && bp > 0 ? bp : (kp ?? null);
      const hh = kaptInfo[n]?.households ?? buildingInfo[n]?.hhldCnt;
      if (best != null && hh && hh > 0 && kp && kp > best) {
        const bpph = best / hh, kpph = kp / hh;
        if (bpph < 1.0 && kpph >= 1.0 && kpph <= 2.0) best = kp;
      }
      return best;
    })();
    // 네이버 주차 — perHh>0일 때만 유효(0은 네이버 '데이터 없음' sentinel → fallback)
    const npRaw = naverParking[n];
    const naverPark = npRaw && npRaw.perHh > 0 ? npRaw : null;

    results.push({
      name: n,
      display_name: hgnnNames[n] ?? n,
      atype,
      area: av,
      avg: Math.round(avg),
      accel: acc != null ? Math.round(acc * 10) / 10 : null,
      r3_avg: r3Avg,
      p3_avg: p3Avg,
      count: cnt,
      build: bld,
      region: reg,
      dong,
      liquidity: liq != null ? Math.round(liq * 10) / 10 : null,
      type_units: tu,
      morning: mEarly.avg.get(n) ?? null,
      evening: eEarly.avg.get(n) ?? null,
      morning_cnt: mEarly.cnt.get(n) ?? 0,
      evening_cnt: eEarly.cnt.get(n) ?? 0,
      morning_details: mEarly.details.get(n) ?? [],
      evening_details: eEarly.details.get(n) ?? [],
      morning_late: mLate.avg.get(n) ?? null,
      evening_late: eLate.avg.get(n) ?? null,
      morning_late_cnt: mLate.cnt.get(n) ?? 0,
      evening_late_cnt: eLate.cnt.get(n) ?? 0,
      morning_late_details: mLate.details.get(n) ?? [],
      evening_late_details: eLate.details.get(n) ?? [],
      slope: sl != null ? Math.round(sl * 10) / 10 : null,
      slope_method: sm,
      slope_dongs: seDongs,
      lat: aptLat,
      lng: aptLng,
      pedia1: p1,
      pedia1_name: p1n,
      pedia1_slope: ps[0] ?? null,
      pedia2: p2,
      pedia2_name: p2n,
      pedia2_slope: ps[1] ?? null,
      hcode: idMap.get(n)?.hcode ?? null,
      recent_trades: rt,
      long_trend,
      // 주차 — 네이버 세대당 주차대수 최우선(올바른 단지별 세대수로 계산, 과소집계·구축 모두 정확).
      // 네이버 없으면 건축물대장·K-apt(과소집계 교정 bestParking) fallback.
      parking: naverPark?.total ?? bestParking,
      parking_per_hh: (() => {
        if (naverPark) return naverPark.perHh;
        const hh = kaptInfo[n]?.households ?? buildingInfo[n]?.hhldCnt;
        if (bestParking != null && hh && hh > 0) return Math.round((bestParking / hh) * 100) / 100;
        return kaptInfo[n]?.parkingPerHh ?? null;
      })(),
      parking_src: naverPark ? "naver" : (buildingInfo[n]?.parking > 0 ? "building" : (kaptInfo[n]?.parkingTotal ? "kapt" : null)),
      elevator: kaptInfo[n]?.elevatorCount ?? null,
      households: kaptInfo[n]?.households ?? buildingInfo[n]?.hhldCnt ?? unitTypes[n]?.totalUnits ?? null,
      dong_count: kaptInfo[n]?.dongCount ?? null,
      top_floor: kaptInfo[n]?.topFloor ?? null,
      heat_type: kaptInfo[n]?.heatType ?? null,
      structure: kaptInfo[n]?.structure ?? null,
      cctv: kaptInfo[n]?.cctvCount ?? null,
      doro_juso: kaptInfo[n]?.doroJuso ?? null,
      use_date: kaptInfo[n]?.useDate ?? null,
      repair_fund: kaptInfo[n]?.repairFund ?? null,
      subway_line: kaptInfo[n]?.subwayLine ?? null,
      subway_station: kaptInfo[n]?.subwayStation ?? null,
      education: kaptInfo[n]?.education ?? null,
      energy: kaptInfo[n]?.energy ?? null,
      // 관리비 (만원/세대/월 — V2 API에서 세대당 금액으로 수집됨)
      mgmt_cost: mgmtCost[n]?.year ?? null,
      mgmt_summer: mgmtCost[n]?.summer ?? null,
      mgmt_winter: mgmtCost[n]?.winter ?? null,
      // 지도
      naver_place_id: idMap.get(n)?.naver_place_id ?? null,
      naver_complex_id: naverComplex[n] ?? null,
      // KB부동산 시세 (만원) — PricePopover LTV 기본값
      kb_sale: kbPrice[`${n}|${atype}`]?.sale ?? null,
      kb_jeonse: kbPrice[`${n}|${atype}`]?.jeonse ?? null,
      kb_as_of: kbPrice[`${n}|${atype}`]?.asOf ?? null,
      kb_cno: kbPrice[`${n}|${atype}`]?.cno ?? null, // 런타임 실시간 시세 조회용
      kb_ano: kbPrice[`${n}|${atype}`]?.ano ?? null,
      pyeong_type_nos: null as number[] | null, // 후처리에서 채움
      // 건축물대장
      eq_design: buildingInfo[n]?.earthquakeDesign ?? null,
      eq_capacity: buildingInfo[n]?.earthquakeCapacity ?? null,
      energy_grade: buildingInfo[n]?.energyGrade ?? null,
      vl_rat: buildingInfo[n]?.vlRat ?? null,
      bc_rat: buildingInfo[n]?.bcRat ?? null,
      land_share: (buildingInfo[n]?.platArea && buildingInfo[n]?.hhldCnt)
        ? Math.round((buildingInfo[n].platArea / buildingInfo[n].hhldCnt) * 10) / 10
        : null,
      // 배정 초등학교
      schools: schoolMap[n] ?? [],
      // 학교폭력 데이터는 별도 파일(school_violence.json)로 분리. 클라이언트에서 학교명 키로 inline 매핑.
      // (이전엔 단지마다 복제되어 8MB 차지. 학교 5000개 × ~400B = 2MB로 감소 + 참조 공유)
      // 치안 점수
      safety_score: safetyData.scores[reg]?.score ?? null,
      foreign_rate: safetyData.scores[reg]?.foreign_rate ?? null,
      foreign_count: safetyData.scores[reg]?.foreign_count ?? null,
      safety_grade: safetyData.scores[reg]?.safety_grade ?? null,
      safety_grade_label: safetyData.scores[reg]?.grade_label ?? null,
      safety_population: safetyData.scores[reg]?.population ?? null,
      // 장기수선충당금
      repair_balance: repairFund[n]?.balance_per_hh ?? null,
      repair_levy: repairFund[n]?.levy_per_hh ?? null,
      repair_reserve_rate: repairFund[n]?.reserve_rate ?? null,
      // 유지관리 이력 (요약값만)
      maint_count: maintHistory[n]?.items?.length ?? null,
      maint_recent: maintHistory[n]?.summary?.recentYear ?? null,
      maint_elevator_remaining: maintHistory[n]?.summary?.elevatorRemaining ?? null,
      maint_piping_remaining: maintHistory[n]?.summary?.pipingRemaining ?? null,
      maint_waterproof_remaining: maintHistory[n]?.summary?.waterproofRemaining ?? null,
      // 회계감사
      audit_year: auditHistory[n]?.year ?? null,
      audit_done: auditHistory[n]?.audited ?? null,
      audit_opinion: auditOpinionLabel(auditHistory[n]?.opinion ?? null),
      audit_net_profit: auditHistory[n]?.netProfit ?? null,
      // LH 분양전환
      lh_origin: lhOrigin.get(n)?.lh_origin ?? false,
      lh_has_conversion: lhOrigin.get(n)?.has_conversion ?? false,
      lh_types: lhOrigin.get(n)?.lh_types ?? [],
      // 가족 비중 신호
      school_lower3_rate: (() => {
        const sn = (schoolMap[n] ?? [])[0];
        return sn ? schoolGrade[sn]?.lower3_rate ?? null : null;
      })(),
      school_total: (() => {
        const sn = (schoolMap[n] ?? [])[0];
        return sn ? schoolGrade[sn]?.total ?? null : null;
      })(),
      dong_age0_9_rate: (() => {
        const bj = idMap.get(n)?.bjdong;
        const v = bj ? dongPop.byBjdong[bj] : null;
        if (v) return v.age0_9_rate;
        const hj = aptHjdong[n];
        return hj ? dongPop.byHjdong[hj]?.age0_9_rate ?? null : null;
      })(),
      dong_age30s_rate: (() => {
        const bj = idMap.get(n)?.bjdong;
        const v = bj ? dongPop.byBjdong[bj] : null;
        if (v) return v.age30s_rate;
        const hj = aptHjdong[n];
        return hj ? dongPop.byHjdong[hj]?.age30s_rate ?? null : null;
      })(),
      dong_pop_total: (() => {
        const bj = idMap.get(n)?.bjdong;
        const v = bj ? dongPop.byBjdong[bj] : null;
        if (v) return v.tot;
        const hj = aptHjdong[n];
        return hj ? dongPop.byHjdong[hj]?.tot ?? null : null;
      })(),
    });
  }

  // ── 거래 없는 atype도 ghost row로 추가 (AllTypesDialog에서 전체 평형 보여주기용) ──
  // unit_types에 등록된 area 중 r3 거래 없는 atype 버킷에 대해 빈 row 생성.
  const existingByName = new Map<string, Set<string>>();
  for (const r of results) {
    if (!existingByName.has(r.name)) existingByName.set(r.name, new Set());
    existingByName.get(r.name)!.add(r.atype);
  }
  for (const [n, info] of Object.entries(unitTypes)) {
    if ((info as any).fromKapt) continue; // K-apt 데이터는 atype 버킷 부정확
    const existing = existingByName.get(n);
    if (!existing) continue; // 단지 자체가 results에 없음 (r3 거래 0건 단지) → 표 미노출이므로 스킵
    // atype별 areaTypes 그룹화
    const byAtype = new Map<string, { area: number; count: number }[]>();
    for (const t of (info as any).areaTypes ?? []) {
      const at = areaType(t.area);
      if (!byAtype.has(at)) byAtype.set(at, []);
      byAtype.get(at)!.push(t);
    }
    const baseRow = results.find((r) => r.name === n)!;
    for (const [at, ts] of byAtype) {
      if (existing.has(at)) continue; // 이미 거래 있는 atype
      // 대표 area = 가장 세대수 많은 평형
      const rep = ts.sort((a, b) => b.count - a.count)[0];
      const tu = ts.reduce((s, t) => s + t.count, 0);
      results.push({
        ...baseRow,
        atype: at,
        area: Math.round(rep.area * 100) / 100,
        avg: 0,
        accel: null,
        r3_avg: null,
        p3_avg: null,
        count: 0,
        liquidity: null,
        type_units: tu,
        recent_trades: [],
        long_trend: [],
        pyeong_type_nos: null,
        // KB시세는 ghost row의 atype 기준으로 재조회 (baseRow의 값 덮어쓰기)
        kb_sale: kbPrice[`${n}|${at}`]?.sale ?? null,
        kb_jeonse: kbPrice[`${n}|${at}`]?.jeonse ?? null,
        kb_as_of: kbPrice[`${n}|${at}`]?.asOf ?? null,
        kb_cno: kbPrice[`${n}|${at}`]?.cno ?? null,
        kb_ano: kbPrice[`${n}|${at}`]?.ano ?? null,
        no_trades: true,
      } as any);
    }
  }

  // articlePyeongTypeNumbers: 네이버페이 부동산의 평면형 번호 (실제 raw 면적 단위, 1-based 오름차순).
  // 한 단지에 84.7/84.96/84.97/84.98/84.99 같은 평면형이 있으면 각각 다른 번호.
  // row는 atype 버킷 단위로 묶이므로, 그 버킷에 포함된 모든 평면형 번호를 배열로 보낸다.
  const aptAreas = new Map<string, Set<number>>();
  for (const r of results) {
    if (!aptAreas.has(r.name)) aptAreas.set(r.name, new Set());
    const set = aptAreas.get(r.name)!;
    for (const t of r.recent_trades ?? []) set.add(t.area);
    set.add(r.area);
  }
  // 단지 내 모든 거래 + 건축물대장 평면형까지 포함 (직거래/1층도 포함해야 네이버 평면형 번호와 일치)
  for (const r of dfAllTyped) {
    const set = aptAreas.get(r.단지명);
    if (set) set.add(Math.round(r.전용면적 * 100) / 100);
  }
  for (const [name, info] of Object.entries(unitTypes)) {
    const set = aptAreas.get(name);
    if (!set) continue;
    if ((info as any).fromKapt) continue; // K-apt 데이터는 면적 부정확
    for (const t of (info as any).areaTypes ?? []) {
      set.add(Math.round(t.area * 100) / 100);
    }
  }
  const aptAreaIndex = new Map<string, Map<number, number>>();
  for (const [name, areas] of aptAreas) {
    const sorted = [...areas].sort((a, b) => a - b);
    const idx = new Map<number, number>();
    sorted.forEach((a, i) => idx.set(a, i + 1));
    aptAreaIndex.set(name, idx);
  }
  for (const r of results) {
    const idxMap = aptAreaIndex.get(r.name);
    if (!idxMap) { r.pyeong_type_nos = null; continue; }
    const nos = new Set<number>();
    for (const t of r.recent_trades ?? []) {
      if (areaType(t.area) === r.atype) {
        const i = idxMap.get(t.area);
        if (i) nos.add(i);
      }
    }
    // 거래 없어도 atype 버킷에 속하는 모든 평면형 포함
    for (const [area, i] of idxMap) {
      if (areaType(area) === r.atype) nos.add(i);
    }
    r.pyeong_type_nos = nos.size > 0 ? [...nos].sort((a, b) => a - b) : null;
  }

  // 광역 단위 분할 (data-seoul.json + data-gyeonggi.json + data-index.json)
  // 합본 data.json은 100MB 초과로 GitHub 차단 → 제거.
  const shardDefs: { key: string; label: string; match: (r: any) => boolean }[] = [
    { key: "seoul", label: "서울특별시", match: (r) => (r.region || "").startsWith("서울") },
    { key: "gyeonggi", label: "경기도", match: (r) => !(r.region || "").startsWith("서울") },
  ];
  const shardSummary: { key: string; label: string; url: string; count: number; region_prefixes: string[] }[] = [];
  for (const sd of shardDefs) {
    const subset = results.filter(sd.match);
    const prefixes = [...new Set(subset.map((r: any) => (r.region || "").split(" ")[0]).filter(Boolean))].sort();
    const fname = `data-${sd.key}.json`;
    // minify (no indent) — 50% 크기 절감 + gzip 효과 충분
    await Bun.write(join(PAGES_DIR, "public", fname), JSON.stringify(subset));
    shardSummary.push({ key: sd.key, label: sd.label, url: fname, count: subset.length, region_prefixes: prefixes });
    console.log(`  ${fname} → ${subset.length}개 단지 (${prefixes.join(", ")})`);
  }
  const indexPath = join(PAGES_DIR, "public", "data-index.json");
  await Bun.write(indexPath, JSON.stringify({ shards: shardSummary, generatedAt: new Date().toISOString() }, null, 2));

  // 기존 100MB+ data.json이 git에 남아있으면 push 실패 → 제거
  const oldDataJson = join(PAGES_DIR, "public", "data.json");
  if (existsSync(oldDataJson)) {
    try { Bun.spawnSync(["rm", "-f", oldDataJson]); } catch {}
  }

  // multicultural.json 복사
  const mcSrc = join(DATA_DIR, "multicultural.json");
  if (existsSync(mcSrc)) {
    copyFileSync(mcSrc, join(PAGES_DIR, "public", "multicultural.json"));
  }

  // school_ids.json 복사
  const sidSrc = join(DATA_DIR, "school_ids.json");
  if (existsSync(sidSrc)) {
    copyFileSync(sidSrc, join(PAGES_DIR, "public", "school_ids.json"));
  }

  // school_violence.json 분리 (단지 row에서 제외, 학교명 키로 참조 공유). minify.
  const svSrc = join(DATA_DIR, "school_violence_full.json");
  if (existsSync(svSrc)) {
    const svFull = await Bun.file(svSrc).json();
    // 실제 사용되는 학교(school_map에 등장)만 추출하여 더 가볍게
    const usedSchools = new Set<string>();
    for (const arr of Object.values(schoolMap)) for (const s of (arr as string[])) usedSchools.add(s);
    const svFiltered: Record<string, any> = {};
    for (const [k, v] of Object.entries(svFull)) if (usedSchools.has(k)) svFiltered[k] = v;
    await Bun.write(join(PAGES_DIR, "public", "school_violence.json"), JSON.stringify(svFiltered));
  }

  // 검증용 — shard만 생성하고 배포 스킵
  if (process.argv.includes("--no-deploy")) {
    console.log("  → --no-deploy: shard만 생성, 배포 스킵");
    return;
  }

  // 로컬 빌드 + gh-pages 브랜치 직접 배포
  const gitOpts = { cwd: PAGES_DIR };
  // main 브랜치는 가벼움 유지: 큰 data 파일들은 gh-pages에만 배포.
  // --cached: index에서만 제거, working tree 파일은 유지 (vite build가 dist로 복사해야 함)
  Bun.spawnSync(["git", "rm", "--cached", "-f", "--ignore-unmatch", "public/data.json", "public/data-seoul.json", "public/data-gyeonggi.json", "public/data-index.json"], gitOpts);
  const diff = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], gitOpts);
  if (diff.exitCode !== 0) {
    // main에 소스 커밋 + push
    Bun.spawnSync(["git", "commit", "-m", "Update scoring data"], gitOpts);
    Bun.spawnSync(["git", "push"], gitOpts);
  }

  // 항상 로컬 빌드 → gh-pages 배포
  const build = Bun.spawnSync(["bun", "run", "build"], gitOpts);
  if (build.exitCode !== 0) {
    console.error("  ✗ 빌드 실패");
    return;
  }
  const distDir = join(PAGES_DIR, "dist");
  // dist/ 내용을 gh-pages 브랜치로 push
  const r1 = Bun.spawnSync(["git", "init"], { cwd: distDir });
  Bun.spawnSync(["git", "add", "-A"], { cwd: distDir });
  Bun.spawnSync(["git", "commit", "-m", "Deploy"], { cwd: distDir });
  const pushResult = Bun.spawnSync(
    ["git", "push", "-f", `https://github.com/geeksbaek/home-scoring.git`, "HEAD:gh-pages"],
    { cwd: distDir },
  );
  // dist/.git 정리
  Bun.spawnSync(["rm", "-rf", join(distDir, ".git")]);
  if (pushResult.exitCode === 0) {
    console.log("  → GitHub Pages (gh-pages branch)");
  } else {
    console.error("  ✗ gh-pages push 실패");
  }
}

// 직접 실행 시
if (import.meta.main) {
  sync();
}
