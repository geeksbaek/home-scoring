export interface AptData {
  name: string;
  display_name: string;
  atype: string;
  area: number;
  avg: number;
  accel: number | null;
  accel_tau?: number | null; // 상승 일관성 (Kendall tau, ∈[-1,1])
  r3_avg: number;
  p3_avg: number | null;
  count: number;
  build: number;
  region: string;
  dong: string;
  liquidity: number | null;
  liq_approx?: boolean;
  type_units: number | null; // 해당 면적타입 세대수
  // 출퇴근 — 일찍(출근06:30/퇴근16:00)
  morning: number | null;
  evening: number | null;
  morning_cnt: number;
  evening_cnt: number;
  morning_details: { date: string; weekday: string; minutes: number; time?: string }[];
  evening_details: { date: string; weekday: string; minutes: number; time?: string }[];
  // 출퇴근 — 늦게(출근08:00/퇴근18:00). 신규 측정 누적 전까지 null/빈 배열.
  morning_late: number | null;
  evening_late: number | null;
  morning_late_cnt: number;
  evening_late_cnt: number;
  morning_late_details: { date: string; weekday: string; minutes: number; time?: string }[];
  evening_late_details: { date: string; weekday: string; minutes: number; time?: string }[];
  slope: number | null;
  slope_method: string;
  slope_dongs: { dong: number; elev: number }[];
  pedia1: number | null;
  pedia1_name: string | null;
  pedia1_slope: number | null;
  pedia2: number | null;
  pedia2_name: string | null;
  pedia2_slope: number | null;
  hcode: string | null;
  recent_trades: { date: string; price: number; floor: number | null; area: number; direct?: boolean }[];
  long_trend?: [number, number, number][]; // 장기 추이: [yyyymm, 억, 건수] 월별 중앙값 (전 기간)
  // K-apt
  parking: number | null;
  parking_per_hh: number | null;
  elevator: number | null;
  households: number | null;
  dong_count: number | null;
  top_floor: number | null;
  heat_type: string | null;
  structure: string | null;
  cctv: number | null;
  doro_juso: string | null;
  use_date: string | null;
  repair_fund: number | null;
  subway_line: string | null;
  subway_station: string | null;
  education: string | null;
  energy: { heat: number; waterHot: number; elect: number; waterCool: number; gas: number } | null;
  // 지도
  naver_place_id: string | null;
  naver_complex_id: string | null;
  pyeong_type_nos: number[] | null;
  // KB부동산 시세 (만원) — PricePopover LTV 기본값
  kb_sale?: number | null;
  kb_jeonse?: number | null;
  kb_as_of?: string | null;
  kb_cno?: string | null; // 단지기본일련번호 (런타임 실시간 시세 조회용)
  kb_ano?: number | null; // 대표 면적일련번호
  // 관리비 (만원/월)
  mgmt_cost: number | null;
  mgmt_summer: number | null;
  mgmt_winter: number | null;
  // 건축물대장
  eq_design: boolean | null;
  eq_capacity: string | null;
  energy_grade: string | null;
  // 배정 초등학교
  schools: string[];
  school_violence: Record<string, Record<string, any>>; // school → year → { cases, types, vp, ps, sped }
  // 좌표
  lat: number | null;
  lng: number | null;
  // 치안
  safety_score: number | null;
  foreign_rate: number | null;
  foreign_count: number | null;
  safety_grade: number | null;
  safety_grade_label: string | null;
  safety_population: number | null;
  // 장기수선충당금
  repair_balance: number | null; // 세대당 적립금 (만원)
  repair_levy: number | null; // 세대당 월 부과액 (원)
  repair_reserve_rate: number | null; // 적립요율 (%)
  // 건축물 제원
  vl_rat: number | null; // 용적률 (%)
  bc_rat: number | null; // 건폐율 (%)
  land_share: number | null; // 대지지분 (㎡/세대)
  // 유지관리 이력
  maint_count: number | null;
  maint_recent: string | null;
  maint_elevator_remaining: number | null;
  maint_piping_remaining: number | null;
  maint_waterproof_remaining: number | null;
  // 회계감사
  audit_year: string | null;
  audit_done: boolean | null;
  audit_opinion: string | null;
  audit_net_profit: number | null;
  // LH 분양전환 정보
  lh_origin: boolean;
  lh_has_conversion: boolean;
  lh_types: string[];
  // 가족 비중 추정 신호
  school_lower3_rate: number | null;  // 배정초 1~3학년/전체 (%)
  school_total: number | null;        // 배정초 전체 학생수
  dong_age0_9_rate: number | null;    // 행정동 0~9세 비율 (%)
  dong_age30s_rate: number | null;    // 행정동 30대 비율 (%)
  dong_pop_total: number | null;      // 행정동 인구
  // r3 거래가 없는 atype (AllTypesDialog 표시용 ghost row)
  no_trades?: boolean;
  // computed
  score: number;
  pedScore: number | null;
  commuteScore: number | null;
}

export function pedScore(d: AptData): number | null {
  if (!d.pedia1) return null;
  // 가장 가까운 소아과 1개만 기준 (고저차 패널티 0.2 가중)
  return Math.round((d.pedia1 + Math.abs(d.pedia1_slope ?? 0) * 0.2) * 10) / 10;
}

export type CommuteSlot = "early" | "late";

// 선택 슬롯의 출근/퇴근 평균·상세를 꺼낸다. late 필드가 없는 구버전 데이터는 null/빈배열.
export function commuteValues(d: AptData, slot: CommuteSlot = "early") {
  if (slot === "late") {
    return {
      morning: d.morning_late ?? null,
      evening: d.evening_late ?? null,
      morning_details: d.morning_late_details ?? [],
      evening_details: d.evening_late_details ?? [],
    };
  }
  return {
    morning: d.morning,
    evening: d.evening,
    morning_details: d.morning_details ?? [],
    evening_details: d.evening_details ?? [],
  };
}

export function commuteScore(d: AptData, slot: CommuteSlot = "early"): number | null {
  const { morning, evening } = commuteValues(d, slot);
  if (!morning && !evening) return null;
  const m = morning ?? evening!;
  const e = evening ?? morning!;
  return Math.round((m + e) / 2);
}

export interface ScoreWeights {
  accel: number;
  liquidity: number;
  build: number;
  commute: number;
  pedia: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = { accel: 35, liquidity: 25, build: 20, commute: 10, pedia: 10 };

export function calcScores(data: AptData[], weights: ScoreWeights = DEFAULT_WEIGHTS) {
  // ghost row(no_trades)는 거래/가속도 등이 없어 점수 무의미 → 제외
  const live = data.filter((d) => !d.no_trades);
  const n = live.length;
  if (n === 0) return;
  // 값 → 정렬 후 최초 등장 인덱스. 동점은 동일 순위(기존 indexOf 동작과 일치).
  // 기존: arr.map(v => sorted.indexOf(v)) = O(n²) → n≈16000에서 수 초 freeze.
  // 개선: 최초 인덱스를 Map에 1회 적재 → O(n log n).
  const rank = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const firstIdx = new Map<number, number>();
    for (let i = 0; i < sorted.length; i++) {
      if (!firstIdx.has(sorted[i])) firstIdx.set(sorted[i], i);
    }
    return arr.map((v) => (firstIdx.get(v)! + 1) / n);
  };
  const accels = rank(live.map((d) => d.accel ?? 0));
  const liqs = rank(live.map((d) => d.liquidity ?? 0));
  const builds = rank(live.map((d) => d.build));
  const commutes = rank(live.map((d) => -(d.commuteScore ?? 999)));
  const peds = rank(live.map((d) => -(d.pedScore ?? 999)));
  live.forEach((d, i) => {
    d.score = Math.round((accels[i] * weights.accel + liqs[i] * weights.liquidity + builds[i] * weights.build + commutes[i] * weights.commute + peds[i] * weights.pedia) * 10) / 10;
  });
  for (const d of data) {
    if (d.no_trades) d.score = 0;
  }
}

export type Label = { text: string; variant: "default" | "success" | "warning" | "destructive" };

export function commuteLabel(v: number | null): Label {
  if (v == null) return { text: "-", variant: "default" };
  if (v <= 20) return { text: "매우좋음", variant: "success" };
  if (v <= 30) return { text: "좋음", variant: "success" };
  if (v <= 40) return { text: "보통", variant: "default" };
  if (v <= 50) return { text: "나쁨", variant: "warning" };
  return { text: "매우나쁨", variant: "destructive" };
}

export function pedLabel(v: number | null): Label {
  if (v == null) return { text: "-", variant: "default" };
  if (v <= 6) return { text: "매우좋음", variant: "success" };
  if (v <= 10) return { text: "좋음", variant: "success" };
  if (v <= 15) return { text: "보통", variant: "default" };
  if (v <= 20) return { text: "나쁨", variant: "warning" };
  return { text: "매우나쁨", variant: "destructive" };
}

export function liquidityLabel(v: number | null): Label {
  if (v == null) return { text: "-", variant: "default" };
  if (v >= 7) return { text: `${v}%`, variant: "success" };
  if (v >= 4) return { text: `${v}%`, variant: "default" };
  if (v >= 2) return { text: `${v}%`, variant: "warning" };
  return { text: `${v}%`, variant: "destructive" };
}

export function mgmtCostLabel(v: number | null): Label {
  if (v == null) return { text: "-", variant: "default" };
  if (v <= 25) return { text: `${v}만`, variant: "success" };
  if (v <= 30) return { text: `${v}만`, variant: "default" };
  if (v <= 35) return { text: `${v}만`, variant: "warning" };
  return { text: `${v}만`, variant: "destructive" };
}

export function parkingLabel(v: number | null): Label {
  if (v == null) return { text: "-", variant: "default" };
  if (v >= 1.3) return { text: `${v}대`, variant: "success" };
  if (v >= 1.2) return { text: `${v}대`, variant: "default" };
  if (v >= 1.1) return { text: `${v}대`, variant: "warning" };
  return { text: `${v}대`, variant: "destructive" };
}

// 세대당 주차대수 → 등급 텍스트
export function parkingGrade(v: number | null): string {
  if (v == null) return "-";
  if (v >= 1.3) return "넉넉";
  if (v >= 1.2) return "보통";
  if (v >= 1.1) return "부족";
  return "매우부족";
}

export function safetyLabel(grade: number | null): Label {
  if (grade == null) return { text: "-", variant: "default" };
  if (grade <= 1) return { text: `${grade}등급`, variant: "success" };
  if (grade <= 2) return { text: `${grade}등급`, variant: "success" };
  if (grade <= 3) return { text: `${grade}등급`, variant: "default" };
  if (grade <= 4) return { text: `${grade}등급`, variant: "warning" };
  return { text: `${grade}등급`, variant: "destructive" };
}

export function naverMapUrl(placeId: string | null, query: string, isMobile: boolean): string {
  if (placeId) {
    return isMobile
      ? `nmap://place?id=${placeId}&appname=com.nhn.NaverMap`
      : `https://map.naver.com/v5/entry/place/${placeId}`;
  }
  return isMobile
    ? `nmap://search?query=${encodeURIComponent(query)}&appname=com.nhn.NaverMap`
    : `https://map.naver.com/v5/search/${encodeURIComponent(query)}`;
}

export function naverLandUrl(complexId: string, isMobile: boolean, pyeongTypeNos: number[] | null = null): string {
  // 네이버페이 부동산 (리뉴얼) — 매물 탭, 매매, 가격 오름차순
  const params = new URLSearchParams({
    articleSortingType: "PRICE_ASC",
    articleTradeTypes: "A1",
    tab: "article",
    transactionTradeType: "A1",
  });
  if (pyeongTypeNos && pyeongTypeNos.length > 0) {
    params.set("articlePyeongTypeNumbers", pyeongTypeNos.join("-"));
  }
  const web = `https://fin.land.naver.com/complexes/${complexId}?${params.toString()}`;
  return isMobile
    ? `naversearchapp://inappbrowser?url=${encodeURIComponent(web)}&target=new&version=6`
    : web;
}

export function naverArticleUrl(articleNo: string, isMobile: boolean): string {
  // 네이버페이 부동산 매물 상세 (articleNo → 상세 레이어로 리다이렉트)
  const web = `https://fin.land.naver.com/articles/${articleNo}`;
  return isMobile
    ? `naversearchapp://inappbrowser?url=${encodeURIComponent(web)}&target=new&version=6`
    : web;
}

export function naverLandSearchUrl(query: string, isMobile: boolean): string {
  const web = `https://fin.land.naver.com/search?query=${encodeURIComponent(query)}`;
  return isMobile
    ? `naversearchapp://inappbrowser?url=${encodeURIComponent(web)}&target=new&version=6`
    : web;
}
