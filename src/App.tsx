import React, { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  type AptData, pedScore, commuteScore, commuteValues, type CommuteSlot, calcScores, DEFAULT_WEIGHTS, type ScoreWeights,
  commuteLabel, pedLabel, parkingLabel, liquidityLabel, safetyLabel, naverMapUrl, naverLandUrl, naverArticleUrl, naverLandSearchUrl, type Label,
} from "@/lib/scoring";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fetchKbLivePrice, type KbLivePrice } from "@/lib/kbLivePrice";
import { getProxyUrl, setProxyUrl, getProxyToken, setProxyToken, useColumnListings, articlesForAtype, isMovableBy, isTenant, isOwnerJeonse, moveInLabel, formatWon, formatArticlePrice, formatConfirm, verifyLabel, type NaverArticle } from "@/lib/useNaverArticles";
import { ChevronDown } from "lucide-react";
import { lazy, Suspense } from "react";
const AptMap = lazy(() => import("@/components/AptMap"));
const MolitPressViewer = lazy(() => import("@/components/MolitPressViewer"));

const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);

function atypeBadgeColor(atype: string): string {
  const m: Record<string, string> = {
    "230": "bg-fuchsia-500/10 text-fuchsia-500 border-fuchsia-500/20",
    "200": "bg-purple-500/10 text-purple-500 border-purple-500/20",
    "160": "bg-violet-500/10 text-violet-500 border-violet-500/20",
    "140": "bg-indigo-500/10 text-indigo-500 border-indigo-500/20",
    "124": "bg-blue-500/10 text-blue-500 border-blue-500/20",
    "114": "bg-sky-500/10 text-sky-500 border-sky-500/20",
    "104": "bg-cyan-500/10 text-cyan-500 border-cyan-500/20",
    "99": "bg-teal-500/10 text-teal-500 border-teal-500/20",
    "84": "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
    "74": "bg-lime-500/10 text-lime-500 border-lime-500/20",
    "64": "bg-amber-500/10 text-amber-500 border-amber-500/20",
    "60": "bg-amber-300/10 text-amber-300 border-amber-300/20",
    "59": "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
    "52": "bg-yellow-300/10 text-yellow-300 border-yellow-300/20",
    "49": "bg-orange-500/10 text-orange-500 border-orange-500/20",
    "39": "bg-red-500/10 text-red-500 border-red-500/20",
    "29": "bg-rose-500/10 text-rose-500 border-rose-500/20",
  };
  return m[atype] ?? "bg-muted text-muted-foreground border-border";
}

function atypeLabel(atype: string): string {
  const m: Record<string, string> = {
    "large": "대형 전체",
    "medium": "중형 전체",
    "small": "소형 전체",
    "230": "220㎡+",
    "200": "180~219㎡",
    "160": "150~179㎡",
    "140": "130~149㎡",
    "124": "120~129㎡",
    "114": "110~119㎡",
    "104": "100~109㎡",
    "99": "85~99㎡",
    "84": "80~84㎡",
    "74": "70~79㎡",
    "64": "64~69㎡",
    "60": "60~63㎡",
    "59": "57~59㎡",
    "52": "50~56㎡",
    "49": "40~49㎡",
    "39": "30~39㎡",
    "29": "~29㎡",
  };
  return m[atype] ?? `${atype}㎡`;
}

// 면적 그룹: 84 초과=대형, 84=중형, 84 미만=소형
const ATYPES_LARGE = ["230", "200", "160", "140", "124", "114", "104", "99"];
const ATYPES_MEDIUM = ["84"];
const ATYPES_SMALL = ["74", "64", "60", "59", "52", "49", "39", "29"];

function atypeMatchesFilter(atype: string, filter: string): boolean {
  if (filter === "large") return ATYPES_LARGE.includes(atype);
  if (filter === "medium") return ATYPES_MEDIUM.includes(atype);
  if (filter === "small") return ATYPES_SMALL.includes(atype);
  return atype === filter;
}

function LabelBadge({ label }: { label: Label }) {
  if (label.text === "-") return <span className="text-muted-foreground">-</span>;
  const colors: Record<string, string> = {
    success: "bg-emerald-500/15 text-emerald-500 border-emerald-500/20",
    warning: "bg-amber-500/15 text-amber-500 border-amber-500/20",
    destructive: "bg-red-500/15 text-red-500 border-red-500/20",
    default: "bg-muted text-muted-foreground border-border",
  };
  return <Badge variant="outline" className={cn("text-xs font-medium", colors[label.variant])}>{label.text}</Badge>;
}

function LabelText({ label }: { label: Label }) {
  if (label.text === "-") return <span className="text-muted-foreground">-</span>;
  const colors: Record<string, string> = {
    success: "text-emerald-500",
    warning: "text-amber-500",
    destructive: "text-red-500",
    default: "text-muted-foreground",
  };
  return <span className={cn("text-xs font-medium", colors[label.variant])}>{label.text}</span>;
}

function AccelBadge({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">-</span>;
  const cls = value > 5 ? "text-emerald-500" : value < 0 ? "text-red-500" : "text-foreground";
  return <span className={cn("font-medium", cls)}>{value > 0 ? "+" : ""}{value}%</span>;
}

const median = (arr: number[]): number => {
  const n = arr.length;
  if (!n) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

// 가속도 — 가격 vs 시간 Theil-Sen 회귀(쌍별 기울기 중앙값)로 강건 추세 추정.
// 한 row가 같은 atype 버킷이라 면적이 사실상 동일(편차 중앙값 0%) → ㎡정규화 불필요.
// 중앙값 기반이라 이상치(급매/고층) 면역, 실제 거래일 연속 사용(중간점 절벽 제거).
// 결과는 기존과 동일한 스케일 유지를 위해 '선택기간 절반(halfMonths) 동안의 %변화'로 환산.
function robustAccel(
  trades: { date: string; price: number }[],
  windowMonths: number,
): number | null {
  const pts = trades
    .filter((t) => t.price > 0)
    .map((t) => ({ x: Date.parse(t.date) / 86400000, y: t.price })) // x: 일(day), y: 억
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return null;
  const base = median(pts.map((p) => p.y)); // 가격 중앙값 (억)
  if (!(base > 0)) return null;
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x;
      if (dx !== 0) slopes.push((pts[j].y - pts[i].y) / dx); // 억 per day
    }
  if (!slopes.length) return null; // 모든 거래가 같은 날 → 시간 분산 없음
  const halfDays = (windowMonths / 2) * 30.44;
  return Math.round(((median(slopes) * halfDays) / base) * 100 * 10) / 10;
}

function Sparkline({ data, pctRange }: { data: { date: string; price: number }[]; pctRange: number }) {
  const [hover, setHover] = useState<{ x: number; date: string; price: number } | null>(null);
  if (!data.length) return null;
  const prices = data.map((d) => d.price);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const min = mean * (1 - pctRange);
  const max = mean * (1 + pctRange);
  const range = max - min || 1;
  const w = 80, h = 24, pad = 2;
  const pts = data.map((d, i) => ({
    x: pad + (i / Math.max(data.length - 1, 1)) * (w - pad * 2),
    y: h - pad - ((d.price - min) / range) * (h - pad * 2),
    date: d.date,
    price: d.price,
  }));
  const points = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const last = prices[prices.length - 1];
  const first = prices[0];
  const color = last >= first ? "#4ade80" : "#f87171";
  return (
    <div className="relative inline-block">
      <svg width={w} height={h} onMouseLeave={() => setHover(null)}>
        <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={4} fill="transparent" stroke="none"
            onMouseEnter={() => setHover({ x: p.x, date: p.date, price: p.price })} />
        ))}
        {hover && (
          <circle cx={pts.find(p => p.date === hover.date)?.x} cy={pts.find(p => p.date === hover.date)?.y} r={2.5} fill={color} />
        )}
      </svg>
      {hover && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-1.5 py-0.5 bg-popover border rounded shadow text-[10px] whitespace-nowrap z-50 pointer-events-none">
          {hover.date.slice(2).replace(/-/g, ".")} <span className="font-medium">{hover.price}억</span>
        </div>
      )}
    </div>
  );
}

function CommutePopover({ data, slot = "early" }: { data: AptData; slot?: CommuteSlot }) {
  const label = commuteLabel(commuteScore(data, slot));
  const cv = commuteValues(data, slot);
  const slotLabel = slot === "late" ? "늦게 · 출근08:00/퇴근18:00" : "일찍 · 출근06:30/퇴근16:00";
  const color = (m: number) =>
    m <= 30 ? "text-emerald-500" : m <= 40 ? "text-foreground" : m <= 50 ? "text-amber-500" : "text-red-500";

  // 날짜별 출퇴근 병합
  const dayMap = new Map<string, { date: string; weekday: string; morning?: number; morningTime?: string; evening?: number; eveningTime?: string }>();
  for (const t of cv.morning_details ?? []) {
    const key = t.date;
    if (!dayMap.has(key)) dayMap.set(key, { date: t.date, weekday: t.weekday });
    const e = dayMap.get(key)!;
    e.morning = t.minutes;
    e.morningTime = t.time;
  }
  for (const t of cv.evening_details ?? []) {
    const key = t.date;
    if (!dayMap.has(key)) dayMap.set(key, { date: t.date, weekday: t.weekday });
    const e = dayMap.get(key)!;
    e.evening = t.minutes;
    e.eveningTime = t.time;
  }
  const days = [...dayMap.values()].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <Popover>
      <PopoverTrigger><span className="cursor-pointer"><LabelBadge label={label} /></span></PopoverTrigger>
      <PopoverContent className="w-64 text-xs">
        <p className="font-semibold mb-0.5">출퇴근 상세 (판교)</p>
        <p className="text-muted-foreground text-[10px] mb-2">{slotLabel}</p>
        <div className="flex justify-between mb-2">
          <span className="text-muted-foreground">출근 평균</span><span className={color(cv.morning ?? 99)}>{cv.morning ? `${cv.morning}분` : "-"}</span>
          <span className="text-muted-foreground ml-3">퇴근 평균</span><span className={color(cv.evening ?? 99)}>{cv.evening ? `${cv.evening}분` : "-"}</span>
        </div>
        {days.length > 0 && (
          <table className="w-full border-t border-border/50">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left py-1 font-normal">날짜</th>
                <th className="text-right py-1 font-normal">출근</th>
                <th className="text-right py-1 font-normal">퇴근</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date} className="border-t border-border/30">
                  <td className="py-0.5 text-muted-foreground">{d.date.slice(5)} ({d.weekday})</td>
                  <td className={cn("text-right py-0.5", d.morning ? color(d.morning) : "text-muted-foreground")}>
                    {d.morning ? <span>{d.morning}분{d.morningTime && <span className="text-muted-foreground text-[10px] ml-1">{d.morningTime}</span>}</span> : "-"}
                  </td>
                  <td className={cn("text-right py-0.5", d.evening ? color(d.evening) : "text-muted-foreground")}>
                    {d.evening ? <span>{d.evening}분{d.eveningTime && <span className="text-muted-foreground text-[10px] ml-1">{d.eveningTime}</span>}</span> : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(data.subway_line || data.subway_station) && (
          <div className="mt-2 pt-2 border-t">
            <div className="flex justify-between"><span className="text-muted-foreground">지하철</span><span>{[data.subway_line, data.subway_station].filter(Boolean).join(" ")}</span></div>
          </div>
        )}
        <p className="mt-2 pt-2 border-t text-muted-foreground text-[10px]">점수 = (출근 + 퇴근) / 2</p>
      </PopoverContent>
    </Popover>
  );
}

function PedPopover({ data }: { data: AptData }) {
  const label = pedLabel(data.pedScore);
  const sc = (v: number | null) =>
    v == null ? "" : Math.abs(v) >= 10 ? "text-red-500" : Math.abs(v) >= 5 ? "text-amber-500" : "text-emerald-500";
  return (
    <Popover>
      <PopoverTrigger><span className="cursor-pointer"><LabelBadge label={label} /></span></PopoverTrigger>
      <PopoverContent className="w-56 text-xs">
        <p className="font-semibold mb-2">소아과 상세</p>
        {data.pedia1_name && (<><p className="text-muted-foreground">1. {data.pedia1_name}</p>
          <div className="flex justify-between"><span className="text-muted-foreground">도보</span><span>{data.pedia1}분 {data.pedia1_slope != null && <span className={sc(data.pedia1_slope)}>{data.pedia1_slope > 0 ? "+" : ""}{data.pedia1_slope}m</span>}</span></div></>)}
        {data.pedia2_name && (<div className="mt-1"><p className="text-muted-foreground">2. {data.pedia2_name}</p>
          <div className="flex justify-between"><span className="text-muted-foreground">도보</span><span>{data.pedia2}분 {data.pedia2_slope != null && <span className={sc(data.pedia2_slope)}>{data.pedia2_slope > 0 ? "+" : ""}{data.pedia2_slope}m</span>}</span></div></div>)}
        <p className="mt-2 pt-2 border-t text-muted-foreground text-[10px]">점수 = 평균도보 + |고저차|×0.2</p>
      </PopoverContent>
    </Popover>
  );
}

// 연봉(만원) → 월 실수령액(만원) — cosmosfarm 간이세액표 기반 보간
const NET_TABLE: [number, number][] = [
  [2000, 155], [2500, 195], [3000, 234], [3500, 272], [4000, 311],
  [4500, 340], [5000, 357], [5500, 389], [6000, 420], [6500, 452],
  [7000, 483], [7500, 512], [8000, 540], [8500, 569], [9000, 598],
  [9500, 628], [10000, 657], [11000, 714], [12000, 770], [13000, 821],
  [14000, 856], [15000, 898],
];
function calcNetMonthly(annualMan: number): number {
  if (annualMan <= 0) return 0;
  if (annualMan <= NET_TABLE[0][0]) return Math.round(annualMan / NET_TABLE[0][0] * NET_TABLE[0][1]);
  for (let i = 1; i < NET_TABLE.length; i++) {
    if (annualMan <= NET_TABLE[i][0]) {
      const [x0, y0] = NET_TABLE[i - 1];
      const [x1, y1] = NET_TABLE[i];
      return Math.round(y0 + (y1 - y0) * (annualMan - x0) / (x1 - x0));
    }
  }
  // 15000 초과: 마지막 구간 기울기로 외삽
  const [x0, y0] = NET_TABLE[NET_TABLE.length - 2];
  const [x1, y1] = NET_TABLE[NET_TABLE.length - 1];
  const slope = (y1 - y0) / (x1 - x0);
  return Math.round(y1 + slope * (annualMan - x1));
}

function calcDsrMaxLoan(incomeMan: number, existDebtMan: number, existRate = 0.055, rate = 0.045, years = 30): number {
  const monthlyRate = rate / 12;
  const months = years * 12;
  const existInterest = existDebtMan * existRate; // 기존대출 연 이자
  const maxAnnualRepay = incomeMan * 0.4 - existInterest; // DSR 40%
  if (maxAnnualRepay <= 0) return 0;
  const monthlyRepay = maxAnnualRepay / 12;
  // 원리금균등: loan = payment * ((1 - (1+r)^-n) / r)
  const factor = (1 - Math.pow(1 + monthlyRate, -months)) / monthlyRate;
  return Math.round(monthlyRepay * factor);
}

// 규제지역: 서울 전 25구(투기과열·조정대상), 성남(분당/수정/중원), 수원(영통/장안/팔달), 용인 수지, 하남
const REGULATED_REGIONS = new Set([
  // 서울 25구 전체
  "서울특별시 종로구", "서울특별시 중구", "서울특별시 용산구", "서울특별시 성동구",
  "서울특별시 광진구", "서울특별시 동대문구", "서울특별시 중랑구", "서울특별시 성북구",
  "서울특별시 강북구", "서울특별시 도봉구", "서울특별시 노원구", "서울특별시 은평구",
  "서울특별시 서대문구", "서울특별시 마포구", "서울특별시 양천구", "서울특별시 강서구",
  "서울특별시 구로구", "서울특별시 금천구", "서울특별시 영등포구", "서울특별시 동작구",
  "서울특별시 관악구", "서울특별시 서초구", "서울특별시 강남구", "서울특별시 송파구",
  "서울특별시 강동구",
  // 경기 주요
  "성남시 분당구", "성남시 수정구", "성남시 중원구",
  "수원시 영통구", "수원시 장안구", "수원시 팔달구",
  "용인시 수지구", "하남시",
]);

// 사내 이자지원 (주택구입 매매대출): 본인 2% 부담, 초과분 회사 지원
// 기본적으로 일반 주담대 대상. 정책상품의 경우 특정 은행에서만 가능:
// 신한은행 신생아특례 / SC제일은행 u-보금자리(특례보금자리론).
// 한도: 매매가 50% / 최대 15,000만원
const SUBSIDY_USER_RATE = 0.02;
const SUBSIDY_MAX_AMOUNT = 15000; // 만원
const SUBSIDY_LTV = 0.5;

// 정책상품 정의 (2025-2026 기준, 부부합산 소득 기준)
// 디딤돌: HUG 디딤돌대출 (생애최초 한정 우대)
// 보금자리: 한국주택금융공사 보금자리론 (특례 종료, u-보금자리 신설)
// 신생아특례: 2024-01 시행 → 2025-04 소득상한 2.5억 확대 (한시)
type LoanProduct = "normal" | "didimdol" | "bogeumjari" | "newborn";
const LOAN_PRODUCTS: Record<LoanProduct, {
  name: string;
  rate: number;
  maxLoan: number; // 최대 대출 한도 (만원). 0 = 없음
  maxPrice: number; // 주택가격 한도 (만원). 0 = 없음
  maxIncome: number; // 부부합산 소득 한도 (만원). 0 = 없음
  maxAreaSqm: number; // 전용면적 한도 (㎡). 0 = 없음
  forceLtv?: number; // LTV 강제 (정책상품)
  desc: string;
}> = {
  normal: { name: "일반 주담대", rate: 0.045, maxLoan: 0, maxPrice: 0, maxIncome: 0, maxAreaSqm: 0, desc: "은행 자체상품, 시장금리" },
  // 디딤돌 (2025): 부부합산 8.5천 (신혼·2자녀 1억), 주택 5억(수도권 6억), 한도 일반 2.5억/신혼 4억/2자녀 4억/신생아 4억
  didimdol: { name: "디딤돌 (생애최초)", rate: 0.032, maxLoan: 40000, maxPrice: 60000, maxIncome: 8500, maxAreaSqm: 85, forceLtv: 0.7, desc: "부부합산 8.5천(신혼/자녀 1억), 한도 신혼 4억" },
  // 보금자리: 2024 종료 → u-보금자리 (디딤돌 흡수) → 일반 보금자리 한도 3.6억, 생애최초 4.2억, 부부합산 7천(신혼 8.5천), 주택 6억
  bogeumjari: { name: "u-보금자리 (생애최초)", rate: 0.044, maxLoan: 42000, maxPrice: 60000, maxIncome: 7000, maxAreaSqm: 0, forceLtv: 0.7, desc: "부부합산 7천(신혼 8.5천), LTV 70%, 4.2억" },
  // 신생아특례 (2024-01 시행): 부부합산 1.3억 → 2025-04부터 한시 2.5억 상향
  // 2년 내 출산 가구, 9억 이하 주택, 전용 85㎡ 이하 (수도권), 한도 4억(2025-06-27부터 5억→4억 축소)
  // rate: 표시용 기본값 — 실제 적용 금리는 getNewbornRate(소득·만기·맞벌이) 사용
  newborn: { name: "신생아특례 (출산 2년 내)", rate: 0.026, maxLoan: 40000, maxPrice: 90000, maxIncome: 25000, maxAreaSqm: 85, forceLtv: 0.8, desc: "부부합산 2.5억(맞벌이), 9억·85㎡ 이하, 한도 4억, 금리 1.8~4.5% (소득·만기별)" },
};

// 신생아 특례 디딤돌 금리표 (2026-05 기준, myhome.go.kr)
// 부부합산 소득(만원) × 만기(10/15/20/30년) — 기본 5년 적용, 우대금리 별도
function getNewbornRate(incomeMan: number, years: number, dualIncome: boolean): number {
  const termIdx = years <= 10 ? 0 : years <= 15 ? 1 : years <= 20 ? 2 : 3;
  const brackets: Array<{ upper: number; dualOnly?: boolean; rates: [number, number, number, number] }> = [
    { upper: 2000,  rates: [0.0180, 0.0190, 0.0200, 0.0205] },
    { upper: 4000,  rates: [0.0215, 0.0225, 0.0235, 0.0240] },
    { upper: 6000,  rates: [0.0240, 0.0250, 0.0260, 0.0265] },
    { upper: 8500,  rates: [0.0265, 0.0275, 0.0285, 0.0290] },
    { upper: 13000, rates: [0.0290, 0.0300, 0.0310, 0.0320] },
    { upper: 15000, dualOnly: true, rates: [0.0350, 0.0360, 0.0370, 0.0380] },
    { upper: 17000, dualOnly: true, rates: [0.0385, 0.0395, 0.0405, 0.0415] },
    { upper: 20000, dualOnly: true, rates: [0.0420, 0.0430, 0.0440, 0.0450] },
  ];
  for (const b of brackets) {
    if (incomeMan <= b.upper) {
      if (b.dualOnly && !dualIncome) return LOAN_PRODUCTS.normal.rate; // 외벌이 1.3억 초과 → 자격 미달
      return b.rates[termIdx];
    }
  }
  return LOAN_PRODUCTS.normal.rate; // 2억 초과
}

function calcAffordability(priceMan: number, capitalMan: number, extraLoanLimit: number, income1Man: number, income2Man: number, years: number, extraRepayYrs: number, areaSqm?: number, firstTimeBuyer: boolean = true, regulated: boolean = false, product: LoanProduct = "normal", interestSubsidy: boolean = false, interiorCost: number = 0, kbPriceMan: number | null = null) {
  const incomeMan = income1Man + income2Man;
  // 취득세율: 6억 이하 1%, 6~9억 누진, 9억 초과 3%
  let taxRate: number;
  if (priceMan <= 60000) taxRate = 0.01;
  else if (priceMan <= 90000) taxRate = (priceMan * 2 / 30000 - 3) / 100;
  else taxRate = 0.03;
  const acqTax = Math.round(priceMan * taxRate); // 취득세
  const eduTax = Math.round(acqTax * 0.1); // 지방교육세 10%
  const ruralTax = (areaSqm ?? 0) > 85 ? Math.round(acqTax * 0.2) : 0; // 농어촌특별세 20% (85㎡ 초과만)
  const totalTax = acqTax + eduTax + ruralTax;
  const taxExempt = firstTimeBuyer ? 200 : 0; // 생애최초 감면 200만원
  const netTax = Math.max(0, totalTax - taxExempt);

  // 중개보수 (0.4% + VAT 10%)
  let brokerRate: number;
  if (priceMan <= 5000) brokerRate = 0.006;
  else if (priceMan <= 20000) brokerRate = 0.005;
  else if (priceMan <= 90000) brokerRate = 0.004;
  else if (priceMan <= 120000) brokerRate = 0.005;
  else brokerRate = 0.006;
  const broker = Math.round(priceMan * brokerRate * 1.1);

  // 법무사 비용 (등기대행, 매매가 구간별 추정)
  const legalFee = priceMan <= 50000 ? 50 : priceMan <= 100000 ? 70 : 90; // 만원

  // 인지세 (1억~10억: 15만원)
  const stampTax = priceMan >= 10000 ? 15 : 0; // 만원

  // 국민주택채권 매입 할인손 (85㎡ 이하: 13/1000, 초과: 26/1000, 할인율 약 6%)
  const bondRate = (areaSqm ?? 0) > 85 ? 0.026 : 0.013;
  const bondDiscount = Math.round(priceMan * bondRate * 0.06); // 만원

  // 기타 부대비용 합계
  const miscCost = legalFee + stampTax + bondDiscount;

  // LTV: 규제지역 vs 비규제지역 (2026 정책)
  // 규제: 생애최초 70%, 일반 40%, cap 6억 (15억초과→4억, 25억초과→2억)
  // 비규제: 생애최초/일반 모두 70%, cap 6억
  const prodInfo = LOAN_PRODUCTS[product];
  // 정책상품 LTV: 규제지역 진입 시 70% 상한 적용 (신생아특례 80% → 70% 등)
  const ltvRate = prodInfo.forceLtv != null
    ? (regulated ? Math.min(prodInfo.forceLtv, 0.7) : prodInfo.forceLtv)
    : regulated
      ? (firstTimeBuyer ? 0.7 : 0.4)
      : 0.7; // 비규제: 생초·일반 모두 70%
  // KB시세 입력 시 LTV는 min(매매가, KB시세) 기준 (은행 실무)
  const ltvBase = kbPriceMan != null && kbPriceMan > 0 ? Math.min(priceMan, kbPriceMan) : priceMan;
  const ltvCalc = Math.round(ltvBase * ltvRate);
  let ltvCap = 60000; // 기본 6억 (비규제·규제 15억 이하 동일)
  if (regulated) {
    if (ltvBase > 250000) ltvCap = 20000;
    else if (ltvBase > 150000) ltvCap = 40000;
  }
  // 정책상품 절대 한도
  const productCap = prodInfo.maxLoan > 0 ? prodInfo.maxLoan : Infinity;
  // 정책상품 자격 미달 검증
  const eligIssues: string[] = [];
  if (prodInfo.maxPrice > 0 && priceMan > prodInfo.maxPrice) eligIssues.push(`주택가격 ${prodInfo.maxPrice / 10000}억 초과`);
  if (prodInfo.maxIncome > 0 && incomeMan > prodInfo.maxIncome) eligIssues.push(`소득 ${prodInfo.maxIncome / 10000}억 초과`);
  if (prodInfo.maxAreaSqm > 0 && (areaSqm ?? 0) > prodInfo.maxAreaSqm) eligIssues.push(`전용 ${prodInfo.maxAreaSqm}㎡ 초과`);
  const ltvMax = Math.min(ltvCalc, ltvCap, productCap);
  // 추가대출 없이 먼저 필요자금 계산
  const dsrMaxNone = incomeMan && incomeMan > 0 ? calcDsrMaxLoan(incomeMan, 0, 0.055, 0.045, Math.min(years, 40)) : null;
  const maxLoanBase = dsrMaxNone != null ? Math.min(ltvMax, dsrMaxNone) : ltvMax;
  // 인테리어는 주담대 LTV 대상이 아님 → 자본금/추가대출로만 처리
  const shortfall = Math.max(0, priceMan + netTax + broker + miscCost + interiorCost - maxLoanBase - capitalMan);

  // 실제 추가대출 = 모자란 금액, 한도 이내
  const extraLoanMan = Math.min(shortfall, extraLoanLimit);

  // DSR 기반 한도 (실제 추가대출 반영)
  const dsrMax = incomeMan && incomeMan > 0 ? calcDsrMaxLoan(incomeMan, extraLoanMan, 0.055, 0.045, Math.min(years, 40)) : null;
  const maxLoan = dsrMax != null ? Math.min(ltvMax, dsrMax) : ltvMax;
  const dsrLimited = dsrMax != null && dsrMax < ltvMax;

  // 총 자본금 = 보유자본 + 실제 추가대출
  const totalCapital = capitalMan + extraLoanMan;

  // 필요자금
  const required = priceMan + netTax + broker + miscCost + interiorCost - maxLoan;
  const affordable = totalCapital >= required;

  // 월납입금/이자총액
  const mortgageRate = product === "newborn"
    ? getNewbornRate(incomeMan, years, income1Man > 0 && income2Man > 0)
    : prodInfo.rate; // 상품별 금리
  const extraRate = 0.055; // 추가/신용대출 5.5%
  const months = years * 12;
  const mr = mortgageRate / 12;
  const grossMortgageMonthly = maxLoan > 0 ? Math.round(maxLoan * mr / (1 - Math.pow(1 + mr, -months))) : 0;

  // 사내 이자지원: min(잔액, 1.5억) × (mortgageRate - 2%) 매월 지원.
  // LTV 50% 제약 = 매매가의 50% 까지만 지원금 한도로 인정.
  const subsidyEligible = interestSubsidy;
  const subsidyAmount = subsidyEligible
    ? Math.min(maxLoan, Math.floor(priceMan * SUBSIDY_LTV), SUBSIDY_MAX_AMOUNT)
    : 0;
  const subsidyDiffRate = Math.max(0, mortgageRate - SUBSIDY_USER_RATE);
  // amortization 시뮬: 매월 잔액 추적 → 잔액이 1.5억 밑으로 가면 그만큼만 보조
  let subsidyTotal = 0;
  if (subsidyAmount > 0 && grossMortgageMonthly > 0) {
    const subsidyMr = subsidyDiffRate / 12;
    let bal = maxLoan;
    for (let m = 0; m < months; m++) {
      const base = Math.min(bal, subsidyAmount);
      subsidyTotal += base * subsidyMr;
      const interest = bal * mr;
      const principal = grossMortgageMonthly - interest;
      bal -= principal;
      if (bal < 0) bal = 0;
    }
  }
  subsidyTotal = Math.round(subsidyTotal);
  const subsidyMonthly = months > 0 ? Math.round(subsidyTotal / months) : 0;
  const mortgageMonthly = Math.max(0, grossMortgageMonthly - subsidyMonthly);
  const mortgageTotalInterest = maxLoan > 0 ? grossMortgageMonthly * months - maxLoan - subsidyTotal : 0;
  // 표시용 effective rate (총 지원액 / (원금 × 연수)로 근사한 본인 평균 금리)
  const effectiveRate = subsidyAmount > 0 && maxLoan > 0 && years > 0
    ? Math.max(0, mortgageRate - subsidyTotal / (maxLoan * years))
    : mortgageRate;

  const extraMonthly = Math.round(extraLoanMan * extraRate / 12); // 추가 이자만
  const totalMonthly = mortgageMonthly + extraMonthly;
  const totalInterest = mortgageTotalInterest + extraLoanMan * extraRate * years;

  // 추가 상환 시뮬레이션 (원리금균등)
  const er = extraRate / 12;
  const extraRepayMonths = extraRepayYrs * 12;
  const extraRepayMonthly = extraLoanMan > 0 && extraRepayMonths > 0 ? Math.round(extraLoanMan * er / (1 - Math.pow(1 + er, -extraRepayMonths))) : 0;

  // 건전성 (세후 실수령 기준)
  const net1 = calcNetMonthly(income1Man);
  const net2 = calcNetMonthly(income2Man);
  const netMonthlyIncome = (income1Man + income2Man) > 0 ? net1 + net2 : null;
  const netMonthlyParental = (income1Man + income2Man) > 0 ? Math.max(net1, net2) : null; // 육아휴직: 고소득자 1인만
  const repayRatio = netMonthlyIncome ? totalMonthly / netMonthlyIncome : null;
  const repayRatioParental = netMonthlyParental ? totalMonthly / netMonthlyParental : null;

  return { taxRate, acqTax, eduTax, ruralTax, totalTax, netTax, taxExempt, broker, legalFee, stampTax, bondDiscount, miscCost, interiorCost, ltvRate, ltvBase, ltvMax, ltvCap, productCap, eligIssues, dsrMax, maxLoan, dsrLimited, totalCapital, extraLoanMan, required, affordable, totalMonthly, mortgageMonthly, extraMonthly, mortgageRate, extraRate, effectiveRate, totalInterest, extraRepayMonthly, extraRepayYrs, netMonthlyIncome, netMonthlyParental, repayRatio, repayRatioParental, years, firstTimeBuyer, regulated, product, productName: prodInfo.name, interestSubsidy, subsidyEligible, subsidyAmount, subsidyMonthly, subsidyTotal, grossMortgageMonthly };
}

// 2026년 기준 인테리어 평당 단가 (수도권 평균, 자재·시공 포함). 출처: 업계 단가 벤치마크 (오늘의집/집브로/AJD 2025-26).
//   신축 0~5년: 도배·장판 정도 → 평당 30~80만
//   부분 6~15년: + 조명/필름/일부 화장실 → 평당 80~150만
//   올수리 16~25년: + 욕실·주방·바닥 전체 → 평당 150~250만
//   풀리모델링 26년+: + 창호·일부 구조 → 평당 250~400만
// 평수 = 전용면적 × 1.3(공급/전용 평균비) ÷ 3.3058
function calcInterior(areaSqm: number | null | undefined, buildYear: number | null | undefined) {
  if (!areaSqm || areaSqm <= 0) return null;
  if (!buildYear || buildYear <= 1900) return null;
  const py = (areaSqm * 1.3) / 3.3058;
  const age = 2026 - buildYear;
  let minRate: number, maxRate: number, level: string, scope: string;
  if (age <= 5) {
    minRate = 30; maxRate = 80;
    level = "신축"; scope = "도배·장판 (옵션)";
  } else if (age <= 15) {
    minRate = 80; maxRate = 150;
    level = "부분 보수"; scope = "도배·장판·조명+α";
  } else if (age <= 25) {
    minRate = 150; maxRate = 250;
    level = "올수리"; scope = "+ 욕실·주방·바닥";
  } else {
    minRate = 250; maxRate = 400;
    level = "풀 리모델링"; scope = "+ 창호·일부 구조";
  }
  return {
    pyeong: Math.round(py * 10) / 10,
    age,
    level,
    scope,
    minRate, maxRate,
    min: Math.round(py * minRate),
    max: Math.round(py * maxRate),
  };
}

function ArticleCard({ a, targetMonth }: { a: NaverArticle; targetMonth?: string }) {
  const movable = targetMonth ? isMovableBy(a, targetMonth) : undefined;
  const ownerJeonse = isOwnerJeonse(a);
  const tenant = isTenant(a);
  return (
    <a
      href={naverArticleUrl(a.articleNo, isMobile)}
      target="_blank"
      rel="noopener"
      title="네이버부동산 매물 상세 보기"
      className={cn("block rounded border px-1.5 py-1 transition-colors hover:border-primary/70 hover:bg-accent/40", movable === false ? "border-border/40 opacity-60" : "border-border/60")}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="flex items-center gap-1">
          <Badge variant="outline" className="text-[9px] px-1 py-0">{a.tradeName}</Badge>
          <strong className="tabular-nums">{formatArticlePrice(a)}</strong>
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {a.exclusiveName ?? (a.exclusiveArea ? `${Math.floor(a.exclusiveArea)}㎡` : "")}
          {a.floor ? ` · ${a.floor}층` : ""}
        </span>
      </div>
      <div className="flex items-center gap-1 text-[10px] flex-wrap">
        <span className={cn(a.moveIn === undefined ? "text-amber-600 animate-pulse" : !ownerJeonse && !tenant && a.moveIn?.immediate ? "text-emerald-600 font-medium" : "text-muted-foreground")}>{a.moveIn === undefined ? "입주확인중…" : moveInLabel(a)}</span>
        {ownerJeonse && <span className="text-rose-500 font-medium">· 주인전세(실입주X)</span>}
        {tenant && !ownerJeonse && <span className="text-rose-500">· 세낀(대출X)</span>}
        {a.dong && <span className="text-muted-foreground">· {a.dong}</span>}
        {a.directionName && <span className="text-muted-foreground">· {a.directionName}향</span>}
        {verifyLabel(a.verifyType) && <span className="text-muted-foreground">· {verifyLabel(a.verifyType)}</span>}
        {a.confirmDate && <span className="ml-auto text-muted-foreground">{formatConfirm(a.confirmDate)} 확인</span>}
      </div>
      {a.feature && <p className="text-[10px] text-foreground/80 line-clamp-1" title={a.feature}>{a.feature}</p>}
      {a.broker && <p className="text-[9px] text-muted-foreground line-clamp-1">{a.broker}</p>}
    </a>
  );
}

function MoveInCell({ data, allData, targetMonth, enabled }: { data: AptData; allData: AptData[]; targetMonth: string; enabled: boolean }) {
  const complexId = data.naver_complex_id;
  const { entry, load, refresh } = useColumnListings(complexId, enabled && !!complexId);
  // 같은 단지의 atype별 대표면적 → 매물을 가장 가까운 atype에 배정(네이버 평형번호 미사용).
  const reps = useMemo(() => allData.filter((x) => x.name === data.name).map((x) => ({ atype: x.atype, area: x.area })), [allData, data.name]);
  if (!complexId) return <span className="text-muted-foreground text-xs">-</span>;
  if (!enabled) return <span className="text-muted-foreground text-xs" title="상단 '네이버 호가' 토글을 켜면 셀에서 조회 가능">·</span>;
  // 자동 조회 안 함 — 명시적으로 '조회' 클릭해야 로드.
  if (!entry) return (
    <button type="button" onClick={load} className="text-primary text-xs underline decoration-dotted underline-offset-4 hover:text-primary/80" title="네이버 실매물 조회">조회</button>
  );
  // 최초 로딩(직전 데이터 없음) → 스피너. 새로고침 중(직전 데이터 있음)이면 아래 팝오버 유지.
  if (entry.status === "loading" && entry.articles.length === 0) return <span className="text-muted-foreground text-xs animate-pulse" title="네이버 매물 조회 중">…</span>;
  if (entry.status === "error" && entry.articles.length === 0) return (
    <button type="button" onClick={refresh} className="text-rose-500 text-xs cursor-pointer hover:underline" title={`조회 실패: ${entry.error} · 클릭하면 재시도`}>!재시도</button>
  );

  const refreshing = entry.status === "loading";
  // 단지 전체 매물 수신 → 이 row의 atype만 nearest-area 매칭으로 필터(네이버 평형번호 미사용).
  const all = articlesForAtype(entry.articles, data.atype, reps).sort((x, y) => x.dealPrice - y.dealPrice);
  const movable = all.filter((a) => isMovableBy(a, targetMonth));
  const minMovable = movable.length ? Math.min(...movable.map((a) => a.dealPrice)) : null;
  const moreUrl = naverLandUrl(complexId, isMobile, data.pyeong_type_nos);
  // 입주가능일(상세) 수집 진행률 — 스트리밍 중 동적 갱신. moveIn 부착된 매물 수 / 전체.
  const enriched = all.filter((a) => a.moveIn !== undefined).length;
  const collecting = refreshing && enriched < all.length;

  return (
    <Popover>
      <PopoverTrigger className={cn("cursor-pointer underline decoration-dotted underline-offset-4 tabular-nums", refreshing && "opacity-60")} title={collecting ? "입주가능일 수집 중…" : undefined}>
        {minMovable != null
          ? formatWon(minMovable)
          : collecting
            ? <span className="text-muted-foreground animate-pulse">{all.length ? formatWon(all[0].dealPrice) : "…"}</span>
            : <span className="text-muted-foreground">{all.length ? "세낀만" : "없음"}</span>}
      </PopoverTrigger>
      <PopoverContent className="w-72 text-xs max-h-96 overflow-y-auto">
        <div className="flex items-center justify-between mb-0.5">
          <p className="font-semibold">네이버 매매 <span className="font-normal text-muted-foreground">{Math.floor(data.area)}㎡ {all.length}건</span></p>
          <div className="flex items-center gap-1.5">
            {collecting
              ? <span className="text-[10px] text-amber-600 animate-pulse tabular-nums">입주확인 {enriched}/{all.length}</span>
              : <span className="text-[10px] text-emerald-600">실입주 {movable.length}건</span>}
            <button type="button" onClick={refresh} disabled={refreshing} className={cn("text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50", refreshing && "animate-spin")} title="다시 조회 (서버 캐시 무시)">↻</button>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground mb-1.5">~{targetMonth} 입주가능 기준 · 세낀/지연 매물은 흐리게</p>
        {all.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">매매 매물 없음 · <a href={moreUrl} target="_blank" rel="noopener" className="text-primary hover:underline">네이버 →</a></p>
        ) : (
          <>
            <div className="space-y-1">{all.map((a) => <ArticleCard key={a.articleNo} a={a} targetMonth={targetMonth} />)}</div>
            <a href={moreUrl} target="_blank" rel="noopener" className="block mt-1 text-[10px] text-primary hover:underline">네이버부동산에서 더보기 →</a>
            <div className="mt-1 pt-1 border-t"><ProxySetting /></div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ProxySetting() {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(() => getProxyUrl());
  const [tok, setTok] = useState(() => getProxyToken());
  if (!open) {
    return (
      <button type="button" onClick={() => { setVal(getProxyUrl()); setTok(getProxyToken()); setOpen(true); }} className="text-[10px] text-muted-foreground hover:text-foreground" title="실매물 프록시 URL + 비밀 토큰 설정">⚙ 프록시 설정</button>
    );
  }
  return (
    <div className="mt-1 space-y-1">
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="프록시 URL (https://...)"
        className="w-full bg-background border border-border rounded px-1 py-0 text-[10px] focus:outline-none focus:border-primary"
      />
      <input
        type="password"
        value={tok}
        onChange={(e) => setTok(e.target.value)}
        placeholder="비밀 토큰"
        autoComplete="off"
        className="w-full bg-background border border-border rounded px-1 py-0 text-[10px] focus:outline-none focus:border-primary"
      />
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => { setProxyUrl(val); setProxyToken(tok); setOpen(false); }} className="text-[10px] text-primary hover:underline">저장</button>
        <button type="button" onClick={() => setOpen(false)} className="text-[10px] text-muted-foreground hover:text-foreground">✕</button>
      </div>
    </div>
  );
}

function PricePopover({ data, capitalMan, extraLoanMan, income1Man, income2Man, loanYears, extraRepayYrs, firstTimeBuyer, loanProduct, interestSubsidy, includeInterior }: { data: AptData; capitalMan: number | null; extraLoanMan: number; income1Man: number; income2Man: number; loanYears: number; extraRepayYrs: number; firstTimeBuyer: boolean; loanProduct: LoanProduct; interestSubsidy: boolean; includeInterior: boolean }) {
  const [customPrice, setCustomPrice] = useState<string>("");
  const customMan = customPrice && !Number.isNaN(parseFloat(customPrice)) ? parseFloat(customPrice) * 10000 : null;
  const kbStorageKey = `kb:${data.name}|${data.atype}`;
  // 팝오버 열 때 KB 실시간 시세 1콜 조회 (cno+ano 보유 단지만). 실패 시 정적 kb_sale fallback.
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<KbLivePrice | null>(null);
  useEffect(() => {
    if (!open || live != null) return;
    if (data.kb_cno == null || data.kb_ano == null) return;
    let alive = true;
    fetchKbLivePrice(data.kb_cno, data.kb_ano).then((r) => {
      if (alive && r != null) setLive(r);
    });
    return () => { alive = false; };
  }, [open, live, data.kb_cno, data.kb_ano]);
  // KB부동산 시세 (만원). 실시간 조회값 우선, 없으면 빌드타임 정적값.
  const liveSaleMan = live?.sale != null && live.sale > 0 ? live.sale : null;
  const kbAutoMan = liveSaleMan ?? (data.kb_sale != null && data.kb_sale > 0 ? data.kb_sale : null);
  const kbAsOf = (liveSaleMan != null ? live?.asOf : null) ?? data.kb_as_of;
  const kbIsLive = liveSaleMan != null;
  const kbAutoStr = kbAutoMan != null ? (kbAutoMan / 10000).toFixed(1) : "";
  // localStorage는 사용자 수동 override 전용. 빈 문자열이면 자동값 사용.
  const [kbOverride, setKbOverride] = useState<string>(() => localStorage.getItem(kbStorageKey) ?? "");
  useEffect(() => {
    if (kbOverride) localStorage.setItem(kbStorageKey, kbOverride);
    else localStorage.removeItem(kbStorageKey);
  }, [kbStorageKey, kbOverride]);
  // 표시·계산에 쓸 값: override 우선, 없으면 자동값
  const kbPrice = kbOverride !== "" ? kbOverride : kbAutoStr;
  const kbIsManual = kbOverride !== "" && kbOverride !== kbAutoStr;
  const kbMan = kbPrice && !Number.isNaN(parseFloat(kbPrice)) ? parseFloat(kbPrice) * 10000 : null;
  const priceMan = customMan ?? data.avg;
  const interior = calcInterior(data.area, data.build);
  const interiorAvg = interior ? Math.round((interior.min + interior.max) / 2) : 0;
  const interiorForCalc = includeInterior ? interiorAvg : 0;
  const triggerText = includeInterior && interior
    ? `${((data.avg + interiorAvg) / 10000).toFixed(1)}억`
    : `${(data.avg / 10000).toFixed(1)}억`;
  const regulated = REGULATED_REGIONS.has(data.region);
  const aff = capitalMan != null ? calcAffordability(priceMan, capitalMan, extraLoanMan, income1Man, income2Man, loanYears, extraRepayYrs, data.area, firstTimeBuyer, regulated, loanProduct, interestSubsidy, interiorForCalc, kbMan) : null;
  const color = aff ? (aff.affordable ? (aff.extraLoanMan > 0 ? "text-amber-500" : "text-emerald-500") : "text-red-500") : "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={cn("cursor-pointer underline decoration-dotted underline-offset-4", color)}>{triggerText}</PopoverTrigger>
      <PopoverContent className="w-64 text-xs max-h-80 overflow-y-auto">
        {aff && (
          <div className="mb-2 pb-2 border-b">
            <p className="font-semibold mb-1 flex items-center justify-between">
              <span>{aff.affordable ? "구매 가능" : "자금 부족"}</span>
              <span className="text-[10px] text-muted-foreground font-normal">{aff.productName}</span>
            </p>
            {aff.eligIssues.length > 0 && (
              <p className="text-[10px] text-amber-500 mb-1">⚠ 자격 미달: {aff.eligIssues.join(", ")}</p>
            )}
            <div className="space-y-0.5">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">매매가</span>
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    step="0.1"
                    inputMode="decimal"
                    placeholder={(data.avg / 10000).toFixed(1)}
                    value={customPrice}
                    onChange={(e) => setCustomPrice(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                      e.preventDefault();
                      const base = customPrice && !Number.isNaN(parseFloat(customPrice))
                        ? parseFloat(customPrice)
                        : data.avg / 10000;
                      const delta = e.key === "ArrowUp" ? 0.1 : -0.1;
                      const next = Math.max(0, Math.round((base + delta) * 10) / 10);
                      setCustomPrice(next.toFixed(1));
                    }}
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                    className={cn(
                      "w-14 text-right bg-background border border-border rounded px-1 py-0 text-xs tabular-nums focus:outline-none focus:border-primary",
                      customPrice && "text-amber-500 border-amber-500/50"
                    )}
                  />
                  <span className="text-muted-foreground">억</span>
                  {customPrice && (
                    <button
                      type="button"
                      onClick={() => setCustomPrice("")}
                      className="text-muted-foreground hover:text-foreground text-[10px]"
                      title="현재가로 리셋"
                    >
                      ↺
                    </button>
                  )}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground" title={`LTV는 min(매매가, KB시세) × LTV율로 계산.${kbAutoMan != null ? ` KB부동산 ${kbIsLive ? "실시간" : "자동"} 시세${kbAsOf ? ` (${kbAsOf} 기준)` : ""}.` : ""} 직접 수정 시 단지별 자동 저장.`}>
                  KB시세 {kbIsManual ? "(수정됨)" : kbIsLive ? "(실시간)" : kbAutoMan != null ? "(자동)" : "(선택)"}
                </span>
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    step="0.1"
                    inputMode="decimal"
                    placeholder="-"
                    value={kbPrice}
                    onChange={(e) => setKbOverride(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                      e.preventDefault();
                      const base = kbPrice && !Number.isNaN(parseFloat(kbPrice))
                        ? parseFloat(kbPrice)
                        : (data.avg / 10000);
                      const delta = e.key === "ArrowUp" ? 0.1 : -0.1;
                      const next = Math.max(0, Math.round((base + delta) * 10) / 10);
                      setKbOverride(next.toFixed(1));
                    }}
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                    className={cn(
                      "w-14 text-right bg-background border border-border rounded px-1 py-0 text-xs tabular-nums focus:outline-none focus:border-primary",
                      kbPrice && (kbIsManual ? "text-sky-500 border-sky-500/50" : "text-muted-foreground")
                    )}
                  />
                  <span className="text-muted-foreground">억</span>
                  {kbIsManual && (
                    <button type="button" onClick={() => setKbOverride("")} className="text-muted-foreground hover:text-foreground text-[10px]" title={kbAutoMan != null ? "KB 자동값으로 복귀" : "제거"}>↺</button>
                  )}
                </span>
              </div>
              <div className="flex justify-between"><span className="text-muted-foreground">취득세 ({(aff.taxRate * 100).toFixed(1)}%+교육{aff.ruralTax > 0 ? "+농특" : ""})</span><span>{aff.netTax.toLocaleString()}만원</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">중개보수 (0.44%)</span><span>{aff.broker.toLocaleString()}만원</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">법무사/인지/채권</span><span>{aff.miscCost.toLocaleString()}만원</span></div>
              {aff.taxExempt > 0 && <div className="flex justify-between"><span className="text-muted-foreground">생애최초 감면</span><span className="text-emerald-500">-{aff.taxExempt.toLocaleString()}만원</span></div>}
              {aff.interiorCost > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">인테리어 (평균)</span><span>{aff.interiorCost.toLocaleString()}만원</span></div>
              )}
              <div className="flex justify-between border-t pt-0.5"><span className="text-muted-foreground">총 비용{aff.interiorCost > 0 ? " (인테리어 포함)" : ""}</span><span>{((priceMan + aff.netTax + aff.broker + aff.miscCost + aff.interiorCost) / 10000).toFixed(1)}억</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">LTV {(aff.ltvRate * 100).toFixed(0)}% · {aff.regulated ? "규제" : "비규제"}{` · 한도 ${aff.ltvCap / 10000}억`}{aff.productCap !== Infinity ? ` · 상품한도 ${aff.productCap / 10000}억` : ""}{aff.ltvBase < priceMan ? ` · KB ${(aff.ltvBase / 10000).toFixed(1)}억 기준` : ""}</span><span>-{(aff.ltvMax / 10000).toFixed(1)}억</span></div>
              {aff.dsrMax != null && <div className="flex justify-between"><span className="text-muted-foreground">DSR 한도 (40%)</span><span className={aff.dsrLimited ? "text-amber-500" : ""}>-{(aff.dsrMax / 10000).toFixed(1)}억</span></div>}
              {aff.dsrLimited && <p className="text-[10px] text-amber-500">DSR에 의해 대출 제한</p>}
              {aff.extraLoanMan > 0 && <div className="flex justify-between"><span className="text-muted-foreground">추가대출</span><span>+{(aff.extraLoanMan / 10000).toFixed(1)}억</span></div>}
              <div className="flex justify-between font-medium border-t pt-0.5"><span>필요 자본금</span><span className={aff.affordable ? "text-emerald-500" : "text-red-500"}>{(aff.required / 10000).toFixed(1)}억</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">보유 자본금</span><span>{(aff.totalCapital / 10000).toFixed(1)}억{!aff.affordable && <span className="text-red-500 ml-1">(-{((aff.required - aff.totalCapital) / 10000).toFixed(1)}억)</span>}</span></div>
            </div>
            <div className="mt-2 pt-2 border-t space-y-0.5">
              <p className="font-semibold mb-0.5">월 상환 ({aff.years}년)</p>
              {aff.subsidyAmount > 0 ? (
                <>
                  <div className="flex justify-between"><span className="text-muted-foreground">주담대 원리금 ({(aff.mortgageRate * 100).toFixed(1)}%)</span><span>{aff.grossMortgageMonthly.toLocaleString()}만원</span></div>
                  <div className="flex justify-between"><span className="text-emerald-500">└ 회사 이자지원 ({(aff.subsidyAmount / 10000).toFixed(1)}억 × {((aff.mortgageRate - 0.02) * 100).toFixed(1)}%, 평균)</span><span className="text-emerald-500">-{aff.subsidyMonthly.toLocaleString()}만원</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">└ 본인 부담 원리금 (평균)</span><span>{aff.mortgageMonthly.toLocaleString()}만원</span></div>
                </>
              ) : (
                <div className="flex justify-between"><span className="text-muted-foreground">주담대 원리금 ({(aff.mortgageRate * 100).toFixed(1)}%)</span><span>{aff.mortgageMonthly.toLocaleString()}만원</span></div>
              )}
              {aff.extraMonthly > 0 && <div className="flex justify-between"><span className="text-muted-foreground">추가대출 이자 ({(aff.extraRate * 100).toFixed(1)}%)</span><span>{aff.extraMonthly.toLocaleString()}만원</span></div>}
              <div className="flex justify-between font-medium"><span>월 납입 합계{aff.subsidyAmount > 0 ? " (실부담)" : ""}</span><span>{aff.totalMonthly.toLocaleString()}만원</span></div>
              <div className="flex justify-between text-muted-foreground"><span>{aff.years}년 이자 총액{aff.subsidyAmount > 0 ? " (실부담)" : ""}</span><span>{(aff.totalInterest / 10000).toFixed(1)}억</span></div>
              {aff.subsidyAmount > 0 && (
                <div className="flex justify-between text-emerald-500"><span>{aff.years}년 회사 지원 총액</span><span>-{(aff.subsidyTotal / 10000).toFixed(2)}억</span></div>
              )}
              {aff.repayRatio != null && (
                <div className="mt-1 pt-1 border-t space-y-0.5">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">상환비율 (세후{aff.netMonthlyIncome?.toLocaleString()}만)</span>
                    <span className={aff.repayRatio <= 0.25 ? "text-emerald-500" : aff.repayRatio <= 0.33 ? "" : "text-amber-500"}>{(aff.repayRatio * 100).toFixed(0)}% {aff.repayRatio <= 0.25 ? "안전" : aff.repayRatio <= 0.33 ? "적정" : "부담"}</span>
                  </div>
                  {aff.repayRatioParental != null && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">육아휴직 시 (세후{aff.netMonthlyParental?.toLocaleString()}만)</span>
                      <span className={aff.repayRatioParental! <= 0.25 ? "text-emerald-500" : aff.repayRatioParental! <= 0.33 ? "" : aff.repayRatioParental! <= 0.5 ? "text-amber-500" : "text-red-500"}>{(aff.repayRatioParental! * 100).toFixed(0)}% {aff.repayRatioParental! <= 0.25 ? "안전" : aff.repayRatioParental! <= 0.33 ? "적정" : aff.repayRatioParental! <= 0.5 ? "부담" : "위험"}</span>
                    </div>
                  )}
                </div>
              )}
              {aff.extraLoanMan > 0 && (
                <div className="mt-1 pt-1 border-t space-y-0.5">
                  <p className="text-muted-foreground">추가대출 {(aff.extraLoanMan / 10000).toFixed(1)}억 {aff.extraRepayYrs}년 상환</p>
                  <div className="flex justify-between"><span className="text-muted-foreground">월 원리금</span><span>{aff.extraRepayMonthly.toLocaleString()}만원</span></div>
                  <div className="flex justify-between text-muted-foreground"><span>이자 총액</span><span>{(aff.extraRepayMonthly * aff.extraRepayYrs * 12 - aff.extraLoanMan).toLocaleString()}만원</span></div>
                  <div className="flex justify-between font-medium"><span>상환기간 월합계</span><span>{(aff.mortgageMonthly + aff.extraRepayMonthly).toLocaleString()}만원</span></div>
                </div>
              )}
            </div>
          </div>
        )}
        {(() => {
          const it = calcInterior(data.area, data.build);
          if (!it) return null;
          return (
            <div className="mb-2 pb-2 border-b">
              <p className="font-semibold mb-1">예상 인테리어 <span className="text-[10px] font-normal text-muted-foreground">({it.pyeong}평{it.age != null && `, ${it.age}년차`})</span></p>
              <div className="space-y-0.5">
                <div className="flex justify-between"><span className="text-muted-foreground">권장 수준</span><span>{it.level} <span className="text-[10px] text-muted-foreground">({it.scope})</span></span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">평당 단가</span><span>{it.minRate}~{it.maxRate}만원</span></div>
                <div className="flex justify-between font-medium"><span>예상 비용</span><span>{it.min.toLocaleString()}~{it.max.toLocaleString()}만원</span></div>
                <div className="flex justify-between text-[10px] text-muted-foreground"><span>매매가 + 부대비 + 인테리어 (최대 기준)</span><span>{((priceMan + (aff?.netTax ?? 0) + (aff?.broker ?? 0) + (aff?.miscCost ?? 0) + it.max) / 10000).toFixed(1)}억</span></div>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">2026년 수도권 평균 기준 (자재·시공 포함). 자재 등급/디자인에 따라 변동.</p>
            </div>
          );
        })()}
        {data.recent_trades?.length > 0 && (
          <>
            <p className="font-semibold mb-1">최근 거래</p>
            <table className="w-full text-xs">
              <thead><tr className="text-muted-foreground"><th className="text-left pb-1">날짜</th><th>가격</th><th>층</th><th>면적</th></tr></thead>
              <tbody>{data.recent_trades.map((t, i) => <tr key={i}><td className="text-left">{t.date.slice(5)}</td><td>{t.price}억</td><td>{t.floor}층</td><td>{t.area}㎡</td></tr>)}</tbody>
            </table>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AccelPopover({ data, halfLabel = "3개월" }: { data: AptData; halfLabel?: string }) {
  return (
    <Popover>
      <PopoverTrigger><span className="cursor-pointer"><AccelBadge value={data.accel} /></span></PopoverTrigger>
      <PopoverContent className="w-56 text-xs">
        <p className="font-semibold mb-1">가속도 — 가격 추세</p>
        <p className="text-muted-foreground mb-2 leading-snug">Theil-Sen 회귀(쌍별 기울기 중앙값) · 이상치 면역. {halfLabel} 환산 변화율.</p>
        <div className="flex justify-between"><span className="text-muted-foreground">최근 {halfLabel} 평균</span><span>{(data.r3_avg / 10000).toFixed(1)}억</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">이전 {halfLabel} 평균</span><span>{data.p3_avg != null ? `${(data.p3_avg / 10000).toFixed(1)}억` : "-"}</span></div>
      </PopoverContent>
    </Popover>
  );
}

function SlopePopover({ data }: { data: AptData }) {
  if (data.slope == null) return <span className="text-muted-foreground">-</span>;
  const cls = data.slope <= 10 ? "text-emerald-500" : data.slope >= 30 ? "text-red-500" : "";
  const dongs = data.slope_dongs ?? [];
  if (!dongs.length) return <span className={cn("text-xs", cls)}>{data.slope}m</span>;
  const sorted = [...dongs].sort((a, b) => a.elev - b.elev);
  const minE = sorted[0].elev;
  const maxE = sorted[sorted.length - 1].elev;
  return (
    <Popover>
      <PopoverTrigger className={cn("cursor-pointer text-xs font-medium", cls)}>{data.slope}m</PopoverTrigger>
      <PopoverContent className="w-56 text-xs max-h-64 overflow-y-auto">
        <p className="font-semibold mb-2">동별 고도 ({dongs.length}동)</p>
        <div className="flex justify-between mb-1"><span className="text-muted-foreground">최저</span><span>{minE}m</span></div>
        <div className="flex justify-between mb-2"><span className="text-muted-foreground">최고</span><span>{maxE}m</span></div>
        <div className="space-y-0.5">
          {sorted.map((d) => {
            const pct = maxE === minE ? 0 : ((d.elev - minE) / (maxE - minE)) * 100;
            return (
              <div key={d.dong} className="flex items-center gap-2">
                <span className="w-10 text-muted-foreground text-right">{d.dong}동</span>
                <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                  <div className="h-full rounded bg-primary" style={{ width: `${Math.max(pct, 4)}%` }} />
                </div>
                <span className="w-12 text-right">{d.elev}m</span>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LiquidityCell({ data }: { data: AptData }) {
  const v = data.liquidity;
  if (v == null) return <span className="text-muted-foreground text-xs">-</span>;
  const label = liquidityLabel(v);
  return (
    <Popover>
      <PopoverTrigger className="cursor-pointer"><LabelText label={label} /></PopoverTrigger>
      <PopoverContent className="w-56 text-xs">
        <p className="font-semibold mb-2">환금성</p>
        <div className="space-y-0.5">
          <div className="flex justify-between"><span className="text-muted-foreground">최근 6개월 거래</span><span>{data.count}건</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">{atypeLabel(data.atype)} 타입 세대수</span><span>{v > 0 ? Math.round(data.count / v * 100) : "-"}세대</span></div>
          <div className="flex justify-between font-medium"><span className="text-muted-foreground">환금성</span><span>{v}%</span></div>
        </div>
        <p className="text-muted-foreground mt-2 pt-2 border-t leading-relaxed">거래건수 / 해당 면적타입 세대수. 높을수록 거래가 활발하여 매도 시 유리</p>
      </PopoverContent>
    </Popover>
  );
}

function ParkingCell({ data }: { data: AptData }) {
  const v = data.parking_per_hh;
  if (v == null) return <span className="text-muted-foreground text-xs">-</span>;
  const label = parkingLabel(v);
  return (
    <Popover>
      <PopoverTrigger className="cursor-pointer"><LabelText label={label} /></PopoverTrigger>
      <PopoverContent className="w-48 text-xs">
        <p className="font-semibold mb-2">주차 정보</p>
        <div className="flex justify-between"><span className="text-muted-foreground">총 주차대수</span><span>{data.parking?.toLocaleString()}대</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">총 세대수</span><span>{data.households?.toLocaleString()}세대</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">세대당 주차</span><span>{v}대</span></div>
        {data.elevator != null && <div className="flex justify-between mt-1"><span className="text-muted-foreground">승강기</span><span>{data.elevator}대</span></div>}
        {data.repair_fund != null && <div className="flex justify-between mt-1 pt-1 border-t"><span className="text-muted-foreground">장기수선충당금</span><span>{Math.round(data.repair_fund / 10000).toLocaleString()}만원</span></div>}
        {data.energy && (
          <div className="mt-1 pt-1 border-t">
            <p className="font-semibold text-muted-foreground mb-0.5">월 에너지 사용량</p>
            {data.energy.heat > 0 && <div className="flex justify-between"><span className="text-muted-foreground">난방</span><span>{Math.round(data.energy.heat / 10000).toLocaleString()}만Mcal</span></div>}
            {data.energy.elect > 0 && <div className="flex justify-between"><span className="text-muted-foreground">전기</span><span>{Math.round(data.energy.elect / 10000).toLocaleString()}만kWh</span></div>}
            {data.energy.waterCool > 0 && <div className="flex justify-between"><span className="text-muted-foreground">수도</span><span>{data.energy.waterCool.toLocaleString()}톤</span></div>}
            {data.energy.gas > 0 && <div className="flex justify-between"><span className="text-muted-foreground">가스</span><span>{data.energy.gas.toLocaleString()}m³</span></div>}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function EqCell({ data }: { data: AptData }) {
  if (data.eq_design == null) return <span className="text-muted-foreground text-xs">-</span>;
  const applied = data.eq_design;
  return (
    <Popover>
      <PopoverTrigger className={cn("cursor-pointer text-xs font-medium", applied ? "text-emerald-500" : "text-red-500")}>
        {applied ? "적용" : "미적용"}
      </PopoverTrigger>
      <PopoverContent className="w-60 text-xs">
        <p className="font-semibold mb-2">건축 정보</p>
        <div className="space-y-0.5">
          <div className="flex justify-between"><span className="text-muted-foreground">내진설계</span><span className={applied ? "text-emerald-500" : "text-red-500"}>{applied ? "적용" : "미적용"}</span></div>
          {data.eq_capacity && <div className="flex justify-between"><span className="text-muted-foreground">내진능력</span><span>{data.eq_capacity}</span></div>}
          {data.vl_rat != null && <div className="flex justify-between"><span className="text-muted-foreground">용적률</span><span>{data.vl_rat}%</span></div>}
          {data.bc_rat != null && <div className="flex justify-between"><span className="text-muted-foreground">건폐율</span><span>{data.bc_rat}%</span></div>}
          {data.land_share != null && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">대지지분</span>
              <span className={data.land_share >= 60 ? "text-emerald-500" : data.land_share >= 40 ? "" : "text-amber-500"}>
                {data.land_share}㎡/세대 ({(data.land_share / 3.3058).toFixed(1)}평)
              </span>
            </div>
          )}
        </div>
        <div className="mt-2 pt-2 border-t text-muted-foreground text-[10px] space-y-1">
          <p className="font-semibold text-foreground/70">대지지분이 클수록</p>
          <p>재건축 시 추가분담금이 적고 사업성이 좋다</p>
          <p>~30㎡ 작음 / 30~60㎡ 보통 / 60㎡~ 우수</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LhCell({ data }: { data: AptData }) {
  if (!data.lh_origin) return <span className="text-muted-foreground text-xs">-</span>;
  const conv = data.lh_has_conversion;
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "cursor-pointer text-[10px] px-1.5 py-0 rounded border",
          conv ? "border-amber-500/60 text-amber-500 bg-amber-500/10" : "border-border text-muted-foreground"
        )}
      >
        {conv ? "임대전환" : "LH"}
      </PopoverTrigger>
      <PopoverContent className="w-64 text-xs">
        <p className="font-semibold mb-1">LH 공급 유형</p>
        <ul className="space-y-0.5 text-muted-foreground">
          {data.lh_types.map((t) => <li key={t}>· {t}</li>)}
        </ul>
        {conv && (
          <p className="mt-2 pt-2 border-t text-[10px] text-muted-foreground">
            5/10/50년 또는 분납 임대 후 분양전환 단지 (일부 동만 해당될 수 있음)
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface MulticulturalCity {
  total: number; domestic: number; midEntry: number; foreign: number;
  totalStudents?: number;
  countries: Record<string, { domestic: number; midEntry: number; foreign: number }>;
}
type MulticulturalData = Record<string, MulticulturalCity>;

function getYearTotal(yearData: any): number {
  if (!yearData || yearData.zero || yearData.noData) return 0;
  return (yearData.cases?.s1?.n || 0) + (yearData.cases?.s2?.n || 0);
}

function YearDetail({ yd, yearLabel }: { yd: any; yearLabel: string }) {
  const TYPE_LABELS = ["신체","언어","금품","강요","따돌림","성폭력","사이버","기타"];
  const VP_LABELS = ["심리상담","일시보호","치료요양","학급교체","전학","기타"];
  const PS_LABELS = ["서면사과","접촉금지","학교봉사","사회봉사","특별교육","출석정지","학급교체","전학","퇴학"];

  if (!yd || yd.zero || yd.noData || yd.parseError) return null;
  const total = (yd.cases?.s1?.n || 0) + (yd.cases?.s2?.n || 0);
  if (total === 0) return null;

  const victims = (yd.cases?.s1?.v||0) + (yd.cases?.s2?.v||0);
  const perps = (yd.cases?.s1?.p||0) + (yd.cases?.s2?.p||0);
  const typeSums = TYPE_LABELS.map((_, i) => (yd.types?.s1?.[i]||0) + (yd.types?.s2?.[i]||0));
  const vpSums = VP_LABELS.map((_, i) => (yd.vp?.s1?.[i]||0) + (yd.vp?.s2?.[i]||0));
  const psSums = PS_LABELS.map((_, i) => (yd.ps?.s1?.[i]||0) + (yd.ps?.s2?.[i]||0));
  const spedTarget = (yd.sped?.s1?.[0]||0) + (yd.sped?.s2?.[0]||0);
  const spedDone = (yd.sped?.s1?.[1]||0) + (yd.sped?.s2?.[1]||0);
  const spedParent = (yd.sped?.s1?.[2]||0) + (yd.sped?.s2?.[2]||0);
  const hasVp = vpSums.some(v => v > 0);
  const hasPs = psSums.some(v => v > 0);
  const hasSped = spedTarget > 0;

  return (
    <div className="flex flex-col gap-1 border-t border-border/50 pt-1">
      <div className="flex items-center gap-1.5">
        <span className="font-semibold text-destructive">{yearLabel}학년도</span>
        <span className="text-muted-foreground">심의 {total}건 · 피해 {victims}명 · 가해 {perps}명</span>
      </div>
      {/* 유형별 */}
      <div className="flex flex-wrap gap-1">
        {TYPE_LABELS.map((l, i) => typeSums[i] > 0 ? (
          <span key={l} className="rounded bg-destructive/10 text-destructive px-1">{l} {typeSums[i]}</span>
        ) : null)}
      </div>
      {/* 피해학생 보호조치 */}
      {hasVp && (
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-muted-foreground">보호조치:</span>
          {VP_LABELS.map((l, i) => vpSums[i] > 0 ? (
            <span key={l} className="rounded bg-blue-500/10 text-blue-500 px-1">{l} {vpSums[i]}</span>
          ) : null)}
        </div>
      )}
      {/* 가해학생 선도교육조치 */}
      {hasPs && (
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-muted-foreground">선도조치:</span>
          {PS_LABELS.map((l, i) => psSums[i] > 0 ? (
            <span key={l} className="rounded bg-orange-500/10 text-orange-500 px-1">{l} {psSums[i]}</span>
          ) : null)}
        </div>
      )}
      {/* 특별교육 */}
      {hasSped && (
        <div className="text-muted-foreground">
          특별교육: 대상 {spedTarget}명 · 학생완료 {spedDone} · 보호자완료 {spedParent}
        </div>
      )}
    </div>
  );
}

function schoolInfoUrl(schoolName: string, region: string | undefined): string {
  // 학교알리미는 deep link를 지원하지 않음 (모든 페이지가 세션 기반).
  // 동명 학교 disambiguation 위해 region(시군구) 포함하여 Naver 검색.
  const city = region?.split(" ")[0] ?? "";
  const q = `${city} ${schoolName} 학교알리미`.trim();
  return `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}`;
}

function SchoolCell({ data }: { data: AptData }) {
  if (!data.schools || data.schools.length === 0) return <span className="text-muted-foreground text-xs">-</span>;
  const sv = data.school_violence ?? {};
  const currentYear = new Date().getFullYear();
  const YEARS = Array.from({ length: 4 }, (_, i) => String(currentYear - 3 + i));
  const YEAR_LABELS = YEARS.map((y) => y.slice(2));

  // 배정학교 중 4개년 합계가 가장 높은 한 학교의 합계
  const allYearsTotal = Math.max(0, ...data.schools.map((s) => YEARS.reduce((ys, y) => ys + getYearTotal(sv[s]?.[y]), 0)));

  return (
    <Popover>
      <PopoverTrigger>
        <span className="cursor-pointer text-xs">
          {data.schools[0].replace("초등학교", "초")}
          {data.schools.length > 1 && <span className="text-muted-foreground"> +{data.schools.length - 1}</span>}
          {allYearsTotal > 0 && <span className="text-destructive ml-0.5">({allYearsTotal})</span>}
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-xs max-h-[70vh] overflow-y-auto">
        <p className="font-semibold mb-2">배정 초등학교 학폭 현황</p>
        <div className="flex flex-col gap-3">
          {data.schools.map((s) => {
            const schoolData = sv[s];
            if (!schoolData) return <div key={s} className="text-muted-foreground">{s}: 데이터 미조회</div>;

            const yearTotals = YEARS.map((y) => getYearTotal(schoolData[y]));
            const hasAny = yearTotals.some((t) => t > 0);
            const trend = yearTotals[yearTotals.length - 1] - yearTotals[0]; // latest vs oldest

            return (
              <div key={s} className="rounded-md bg-muted/50 px-2 py-1.5">
                <div className="font-medium mb-1.5 flex items-center justify-between gap-2">
                  <span>{s}</span>
                  <a
                    href={schoolInfoUrl(s, data.region)}
                    target="_blank"
                    rel="noopener"
                    className="text-[10px] text-primary hover:underline font-normal"
                    title="학교알리미 검색"
                  >학교알리미 ↗</a>
                </div>

                {/* 연도별 추이 바 */}
                <div className="flex items-end gap-1 mb-1.5">
                  {YEARS.map((y, i) => {
                    const t = yearTotals[i];
                    const maxH = Math.max(...yearTotals, 1);
                    const h = Math.max(4, (t / maxH) * 28);
                    return (
                      <div key={y} className="flex flex-col items-center gap-0.5">
                        <span className={t > 0 ? "text-destructive font-semibold" : "text-muted-foreground"}>{t}</span>
                        <div className={`w-5 rounded-sm ${t > 0 ? "bg-destructive/70" : "bg-muted-foreground/20"}`} style={{ height: h }} />
                        <span className="text-[9px] text-muted-foreground">{YEAR_LABELS[i]}</span>
                      </div>
                    );
                  })}
                  <div className="ml-2 text-[10px]">
                    {trend > 0 && <span className="text-destructive font-medium">+{trend} 증가</span>}
                    {trend < 0 && <span className="text-emerald-500 font-medium">{trend} 감소</span>}
                    {trend === 0 && hasAny && <span className="text-muted-foreground">변동없음</span>}
                    {!hasAny && <span className="text-emerald-500">3년간 0건</span>}
                  </div>
                </div>

                {/* 각 연도 세부 데이터 (최신부터) */}
                <div className="flex flex-col gap-1.5">
                  {[...YEARS].reverse().map((y, i) => (
                    <YearDetail key={y} yd={schoolData[y]} yearLabel={YEAR_LABELS[YEARS.length - 1 - i]} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-muted-foreground mt-2 text-[10px]">출처: 학교알리미 ({currentYear - 4}-{currentYear - 1}학년도) · 유형 중복 포함</p>
      </PopoverContent>
    </Popover>
  );
}

function MulticulturalPanel({ mc }: { mc: MulticulturalData }) {
  const [selected, setSelected] = useState<string>("수원시");
  const targets = ["수원시", "성남시", "용인시", "하남시", "화성시"];
  const items = targets.filter((c) => mc[c]).map((c) => ({ city: c, ...mc[c] }));
  if (items.length === 0) return <p className="text-xs text-muted-foreground">데이터 로딩 중...</p>;

  const maxTotal = Math.max(1, ...items.map((d) => d.total));
  const detail = mc[selected];
  const topCountries = detail
    ? Object.entries(detail.countries)
        .map(([c, v]) => ({ country: c, domestic: v.domestic, midEntry: v.midEntry, foreign: v.foreign, total: v.domestic + v.midEntry + v.foreign }))
        .filter((d) => d.total > 0)
        .sort((a, b) => b.total - a.total)
    : [];

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">경기도교육청 2024 기준, 초등학교 다문화학생 수 (시 클릭 시 국적별 상세). 전체 학생 수 대비 비율.</p>
      <div className="space-y-3">
        {items.map((d) => (
          <div key={d.city} className="space-y-1 cursor-pointer" onClick={() => setSelected(d.city)}>
            <div className="flex justify-between text-sm">
              <span className={cn("font-medium", selected === d.city && "text-primary")}>{d.city}</span>
              <span className="text-muted-foreground text-xs">
                {d.total.toLocaleString()}명{d.totalStudents ? ` / ${d.totalStudents.toLocaleString()}명` : ""}
                <span className="ml-1 text-[10px]">({d.totalStudents ? `${(d.total / d.totalStudents * 100).toFixed(1)}%` : `국내${d.domestic} 중도${d.midEntry} 외국${d.foreign}`})</span>
              </span>
            </div>
            <div className="h-4 bg-muted rounded-full overflow-hidden flex">
              <div className="bg-blue-500 h-full" style={{ width: `${(d.domestic / maxTotal) * 100}%` }} />
              <div className="bg-amber-500 h-full" style={{ width: `${(d.midEntry / maxTotal) * 100}%` }} />
              <div className="bg-red-400 h-full" style={{ width: `${(d.foreign / maxTotal) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-4 text-[10px] text-muted-foreground justify-center">
        <span className="flex items-center gap-1"><span className="w-2 h-2 bg-blue-500 rounded-full inline-block" />국내출생</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 bg-amber-500 rounded-full inline-block" />중도입국</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 bg-red-400 rounded-full inline-block" />외국인</span>
      </div>
      {detail && topCountries.length > 0 && (
        <div className="border-t pt-3 space-y-3">
          <p className="text-sm font-semibold">{selected} 국적별 상세 ({detail.total.toLocaleString()}명)</p>
          <div className="space-y-2">
            {topCountries.map((d) => (
              <div key={d.country} className="flex items-center gap-2 text-xs">
                <span className="w-28 truncate">{d.country}</span>
                <div className="flex-1 h-3.5 bg-muted rounded-full overflow-hidden flex">
                  <div className="bg-blue-500 h-full" style={{ width: `${(d.domestic / Math.max(topCountries[0].total, 1)) * 100}%` }} />
                  <div className="bg-amber-500 h-full" style={{ width: `${(d.midEntry / Math.max(topCountries[0].total, 1)) * 100}%` }} />
                  <div className="bg-red-400 h-full" style={{ width: `${(d.foreign / Math.max(topCountries[0].total, 1)) * 100}%` }} />
                </div>
                <span className="w-20 text-right tabular-nums text-[11px]">{d.total}명 ({(d.total / detail.total * 100).toFixed(1)}%)</span>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-muted-foreground mt-2 space-y-0.5">
            <p>* 국내출생: 국제결혼가정 한국 출생 자녀 (부/모 국적 기준)</p>
            <p>* 중도입국: 국제결혼가정 해외 출생 후 입국 자녀</p>
            <p>* 외국인: 부모 모두 외국인 가정 자녀 (주재원/유학 등)</p>
          </div>
        </div>
      )}
    </div>
  );
}

function AptInfoPopover({ d }: { d: AptData }) {
  const maintLabel = (n: number | null) => {
    if (n == null) return null;
    if (n < 0) return { text: `주기 초과 ${Math.abs(n)}년`, cls: "text-red-500" };
    if (n === 0) return { text: "교체 임박", cls: "text-amber-500" };
    if (n <= 3) return { text: `${n}년`, cls: "text-amber-500" };
    return { text: `${n}년`, cls: "text-emerald-500" };
  };
  const elev = maintLabel(d.maint_elevator_remaining);
  const pipe = maintLabel(d.maint_piping_remaining);
  const wp = maintLabel(d.maint_waterproof_remaining);

  return (
    <Popover>
      <PopoverTrigger className="cursor-pointer font-medium text-sm hover:underline decoration-dotted underline-offset-4">
        {d.display_name}
      </PopoverTrigger>
      <PopoverContent className="w-72 text-xs p-0">
        <div className="px-3 pt-3 pb-2 border-b">
          <p className="font-semibold">단지 정보</p>
          {d.doro_juso && <p className="text-muted-foreground mt-0.5">{d.doro_juso}</p>}
        </div>
        <div className="px-3 py-2 max-h-80 overflow-y-auto">
        <div className="space-y-0.5">
          {d.dong_count != null && <div className="flex justify-between"><span className="text-muted-foreground">동수</span><span>{d.dong_count}동</span></div>}
          {d.top_floor != null && <div className="flex justify-between"><span className="text-muted-foreground">최고층</span><span>{d.top_floor}층</span></div>}
          {d.structure && <div className="flex justify-between"><span className="text-muted-foreground">구조</span><span>{d.structure}</span></div>}
          {d.heat_type && <div className="flex justify-between"><span className="text-muted-foreground">난방</span><span>{d.heat_type}</span></div>}
          {d.use_date && <div className="flex justify-between"><span className="text-muted-foreground">사용승인</span><span>{d.use_date.slice(0, 4)}.{d.use_date.slice(4, 6)}.{d.use_date.slice(6, 8)}</span></div>}
          {d.cctv != null && d.cctv > 0 && <div className="flex justify-between"><span className="text-muted-foreground">CCTV</span><span>{d.cctv}대</span></div>}
          {d.vl_rat != null && <div className="flex justify-between"><span className="text-muted-foreground">용적률</span><span>{d.vl_rat}%</span></div>}
          {d.bc_rat != null && <div className="flex justify-between"><span className="text-muted-foreground">건폐율</span><span>{d.bc_rat}%</span></div>}
          {d.land_share != null && <div className="flex justify-between"><span className="text-muted-foreground">대지지분</span><span>{d.land_share}㎡ ({(d.land_share / 3.3058).toFixed(1)}평)</span></div>}
        </div>
        {d.education && (
          <div className="mt-2 pt-2 border-t">
            <p className="text-muted-foreground">교육시설</p>
            <p className="mt-0.5">{d.education}</p>
          </div>
        )}
        {(d.school_lower3_rate != null || d.dong_age0_9_rate != null) && (
          <div className="mt-2 pt-2 border-t">
            <p className="font-semibold mb-1">가족 신호 <span className="text-[10px] font-normal text-muted-foreground">(추정)</span></p>
            <div className="space-y-0.5">
              {d.school_lower3_rate != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">배정초 1~3학년</span>
                  <span className={cn(d.school_lower3_rate >= 50 ? "text-emerald-500" : d.school_lower3_rate <= 35 ? "text-amber-500" : "")}>
                    {d.school_lower3_rate}%
                    {d.school_total != null && <span className="text-[10px] text-muted-foreground"> ({d.school_total}명)</span>}
                  </span>
                </div>
              )}
              {d.dong_age0_9_rate != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">동 0~9세 비율</span>
                  <span className={cn(d.dong_age0_9_rate >= 8 ? "text-emerald-500" : d.dong_age0_9_rate <= 4 ? "text-amber-500" : "")}>
                    {d.dong_age0_9_rate}%
                  </span>
                </div>
              )}
              {d.dong_age30s_rate != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">동 30대 비율</span>
                  <span>{d.dong_age30s_rate}%</span>
                </div>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">학교: 학년 비율 ↑ = 어린 자녀 가구 ↑ / 동: 연령대 ↑ = 가족·신혼 가구 ↑</p>
          </div>
        )}
        {d.mgmt_cost != null && (
          <div className="mt-2 pt-2 border-t">
            <p className="font-semibold mb-1">관리비 ({d.area}㎡ 기준)</p>
            <div className="space-y-0.5">
              <div className="flex justify-between"><span className="text-muted-foreground">연평균</span><span className="font-medium">{d.mgmt_cost}만원/월</span></div>
              {d.mgmt_summer != null && <div className="flex justify-between"><span className="text-muted-foreground">여름</span><span>{d.mgmt_summer}만원</span></div>}
              {d.mgmt_winter != null && <div className="flex justify-between"><span className="text-muted-foreground">겨울</span><span>{d.mgmt_winter}만원</span></div>}
              {d.energy_grade && <div className="flex justify-between"><span className="text-muted-foreground">에너지등급</span><span>{d.energy_grade}</span></div>}
            </div>
          </div>
        )}
        {d.repair_balance != null && (
          <div className="mt-2 pt-2 border-t">
            <p className="font-semibold mb-1">장기수선충당금</p>
            <div className="space-y-0.5">
              <div className="flex justify-between"><span className="text-muted-foreground">적립금</span><span>{d.repair_balance}만원/세대</span></div>
              {d.repair_levy != null && <div className="flex justify-between"><span className="text-muted-foreground">월부과</span><span>{d.repair_levy.toLocaleString()}원/세대</span></div>}
              {d.repair_reserve_rate != null && <div className="flex justify-between"><span className="text-muted-foreground">적립요율</span><span>{d.repair_reserve_rate}%</span></div>}
            </div>
            <div className="mt-1.5 text-muted-foreground text-[10px] leading-relaxed">
              <p>적립금이 충분해야 큰 수선 시 분담금 추가 부과 부담이 적음.</p>
            </div>
          </div>
        )}
        {d.audit_year && (
          <div className="mt-2 pt-2 border-t">
            <p className="font-semibold mb-1">회계감사 ({d.audit_year}년)</p>
            <div className="space-y-0.5">
              <div className="flex justify-between"><span className="text-muted-foreground">이행</span><span className={d.audit_done ? "text-emerald-500" : "text-red-500"}>{d.audit_done ? "완료" : "미실시 ⚠"}</span></div>
              {d.audit_opinion && <div className="flex justify-between"><span className="text-muted-foreground">의견</span><span className={d.audit_opinion === "적정" ? "text-emerald-500" : "text-amber-500"}>{d.audit_opinion}{d.audit_opinion !== "적정" ? " ⚠" : ""}</span></div>}
              {d.audit_net_profit != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">당기손익</span>
                  <span className={d.audit_net_profit >= 0 ? "text-emerald-500" : "text-red-500"}>{d.audit_net_profit >= 0 ? "흑자 " : "적자 "}{(Math.abs(d.audit_net_profit) / 10000).toFixed(0)}만원</span>
                </div>
              )}
            </div>
            <div className="mt-1.5 text-muted-foreground text-[10px] leading-relaxed">
              <p>미실시·부정적 의견은 운영 리스크. 흑/적자는 큰 수선년도엔 적자가 자연스러움.</p>
            </div>
          </div>
        )}
        {d.maint_count != null && d.maint_count > 0 && (
          <div className="mt-2 pt-2 border-t">
            <p className="font-semibold mb-1">유지관리 이력 ({d.maint_count}건)</p>
            <div className="space-y-0.5">
              {d.maint_recent && <div className="flex justify-between"><span className="text-muted-foreground">최근 공사</span><span>{d.maint_recent}</span></div>}
              {elev && <div className="flex justify-between"><span className="text-muted-foreground">승강기</span><span className={elev.cls}>{elev.text}</span></div>}
              {pipe && <div className="flex justify-between"><span className="text-muted-foreground">배관</span><span className={pipe.cls}>{pipe.text}</span></div>}
              {wp && <div className="flex justify-between"><span className="text-muted-foreground">방수</span><span className={wp.cls}>{wp.text}</span></div>}
            </div>
            <div className="mt-1.5 text-muted-foreground text-[10px] leading-relaxed">
              <p>다음 교체 주기까지 남은 기간.</p>
              <p>• <span className="text-red-500">주기 초과</span> = 적립금 부족 시 분담금 위험</p>
              <p>• <span className="text-amber-500">교체 임박</span> = 곧 큰 수선비 발생</p>
              <p>• <span className="text-emerald-500">N년</span> = 당분간 큰 비용 없음</p>
            </div>
          </div>
        )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AllTypesDialog({ name, allData, favorites, onToggleFav }: { name: string; allData: AptData[]; favorites: Set<string>; onToggleFav: (key: string) => void }) {
  const types = useMemo(
    () => allData.filter((d) => d.name === name).sort((a, b) => a.area - b.area),
    [allData, name]
  );
  if (types.length <= 1) return null;

  return (
    <Dialog>
      <DialogTrigger
        className="text-[10px] text-muted-foreground hover:text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        전체 {types.length}타입
      </DialogTrigger>
      <DialogContent className="!w-[95vw] sm:!w-fit !max-w-[95vw]">
        <DialogHeader>
          <DialogTitle>{name} — 전체 평형</DialogTitle>
        </DialogHeader>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="w-8 text-center"></TableHead>
                <TableHead>면적</TableHead>
                <TableHead className="text-right">세대수</TableHead>
                <TableHead className="text-right">현재가</TableHead>
                <TableHead className="text-right">가속도</TableHead>
                <TableHead className="text-center">환금</TableHead>
                <TableHead className="text-right text-xs">6개월거래</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {types.map((t) => {
                const favKey = `${t.name}|${t.atype}`;
                const isFav = favorites.has(favKey);
                return (
                <TableRow key={t.atype} className={cn(t.no_trades && "opacity-60")}>
                  <TableCell
                    className={cn("text-center select-none", t.no_trades ? "text-muted-foreground" : "cursor-pointer", isFav && "text-yellow-400")}
                    onClick={() => !t.no_trades && onToggleFav(favKey)}
                    title={t.no_trades ? "거래 없음" : (isFav ? "즐겨찾기 해제" : "즐겨찾기 추가")}
                  >
                    {t.no_trades ? "" : (isFav ? "★" : "☆")}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("text-[10px]", atypeBadgeColor(t.atype))}>
                      {t.area}㎡
                    </Badge>
                    <span className="ml-2 text-xs text-muted-foreground">{atypeLabel(t.atype)}</span>
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {t.type_units != null
                      ? <span>{t.type_units.toLocaleString()}<span className="text-muted-foreground">세대</span></span>
                      : <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="text-right text-sm font-medium">
                    {t.no_trades ? <span className="text-muted-foreground">-</span> : `${(t.avg / 10000).toFixed(1)}억`}
                  </TableCell>
                  <TableCell className="text-right">{t.no_trades ? <span className="text-muted-foreground">-</span> : <AccelBadge value={t.accel} />}</TableCell>
                  <TableCell className="text-center">{t.no_trades ? <span className="text-muted-foreground">-</span> : <LabelText label={liquidityLabel(t.liquidity)} />}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{t.no_trades ? "거래 없음" : `${t.count}건`}</TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {types.some(t => t.type_units == null) && (
            <p className="text-[10px] text-muted-foreground mt-2">- = 건축물대장 미등록 (소규모 단지)</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CompareDialog({ open, onOpenChange, items, onRemove, slot = "early" }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  items: AptData[];
  onRemove: (key: string) => void;
  slot?: CommuteSlot;
}) {
  if (items.length === 0) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>단지 비교</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">비교할 즐겨찾기가 없습니다. ★를 눌러 즐겨찾기에 추가하세요.</p>
        </DialogContent>
      </Dialog>
    );
  }

  // 행 정의
  type Row = { label: string; render: (d: AptData) => React.ReactNode; group?: string };
  const fmt = (n: number | null | undefined, suffix = "") => n == null ? "-" : `${n}${suffix}`;
  const fmtBil = (n: number | null | undefined) => n == null ? "-" : `${(n / 10000).toFixed(2)}억`;
  const fmtPct = (n: number | null | undefined) => n == null ? "-" : `${n}%`;
  const slopeMaint = (n: number | null) => {
    if (n == null) return "-";
    if (n < 0) return <span className="text-red-500">초과 {Math.abs(n)}년</span>;
    if (n === 0) return <span className="text-amber-500">교체 임박</span>;
    if (n <= 3) return <span className="text-amber-500">{n}년</span>;
    return <span className="text-emerald-500">{n}년</span>;
  };
  const slopeColor = (n: number | null) => n == null ? "" : n <= 10 ? "text-emerald-500" : n >= 30 ? "text-red-500" : "";
  const commuteColor = (m: number | null) => m == null ? "" : m <= 30 ? "text-emerald-500" : m <= 40 ? "" : m <= 50 ? "text-amber-500" : "text-red-500";
  const pedColor = (m: number | null) => m == null ? "" : m <= 20 ? "text-emerald-500" : m <= 30 ? "" : "text-amber-500";
  const violenceTotal = (sv: any, year: string) => {
    const yd = sv?.[year];
    if (!yd || yd.zero || yd.noData) return 0;
    return (yd.cases?.s1?.n || 0) + (yd.cases?.s2?.n || 0);
  };
  const currentYear = new Date().getFullYear();
  const YEARS = [String(currentYear - 3), String(currentYear - 2), String(currentYear - 1), String(currentYear)];

  const rows: Row[] = [
    { label: "지역", render: (d) => d.region },
    { label: "준공", render: (d) => `${d.build}년` },
    { label: "동수", render: (d) => fmt(d.dong_count, "동") },
    { label: "최고층", render: (d) => fmt(d.top_floor, "층") },
    { label: "총 세대수", render: (d) => d.households != null ? d.households.toLocaleString() + "세대" : "-" },
    { label: "면적", render: (d) => <Badge variant="outline" className={cn("text-[10px]", atypeBadgeColor(d.atype))}>{Math.floor(d.area)}㎡</Badge> },
    { label: "타입 세대수", render: (d) => d.type_units != null ? d.type_units.toLocaleString() + "세대" : "-" },
    { label: "현재가", render: (d) => <span className="font-medium">{fmtBil(d.avg)}</span>, group: "가격" },
    { label: "가속도", render: (d) => <AccelBadge value={d.accel} /> },
    { label: "환금성", render: (d) => <LabelText label={liquidityLabel(d.liquidity)} /> },
    { label: "6개월 거래", render: (d) => `${d.count}건` },
    { label: "출퇴근 점수", render: (d) => <LabelBadge label={commuteLabel(d.commuteScore)} />, group: "교통" },
    { label: slot === "late" ? "출근 08:00(판교)" : "출근 06:30(판교)", render: (d) => { const m = commuteValues(d, slot).morning; return m != null ? <span className={commuteColor(m)}>{m}분</span> : "-"; } },
    { label: slot === "late" ? "퇴근 18:00(판교)" : "퇴근 16:00(판교)", render: (d) => { const e = commuteValues(d, slot).evening; return e != null ? <span className={commuteColor(e)}>{e}분</span> : "-"; } },
    { label: "지하철", render: (d) => [d.subway_line, d.subway_station].filter(Boolean).join(" ") || "-" },
    { label: "단지 고저차", render: (d) => d.slope != null ? <span className={slopeColor(d.slope)}>{d.slope}m</span> : "-", group: "환경" },
    { label: "소아과 점수", render: (d) => <LabelBadge label={pedLabel(d.pedScore)} /> },
    { label: "소아과 1", render: (d) => d.pedia1_name ? <span className={pedColor(d.pedia1)}>{d.pedia1_name} {d.pedia1}분{d.pedia1_slope != null ? ` (${d.pedia1_slope > 0 ? "↑" : "↓"}${Math.abs(d.pedia1_slope)}m)` : ""}</span> : "-" },
    { label: "소아과 2", render: (d) => d.pedia2_name ? <span className={pedColor(d.pedia2)}>{d.pedia2_name} {d.pedia2}분{d.pedia2_slope != null ? ` (${d.pedia2_slope > 0 ? "↑" : "↓"}${Math.abs(d.pedia2_slope)}m)` : ""}</span> : "-" },
    { label: "주차/세대", render: (d) => <LabelText label={parkingLabel(d.parking_per_hh)} /> },
    { label: "배정초", render: (d) => d.schools?.join(", ") || "-", group: "교육" },
    { label: "학폭 (4년)", render: (d) => {
      if (!d.schools?.length) return "-";
      const totals = YEARS.map((y) => d.schools.reduce((s, sn) => s + violenceTotal(d.school_violence?.[sn], y), 0));
      const total4yr = totals.reduce((a, b) => a + b, 0);
      const recent = totals[totals.length - 1];
      const cls = recent >= 3 ? "text-red-500" : recent > 0 ? "text-amber-500" : total4yr === 0 ? "text-emerald-500" : "";
      return <span className={cls}>{total4yr}건 (최근 {recent}건)</span>;
    } },
    { label: "치안", render: (d) => <LabelText label={safetyLabel(d.safety_grade)} /> },
    { label: "내진설계", render: (d) => d.eq_design === true ? <span className="text-emerald-500">적용</span> : d.eq_design === false ? <span className="text-red-500">미적용</span> : "-", group: "건축" },
    { label: "용적률", render: (d) => fmtPct(d.vl_rat) },
    { label: "건폐율", render: (d) => fmtPct(d.bc_rat) },
    { label: "대지지분", render: (d) => d.land_share != null ? <span className={d.land_share >= 60 ? "text-emerald-500" : d.land_share >= 40 ? "" : "text-amber-500"}>{d.land_share}㎡ ({(d.land_share / 3.3058).toFixed(1)}평)</span> : "-" },
    { label: "관리비 연평균", render: (d) => d.mgmt_cost != null ? `${d.mgmt_cost}만원/월` : "-", group: "운영비" },
    { label: "관리비 여름", render: (d) => d.mgmt_summer != null ? `${d.mgmt_summer}만원` : "-" },
    { label: "관리비 겨울", render: (d) => d.mgmt_winter != null ? `${d.mgmt_winter}만원` : "-" },
    { label: "에너지등급", render: (d) => d.energy_grade ?? "-" },
    { label: "장기수선 적립", render: (d) => d.repair_balance != null ? `${d.repair_balance}만/세대` : "-", group: "장기수선" },
    { label: "월 부과액", render: (d) => d.repair_levy != null ? `${d.repair_levy.toLocaleString()}원/세대` : "-" },
    { label: "적립률", render: (d) => fmtPct(d.repair_reserve_rate) },
    { label: "회계감사", render: (d) => d.audit_year ? <span>{d.audit_year} {d.audit_done ? "완료" : <span className="text-red-500">미실시</span>} {d.audit_opinion === "적정" ? <span className="text-emerald-500">적정</span> : <span className="text-amber-500">{d.audit_opinion}</span>}</span> : "-", group: "감사" },
    { label: "당기손익", render: (d) => d.audit_net_profit != null ? <span className={d.audit_net_profit >= 0 ? "text-emerald-500" : "text-red-500"}>{d.audit_net_profit >= 0 ? "흑자 " : "적자 "}{(Math.abs(d.audit_net_profit) / 10000).toFixed(0)}만</span> : "-" },
    { label: "유지관리 건수", render: (d) => d.maint_count != null ? `${d.maint_count}건` : "-", group: "유지관리" },
    { label: "최근 공사", render: (d) => d.maint_recent ?? "-" },
    { label: "승강기 잔여", render: (d) => slopeMaint(d.maint_elevator_remaining) },
    { label: "배관 잔여", render: (d) => slopeMaint(d.maint_piping_remaining) },
    { label: "방수 잔여", render: (d) => slopeMaint(d.maint_waterproof_remaining) },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-[95vw] sm:!w-fit !max-w-[95vw] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>단지 비교 — 즐겨찾기 {items.length}개</DialogTitle>
        </DialogHeader>
        <div className="overflow-auto flex-1">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className="text-left p-2 border-b font-medium text-muted-foreground sticky left-0 bg-background min-w-[100px] z-20">항목</th>
                {items.map((d) => (
                  <th key={`${d.name}|${d.atype}`} className="text-left p-2 border-b border-l min-w-[180px] align-top">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-sm">{d.display_name}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {d.region} · {d.area}㎡
                        </div>
                      </div>
                      <button
                        onClick={() => onRemove(`${d.name}|${d.atype}`)}
                        className="text-muted-foreground hover:text-destructive text-base leading-none"
                        title="즐겨찾기 해제"
                      >×</button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const isGroupStart = row.group && (i === 0 || rows[i - 1].group !== row.group);
                return (
                  <React.Fragment key={row.label}>
                    {isGroupStart && (
                      <tr><td colSpan={items.length + 1} className="bg-muted/40 px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{row.group}</td></tr>
                    )}
                    <tr className="border-b">
                      <td className="p-2 text-muted-foreground sticky left-0 bg-background">{row.label}</td>
                      {items.map((d) => (
                        <td key={`${d.name}|${d.atype}|${row.label}`} className="p-2 border-l align-top">
                          {row.render(d)}
                        </td>
                      ))}
                    </tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type SortKey = "score" | "accel" | "liquidity" | "commuteScore" | "pedScore" | "slope" | "avg" | "build" | "name" | "distance";

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class MapErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) return (
      <div className="w-full h-[500px] rounded-lg border flex flex-col items-center justify-center text-muted-foreground gap-2">
        <p>지도 로드 실패</p>
        <p className="text-xs">{this.state.error.message}</p>
        <button className="text-xs text-primary underline" onClick={() => this.setState({ error: null })}>재시도</button>
      </div>
    );
    return this.props.children;
  }
}

export default function App() {
  const [data, setData] = useState<AptData[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightedApt, setHighlightedApt] = useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const searchTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  const onSearchInput = (v: string) => {
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => startTransition(() => setSearchQuery(v)), 150);
  };
  const clearSearch = () => {
    if (searchRef.current) searchRef.current.value = "";
    setSearchQuery("");
  };
  const ls = (k: string, d: string) => localStorage.getItem(k) ?? d;
  const lsArr = (k: string): string[] => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : []; } catch { return []; }
  };
  const [typeFilter, setTypeFilter] = useState<string[]>(() => lsArr("f_type_multi"));
  const [sortField, setSortField] = useState<SortKey>(() => ls("f_sort", "score") as SortKey);
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "map">("table");
  // 메인 테이블 점진 렌더 — 필터 없을 때 ~5,900행 동시 렌더 freeze 방지
  const ROW_PAGE = 60;
  const [visibleCount, setVisibleCount] = useState(ROW_PAGE);
  const sentinelRef = React.useRef<HTMLTableRowElement>(null);
  const [regionFilter, setRegionFilter] = useState<string[]>(() => lsArr("f_region_multi"));
  const [commuteFilter, setCommuteFilter] = useState(() => ls("f_commute", "all"));
  const [commuteSlot, setCommuteSlot] = useState<CommuteSlot>(() => ls("f_commuteSlot", "early") as CommuteSlot);
  const [trendRange, setTrendRange] = useState(() => ls("f_trendRange", "6")); // 추이 그래프 기간(개월): 3/6/12
  const [liquidityFilter, setLiquidityFilter] = useState(() => ls("f_liquidity", "all"));
  const [accelFilter, setAccelFilter] = useState(() => ls("f_accel", "all"));
  const [priceMin, setPriceMin] = useState(() => ls("f_priceMin", "0"));
  const [priceMax, setPriceMax] = useState(() => ls("f_priceMax", "20"));
  const [hhMin, setHhMin] = useState(() => {
    const v = ls("f_hhMin", "0");
    return ["0", "150", "300", "500", "1000"].includes(v) ? v : "0";
  });
  const [buildMin, setBuildMin] = useState(() => {
    const v = ls("f_buildMin", "0");
    return ["0", "1992", "2005", "2018", "2019"].includes(v) ? v : "0";
  });
  const [tradeMin, setTradeMin] = useState(() => ls("f_tradeMin", "0"));
  const [excludeDirect, setExcludeDirect] = useState(() => ls("f_exDirect", "true") === "true");
  const [excludeFirstFloor, setExcludeFirstFloor] = useState(() => ls("f_ex1F", "true") === "true");
  const [capital, setCapital] = useState<string>(() => localStorage.getItem("capital") ?? "");
  const [income1, setIncome1] = useState<string>(() => localStorage.getItem("income1") ?? "");
  const [income2, setIncome2] = useState<string>(() => localStorage.getItem("income2") ?? "");
  const [extraLoan, setExtraLoan] = useState<string>(() => localStorage.getItem("extraLoan") ?? "");
  const [loanYears, setLoanYears] = useState<string>(() => localStorage.getItem("loanYears") ?? "30");
  const [extraRepayYears, setExtraRepayYears] = useState<string>(() => localStorage.getItem("extraRepayYears") ?? "2");
  const [firstTimeBuyer, setFirstTimeBuyer] = useState(() => ls("f_firstTime", "true") === "true");
  const [loanProduct, setLoanProduct] = useState<LoanProduct>(() => ls("f_loanProduct", "normal") as LoanProduct);
  const [interestSubsidy, setInterestSubsidy] = useState(() => ls("f_interestSubsidy", "false") === "true");
  const [includeInterior, setIncludeInterior] = useState(() => ls("f_includeInterior", "false") === "true");
  // 네이버 실입주가 컬럼: 라이브 로딩 토글(기본 off) + 목표 입주가능월(기본 6개월 후)
  const [naverColEnabled, setNaverColEnabled] = useState(() => ls("f_naverCol", "false") === "true");
  const [moveInMonth, setMoveInMonth] = useState<string>(() => {
    const v = localStorage.getItem("f_moveInMonth");
    if (v) return v;
    const d = new Date(); d.setMonth(d.getMonth() + 6);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [financeOpen, setFinanceOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [weights, setWeights] = useState<ScoreWeights>(() => {
    try { const s = localStorage.getItem("weights"); return s ? JSON.parse(s) : DEFAULT_WEIGHTS; } catch { return DEFAULT_WEIGHTS; }
  });
  const updateWeight = (key: keyof ScoreWeights, val: string) => {
    const w = { ...weights, [key]: +val || 0 };
    setWeights(w);
    localStorage.setItem("weights", JSON.stringify(w));
  };
  const weightSum = weights.accel + weights.liquidity + weights.build + weights.commute + weights.pedia;
  const [mcOpen, setMcOpen] = useState(false);
  const [multicultural, setMulticultural] = useState<MulticulturalData>({});
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("favorites") ?? "[]")); } catch { return new Set(); }
  });

  const toggleFav = (key: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      localStorage.setItem("favorites", JSON.stringify([...next]));
      return next;
    });
  };

  const [compareOpen, setCompareOpen] = useState(false);

  useEffect(() => {
    const base = import.meta.env.BASE_URL ?? "/";
    const loadFromIndex = async () => {
      const idxRes = await fetch(base + "data-index.json");
      if (!idxRes.ok) throw new Error("no-index");
      const idx: { shards: { url: string }[] } = await idxRes.json();
      const parts = await Promise.all(
        idx.shards.map((s) => fetch(base + s.url).then((r) => r.json() as Promise<AptData[]>)),
      );
      return parts.flat();
    };
    const loadFallback = () => fetch(base + "data.json").then((r) => r.json() as Promise<AptData[]>);

    Promise.all([
      loadFromIndex().catch(() => loadFallback()),
      // school_violence는 별도 파일. 학교명 키로 참조 공유 → 메모리 절감 (8MB → 2MB)
      fetch(base + "school_violence.json").then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    ]).then(([raw, sv]: [AptData[], Record<string, Record<string, any>>]) => {
      raw.forEach((d) => {
        // schools 배열 기반 inline 매핑. 객체 참조 공유 (deep copy X)
        if (d.schools && d.schools.length > 0) {
          const m: Record<string, Record<string, any>> = {};
          for (const s of d.schools) if (sv[s]) m[s] = sv[s];
          d.school_violence = m;
        } else {
          d.school_violence = {};
        }
        d.pedScore = pedScore(d);
        d.commuteScore = commuteScore(d, commuteSlot);
        d.score = 0;
      });
      calcScores(raw, weights);
      setData(raw);
    });
    fetch(base + "multicultural.json")
      .then((r) => r.json())
      .then(setMulticultural)
      .catch(() => {});
  }, []);

  // 필터 localStorage 저장
  useEffect(() => { localStorage.setItem("f_type_multi", JSON.stringify(typeFilter)); }, [typeFilter]);
  useEffect(() => { localStorage.setItem("f_sort", sortField); }, [sortField]);
  useEffect(() => { localStorage.setItem("f_region_multi", JSON.stringify(regionFilter)); }, [regionFilter]);
  useEffect(() => { localStorage.setItem("f_commute", commuteFilter); }, [commuteFilter]);
  useEffect(() => { localStorage.setItem("f_commuteSlot", commuteSlot); }, [commuteSlot]);
  useEffect(() => { localStorage.setItem("f_trendRange", trendRange); }, [trendRange]);
  useEffect(() => { localStorage.setItem("f_liquidity", liquidityFilter); }, [liquidityFilter]);
  useEffect(() => { localStorage.setItem("f_accel", accelFilter); }, [accelFilter]);
  useEffect(() => { localStorage.setItem("f_priceMin", priceMin); }, [priceMin]);
  useEffect(() => { localStorage.setItem("f_priceMax", priceMax); }, [priceMax]);
  useEffect(() => { localStorage.setItem("f_hhMin", hhMin); }, [hhMin]);
  useEffect(() => { localStorage.setItem("f_buildMin", buildMin); }, [buildMin]);
  useEffect(() => { localStorage.setItem("f_tradeMin", tradeMin); }, [tradeMin]);
  useEffect(() => { localStorage.setItem("f_exDirect", String(excludeDirect)); }, [excludeDirect]);
  useEffect(() => { localStorage.setItem("f_ex1F", String(excludeFirstFloor)); }, [excludeFirstFloor]);

  // 출퇴근 시간대 변경 시 commuteScore 재계산 → tradeFilteredData가 점수 재계산.
  // 가중치 변경은 tradeFilteredData(deps: weights)가 직접 처리.
  useEffect(() => {
    if (data.length === 0) return;
    for (const d of data) d.commuteScore = commuteScore(d, commuteSlot);
    setData([...data]);
  }, [commuteSlot]);

  const regions = useMemo(() => {
    const cities = new Set<string>();
    const districts = new Map<string, Set<string>>(); // city → 구 set
    for (const d of data) {
      const [city, gu] = d.region.split(" ");
      cities.add(city);
      if (gu) {
        if (!districts.has(city)) districts.set(city, new Set());
        districts.get(city)!.add(d.region);
      }
    }
    // 시 → 시의 구들 순으로 평탄화
    const list: string[] = [];
    for (const city of [...cities].sort()) {
      list.push(city);
      const gus = districts.get(city);
      if (gus) for (const r of [...gus].sort()) list.push(r);
    }
    return list;
  }, [data]);

  // 추이 그래프 기간 컷오프 — 선택 개월수 기준 첫째 날 (예: 2026-06 + 6 → 2026-01-01)
  const trendCutoff = useMemo(() => {
    const months = parseInt(trendRange) || 6;
    const now = new Date();
    const c = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
    return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}-01`;
  }, [trendRange]);
  // 가속도용 추이 기간의 중간 지점 컷오프 (윈도우를 절반으로 나눠 최근/이전 비교)
  const accelMidCutoff = useMemo(() => {
    const months = parseInt(trendRange) || 6;
    const now = new Date();
    const startMs = new Date(now.getFullYear(), now.getMonth() - months + 1, 1).getTime();
    const midMs = (startMs + now.getTime()) / 2;
    const m = new Date(midMs);
    return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-${String(m.getDate()).padStart(2, "0")}`;
  }, [trendRange]);
  // 가속도 팝오버 라벨 — 추이 기간의 절반 (예: 6개월 → 3개월씩 비교)
  const accelHalfLabel = `${(parseInt(trendRange) || 6) / 2}개월`;

  // 1층·직거래 토글을 recent_trades에 적용 + count·환금·가속도 재계산 (메인/즐겨찾기/전체타입 공용)
  const applyTradeFilter = useCallback((d: AptData): AptData => {
    const all = d.recent_trades ?? [];
    const trades = all.filter((t) => {
      if (excludeDirect && t.direct) return false;
      if (excludeFirstFloor && t.floor === 1) return false;
      return true;
    });
    const count = trades.length;
    const liquidity = d.type_units && d.type_units > 0
      ? Math.round((count / d.type_units) * 1000) / 10
      : d.liquidity;
    const win = trades.filter((t) => t.date >= trendCutoff);
    // 표시용 컨텍스트 — 최근/이전 절반 평균가 (팝오버)
    const recent = win.filter((t) => t.date >= accelMidCutoff).map((t) => t.price);
    const older = win.filter((t) => t.date < accelMidCutoff).map((t) => t.price);
    const avgOf = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const r3_avg = recent.length ? Math.round(avgOf(recent) * 10000) : d.avg; // 만원
    const p3_avg = older.length ? Math.round(avgOf(older) * 10000) : null;
    // 가속도 — ㎡단가 Theil-Sen 강건 추세 (면적정규화·이상치면역·실거래일 연속)
    const accel = robustAccel(win, parseInt(trendRange) || 6);
    return { ...d, recent_trades: trades, count, liquidity, accel, r3_avg, p3_avg };
  }, [excludeDirect, excludeFirstFloor, trendCutoff, accelMidCutoff, trendRange]);
  const tradeFilteredData = useMemo(() => {
    const mapped = data.map(applyTradeFilter);
    calcScores(mapped, weights); // 재계산된 가속도/환금성을 종합점수에 반영
    return mapped;
  }, [data, applyTradeFilter, weights]);

  const filtered = useMemo(() => {
    const pMinVal = priceMin !== "" ? +priceMin * 10000 : 0;
    const pMaxVal = priceMax !== "" && +priceMax < 20 ? +priceMax * 10000 : Infinity;
    const hhMinVal = hhMin !== "" ? +hhMin : 0;
    const buildMinVal = buildMin !== "" ? +buildMin : 0;
    const tradeMinVal = tradeMin !== "" ? +tradeMin : 0;

    let f = [...tradeFilteredData];

    f = f.filter((d) => {
      if (d.no_trades) return false; // 거래 없는 ghost row는 메인 표 제외
      if (typeFilter.length > 0 && !typeFilter.some((f) => atypeMatchesFilter(d.atype, f))) return false;
      if (regionFilter.length > 0 && !regionFilter.some(r => d.region.includes(r))) return false;
      if (commuteFilter === "good" && (d.commuteScore == null || d.commuteScore > 30)) return false;
      if (commuteFilter === "ok" && (d.commuteScore == null || d.commuteScore > 40)) return false;
      if (liquidityFilter === "good" && (d.liquidity == null || d.liquidity < 7)) return false;
      if (liquidityFilter === "ok" && (d.liquidity == null || d.liquidity < 4)) return false;
      if (liquidityFilter === "bad" && (d.liquidity == null || d.liquidity < 2)) return false;
      if (accelFilter === "good" && (d.accel == null || d.accel <= 5)) return false;
      if (accelFilter === "ok" && (d.accel == null || d.accel < 0)) return false;
      if (accelFilter === "bad" && (d.accel == null || d.accel >= 0)) return false;

      // 비즈니스 로직 필터 (직거래/1층 제외 후 count 기준)
      if (pMinVal > 0 && d.avg < pMinVal) return false;
      if (pMaxVal < Infinity && d.avg > pMaxVal) return false;
      if (hhMinVal > 0 && (d.households ?? 0) < hhMinVal) return false;
      if (buildMinVal > 0 && d.build < buildMinVal) return false;
      if (tradeMinVal > 0 && d.count < tradeMinVal) return false;
      return true;
    });

    f.sort((a, b) => {
      if (sortField === "distance" && myLocation) {
        const da = a.lat && a.lng ? haversineKm(myLocation.lat, myLocation.lng, a.lat, a.lng) : Infinity;
        const db = b.lat && b.lng ? haversineKm(myLocation.lat, myLocation.lng, b.lat, b.lng) : Infinity;
        return da - db;
      }
      const sf = sortField as keyof AptData;
      const va = a[sf] ?? (["commuteScore", "pedScore", "slope", "avg"].includes(sortField) ? Infinity : -Infinity);
      const vb = b[sf] ?? (["commuteScore", "pedScore", "slope", "avg"].includes(sortField) ? Infinity : -Infinity);
      if (sortField === "name") return String(va).localeCompare(String(vb));
      if (["commuteScore", "pedScore", "slope", "avg"].includes(sortField)) return (va as number) - (vb as number);
      return (vb as number) - (va as number);
    });
    return f;
  }, [tradeFilteredData, typeFilter, sortField, regionFilter, commuteFilter, liquidityFilter, accelFilter, priceMin, priceMax, hhMin, buildMin, tradeMin, myLocation]);

  // 필터/정렬/뷰 변경 시 점진 렌더 카운트 리셋 (스크롤 맨 위로 돌아간 효과)
  useEffect(() => { setVisibleCount(ROW_PAGE); }, [filtered, viewMode]);

  // sentinel이 보이면 다음 페이지만큼 더 렌더
  useEffect(() => {
    if (viewMode !== "table") return;
    if (visibleCount >= filtered.length) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        startTransition(() => setVisibleCount((c) => Math.min(c + ROW_PAGE, filtered.length)));
      }
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [viewMode, visibleCount, filtered.length]);

  const favoriteItems = useMemo(() => {
    const items = tradeFilteredData.filter((d) => favorites.has(`${d.name}|${d.atype}`));
    return items.sort((a, b) => {
      if (a.name !== b.name) return a.name.localeCompare(b.name, "ko");
      return a.area - b.area;
    });
  }, [tradeFilteredData, favorites]);

  // 같은 단지(name) row 그룹화 → rowspan 메타
  const favoriteRowMeta = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of favoriteItems) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
    const seen = new Set<string>();
    return favoriteItems.map((d) => {
      const isFirst = !seen.has(d.name);
      seen.add(d.name);
      return { isFirst, span: counts.get(d.name) ?? 1 };
    });
  }, [favoriteItems]);

  const filteredNames = useMemo(() => new Set(filtered.map((d) => d.name)), [filtered]);

  const getFilterReason = (d: AptData): string | null => {
    const pMinVal = priceMin !== "" ? +priceMin * 10000 : 0;
    const pMaxVal = priceMax !== "" && +priceMax < 20 ? +priceMax * 10000 : Infinity;
    const hhMinVal = hhMin !== "" ? +hhMin : 0;
    const buildMinVal = buildMin !== "" ? +buildMin : 0;
    const tradeMinVal = tradeMin !== "" ? +tradeMin : 0;
    const reasons: string[] = [];
    if (typeFilter.length > 0 && !typeFilter.some((f) => atypeMatchesFilter(d.atype, f))) reasons.push("면적");
    if (regionFilter.length > 0 && !regionFilter.some(r => d.region.includes(r))) reasons.push("지역");
    if (commuteFilter === "good" && (d.commuteScore == null || d.commuteScore > 30)) reasons.push(d.commuteScore == null ? "출퇴근 데이터 없음" : "출퇴근 30분 초과");
    if (commuteFilter === "ok" && (d.commuteScore == null || d.commuteScore > 40)) reasons.push(d.commuteScore == null ? "출퇴근 데이터 없음" : "출퇴근 40분 초과");
    if (liquidityFilter === "good" && (d.liquidity == null || d.liquidity < 7)) reasons.push(d.liquidity == null ? "환금성 데이터 없음" : `환금성 ${d.liquidity}% (좋음 미만)`);
    if (liquidityFilter === "ok" && (d.liquidity == null || d.liquidity < 4)) reasons.push(d.liquidity == null ? "환금성 데이터 없음" : `환금성 ${d.liquidity}% (보통 미만)`);
    if (liquidityFilter === "bad" && (d.liquidity == null || d.liquidity < 2)) reasons.push(d.liquidity == null ? "환금성 데이터 없음" : `환금성 ${d.liquidity}% (나쁨 미만)`);
    if (accelFilter === "good" && (d.accel == null || d.accel <= 5)) reasons.push(d.accel == null ? "가속도 데이터 없음" : `가속도 ${d.accel}% (상승 미만)`);
    if (accelFilter === "ok" && (d.accel == null || d.accel < 0)) reasons.push(d.accel == null ? "가속도 데이터 없음" : `가속도 ${d.accel}% (보합 미만)`);
    if (accelFilter === "bad" && (d.accel == null || d.accel >= 0)) reasons.push(d.accel == null ? "가속도 데이터 없음" : `가속도 ${d.accel}% (하락 아님)`);
    if (pMinVal > 0 && d.avg < pMinVal) reasons.push(`${priceMin}억 미만`);
    if (pMaxVal < Infinity && d.avg > pMaxVal) reasons.push(`${priceMax}억 초과`);
    if (hhMinVal > 0 && (d.households ?? 0) < hhMinVal) reasons.push(d.households == null ? `세대수 데이터 없음` : `${hhMin}세대 미만`);
    if (buildMinVal > 0 && d.build < buildMinVal) reasons.push(`${buildMin}년 이전`);
    if (tradeMinVal > 0 && d.count < tradeMinVal) reasons.push(`거래 ${d.count}건`);
    return reasons.length > 0 ? reasons.join(", ") : null;
  };

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    // 특수문자·공백 무시: 소문자화 후 한글/영문/숫자만 남김 (e편한세상 ↔ e-편한세상, 래미안 안양 ↔ 래미안안양)
    const norm = (s: string) => s.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
    const q = norm(searchQuery);
    if (!q) return [];
    // 전체 데이터에서 타입별로 검색 (필터 무관)
    const results: (AptData & { _inFilter: boolean })[] = [];
    for (const d of data) {
      if (d.no_trades) continue;
      const haystack = norm([d.name, d.display_name, d.dong, d.doro_juso, d.region].filter(Boolean).join(" "));
      if (!haystack.includes(q)) continue;
      results.push({ ...d, _inFilter: filteredNames.has(d.name) });
      if (results.length >= 30) break;
    }
    // 정렬: 필터에 있는 것 먼저 → 단지명 → 면적 오름차순
    return results.sort((a, b) => {
      if (a._inFilter !== b._inFilter) return a._inFilter ? -1 : 1;
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.area - b.area;
    });
  }, [data, searchQuery, filteredNames]);

  // Cmd+K / Ctrl+K 단축키
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 50); }
      if (e.key === "Escape") { setSearchOpen(false); clearSearch(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const globalPctRange = useMemo(() => {
    const aptMaxes: number[] = [];
    for (const d of data) {
      const prices = d.recent_trades?.filter((t) => t.date >= trendCutoff).map((t) => t.price) ?? [];
      if (prices.length < 2) continue;
      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      let aptMax = 0;
      for (const p of prices) {
        const pct = Math.abs(p - mean) / mean;
        if (pct > aptMax) aptMax = pct;
      }
      aptMaxes.push(aptMax);
    }
    if (!aptMaxes.length) return 0.1;
    aptMaxes.sort((a, b) => a - b);
    const p90 = aptMaxes[Math.floor(aptMaxes.length * 0.9)];
    return Math.max(p90, 0.05);
  }, [data, trendCutoff]);

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="max-w-7xl mx-auto px-3 py-4 sm:px-6">
        <h1 className="text-xl font-bold mb-1">아파트 매수 후보 스코어링</h1>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
          <p className="text-xs text-muted-foreground">
            데이터: 실거래가 (전 면적) | 최종 업데이트: {new Date().toLocaleDateString("ko-KR")}
          </p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 shrink-0 text-[10px]">
            <Button
              variant="outline"
              size="sm"
              className="text-[10px] h-auto py-0.5 px-2"
              onClick={() => setFinanceOpen(true)}
              title="자본/연봉/대출 설정 (브라우저 로컬에만 저장)"
            >
              💰 자금 설정
              {capital && <span className="ml-1 text-emerald-500">●</span>}
            </Button>
            <select
              value={loanProduct}
              onChange={(e) => { setLoanProduct(e.target.value as LoanProduct); localStorage.setItem("f_loanProduct", e.target.value); }}
              className="h-auto py-0.5 px-1 rounded border bg-background text-[10px]"
              title={LOAN_PRODUCTS[loanProduct].desc}
            >
              {(Object.keys(LOAN_PRODUCTS) as LoanProduct[]).map((p) => {
                const rateLabel = p === "newborn" ? "1.8~4.5%" : `${(LOAN_PRODUCTS[p].rate * 100).toFixed(1)}%`;
                return <option key={p} value={p}>{LOAN_PRODUCTS[p].name} ({rateLabel})</option>;
              })}
            </select>
            <label className="flex items-center gap-1 cursor-pointer" title="테이블 현재가 = 매매가 + 인테리어(평균)">
              <input type="checkbox" checked={includeInterior} onChange={(e) => { setIncludeInterior(e.target.checked); localStorage.setItem("f_includeInterior", String(e.target.checked)); }} className="rounded h-3 w-3" />
              <span>인테리어 합산</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer" title="'호가' 컬럼 활성화 — 자동 호출하지 않고, 각 행의 '조회'를 눌러야 네이버 실매물을 가져옴 (팝오버 ↻로 새로고침)">
              <input type="checkbox" checked={naverColEnabled} onChange={(e) => { setNaverColEnabled(e.target.checked); localStorage.setItem("f_naverCol", String(e.target.checked)); }} className="rounded h-3 w-3" />
              <span>네이버 호가</span>
            </label>
            <label className="flex items-center gap-1" title="이 시점까지 입주 가능한 매물만 '실입주가능'으로 간주 (세낀/지연 매물 제외)">
              <span className="text-muted-foreground">입주가능</span>
              <input type="month" value={moveInMonth} onChange={(e) => { setMoveInMonth(e.target.value); localStorage.setItem("f_moveInMonth", e.target.value); }} className="h-auto py-0.5 px-1 rounded border bg-background text-[10px] tabular-nums" />
            </label>
            <ProxySetting />
            <Button variant="outline" size="sm" className="text-[10px] h-auto py-0.5 px-2" onClick={() => setMcOpen(true)}>다문화 통계</Button>
            <Suspense fallback={null}>
              <MolitPressViewer />
            </Suspense>

            <Dialog open={financeOpen} onOpenChange={setFinanceOpen}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>자금 / 대출 설정</DialogTitle>
                </DialogHeader>
                <p className="text-[11px] text-muted-foreground -mt-1 mb-2">⚠ 민감 정보 — 브라우저 localStorage에만 저장되며 외부로 전송되지 않습니다.</p>
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">보유 자본금 (억)</span>
                      <input type="number" step="0.1" min="0" placeholder="예: 5" value={capital} onChange={(e) => { setCapital(e.target.value); localStorage.setItem("capital", e.target.value); }} className="h-8 rounded border bg-background px-2 text-sm" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">추가대출 한도 (억)</span>
                      <input type="number" step="0.1" min="0" placeholder="예: 1" value={extraLoan} onChange={(e) => { setExtraLoan(e.target.value); localStorage.setItem("extraLoan", e.target.value); }} className="h-8 rounded border bg-background px-2 text-sm" />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">본인 연봉 (억)</span>
                      <input type="number" step="0.01" min="0" placeholder="예: 0.7" value={income1} onChange={(e) => { setIncome1(e.target.value); localStorage.setItem("income1", e.target.value); }} className="h-8 rounded border bg-background px-2 text-sm" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">배우자 연봉 (억)</span>
                      <input type="number" step="0.01" min="0" placeholder="예: 0.5" value={income2} onChange={(e) => { setIncome2(e.target.value); localStorage.setItem("income2", e.target.value); }} className="h-8 rounded border bg-background px-2 text-sm" />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">주담대 만기</span>
                      <select value={loanYears} onChange={(e) => { setLoanYears(e.target.value); localStorage.setItem("loanYears", e.target.value); }} className="h-8 rounded border bg-background px-2 text-sm">
                        <option value="20">20년</option>
                        <option value="30">30년</option>
                        <option value="40">40년</option>
                        <option value="50">50년</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">추가대출 상환</span>
                      <select value={extraRepayYears} onChange={(e) => { setExtraRepayYears(e.target.value); localStorage.setItem("extraRepayYears", e.target.value); }} className="h-8 rounded border bg-background px-2 text-sm">
                        <option value="1">1년</option>
                        <option value="2">2년</option>
                        <option value="3">3년</option>
                        <option value="5">5년</option>
                      </select>
                    </label>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer" title="생애최초 주택 구매자 (LTV 80% / 취득세 200만원 감면)">
                    <input type="checkbox" checked={firstTimeBuyer} onChange={(e) => { setFirstTimeBuyer(e.target.checked); localStorage.setItem("f_firstTime", String(e.target.checked)); }} className="rounded" />
                    <span className="text-sm">생애최초 주택 구매자</span>
                    <span className="text-[10px] text-muted-foreground">(LTV 우대 + 취득세 -200만원)</span>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer" title="사내 대출이자지원 (주택구입 매매대출). 본인 2% 부담, 초과분 회사 지원. 한도: 매매가 50% / 최대 1.5억. 일반 주담대 기본 적용. 정책상품은 신한 신생아특례 / SC제일 u-보금자리에서만 가능.">
                    <input type="checkbox" checked={interestSubsidy} onChange={(e) => { setInterestSubsidy(e.target.checked); localStorage.setItem("f_interestSubsidy", String(e.target.checked)); }} className="rounded mt-0.5" />
                    <div className="flex flex-col">
                      <span className="text-sm">사내 이자지원 (매매대출)</span>
                      <span className="text-[10px] text-muted-foreground">본인 2% 부담, 초과분 회사 지원 · 매매가 50% / 최대 1.5억</span>
                      <span className="text-[10px] text-muted-foreground">일반 주담대 기본 적용 · 정책상품은 신한 신생아특례·SC제일 u-보금자리만 · 실거주 필수</span>
                    </div>
                  </label>
                  <div className="pt-2 border-t flex justify-between gap-2">
                    <button
                      className="text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        for (const k of ["capital", "income1", "income2", "extraLoan"]) localStorage.removeItem(k);
                        setCapital(""); setIncome1(""); setIncome2(""); setExtraLoan("");
                      }}
                    >금액 모두 지우기</button>
                    <Button size="sm" onClick={() => setFinanceOpen(false)}>완료</Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
            <Dialog open={mcOpen} onOpenChange={setMcOpen}>
              <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>행정구역별 다문화학생 현황</DialogTitle>
                </DialogHeader>
                <MulticulturalPanel mc={multicultural} />
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <Collapsible open={infoOpen} onOpenChange={setInfoOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-sm text-primary cursor-pointer mb-3">
            스코어링 가중치 {weightSum !== 100 && <span className="text-destructive text-xs ml-1">(합계 {weightSum}%)</span>}
            <ChevronDown className={cn("h-4 w-4 transition-transform", infoOpen && "rotate-180")} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-1.5 mb-4 text-xs max-w-md">
              {([
                ["accel", "가속도"],
                ["liquidity", "환금성"],
                ["build", "신축도"],
                ["commute", "출퇴근"],
                ["pedia", "소아과"],
              ] as const).map(([key, label]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="text-muted-foreground w-10 text-right shrink-0">{label}</span>
                  <input type="range" min="0" max="50" step="5" value={weights[key]} onChange={(e) => updateWeight(key, e.target.value)} className="flex-1 accent-primary h-1.5 cursor-pointer" />
                  <span className="w-8 text-right tabular-nums font-medium shrink-0">{weights[key]}%</span>
                </div>
              ))}
            </div>
            {weightSum !== 100 && <p className="text-destructive text-[10px] mb-3">합계 {weightSum}% — 100%를 권장합니다</p>}
          </CollapsibleContent>
        </Collapsible>

        <div className="flex flex-wrap gap-2 mb-2 items-center">
          <Select multiple value={typeFilter} onValueChange={(v: string[]) => setTypeFilter(v)}>
            <SelectTrigger className="w-32 h-8 text-xs">
              <SelectValue>{(v: string[]) => v.length === 0 ? "전체 면적" : v.length === 1 ? atypeLabel(v[0]) : `면적 ${v.length}개`}</SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} className="w-auto min-w-fit">
              <SelectItem value="large"><span className="font-medium">대형 전체 (84㎡ 초과)</span></SelectItem>
              {ATYPES_LARGE.map((a) => (
                <SelectItem key={a} value={a}><span className="pl-3 text-muted-foreground">{atypeLabel(a)}</span></SelectItem>
              ))}
              <SelectItem value="medium"><span className="font-medium">중형 전체 (84㎡)</span></SelectItem>
              {ATYPES_MEDIUM.map((a) => (
                <SelectItem key={a} value={a}><span className="pl-3 text-muted-foreground">{atypeLabel(a)}</span></SelectItem>
              ))}
              <SelectItem value="small"><span className="font-medium">소형 전체 (84㎡ 미만)</span></SelectItem>
              {ATYPES_SMALL.map((a) => (
                <SelectItem key={a} value={a}><span className="pl-3 text-muted-foreground">{atypeLabel(a)}</span></SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortField} onValueChange={(v) => {
            if (!v) return;
            if (v === "distance" && !myLocation) {
              navigator.geolocation.getCurrentPosition(
                (pos) => { setMyLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setSortField("distance"); },
                () => { /* 위치 권한 거부 시 무시 */ },
              );
            } else {
              setSortField(v as SortKey);
            }
          }} items={{ score: "점수순", accel: "가속도순", liquidity: "환금성순", commuteScore: "출퇴근순", pedScore: "소아과순", avg: "현재가순", distance: "거리순" }}>
            <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="score">점수순</SelectItem>
              <SelectItem value="accel">가속도순</SelectItem>
              <SelectItem value="liquidity">환금성순</SelectItem>
              <SelectItem value="commuteScore">출퇴근순</SelectItem>
              <SelectItem value="pedScore">소아과순</SelectItem>
              <SelectItem value="avg">현재가순</SelectItem>
              <SelectItem value="distance">거리순</SelectItem>
            </SelectContent>
          </Select>
          <Select multiple value={regionFilter} onValueChange={(v: string[]) => setRegionFilter(v)}>
            <SelectTrigger className="w-32 h-8 text-xs">
              <SelectValue>{(v: string[]) => v.length === 0 ? "전체 지역" : v.length === 1 ? v[0] : `지역 ${v.length}개`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {regions.map((r) => {
                const isGu = r.includes(" ");
                return (
                  <SelectItem key={r} value={r}>
                    {isGu ? <span className="pl-3 text-muted-foreground">{r.split(" ")[1]}</span> : <span className="font-medium">{r}</span>}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Select value={commuteFilter} onValueChange={(v) => v && setCommuteFilter(v)} items={{ all: "출퇴근 전체", good: "좋음 이상", ok: "보통 이상" }}>
            <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">출퇴근 전체</SelectItem>
              <SelectItem value="good">좋음 이상</SelectItem>
              <SelectItem value="ok">보통 이상</SelectItem>
            </SelectContent>
          </Select>
          <Select value={commuteSlot} onValueChange={(v) => v && setCommuteSlot(v as CommuteSlot)} items={{ early: "일찍 (06:30/16:00)", late: "늦게 (08:00/18:00)" }}>
            <SelectTrigger className="w-36 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="early">일찍 (06:30/16:00)</SelectItem>
              <SelectItem value="late">늦게 (08:00/18:00)</SelectItem>
            </SelectContent>
          </Select>
          <Select value={trendRange} onValueChange={(v) => v && setTrendRange(v)} items={{ "3": "추이 3개월", "6": "추이 6개월", "12": "추이 12개월" }}>
            <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="3">추이 3개월</SelectItem>
              <SelectItem value="6">추이 6개월</SelectItem>
              <SelectItem value="12">추이 12개월</SelectItem>
            </SelectContent>
          </Select>
          <Select value={liquidityFilter} onValueChange={(v) => v && setLiquidityFilter(v)} items={{ all: "환금성 전체", good: "좋음 이상 (≥7%)", ok: "보통 이상 (≥4%)", bad: "나쁨 이상 (≥2%)" }}>
            <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">환금성 전체</SelectItem>
              <SelectItem value="good">좋음 이상 (≥7%)</SelectItem>
              <SelectItem value="ok">보통 이상 (≥4%)</SelectItem>
              <SelectItem value="bad">나쁨 이상 (≥2%)</SelectItem>
            </SelectContent>
          </Select>
          <Select value={accelFilter} onValueChange={(v) => v && setAccelFilter(v)} items={{ all: "가속도 전체", good: "상승 (>5%)", ok: "보합 이상 (≥0%)", bad: "하락 (<0%)" }}>
            <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">가속도 전체</SelectItem>
              <SelectItem value="good">상승 (&gt;5%)</SelectItem>
              <SelectItem value="ok">보합 이상 (≥0%)</SelectItem>
              <SelectItem value="bad">하락 (&lt;0%)</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">{filtered.length}개 단지</span>
          <Button variant={viewMode === "table" ? "default" : "outline"} size="sm" className="h-7 text-xs px-2" onClick={() => setViewMode("table")}>테이블</Button>
          <Button variant={viewMode === "map" ? "default" : "outline"} size="sm" className="h-7 text-xs px-2" onClick={() => { setViewMode("map"); if (!myLocation) navigator.geolocation.getCurrentPosition((p) => setMyLocation({ lat: p.coords.latitude, lng: p.coords.longitude }), () => {}); }}>지도</Button>
          {favoriteItems.length > 1 && (
            <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => setCompareOpen(true)}>
              <span className="text-yellow-400">★</span> 비교 ({favoriteItems.length})
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-3 mb-4 items-center text-xs">
          <label className="flex items-center gap-2" title="현재가 범위 (억 단위)">
            <span className="text-muted-foreground">현재가</span>
            <span className="text-[10px] tabular-nums w-24 text-center">
              {(+priceMin === 0 && +priceMax >= 20) ? "전체" : `${priceMin}억 ~ ${+priceMax >= 20 ? "20억+" : priceMax + "억"}`}
            </span>
            <Slider
              className="w-40"
              min={0}
              max={20}
              step={1}
              value={[+priceMin || 0, +priceMax || 20]}
              onValueChange={(v: readonly number[]) => { setPriceMin(String(v[0])); setPriceMax(String(v[1])); }}
            />
          </label>
          <label className="flex items-center gap-1" title="최소 세대수 (공동주택관리법 / 주택건설기준)">
            <span className="text-muted-foreground">세대수</span>
            <Select value={hhMin} onValueChange={(v) => v && setHhMin(v)} items={{ "0": "전체", "150": "150세대↑", "300": "300세대↑", "500": "500세대↑", "1000": "1000세대↑" }}>
              <SelectTrigger className="w-28 h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="w-auto min-w-fit">
                <SelectItem value="0">전체</SelectItem>
                <SelectItem value="150">150세대↑ (승강기/난방 시 의무관리)</SelectItem>
                <SelectItem value="300">300세대↑ (전면 의무관리)</SelectItem>
                <SelectItem value="500">500세대↑ (놀이터·경로당)</SelectItem>
                <SelectItem value="1000">1000세대↑ (대단지)</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-center gap-1" title="최소 준공년도 (스프링클러·주차장 법적 기준)">
            <span className="text-muted-foreground">준공</span>
            <Select value={buildMin} onValueChange={(v) => v && setBuildMin(v)} items={{ "0": "전체", "1992": "1992년↑", "2005": "2005년↑", "2018": "2018년↑", "2019": "2019년↑" }}>
              <SelectTrigger className="w-28 h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="w-auto min-w-fit">
                <SelectItem value="0">전체</SelectItem>
                <SelectItem value="1992">1992년↑ (16층 이상 층만 스프링클러)</SelectItem>
                <SelectItem value="2005">2005년↑ (11층+ 동 전층 스프링클러)</SelectItem>
                <SelectItem value="2018">2018년↑ (6층+ 신축 스프링클러)</SelectItem>
                <SelectItem value="2019">2019년↑ (주차칸 2.5m)</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-center gap-1" title="최근 6개월 최소 거래 건수">
            <span className="text-muted-foreground">6개월 거래</span>
            <input type="number" min="0" placeholder="0" value={tradeMin} onChange={(e) => setTradeMin(e.target.value)} className="w-10 h-7 rounded border bg-background px-1.5 text-xs text-center" />
            <span className="text-muted-foreground text-[10px]">건+</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer" title="중개인 없는 직거래 제외">
            <input type="checkbox" checked={excludeDirect} onChange={(e) => setExcludeDirect(e.target.checked)} className="rounded" />
            <span className="text-muted-foreground">직거래 제외</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer" title="1층 거래 제외">
            <input type="checkbox" checked={excludeFirstFloor} onChange={(e) => setExcludeFirstFloor(e.target.checked)} className="rounded" />
            <span className="text-muted-foreground">1층 제외</span>
          </label>
        </div>

        {favoriteItems.length > 0 && (
          <div className="overflow-x-auto rounded-lg border mb-4">
            <Table>
              <TableHeader>
                <TableRow className="bg-primary/10">
                  <TableHead className="w-6 text-center"></TableHead>
                  <TableHead className="min-w-[160px]">즐겨찾기</TableHead>
                  <TableHead className="text-center">세대수</TableHead>
                  <TableHead className="text-center">현재가</TableHead>
                  <TableHead className="text-center" title="네이버 실매물 중 입주가능월까지 입주 가능한 매매 최저가 (세낀 제외)">호가</TableHead>
                  <TableHead className="text-center w-20">추이</TableHead>
                  <TableHead className="text-center">가속도</TableHead>
                  <TableHead className="text-center">환금</TableHead>
                  <TableHead className="text-center">출퇴근</TableHead>
                  <TableHead className="text-center">소아과</TableHead>
                  <TableHead className="text-center">고저차</TableHead>
                  <TableHead className="text-center">주차</TableHead>
                  <TableHead className="text-center">초등학교</TableHead>
                  <TableHead className="text-center">안전</TableHead>
                  <TableHead className="text-center">내진</TableHead>
                  <TableHead className="text-center">LH</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {favoriteItems.map((d, idx) => {
                  const sparkData = d.recent_trades?.filter((t) => t.date >= trendCutoff).slice().reverse().map((t) => ({ date: t.date, price: t.price })) ?? [];
                  const favKey = `${d.name}|${d.atype}`;
                  const { isFirst, span } = favoriteRowMeta[idx];
                  return (
                    <TableRow key={`fav-${favKey}`} className="bg-primary/5">
                      <TableCell className="text-center cursor-pointer text-yellow-400" onClick={() => toggleFav(favKey)}>★</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <div>
                            <span className="text-muted-foreground text-[11px] mr-1">{d.region}</span>
                            <AptInfoPopover d={d} />
                            <Badge variant="outline" className={cn("ml-1 text-[10px]", atypeBadgeColor(d.atype))}>{Math.floor(d.area)}㎡</Badge>
                            <span className="text-muted-foreground text-[10px] ml-0.5">({d.build})</span>
                          </div>
                          <div className="flex gap-2 text-[10px]">
                            {d.hcode && <a href={`https://hogangnono.com/apt/${d.hcode}`} target="_blank" rel="noopener" className="text-primary hover:underline">호갱노노</a>}
                            <a href={naverMapUrl(d.naver_place_id, `${d.name} ${d.dong}`, isMobile)} target="_blank" rel="noopener" className="text-primary hover:underline">네이버지도</a>
                            {d.naver_complex_id
                              ? <a href={naverLandUrl(d.naver_complex_id, isMobile, d.pyeong_type_nos)} target="_blank" rel="noopener" className="text-primary hover:underline">네이버부동산</a>
                              : <a href={naverLandSearchUrl(d.name, isMobile)} target="_blank" rel="noopener" className="text-muted-foreground hover:underline">네이버부동산</a>
                            }
                            <AllTypesDialog name={d.name} allData={tradeFilteredData} favorites={favorites} onToggleFav={toggleFav} />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-center text-xs">{d.households != null ? (<div className="leading-tight"><div>{d.households.toLocaleString()}</div>{d.type_units != null && <div className="text-muted-foreground text-[10px]">({d.type_units.toLocaleString()})</div>}</div>) : "-"}</TableCell>
                      <TableCell className="text-center text-sm"><PricePopover data={d} capitalMan={capital ? parseFloat(capital) * 10000 : null} extraLoanMan={extraLoan ? parseFloat(extraLoan) * 10000 : 0} income1Man={income1 ? parseFloat(income1) * 10000 : 0} income2Man={income2 ? parseFloat(income2) * 10000 : 0} loanYears={parseInt(loanYears) || 30} extraRepayYrs={parseInt(extraRepayYears) || 2} firstTimeBuyer={firstTimeBuyer} loanProduct={loanProduct} interestSubsidy={interestSubsidy} includeInterior={includeInterior} /></TableCell>
                      <TableCell className="text-center text-sm"><MoveInCell data={d} allData={tradeFilteredData} targetMonth={moveInMonth} enabled={naverColEnabled} /></TableCell>
                      <TableCell className="text-center"><Sparkline data={sparkData} pctRange={globalPctRange} /></TableCell>
                      <TableCell className="text-center"><AccelPopover data={d} halfLabel={accelHalfLabel} /></TableCell>
                      <TableCell className="text-center"><LiquidityCell data={d} /></TableCell>
                      {isFirst && <TableCell rowSpan={span} className="text-center align-middle"><CommutePopover data={d} slot={commuteSlot} /></TableCell>}
                      {isFirst && <TableCell rowSpan={span} className="text-center align-middle"><PedPopover data={d} /></TableCell>}
                      {isFirst && <TableCell rowSpan={span} className="text-center align-middle"><SlopePopover data={d} /></TableCell>}
                      {isFirst && <TableCell rowSpan={span} className="text-center align-middle"><ParkingCell data={d} /></TableCell>}
                      {isFirst && <TableCell rowSpan={span} className="text-center align-middle"><SchoolCell data={d} /></TableCell>}
                      {isFirst && (
                        <TableCell rowSpan={span} className="text-center align-middle">
                          <Popover>
                            <PopoverTrigger className="cursor-pointer">
                              <LabelText label={safetyLabel(d.safety_grade)} />
                            </PopoverTrigger>
                            <PopoverContent className="w-56 text-xs">
                              <p className="font-semibold mb-2">치안 점수 — {d.region}</p>
                              {d.safety_score != null ? (
                                <div className="flex flex-col gap-1">
                                  <div className="flex justify-between"><span className="text-muted-foreground">종합 점수</span><span className="font-bold text-sm">{d.safety_score}<span className="text-[10px] font-normal text-muted-foreground">/100</span></span></div>
                                  <div className="border-t border-border/50 pt-1 mt-0.5" />
                                  <div className="flex justify-between"><span className="text-muted-foreground">범죄 안전등급</span><span>{d.safety_grade}등급 ({d.safety_grade_label})</span></div>
                                  <div className="flex justify-between"><span className="text-muted-foreground">외국인 비율</span><span>{d.foreign_rate}%</span></div>
                                  <div className="flex justify-between"><span className="text-muted-foreground">외국인 수</span><span>{d.foreign_count?.toLocaleString()}명</span></div>
                                  <div className="flex justify-between"><span className="text-muted-foreground">시군구 인구</span><span>{d.safety_population ? (d.safety_population / 10000).toFixed(1) + "만" : "-"}</span></div>
                                  <div className="border-t border-border/50 pt-1 mt-0.5" />
                                  <p className="text-[10px] text-muted-foreground">범죄등급: 행안부 지역안전지수 2024 (1=최고~5=최저)</p>
                                  <p className="text-[10px] text-muted-foreground">외국인: 법무부 등록외국인 2025-02</p>
                                </div>
                              ) : <span className="text-muted-foreground">데이터 없음</span>}
                            </PopoverContent>
                          </Popover>
                        </TableCell>
                      )}
                      {isFirst && <TableCell rowSpan={span} className="text-center align-middle"><EqCell data={d} /></TableCell>}
                      {isFirst && <TableCell rowSpan={span} className="text-center align-middle"><LhCell data={d} /></TableCell>}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {viewMode === "map" && (
          <div className="mb-4">
            <MapErrorBoundary>
              <Suspense fallback={<div className="w-full h-[500px] rounded-lg border flex items-center justify-center text-muted-foreground">지도 로딩...</div>}>
                <AptMap data={filtered} myLocation={myLocation} />
              </Suspense>
            </MapErrorBoundary>
          </div>
        )}

        {viewMode === "table" && <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="w-6 text-center"></TableHead>
                <TableHead className="w-8 text-center">#</TableHead>
                <TableHead className="min-w-[160px]">단지명</TableHead>
                <TableHead className="text-center">세대수</TableHead>
                <TableHead className="text-center">현재가</TableHead>
                  <TableHead className="text-center" title="네이버 실매물 중 입주가능월까지 입주 가능한 매매 최저가 (세낀 제외)">호가</TableHead>
                <TableHead className="text-center w-20">추이</TableHead>
                <TableHead className="text-center">가속도</TableHead>
                <TableHead className="text-center">환금</TableHead>
                <TableHead className="text-center">출퇴근</TableHead>
                <TableHead className="text-center">소아과</TableHead>
                <TableHead className="text-center">고저차</TableHead>
                <TableHead className="text-center">주차</TableHead>
                <TableHead className="text-center">초등학교</TableHead>
                <TableHead className="text-center">안전</TableHead>
                <TableHead className="text-center">내진</TableHead>
                <TableHead className="text-center">LH</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.slice(0, visibleCount).map((d, i) => {
                const sparkData = d.recent_trades
                  ?.filter((t) => t.date >= trendCutoff)
                  .slice()
                  .reverse()
                  .map((t) => ({ date: t.date, price: t.price })) ?? [];
                const favKey = `${d.name}|${d.atype}`;
                const isFav = favorites.has(favKey);
                return (
                  <TableRow key={favKey} data-apt={d.name} className={cn(isFav && "bg-primary/5", highlightedApt === d.name && "!bg-primary/20 animate-pulse")}>
                    <TableCell className={cn("text-center cursor-pointer", isFav && "text-yellow-400")} onClick={() => toggleFav(favKey)}>{isFav ? "★" : "☆"}</TableCell>
                    <TableCell className="text-center text-muted-foreground text-xs">{i + 1}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <div>
                          <span className="text-muted-foreground text-[11px] mr-1">{d.region}</span>
                          <AptInfoPopover d={d} />
                          <Badge variant="outline" className={cn("ml-1 text-[10px]", atypeBadgeColor(d.atype))}>{Math.floor(d.area)}㎡</Badge>
                          <span className="text-muted-foreground text-[10px] ml-0.5">({d.build})</span>
                        </div>
                        <div className="flex gap-2 text-[10px]">
                          {d.hcode && <a href={`https://hogangnono.com/apt/${d.hcode}`} target="_blank" rel="noopener" className="text-primary hover:underline">호갱노노</a>}
                          <a href={naverMapUrl(d.naver_place_id, `${d.name} ${d.dong}`, isMobile)} target="_blank" rel="noopener" className="text-primary hover:underline">네이버지도</a>
                          {d.naver_complex_id
                            ? <a href={naverLandUrl(d.naver_complex_id, isMobile, d.pyeong_type_nos)} target="_blank" rel="noopener" className="text-primary hover:underline">네이버부동산</a>
                            : <a href={naverLandSearchUrl(d.name, isMobile)} target="_blank" rel="noopener" className="text-muted-foreground hover:underline">네이버부동산</a>
                          }
                          <AllTypesDialog name={d.name} allData={tradeFilteredData} favorites={favorites} onToggleFav={toggleFav} />
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-center text-xs">{d.households != null ? (<div className="leading-tight"><div>{d.households.toLocaleString()}</div>{d.type_units != null && <div className="text-muted-foreground text-[10px]">({d.type_units.toLocaleString()})</div>}</div>) : "-"}</TableCell>
                    <TableCell className="text-center text-sm"><PricePopover data={d} capitalMan={capital ? parseFloat(capital) * 10000 : null} extraLoanMan={extraLoan ? parseFloat(extraLoan) * 10000 : 0} income1Man={income1 ? parseFloat(income1) * 10000 : 0} income2Man={income2 ? parseFloat(income2) * 10000 : 0} loanYears={parseInt(loanYears) || 30} extraRepayYrs={parseInt(extraRepayYears) || 2} firstTimeBuyer={firstTimeBuyer} loanProduct={loanProduct} interestSubsidy={interestSubsidy} includeInterior={includeInterior} /></TableCell>
                      <TableCell className="text-center text-sm"><MoveInCell data={d} allData={tradeFilteredData} targetMonth={moveInMonth} enabled={naverColEnabled} /></TableCell>
                    <TableCell className="text-center"><Sparkline data={sparkData} pctRange={globalPctRange} /></TableCell>
                    <TableCell className="text-center"><AccelPopover data={d} halfLabel={accelHalfLabel} /></TableCell>
                    <TableCell className="text-center"><LiquidityCell data={d} /></TableCell>
                    <TableCell className="text-center"><CommutePopover data={d} slot={commuteSlot} /></TableCell>
                    <TableCell className="text-center"><PedPopover data={d} /></TableCell>
                    <TableCell className="text-center"><SlopePopover data={d} /></TableCell>
                    <TableCell className="text-center"><ParkingCell data={d} /></TableCell>
                    <TableCell className="text-center"><SchoolCell data={d} /></TableCell>
                    <TableCell className="text-center">
                      <Popover>
                        <PopoverTrigger className="cursor-pointer">
                          <LabelText label={safetyLabel(d.safety_grade)} />
                        </PopoverTrigger>
                        <PopoverContent className="w-56 text-xs">
                          <p className="font-semibold mb-2">범죄 안전등급 — {d.region}</p>
                          {d.safety_grade != null ? (
                            <div className="flex flex-col gap-1">
                              <div className="flex justify-between"><span className="text-muted-foreground">안전등급</span><span className="font-bold">{d.safety_grade}등급 ({d.safety_grade_label})</span></div>
                              <p className="text-[10px] text-muted-foreground">행안부 지역안전지수 2024 (1=최고~5=최저)</p>
                              <div className="border-t border-border/50 pt-1 mt-0.5" />
                              <p className="text-[10px] text-muted-foreground mb-0.5">참고: 외국인 현황</p>
                              <div className="flex justify-between"><span className="text-muted-foreground">외국인 비율</span><span>{d.foreign_rate}%</span></div>
                              <div className="flex justify-between"><span className="text-muted-foreground">외국인 수</span><span>{d.foreign_count?.toLocaleString()}명</span></div>
                              <div className="flex justify-between"><span className="text-muted-foreground">시군구 인구</span><span>{d.safety_population ? (d.safety_population / 10000).toFixed(1) + "만" : "-"}</span></div>
                              <p className="text-[10px] text-muted-foreground mt-0.5">법무부 등록외국인 2025-02</p>
                            </div>
                          ) : <span className="text-muted-foreground">데이터 없음</span>}
                        </PopoverContent>
                      </Popover>
                    </TableCell>
                    <TableCell className="text-center"><EqCell data={d} /></TableCell>
                    <TableCell className="text-center"><LhCell data={d} /></TableCell>
                  </TableRow>
                );
              })}
              {visibleCount < filtered.length && (
                <TableRow ref={sentinelRef}>
                  <TableCell colSpan={17} className="text-center text-xs text-muted-foreground py-3">
                    {filtered.length - visibleCount}개 더 불러오는 중…
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>}
        <div className="h-20" />
      </div>

      {/* 검색 열렸을 때 바깥 클릭 감지 backdrop (패널 z-50 아래) → 닫기 */}
      {searchOpen && (
        <div className="fixed inset-0 z-40" onClick={() => { setSearchOpen(false); clearSearch(); }} aria-hidden />
      )}
      {/* 플로팅 검색 (Spotlight style) — 보도자료 모달 열렸을 때 숨김 */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-full max-w-md px-4 body-[molit-press-open]:hidden [body.molit-press-open_&]:hidden">
        {!searchOpen ? (
          <button
            onClick={() => { setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 50); }}
            className="w-full flex items-center gap-2 px-4 py-2.5 rounded-full bg-muted/80 backdrop-blur border border-border/50 text-sm text-muted-foreground shadow-lg hover:bg-muted transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            아파트 검색...
            <kbd className="ml-auto text-[10px] bg-background/50 px-1.5 py-0.5 rounded border border-border/50">⌘K</kbd>
          </button>
        ) : (
          <div className="rounded-2xl bg-popover/95 backdrop-blur-xl border border-border shadow-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground shrink-0"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input
                ref={searchRef}
                defaultValue=""
                onChange={(e) => onSearchInput(e.target.value)}
                placeholder="단지명, 법정동, 도로명으로 검색..."
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
                autoFocus
              />
              {searchQuery && (
                <button onClick={() => clearSearch()} className="text-muted-foreground hover:text-foreground text-xs">✕</button>
              )}
              <kbd className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded cursor-pointer" onClick={() => { setSearchOpen(false); clearSearch(); }}>ESC</kbd>
            </div>
            {searchResults.length > 0 && (
              <div className="max-h-96 overflow-y-auto py-1">
                {searchResults.map((d: any, i) => {
                  const inFilter = d._inFilter;
                  const reason = inFilter ? null : getFilterReason(d);
                  const favKey = `${d.name}|${d.atype}`;
                  const isFav = favorites.has(favKey);
                  const prev = searchResults[i - 1];
                  const isFirstOfName = !prev || prev.name !== d.name;
                  return (
                    <div
                      key={favKey}
                      className={cn(
                        "w-full flex items-center gap-2 px-4 py-2 text-left text-sm transition-colors border-l-2",
                        inFilter ? "hover:bg-muted/50 border-transparent" : "border-transparent",
                        isFirstOfName && i > 0 && "border-t border-border/40 mt-0.5 pt-2"
                      )}
                    >
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleFav(favKey); }}
                        className={cn("shrink-0 cursor-pointer text-base leading-none w-5 text-center", isFav && "text-yellow-400")}
                        title={isFav ? "즐겨찾기 해제" : "즐겨찾기 추가"}
                      >{isFav ? "★" : "☆"}</button>
                      <button
                        disabled={!inFilter}
                        className={cn("flex-1 min-w-0 flex items-center gap-3 text-left", inFilter ? "cursor-pointer" : "cursor-not-allowed")}
                        onClick={() => {
                          if (!inFilter) return;
                          setSearchOpen(false); clearSearch();
                          setHighlightedApt(d.name);
                          setTimeout(() => {
                            const row = document.querySelector(`[data-apt="${d.name}"]`);
                            if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
                          }, 50);
                          setTimeout(() => setHighlightedApt(null), 3000);
                        }}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            {isFirstOfName ? (
                              <span className={cn("font-medium truncate", !inFilter && "text-muted-foreground")}>{d.display_name || d.name}</span>
                            ) : (
                              <span className="text-muted-foreground/50 text-xs">└</span>
                            )}
                            <Badge variant="outline" className={cn("text-[9px] shrink-0", atypeBadgeColor(d.atype))}>{Math.floor(d.area)}㎡</Badge>
                            <span className="text-xs text-muted-foreground">{(d.avg / 10000).toFixed(1)}억</span>
                          </div>
                          {isFirstOfName && (
                            <div className="text-[11px] text-muted-foreground mt-0.5">
                              {d.region} {d.dong} · {d.build}년
                              {d.households ? ` · ${d.households.toLocaleString()}세대` : ""}
                              {reason && <span className="text-destructive font-medium text-xs"> · {reason}</span>}
                            </div>
                          )}
                        </div>
                        <span className={cn("text-xs font-medium shrink-0 tabular-nums", d.accel == null ? "text-muted-foreground" : d.accel > 0 ? "text-emerald-500" : d.accel < 0 ? "text-red-500" : "text-muted-foreground")}>
                          {d.accel == null ? "-" : `${d.accel > 0 ? "+" : ""}${d.accel}%`}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {searchQuery && searchResults.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">검색 결과 없음</div>
            )}
          </div>
        )}
        <CompareDialog
          open={compareOpen}
          onOpenChange={setCompareOpen}
          items={data.filter((d) => favorites.has(`${d.name}|${d.atype}`))}
          onRemove={toggleFav}
          slot={commuteSlot}
        />
      </div>
    </div>
  );
}
