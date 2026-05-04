export interface AptData {
  name: string;
  display_name: string;
  atype: string;
  area: number;
  avg: number;
  accel: number;
  r3_avg: number;
  p3_avg: number;
  count: number;
  build: number;
  region: string;
  dong: string;
  liquidity: number | null;
  liq_approx?: boolean;
  morning: number | null;
  evening: number | null;
  morning_cnt: number;
  evening_cnt: number;
  morning_details: { date: string; weekday: string; minutes: number; time?: string }[];
  evening_details: { date: string; weekday: string; minutes: number; time?: string }[];
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
  recent_trades: { date: string; price: number; floor: number | null; area: number }[];
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
  // 네이버
  naver_place_id: string | null;
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
  school_violence: Record<string, { s1: number; s2: number; total: number; types?: { s1: number[]; s2: number[] }; victims?: number[]; perps?: number[] }>;
  // computed
  score: number;
  pedScore: number | null;
  commuteScore: number | null;
}

export function pedScore(d: AptData): number | null {
  if (!d.pedia1) return null;
  const adj1 = d.pedia1 + Math.abs(d.pedia1_slope ?? 0) * 0.2;
  if (!d.pedia2) return Math.round(adj1 * 10) / 10;
  const adj2 = d.pedia2 + Math.abs(d.pedia2_slope ?? 0) * 0.2;
  return Math.round(((adj1 + adj2) / 2) * 10) / 10;
}

export function commuteScore(d: AptData): number | null {
  if (!d.morning && !d.evening) return null;
  const m = d.morning ?? d.evening!;
  const e = d.evening ?? d.morning!;
  return Math.round((m + e) / 2);
}

export function calcScores(data: AptData[]) {
  const n = data.length;
  if (n === 0) return;
  const rank = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return arr.map((v) => (sorted.indexOf(v) + 1) / n);
  };
  const accels = rank(data.map((d) => d.accel));
  const liqs = rank(data.map((d) => d.liquidity ?? 0));
  const builds = rank(data.map((d) => d.build));
  data.forEach((d, i) => {
    d.score = Math.round((accels[i] * 35 + liqs[i] * 25 + builds[i] * 20) * 10) / 10;
  });
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
