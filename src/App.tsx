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
  commuteLabel, pedLabel, parkingLabel, parkingGrade, liquidityLabel, safetyLabel, naverMapUrl, naverLandUrl, naverArticleUrl, naverLandSearchUrl, type Label,
} from "@/lib/scoring";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { unpackPriceSeries } from "@/lib/pricePack";
import { CLOUD_SYNC_EVENT } from "@/lib/sync";
import { fetchKbLivePrice, type KbLivePrice } from "@/lib/kbLivePrice";
import { getProxyUrl, setProxyUrl, getProxyToken, setProxyToken, useColumnListings, articlesForAtype, isMovableBy, isTenant, isOwnerJeonse, moveInLabel, formatWon, formatArticlePrice, formatConfirm, verifyLabel, type NaverArticle } from "@/lib/useNaverArticles";
import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import { lazy, Suspense } from "react";
const AptMap = lazy(() => import("@/components/AptMap"));
const MolitPressViewer = lazy(() => import("@/components/MolitPressViewer"));
const AuthButton = lazy(() => import("@/components/AuthButton"));

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

// 기본값에서 벗어난(활성) 필터 트리거 강조 스타일
const FILTER_ON = "border-primary/60 bg-primary/10 text-primary dark:bg-primary/15 dark:hover:bg-primary/20";

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

// 상승력 — "얼마나 크고 꾸준히 잘 오르는가"를 한 수치로.
// 크기: 가격 vs 시간 Theil-Sen 기울기(쌍별 기울기 중앙값) → 이상치(급매/고층) 면역, 중간점 절벽 없음.
// 일관성: Kendall's tau(시간↔가격 순위상관) → 매 거래 일관 상승할수록 1, 오락가락하면 0.
// 가중: %변화 × (0.5 + 0.5·|tau|). 같은 +%여도 일관 상승 단지가 높게.
//   버킷 내 층/면적 노이즈로 tau가 1까지 안 가는 게 정상(중앙 0.39)이라 최대 절반까지만 감점.
// 결과 스케일은 기존과 동일('선택기간 절반' %환산)이라 임계값(>5%/0%)·필터 그대로.
function robustAccel(
  trades: { date: string; price: number }[],
  windowMonths: number,
): { value: number | null; tau: number | null } {
  const pts = trades
    .filter((t) => t.price > 0)
    .map((t) => ({ x: Date.parse(t.date) / 86400000, y: t.price })) // x: 일(day), y: 억
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return { value: null, tau: null };
  const base = median(pts.map((p) => p.y)); // 가격 중앙값 (억)
  if (!(base > 0)) return { value: null, tau: null };
  const slopes: number[] = [];
  let conc = 0, disc = 0, tie = 0; // 일치/불일치/동률 쌍 (Kendall)
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x;
      if (dx === 0) continue; // 같은 날 → 시간순서 불명
      const dy = pts[j].y - pts[i].y;
      slopes.push(dy / dx); // 억 per day
      const s = Math.sign(dx) * Math.sign(dy);
      if (s > 0) conc++; else if (s < 0) disc++; else tie++;
    }
  if (!slopes.length) return { value: null, tau: null }; // 모든 거래가 같은 날
  const denom = conc + disc + tie;
  const tau = denom ? (conc - disc) / denom : 0; // ∈[-1,1]: +1=매 거래 일관 상승
  const halfDays = (windowMonths / 2) * 30.44;
  const pct = ((median(slopes) * halfDays) / base) * 100;
  const weighted = pct * (0.5 + 0.5 * Math.abs(tau)); // 일관성 가중 (부호 유지)
  return { value: Math.round(weighted * 10) / 10, tau: Math.round(tau * 100) / 100 };
}

function Sparkline({ data, pctRange, autoRange }: { data: { date: string; price: number }[]; pctRange: number; autoRange?: boolean }) {
  const [hover, setHover] = useState<{ x: number; y: number; date: string; price: number } | null>(null);
  if (!data.length) return null;
  const prices = data.map((d) => d.price);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  // 장기(autoRange): 실제 가격 min/max 에 여백을 둬 변동을 꽉 채워 표시.
  // 단기: 전 단지 공통 pctRange(mean 기준)로 스케일 통일.
  let min: number, max: number;
  if (autoRange) {
    const lo = Math.min(...prices), hi = Math.max(...prices);
    const pad = (hi - lo) * 0.12 || hi * 0.02 || 1;
    min = lo - pad; max = hi + pad;
  } else {
    min = mean * (1 - pctRange);
    max = mean * (1 + pctRange);
  }
  const range = max - min || 1;
  const w = 80, h = 24, pad = 2;
  const pts = data.map((d, i) => ({
    x: pad + (i / Math.max(data.length - 1, 1)) * (w - pad * 2),
    y: h - pad - ((d.price - min) / range) * (h - pad * 2),
    date: d.date,
    price: d.price,
  }));
  // 계단형(step-after): 각 시점의 값을 다음 시점까지 수평 유지 후 수직 점프
  const points = pts
    .map((p, i) => (i === 0 ? `${p.x},${p.y}` : `${p.x},${pts[i - 1].y} ${p.x},${p.y}`))
    .join(" ");
  const last = prices[prices.length - 1];
  const first = prices[0];
  const color = last >= first ? "#4ade80" : "#f87171";
  // 호버: 점이 수백 개(전체 기간 개별 거래)여도 가볍도록 단일 mousemove로 최근접 점 탐색.
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const mx = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = pts[0];
    let bd = Infinity;
    for (const p of pts) {
      const dd = Math.abs(p.x - mx);
      if (dd < bd) { bd = dd; best = p; }
    }
    setHover({ x: best.x, y: best.y, date: best.date, price: best.price });
  };
  return (
    <div className="relative inline-block">
      <svg width={w} height={h} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
        {hover && <circle cx={hover.x} cy={hover.y} r={2.5} fill={color} />}
      </svg>
      {hover && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-1.5 py-0.5 bg-popover border rounded shadow text-[10px] whitespace-nowrap z-50 pointer-events-none">
          {hover.date.slice(2).replace(/-/g, ".")} <span className="font-medium">{hover.price}억</span>
        </div>
      )}
    </div>
  );
}

// 장기 추이 차트 — 전체 기간 개별 실거래(ps 압축 시계열)를 시간축 비례 라인으로.
// 샘플링 없이 거래 한 건 한 건 표시. 아래 월별 중앙값 표(long_trend)는 요약으로 유지.
function LongTrendChart({ data, ps, excludeDirect, excludeFirstFloor, trendRange }: { data: [number, number, number][]; ps?: string; excludeDirect?: boolean; excludeFirstFloor?: boolean; trendRange?: string }) {
  const [hi, setHi] = useState<number | null>(null);
  const all = useMemo(() => (ps ? unpackPriceSeries(ps) : null), [ps]);
  // 선택한 추이 기간(trendRange) cutoff — 스파크라인(buildSpark)과 동일 기준. "all"/미지정이면 전체.
  const cutDate = useMemo(() => {
    const m = parseInt(trendRange || "") || 0;
    if (!trendRange || trendRange === "all" || !m) return "";
    const now = new Date();
    const c = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
    return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}-01`;
  }, [trendRange]);
  const rangeLabel = ({ "3": "3개월", "6": "6개월", "12": "1년", "36": "3년", "60": "5년", all: "전체" } as Record<string, string>)[trendRange || "all"] ?? "전체";
  // 차트는 개별 실거래 — 직거래/1층 제외 토글 + 추이 기간 반영. ps 없는 구버전 데이터는 월별 중앙값 fallback.
  const series = useMemo(() => {
    const base = all
      ? all.filter((t) => !(excludeDirect && t.direct) && !(excludeFirstFloor && t.firstFloor))
      : data.map(([ym, p]) => ({ date: `${String(ym).slice(0, 4)}-${String(ym).slice(4, 6)}-15`, price: p, direct: false, firstFloor: false }));
    return cutDate ? base.filter((t) => t.date >= cutDate) : base;
  }, [all, data, excludeDirect, excludeFirstFloor, cutDate]);
  // 월별 중앙값 표 — ps가 있으면 토글 반영된 개별 거래로 재집계, 없으면 long_trend 그대로.
  const monthly = useMemo<[number, number, number][]>(() => {
    if (!all) return data;
    const m = new Map<string, number[]>();
    for (const t of series) {
      const ym = t.date.slice(0, 7);
      let arr = m.get(ym);
      if (!arr) { arr = []; m.set(ym, arr); }
      arr.push(t.price);
    }
    return [...m.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([ym, arr]) => {
        const s = arr.slice().sort((x, y) => x - y);
        const md = s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
        return [Number(ym.replace("-", "")), Math.round(md * 10) / 10, arr.length];
      });
  }, [all, series, data]);
  if (!series.length) return <p className="text-xs text-muted-foreground py-2">{rangeLabel} 기간 거래 없음</p>;
  const prices = series.map((s) => s.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const w = 300, h = 120, padX = 6, padTop = 8, padBottom = 16;
  const dayOf = (date: string) => Date.parse(date) / 86400000;
  const t0 = dayOf(series[0].date), tSpan = dayOf(series[series.length - 1].date) - t0 || 1;
  const xOf = (date: string) => padX + ((dayOf(date) - t0) / tSpan) * (w - padX * 2);
  const yOf = (p: number) => padTop + (1 - (p - min) / range) * (h - padTop - padBottom);
  const pts = series.map((s, i) => ({ x: xOf(s.date), y: yOf(s.price), date: s.date, price: s.price, i }));
  // 계단형(step-after): 각 거래가의 값을 다음 거래까지 수평 유지 후 수직 점프
  const poly = pts
    .map((p, i) => (i === 0 ? `${p.x},${p.y}` : `${p.x},${pts[i - 1].y} ${p.x},${p.y}`))
    .join(" ");
  const first = prices[0], last = prices[prices.length - 1];
  const chg = Math.round(((last - first) / first) * 1000) / 10;
  const yrs = tSpan / 365.25;
  const cagr = yrs >= 1 ? Math.round((Math.pow(last / first, 1 / yrs) - 1) * 1000) / 10 : null;
  const color = last >= first ? "#10b981" : "#ef4444";
  const fmtDate = (d: string) => d.slice(2).replace(/-/g, ".");
  // 연도 경계 세로선 + 라벨
  const yStart = Number(series[0].date.slice(0, 4)), yEnd = Number(series[series.length - 1].date.slice(0, 4));
  const years: number[] = [];
  for (let y = yStart; y <= yEnd; y++) years.push(y);
  const hv = hi != null ? pts[hi] : null;
  // 점 수백 개여도 가볍도록 단일 mousemove 최근접 탐색.
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const mx = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0, bd = Infinity;
    for (const p of pts) { const dd = Math.abs(p.x - mx); if (dd < bd) { bd = dd; best = p.i; } }
    setHi(best);
  };
  return (
    <div className="text-xs">
      <div className="flex items-baseline justify-between mb-1">
        <span className="font-semibold">추이 {rangeLabel} · {series.length}건</span>
        <span className={chg >= 0 ? "text-emerald-500" : "text-red-500"}>{first}억 → {last}억 ({chg >= 0 ? "+" : ""}{chg}%)</span>
      </div>
      <div className="relative" style={{ width: w, height: h }}>
        <svg width={w} height={h} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
          {years.map((y) => {
            const x = xOf(`${y}-01-01`);
            if (x < padX || x > w - padX) return null;
            return <line key={y} x1={x} y1={padTop} x2={x} y2={h - padBottom} stroke="currentColor" strokeWidth="0.5" className="text-muted-foreground/15" />;
          })}
          <polyline points={poly} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
          {hv && <circle cx={hv.x} cy={hv.y} r={3} fill={color} />}
          {years.map((y) => {
            const x = xOf(`${y}-07-01`);
            if (x < padX || x > w - padX) return null;
            return <text key={`l${y}`} x={x} y={h - 4} textAnchor="middle" className="fill-muted-foreground text-[8px]">'{String(y).slice(2)}</text>;
          })}
        </svg>
        {hv && (
          <div className="absolute -top-1 px-1.5 py-0.5 bg-popover border rounded shadow text-[10px] whitespace-nowrap z-50 pointer-events-none -translate-x-1/2" style={{ left: hv.x }}>
            {fmtDate(hv.date)} <span className="font-medium">{hv.price}억</span>
          </div>
        )}
      </div>
      <div className="flex justify-between text-muted-foreground mt-1">
        <span>최저 {min}억 · 최고 {max}억</span>
        {cagr != null && <span>연 {cagr >= 0 ? "+" : ""}{cagr}%</span>}
      </div>
      {/* 월별 중앙값 표 (최신순, 스크롤) — 요약 */}
      <div className="mt-2 border-t pt-1 max-h-40 overflow-y-auto">
        <table className="w-full text-[11px] tabular-nums">
          <thead className="sticky top-0 bg-popover">
            <tr className="text-muted-foreground"><th className="text-left font-normal pb-0.5">월</th><th className="text-right font-normal">중앙값</th><th className="text-right font-normal">건수</th></tr>
          </thead>
          <tbody>
            {[...monthly].reverse().map(([ym, p, c], i) => (
              <tr key={ym} className={i ? "" : "font-medium"}>
                <td className="text-left">{Math.floor(ym / 100)}.{String(ym % 100).padStart(2, "0")}</td>
                <td className="text-right">{p}억</td>
                <td className="text-right text-muted-foreground">{c}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground text-[10px] mt-0.5">차트: 개별 실거래 · 표: 월별 중앙값{excludeDirect || excludeFirstFloor ? ` · ${[excludeDirect && "직거래", excludeFirstFloor && "1층"].filter(Boolean).join("/")} 제외` : ""}</p>
    </div>
  );
}

// 추이 셀 — Sparkline(최근) 표시, 클릭 시 장기 추이 차트 팝오버
function TrendCell({ d, spark, pctRange, autoRange, excludeDirect, excludeFirstFloor, trendRange }: { d: AptData; spark: { date: string; price: number }[]; pctRange: number; autoRange?: boolean; excludeDirect?: boolean; excludeFirstFloor?: boolean; trendRange?: string }) {
  const lt = d.long_trend ?? [];
  if (!spark.length && !lt.length && !d.ps) return <span className="text-muted-foreground">-</span>;
  return (
    <Popover>
      <PopoverTrigger className="cursor-pointer inline-block" title="장기 추이 보기">
        {spark.length ? <Sparkline data={spark} pctRange={pctRange} autoRange={autoRange} /> : <span className="text-muted-foreground text-[10px]">장기↗</span>}
      </PopoverTrigger>
      <PopoverContent className="w-auto"><LongTrendChart data={lt} ps={d.ps} excludeDirect={excludeDirect} excludeFirstFloor={excludeFirstFloor} trendRange={trendRange} /></PopoverContent>
    </Popover>
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
        <p className="mt-2 pt-2 border-t text-muted-foreground text-[10px]">점수 = 가장 가까운 1곳 도보 + |고저차|×0.2</p>
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

// 규제지역: 서울 전 25구(투기과열·조정대상), 성남(분당/수정/중원), 수원(영통/장안/팔달), 용인 수지, 하남, 의왕, 과천
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
  "용인시 수지구", "하남시", "의왕시", "과천시",
]);

// 사내 이자지원 (주택구입 매매대출): 본인 2% 부담, 초과분 회사 지원
// 기본적으로 일반 주담대 대상. 정책상품의 경우 특정 은행에서만 가능:
// 신한은행 신생아특례 / SC제일은행 u-보금자리(특례보금자리론).
// 한도: 매매가 50% / 최대 15,000만원
const SUBSIDY_USER_RATE = 0.02;
const SUBSIDY_MAX_AMOUNT = 15000; // 만원
const SUBSIDY_LTV = 0.5;

// ───────── 대출상품 (2026-06-01 HF·주택도시기금 공시 기준) ─────────
// 검증 출처: hf.go.kr 디딤돌 상품소개/금리안내, 보금자리론 상품소개/금리안내, myhome.go.kr 신생아특례.
// 가구유형(생애최초/신혼/자녀/출산)에 따라 소득상한·주택가·한도·금리가 모두 달라짐 → 함수형 getLoanTerms.
// LTV: 정책상품 생애최초 80%는 수도권·규제지역 제외 — 본 앱 대상(서울·경기 전역)은 사실상 70% 고정.
type LoanProduct = "normal" | "didimdol" | "bogeumjari" | "newborn";
// 가구 프로필 — 자금 설정에서 입력, 상품별 자격·금리 판정에 사용
type HouseholdProfile = {
  firstTime: boolean;   // 생애최초 주택 구입
  newlywed: boolean;    // 혼인신고 7년 이내 (결혼예정 포함)
  children: number;     // 미성년 자녀 수 (3 = 3명 이상)
  recentBirth: boolean; // 대출접수일 기준 2년 내 출산·입양
};
const LOAN_PRODUCT_KEYS: LoanProduct[] = ["normal", "didimdol", "bogeumjari", "newborn"];
type LoanTerms = {
  name: string;
  rate: number;     // 적용 금리 (소득·만기·가구 우대 반영)
  rateMin: number;  // 소득 미입력 시 표시용 범위
  rateMax: number;
  maxLoan: number;    // 최대 대출 한도 (만원). 0 = 없음
  maxPrice: number;   // 주택가격 한도 (만원). 0 = 없음
  maxIncome: number;  // 부부합산 소득 한도 (만원). 0 = 없음
  maxAreaSqm: number; // 전용면적 한도 (㎡). 0 = 없음
  forceLtv?: number;  // LTV 강제 (정책상품)
  desc: string;
  eligNotes: string[]; // 가구·소득 차원 자격미달 사유 (단지 무관 — 가격/면적은 calcAffordability에서)
};
const fmtManwon = (man: number) => man >= 10000 ? `${man % 10000 === 0 ? man / 10000 : (man / 10000).toFixed(1)}억` : `${man / 1000}천만`;
const termIdx4 = (years: number) => years <= 10 ? 0 : years <= 15 ? 1 : years <= 20 ? 2 : 3;

// 디딤돌 금리표 (2026-06-01 공시): 부부합산 소득구간 × 만기(10/15/20/30년). 신혼가구는 별도 특례표.
const DIDIMDOL_RATES: Array<{ upper: number; general: [number, number, number, number]; newlywed: [number, number, number, number] }> = [
  { upper: 2000, general: [0.0285, 0.0295, 0.0305, 0.0310], newlywed: [0.0255, 0.0265, 0.0275, 0.0280] },
  { upper: 4000, general: [0.0320, 0.0330, 0.0340, 0.0345], newlywed: [0.0290, 0.0300, 0.0310, 0.0315] },
  { upper: 7000, general: [0.0355, 0.0365, 0.0375, 0.0380], newlywed: [0.0325, 0.0335, 0.0345, 0.0350] },
  { upper: 8500, general: [0.0390, 0.0400, 0.0410, 0.0415], newlywed: [0.0360, 0.0370, 0.0380, 0.0385] },
];
function getDidimdolRate(incomeMan: number, years: number, p: HouseholdProfile): number {
  const idx = termIdx4(years);
  const row = DIDIMDOL_RATES.find((r) => incomeMan <= r.upper) ?? DIDIMDOL_RATES[DIDIMDOL_RATES.length - 1];
  let rate = p.newlywed ? row.newlywed[idx] : row.general[idx];
  // 우대: 생애최초 0.2%p는 신혼 등과 택1(신혼특례표 사용 시 미적용), 자녀 우대는 중복 가능
  if (!p.newlywed && p.firstTime) rate -= 0.002;
  rate -= p.children >= 3 ? 0.007 : p.children === 2 ? 0.005 : p.children === 1 ? 0.003 : 0;
  return Math.max(rate, 0.015); // 우대 적용 후 하한 1.5%
}

// 보금자리론(아낌e) 만기별 기준금리 (2026-06-01 공시) + 우대 최대 1.0%p 중복, 규제지역 +0.1%p 가산
const BOGEUMJARI_RATES: Array<[number, number]> = [[10, 0.0460], [15, 0.0470], [20, 0.0475], [30, 0.0480], [40, 0.0485], [50, 0.0490]];
function getBogeumjariRate(years: number, p: HouseholdProfile, regulated: boolean): number {
  const base = (BOGEUMJARI_RATES.find(([y]) => years <= y) ?? BOGEUMJARI_RATES[BOGEUMJARI_RATES.length - 1])[1];
  let disc = 0;
  if (p.newlywed) disc += 0.003;
  disc += p.children >= 3 ? 0.007 : p.children >= 2 ? 0.005 : 0;
  if (p.recentBirth) disc += 0.002;
  return base - Math.min(disc, 0.010) + (regulated ? 0.001 : 0);
}

// 신생아 특례 디딤돌 금리표 (2026-06 myhome.go.kr 공시와 일치 확인)
// 부부합산 소득(만원) × 만기(10/15/20/30년) — 특례금리 기본 5년, 우대금리 별도
// 1.3억 초과 구간은 맞벌이 전용 — 자격 검증은 getLoanTerms 에서 (여기선 금리만)
function getNewbornRate(incomeMan: number, years: number): number {
  const brackets: Array<{ upper: number; rates: [number, number, number, number] }> = [
    { upper: 2000,  rates: [0.0180, 0.0190, 0.0200, 0.0205] },
    { upper: 4000,  rates: [0.0215, 0.0225, 0.0235, 0.0240] },
    { upper: 6000,  rates: [0.0240, 0.0250, 0.0260, 0.0265] },
    { upper: 8500,  rates: [0.0265, 0.0275, 0.0285, 0.0290] },
    { upper: 10000, rates: [0.0290, 0.0300, 0.0310, 0.0320] },
    { upper: 13000, rates: [0.0320, 0.0330, 0.0340, 0.0350] },
    { upper: 15000, rates: [0.0350, 0.0360, 0.0370, 0.0380] },
    { upper: 17000, rates: [0.0385, 0.0395, 0.0405, 0.0415] },
    { upper: 20000, rates: [0.0420, 0.0430, 0.0440, 0.0450] },
  ];
  const row = brackets.find((b) => incomeMan <= b.upper) ?? brackets[brackets.length - 1];
  return row.rates[termIdx4(years)];
}

// 상품 × 가구 프로필 × 소득 → 실제 적용 조건. 소득 0(미입력)이면 소득 자격검사 생략.
function getLoanTerms(product: LoanProduct, p: HouseholdProfile, incomeMan: number, dualIncome: boolean, years: number, regulated: boolean, normalRatePct: number): LoanTerms {
  const hasIncome = incomeMan > 0;
  if (product === "didimdol") {
    // 소득: 일반 6천 / 생초·2자녀 7천 / 신혼 8.5천 · 주택: 일반 5억 / 신혼·2자녀 6억
    // 한도: 일반 2억 / 생초 2.4억 / 신혼·2자녀 3.2억 · 85㎡ 이하 · LTV 70%
    const maxIncome = p.newlywed ? 8500 : (p.firstTime || p.children >= 2) ? 7000 : 6000;
    const big = p.newlywed || p.children >= 2;
    const eligNotes: string[] = [];
    if (hasIncome && incomeMan > maxIncome) eligNotes.push(`부부합산 소득 ${fmtManwon(maxIncome)} 초과`);
    return {
      name: "디딤돌", rate: getDidimdolRate(incomeMan, years, p), rateMin: 0.0255, rateMax: 0.0415,
      maxLoan: big ? 32000 : p.firstTime ? 24000 : 20000, maxPrice: big ? 60000 : 50000,
      maxIncome, maxAreaSqm: 85, forceLtv: 0.7,
      desc: `소득 ${fmtManwon(maxIncome)}↓ · 주택 ${big ? "6억" : "5억"}↓ · 85㎡↓ · 한도 ${fmtManwon(big ? 32000 : p.firstTime ? 24000 : 20000)}`,
      eligNotes,
    };
  }
  if (product === "bogeumjari") {
    // 소득: 일반 7천 / 신혼 8.5천 / 1자녀 9천 / 2자녀+ 1억 · 주택 6억 · 한도: 일반·신혼 3.6억 / 생초 4.2억 / 다자녀 4억
    const maxIncome = p.children >= 2 ? 10000 : p.children === 1 ? 9000 : p.newlywed ? 8500 : 7000;
    const maxLoan = p.children >= 2 ? 40000 : p.firstTime ? 42000 : 36000;
    const eligNotes: string[] = [];
    if (hasIncome && incomeMan > maxIncome) eligNotes.push(`부부합산 소득 ${fmtManwon(maxIncome)} 초과`);
    return {
      name: "보금자리론", rate: getBogeumjariRate(years, p, regulated), rateMin: 0.0360, rateMax: 0.0490,
      maxLoan, maxPrice: 60000, maxIncome, maxAreaSqm: 0, forceLtv: 0.7,
      desc: `소득 ${fmtManwon(maxIncome)}↓ · 주택 6억↓ · 한도 ${fmtManwon(maxLoan)}`,
      eligNotes,
    };
  }
  if (product === "newborn") {
    // 2년 내 출산 가구 · 소득 1.3억(맞벌이 2억) — 2.5억 상향안은 미시행 · 9억·85㎡ 이하 · 한도 4억
    const maxIncome = dualIncome ? 20000 : 13000;
    const eligNotes: string[] = [];
    if (!p.recentBirth) eligNotes.push("2년 내 출산 가구 아님");
    if (hasIncome && incomeMan > maxIncome) eligNotes.push(`부부합산 소득 ${dualIncome ? "2억(맞벌이)" : "1.3억(외벌이)"} 초과`);
    return {
      name: "신생아특례", rate: getNewbornRate(incomeMan, years), rateMin: 0.0180, rateMax: 0.0450,
      maxLoan: 40000, maxPrice: 90000, maxIncome, maxAreaSqm: 85, forceLtv: 0.7,
      desc: "출산 2년 내 · 소득 1.3억(맞벌이 2억)↓ · 주택 9억·85㎡↓ · 한도 4억",
      eligNotes,
    };
  }
  // 일반 주담대 — 시중금리는 자금 설정에서 직접 입력 (2026-06 기준 5년 고정 하단 ~5%대, 변동 3.8~4.2%)
  const r = (normalRatePct || 5.2) / 100;
  return { name: "일반 주담대", rate: r, rateMin: r, rateMax: r, maxLoan: 0, maxPrice: 0, maxIncome: 0, maxAreaSqm: 0, desc: "은행 자체상품 — 금리는 자금 설정에서 변경", eligNotes: [] };
}

function calcAffordability(priceMan: number, capitalMan: number, extraLoanLimit: number, income1Man: number, income2Man: number, years: number, extraRepayYrs: number, areaSqm: number | undefined, profile: HouseholdProfile, regulated: boolean = false, product: LoanProduct = "normal", interestSubsidy: boolean = false, interiorCost: number = 0, kbPriceMan: number | null = null, normalRatePct: number = 5.2) {
  const incomeMan = income1Man + income2Man;
  const firstTimeBuyer = profile.firstTime;
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
  const dualIncome = income1Man > 0 && income2Man > 0;
  const chosen = getLoanTerms(product, profile, incomeMan, dualIncome, years, regulated, normalRatePct);
  // 자격 미달(가구·소득 + 단지별 가격·면적) 시 일반 주담대 조건으로 fallback 계산 — 미달 상품 조건으로 계산하는 비현실 방지
  const eligIssues: string[] = [...chosen.eligNotes];
  if (chosen.maxPrice > 0 && priceMan > chosen.maxPrice) eligIssues.push(`주택가격 ${chosen.maxPrice / 10000}억 초과`);
  if (chosen.maxAreaSqm > 0 && (areaSqm ?? 0) > chosen.maxAreaSqm) eligIssues.push(`전용 ${chosen.maxAreaSqm}㎡ 초과`);
  const fellBack = product !== "normal" && eligIssues.length > 0;
  const prodInfo = fellBack ? getLoanTerms("normal", profile, incomeMan, dualIncome, years, regulated, normalRatePct) : chosen;
  // 정책상품 LTV: 규제지역 진입 시 70% 상한 적용
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
  // 정책상품 절대 한도 (fallback 시 일반 주담대 = 한도 없음)
  const productCap = prodInfo.maxLoan > 0 ? prodInfo.maxLoan : Infinity;
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

  // 월납입금/이자총액 — 금리는 상품·가구·소득·만기 반영 (자격미달 시 일반 주담대)
  const mortgageRate = prodInfo.rate;
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

  return { taxRate, acqTax, eduTax, ruralTax, totalTax, netTax, taxExempt, broker, brokerRate, legalFee, stampTax, bondDiscount, miscCost, interiorCost, ltvRate, ltvBase, ltvMax, ltvCap, productCap, eligIssues, fellBack, dsrMax, maxLoan, dsrLimited, totalCapital, extraLoanMan, required, affordable, totalMonthly, mortgageMonthly, extraMonthly, mortgageRate, extraRate, effectiveRate, totalInterest, extraRepayMonthly, extraRepayYrs, netMonthlyIncome, netMonthlyParental, repayRatio, repayRatioParental, years, firstTimeBuyer, regulated, product, productName: fellBack ? `${chosen.name} → 일반` : prodInfo.name, interestSubsidy, subsidyEligible, subsidyAmount, subsidyMonthly, subsidyTotal, grossMortgageMonthly };
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
  const age = new Date().getFullYear() - buildYear;
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

function ArticleCard({ a, targetMonth, pending }: { a: NaverArticle; targetMonth?: string; pending?: boolean }) {
  const movable = targetMonth ? isMovableBy(a, targetMonth) : undefined;
  const ownerJeonse = isOwnerJeonse(a);
  const tenant = isTenant(a);
  const enriching = a.moveIn === undefined && pending; // 스트림 진행 중 + 아직 미수신
  const unknown = a.moveIn === undefined && !pending;  // 스트림 종료 후에도 미상(cap 초과·조회실패)
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
        <span className={cn(enriching ? "text-amber-600 animate-pulse" : unknown ? "text-muted-foreground/60" : !ownerJeonse && !tenant && a.moveIn?.immediate ? "text-emerald-600 font-medium" : "text-muted-foreground")}>{enriching ? "입주확인중…" : unknown ? "입주미상" : moveInLabel(a)}</span>
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
            <div className="space-y-1">{all.map((a) => <ArticleCard key={a.articleNo} a={a} targetMonth={targetMonth} pending={refreshing} />)}</div>
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

function PricePopover({ data, capitalMan, extraLoanMan, income1Man, income2Man, loanYears, extraRepayYrs, household, loanProduct, interestSubsidy, includeInterior, normalRatePct }: { data: AptData; capitalMan: number | null; extraLoanMan: number; income1Man: number; income2Man: number; loanYears: number; extraRepayYrs: number; household: HouseholdProfile; loanProduct: LoanProduct; interestSubsidy: boolean; includeInterior: boolean; normalRatePct: number }) {
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
  const aff = capitalMan != null ? calcAffordability(priceMan, capitalMan, extraLoanMan, income1Man, income2Man, loanYears, extraRepayYrs, data.area, household, regulated, loanProduct, interestSubsidy, interiorForCalc, kbMan, normalRatePct) : null;
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
              <p className="text-[10px] text-amber-500 mb-1">⚠ 자격 미달({aff.eligIssues.join(", ")}){aff.fellBack ? " → 일반 주담대 기준으로 계산" : ""}</p>
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
              <div className="flex justify-between"><span className="text-muted-foreground">중개보수 ({(aff.brokerRate * 110).toFixed(2)}%)</span><span>{aff.broker.toLocaleString()}만원</span></div>
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

function AccelPopover({ data }: { data: AptData }) {
  const tau = data.accel_tau;
  const at = tau == null ? 0 : Math.abs(tau);
  const cons = tau == null ? null : Math.round(at * 100);
  const consLabel = tau == null ? "-" : at >= 0.7 ? "매우 일관" : at >= 0.4 ? "일관" : at >= 0.15 ? "보통" : "들쭉날쭉";
  // 크기 = 일관성 가중 전 원추세 (badge값 ÷ 가중치)
  const raw = data.accel != null && tau != null ? Math.round((data.accel / (0.5 + 0.5 * at)) * 10) / 10 : data.accel;
  return (
    <Popover>
      <PopoverTrigger><span className="cursor-pointer"><AccelBadge value={data.accel} /></span></PopoverTrigger>
      <PopoverContent className="w-60 text-xs">
        <p className="font-semibold mb-1">상승력 = 크기 × 일관성</p>
        <p className="text-muted-foreground mb-2 leading-snug">Theil-Sen 기울기 × Kendall 일관성. 매 거래 꾸준히 오를수록 높음.</p>
        <div className="flex justify-between"><span className="text-muted-foreground">크기 (원추세)</span><span>{raw != null ? `${raw > 0 ? "+" : ""}${raw}%` : "-"}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">일관성</span><span>{cons != null ? `${cons}% · ${consLabel}` : "-"}</span></div>
        <div className="flex justify-between font-medium"><span className="text-muted-foreground">상승력</span><span>{data.accel != null ? `${data.accel > 0 ? "+" : ""}${data.accel}%` : "-"}</span></div>
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
          <div className="flex justify-between"><span className="text-muted-foreground">{atypeLabel(data.atype)} 타입 세대수</span><span>{data.type_units != null ? `${data.type_units.toLocaleString()}세대` : "-"}</span></div>
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
        <div className="flex justify-between"><span className="text-muted-foreground">세대당 주차</span><span>{v}대 · {parkingGrade(v)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">출처</span><span>{data.parking_src === "naver" ? "네이버부동산" : data.parking_src === "building" ? "건축물대장" : data.parking_src === "kapt" ? "K-apt" : "-"}</span></div>
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
                    {!hasAny && <span className="text-emerald-500">4년간 0건</span>}
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
        <p className="text-muted-foreground mt-2 text-[10px]">출처: 학교알리미 ({currentYear - 3}-{currentYear}학년도) · 유형 중복 포함</p>
      </PopoverContent>
    </Popover>
  );
}

function MulticulturalPanel({ mc }: { mc: MulticulturalData }) {
  const [selected, setSelected] = useState<string>("수원시");
  // 데이터에 새 시가 추가되면 자동 반영 (하드코딩 시 신규 지역 누락)
  const targets = Object.keys(mc);
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
                <TableHead className="text-right">상승력</TableHead>
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

// 즐겨찾기 단지 추이 겹쳐보기 — 각 단지의 월별 중앙값 시계열을 한 차트에 오버레이.
const COMPARE_PALETTE = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16", "#06b6d4", "#a855f7"];

function CompareTrendChart({ open, onOpenChange, items, onRemove, excludeDirect, excludeFirstFloor, trendRange }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  items: AptData[];
  onRemove: (key: string) => void;
  excludeDirect?: boolean;
  excludeFirstFloor?: boolean;
  trendRange: string;
}) {
  const [mode, setMode] = useState<"abs" | "delta">("abs"); // 절대가(억) vs 공통기준월 대비 상승액(억, 기준=0)
  const [hoverYm, setHoverYm] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null); // 호버 강조 단지

  // 추이 필터(trendRange) 기간 cutoff (yyyy-mm). "all"이면 전체.
  const cutYm = useMemo(() => {
    const m = parseInt(trendRange) || 0;
    if (trendRange === "all" || !m) return "";
    const now = new Date();
    const c = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
    return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}`;
  }, [trendRange]);

  // 단지별 월별 중앙값 시계열 (직거래/1층 토글 + 추이 기간 반영)
  const seriesList = useMemo(() => {
    return items.map((d, idx) => {
      const trades = d.ps
        ? unpackPriceSeries(d.ps).filter((t) => !(excludeDirect && t.direct) && !(excludeFirstFloor && t.firstFloor))
        : (d.long_trend ?? []).map(([ym, p]) => ({ date: `${String(ym).slice(0, 4)}-${String(ym).slice(4, 6)}-15`, price: p }));
      const m = new Map<string, number[]>();
      for (const t of trades) {
        const ym = t.date.slice(0, 7);
        if (cutYm && ym < cutYm) continue;
        let arr = m.get(ym);
        if (!arr) { arr = []; m.set(ym, arr); }
        arr.push(t.price);
      }
      const monthly = [...m.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([ym, arr]) => {
          const s = arr.slice().sort((x, y) => x - y);
          const md = s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
          return { ym, price: Math.round(md * 10) / 10 };
        });
      const base = monthly[0]?.price ?? 0;
      return {
        key: `${d.name}|${d.atype}`,
        name: d.display_name,
        area: Math.floor(d.area),
        color: COMPARE_PALETTE[idx % COMPARE_PALETTE.length]!,
        base,
        monthly, // [{ym, price}]
        byYm: new Map(monthly.map((p) => [p.ym, p.price])),
      };
    });
  }, [items, excludeDirect, excludeFirstFloor, cutYm]);

  // 상승액(delta) 기준값 = 각 단지의 "표시 기간 내 첫 월별값"(s.base). 그 시점부터 0에서 출발해
  // 얼마(억) 올랐는지 표시. x축 범위는 절대가와 동일(추이 필터 기간 전체) → 모드 전환해도 범위 불변.
  const baseByKey = useMemo(() => new Map(seriesList.map((s) => [s.key, s.base || 0])), [seriesList]);

  // 차트 지오메트리
  const w = 640, h = 280, padL = 40, padR = 12, padTop = 12, padBottom = 28;
  const ymToDay = (ym: string) => Date.parse(`${ym}-15`) / 86400000;
  const allMonths = useMemo(() => [...new Set(seriesList.flatMap((s) => s.monthly.map((p) => p.ym)))].sort(), [seriesList]);
  // delta 모드: 기간 내 첫값(base) 대비 절대 상승액(억) — 각 단지가 자기 시작점에서 0으로 출발.
  const dispVal = (price: number, key: string) => (mode === "delta" ? price - (baseByKey.get(key) ?? 0) : price);
  const deltaOf = (price: number, key: string) => Math.round((price - (baseByKey.get(key) ?? 0)) * 10) / 10;

  const geo = useMemo(() => {
    if (!allMonths.length) return null;
    const days = allMonths.map(ymToDay);
    const t0 = Math.min(...days), t1 = Math.max(...days), tSpan = t1 - t0 || 1;
    let lo = Infinity, hi = -Infinity;
    for (const s of seriesList) for (const p of s.monthly) {
      const v = dispVal(p.price, s.key);
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    const pad = (hi - lo) * 0.08 || hi * 0.05 || 1;
    lo -= pad; hi += pad;
    const range = hi - lo || 1;
    const xOf = (ym: string) => padL + ((ymToDay(ym) - t0) / tSpan) * (w - padL - padR);
    const yOf = (v: number) => padTop + (1 - (v - lo) / range) * (h - padTop - padBottom);
    return { t0, t1, lo, hi, range, xOf, yOf };
  }, [allMonths, seriesList, mode, baseByKey]);

  const years = useMemo(() => {
    if (!allMonths.length) return [];
    const y0 = Number(allMonths[0]!.slice(0, 4)), y1 = Number(allMonths[allMonths.length - 1]!.slice(0, 4));
    const out: number[] = [];
    for (let y = y0; y <= y1; y++) out.push(y);
    return out;
  }, [allMonths]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!geo || !allMonths.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // svg가 축소 렌더(viewBox)될 수 있어 viewBox 좌표로 환산
    const mx = (e.clientX - rect.left) * (w / rect.width);
    const my = (e.clientY - rect.top) * (h / rect.height);
    let best = allMonths[0]!, bd = Infinity;
    for (const ym of allMonths) { const dd = Math.abs(geo.xOf(ym) - mx); if (dd < bd) { bd = dd; best = ym; } }
    setHoverYm(best);
    // 해당 월에서 커서 Y에 가장 가까운 단지 강조
    let nk: string | null = null, ndy = Infinity;
    for (const s of seriesList) {
      const v = s.byYm.get(best);
      if (v == null) continue;
      const dy = Math.abs(geo.yOf(dispVal(v, s.key)) - my);
      if (dy < ndy) { ndy = dy; nk = s.key; }
    }
    setHoverKey(nk);
  };
  const clearHover = () => { setHoverYm(null); setHoverKey(null); };

  const fmtYm = (ym: string) => `${ym.slice(2, 4)}.${ym.slice(5, 7)}`;
  const yTicks = geo ? [geo.lo + geo.range * 0.08, (geo.lo + geo.hi) / 2, geo.hi - geo.range * 0.08] : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-[95vw] sm:!w-fit !max-w-[95vw] max-h-[90vh] overflow-auto flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle>즐겨찾기 추이 비교 — {items.length}개</DialogTitle>
        </DialogHeader>

        {items.length === 0 || !geo ? (
          <p className="text-sm text-muted-foreground py-4">비교할 즐겨찾기가 없습니다. ★를 눌러 즐겨찾기에 추가하세요.</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex rounded-md border overflow-hidden text-xs">
                <button className={cn("px-2 py-1", mode === "abs" ? "bg-primary text-primary-foreground" : "hover:bg-muted")} onClick={() => setMode("abs")}>절대가(억)</button>
                <button className={cn("px-2 py-1", mode === "delta" ? "bg-primary text-primary-foreground" : "hover:bg-muted")} onClick={() => setMode("delta")}>상승액(기준=0)</button>
              </div>
              <span className="text-[10px] text-muted-foreground">
                {{ "3": "최근 3개월", "6": "최근 6개월", "12": "최근 1년", "36": "최근 3년", "60": "최근 5년", all: "전체 기간" }[trendRange] ?? "전체 기간"} · 월별 중앙값{mode === "delta" ? " · 상승액(기간시작=0, 억)" : ""}{(excludeDirect || excludeFirstFloor) ? ` · ${[excludeDirect && "직거래", excludeFirstFloor && "1층"].filter(Boolean).join("/")} 제외` : ""}
              </span>
            </div>

            <div className="relative" style={{ width: w, maxWidth: "100%" }}>
              <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="max-w-full" onMouseMove={onMove} onMouseLeave={clearHover}>
                {/* Y 그리드 + 라벨 */}
                {yTicks.map((v, i) => (
                  <g key={i}>
                    <line x1={padL} y1={geo.yOf(v)} x2={w - padR} y2={geo.yOf(v)} stroke="currentColor" strokeWidth="0.5" className="text-muted-foreground/15" />
                    <text x={padL - 4} y={geo.yOf(v) + 3} textAnchor="end" className="fill-muted-foreground text-[8px]">{mode === "delta" ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : v.toFixed(1)}</text>
                  </g>
                ))}
                {/* 연도 경계 + 라벨 */}
                {years.map((y) => {
                  const x = geo.xOf(`${y}-01`);
                  if (x < padL || x > w - padR) return null;
                  return (
                    <g key={y}>
                      <line x1={x} y1={padTop} x2={x} y2={h - padBottom} stroke="currentColor" strokeWidth="0.5" className="text-muted-foreground/10" />
                      <text x={x} y={h - 8} textAnchor="middle" className="fill-muted-foreground text-[8px]">'{String(y).slice(2)}</text>
                    </g>
                  );
                })}
                {/* 상승액 모드: 0(기준) 가로선 */}
                {mode === "delta" && geo.yOf(0) >= padTop && geo.yOf(0) <= h - padBottom && (
                  <line x1={padL} y1={geo.yOf(0)} x2={w - padR} y2={geo.yOf(0)} stroke="currentColor" strokeWidth="0.75" className="text-muted-foreground/30" />
                )}
                {/* hover 세로선 */}
                {hoverYm && <line x1={geo.xOf(hoverYm)} y1={padTop} x2={geo.xOf(hoverYm)} y2={h - padBottom} stroke="currentColor" strokeWidth="0.75" className="text-muted-foreground/40" />}
                {/* 단지별 라인 (직선 연결) — 호버 시 해당 단지 강조, 나머지 흐리게 */}
                {seriesList.map((s) => {
                  if (!s.monthly.length) return null;
                  const poly = s.monthly.map((p) => `${geo.xOf(p.ym)},${geo.yOf(dispVal(p.price, s.key))}`).join(" ");
                  const hv = hoverYm && s.byYm.has(hoverYm) ? s.byYm.get(hoverYm)! : null;
                  const isHi = hoverKey === s.key;
                  const dim = hoverKey != null && !isHi;
                  return (
                    <g key={s.key} style={{ opacity: dim ? 0.18 : 1 }}>
                      <polyline points={poly} fill="none" stroke={s.color} strokeWidth={isHi ? 2.6 : 1.5} strokeLinejoin="round" />
                      {hv != null && !dim && <circle cx={geo.xOf(hoverYm!)} cy={geo.yOf(dispVal(hv, s.key))} r={isHi ? 3.6 : 3} fill={s.color} />}
                    </g>
                  );
                })}
              </svg>
              {/* hover 툴팁 */}
              {hoverYm && (
                <div className="absolute top-0 right-0 bg-popover border rounded shadow px-2 py-1 text-[10px] pointer-events-none z-50 min-w-[120px]">
                  <div className="font-medium mb-0.5">{fmtYm(hoverYm)}</div>
                  {seriesList.map((s) => {
                    const v = s.byYm.get(hoverYm);
                    return (
                      <div key={s.key} className={cn("flex items-center justify-between gap-2", hoverKey === s.key && "font-semibold")}>
                        <span className="flex items-center gap-1 truncate">
                          <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: s.color }} />
                          <span className="truncate max-w-[90px]">{s.name}</span>
                        </span>
                        <span className="tabular-nums">{v == null ? "-" : mode === "delta" ? `${deltaOf(v, s.key) >= 0 ? "+" : ""}${deltaOf(v, s.key)}억` : `${v}억`}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 범례 — 색상 + 단지명, hover 강조, × 해제 */}
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {seriesList.map((s) => {
                const chg = s.monthly.length > 1 && s.base ? Math.round(((s.monthly[s.monthly.length - 1]!.price - s.base) / s.base) * 1000) / 10 : null;
                const dim = hoverKey != null && hoverKey !== s.key;
                return (
                  <span
                    key={s.key}
                    className={cn("inline-flex items-center gap-1 text-xs cursor-default transition-opacity", dim && "opacity-30")}
                    onMouseEnter={() => setHoverKey(s.key)}
                    onMouseLeave={() => setHoverKey(null)}
                  >
                    <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
                    <span className={cn(hoverKey === s.key && "font-semibold")}>{s.name}</span>
                    <span className="text-[10px] text-muted-foreground">{s.area}㎡</span>
                    {chg != null && <span className={cn("text-[10px]", chg >= 0 ? "text-emerald-500" : "text-red-500")}>{chg >= 0 ? "+" : ""}{chg}%</span>}
                    <button onClick={() => onRemove(s.key)} className="text-muted-foreground hover:text-destructive leading-none ml-0.5" title="즐겨찾기 해제">×</button>
                  </span>
                );
              })}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

type SortKey = "score" | "accel" | "liquidity" | "commuteScore" | "pedScore" | "slope" | "avg" | "build" | "name" | "distance";
// 즐겨찾기 테이블 컬럼 정렬 키
type FavSortKey = "name" | "households" | "avg" | "accel" | "liquidity" | "commuteScore" | "pedScore" | "slope" | "parking";

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
    clearTimeout(searchTimerRef.current); // pending debounce가 닫은 뒤 유령 검색어를 되살리는 것 방지
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
  const [filtersOpen, setFiltersOpen] = useState(false); // 모바일 상세 필터 패널 토글 (sm+ 에선 항상 표시)
  // 메인 테이블 점진 렌더 — 필터 없을 때 ~5,900행 동시 렌더 freeze 방지
  const ROW_PAGE = 60;
  const [visibleCount, setVisibleCount] = useState(ROW_PAGE);
  const sentinelRef = React.useRef<HTMLTableRowElement>(null);
  const [regionFilter, setRegionFilter] = useState<string[]>(() => lsArr("f_region_multi"));
  const [commuteFilter, setCommuteFilter] = useState(() => ls("f_commute", "all"));
  const [pediaFilter, setPediaFilter] = useState(() => ls("f_pedia", "all"));
  const [parkingFilter, setParkingFilter] = useState(() => ls("f_parking", "all"));
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
  const [newlywed, setNewlywed] = useState(() => ls("f_newlywed", "false") === "true");
  const [childCount, setChildCount] = useState(() => ls("f_children", "0"));
  const [recentBirth, setRecentBirth] = useState(() => ls("f_recentBirth", "false") === "true");
  const [normalRate, setNormalRate] = useState(() => ls("f_normalRate", "5.2")); // 일반 주담대 금리 (%, 사용자 입력)
  const household = useMemo<HouseholdProfile>(() => ({
    firstTime: firstTimeBuyer, newlywed, children: parseInt(childCount) || 0, recentBirth,
  }), [firstTimeBuyer, newlywed, childCount, recentBirth]);
  const incomeManTotal = ((parseFloat(income1) || 0) + (parseFloat(income2) || 0)) * 10000; // 부부합산 (만원)
  const dualIncome = (parseFloat(income1) || 0) > 0 && (parseFloat(income2) || 0) > 0;
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

  // 클라우드 동기화: 타 기기 변경(sync.ts onSnapshot)이 localStorage 를 갱신한 뒤
  // "cloudsync" 이벤트를 쏘면, 영향받는 모든 상태를 localStorage 에서 다시 읽어
  // React 에 재주입한다 → 페이지 reload 없이 실시간 반영. (useState 초기화와 동일 파싱)
  const applyCloudState = useCallback(() => {
    setTypeFilter(lsArr("f_type_multi"));
    setSortField(ls("f_sort", "score") as SortKey);
    setRegionFilter(lsArr("f_region_multi"));
    setCommuteFilter(ls("f_commute", "all"));
    setPediaFilter(ls("f_pedia", "all"));
    setParkingFilter(ls("f_parking", "all"));
    setCommuteSlot(ls("f_commuteSlot", "early") as CommuteSlot);
    setTrendRange(ls("f_trendRange", "6"));
    setLiquidityFilter(ls("f_liquidity", "all"));
    setAccelFilter(ls("f_accel", "all"));
    setPriceMin(ls("f_priceMin", "0"));
    setPriceMax(ls("f_priceMax", "20"));
    setHhMin(["0", "150", "300", "500", "1000"].includes(ls("f_hhMin", "0")) ? ls("f_hhMin", "0") : "0");
    setBuildMin(["0", "1992", "2005", "2018", "2019"].includes(ls("f_buildMin", "0")) ? ls("f_buildMin", "0") : "0");
    setTradeMin(ls("f_tradeMin", "0"));
    setExcludeDirect(ls("f_exDirect", "true") === "true");
    setExcludeFirstFloor(ls("f_ex1F", "true") === "true");
    setCapital(localStorage.getItem("capital") ?? "");
    setIncome1(localStorage.getItem("income1") ?? "");
    setIncome2(localStorage.getItem("income2") ?? "");
    setExtraLoan(localStorage.getItem("extraLoan") ?? "");
    setLoanYears(localStorage.getItem("loanYears") ?? "30");
    setExtraRepayYears(localStorage.getItem("extraRepayYears") ?? "2");
    setFirstTimeBuyer(ls("f_firstTime", "true") === "true");
    setNewlywed(ls("f_newlywed", "false") === "true");
    setChildCount(ls("f_children", "0"));
    setRecentBirth(ls("f_recentBirth", "false") === "true");
    setNormalRate(ls("f_normalRate", "5.2"));
    setLoanProduct(ls("f_loanProduct", "normal") as LoanProduct);
    setInterestSubsidy(ls("f_interestSubsidy", "false") === "true");
    setIncludeInterior(ls("f_includeInterior", "false") === "true");
    setNaverColEnabled(ls("f_naverCol", "false") === "true");
    const mv = localStorage.getItem("f_moveInMonth");
    if (mv) setMoveInMonth(mv);
    try { const s = localStorage.getItem("weights"); setWeights(s ? JSON.parse(s) : DEFAULT_WEIGHTS); } catch { /* keep current */ }
    try { setFavorites(new Set(JSON.parse(localStorage.getItem("favorites") ?? "[]"))); } catch { /* keep current */ }
  }, []);
  useEffect(() => {
    window.addEventListener(CLOUD_SYNC_EVENT, applyCloudState);
    return () => window.removeEventListener(CLOUD_SYNC_EVENT, applyCloudState);
  }, [applyCloudState]);

  const [compareOpen, setCompareOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0); // 에러 배너의 재시도 버튼이 증가 → 로드 effect 재실행

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

    setLoadError(false);
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
    }).catch(() => setLoadError(true)); // shard·fallback 모두 실패 시 무한 로딩 대신 에러 배너
    fetch(base + "multicultural.json")
      .then((r) => r.json())
      .then(setMulticultural)
      .catch(() => {});
  }, [reloadKey]);

  // 저장된 정렬이 거리순이면 위치 재요청 (도착 전엔 comparator가 점수순 fallback, 거부 시 점수순 복귀)
  useEffect(() => {
    if (sortField !== "distance") return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setMyLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setSortField("score"),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 필터 localStorage 저장
  useEffect(() => { localStorage.setItem("f_type_multi", JSON.stringify(typeFilter)); }, [typeFilter]);
  useEffect(() => { localStorage.setItem("f_sort", sortField); }, [sortField]);
  useEffect(() => { localStorage.setItem("f_region_multi", JSON.stringify(regionFilter)); }, [regionFilter]);
  useEffect(() => { localStorage.setItem("f_commute", commuteFilter); }, [commuteFilter]);
  useEffect(() => { localStorage.setItem("f_pedia", pediaFilter); }, [pediaFilter]);
  useEffect(() => { localStorage.setItem("f_parking", parkingFilter); }, [parkingFilter]);
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

  // 상승력·환금 계산 윈도우 — 추이 기간을 길게 잡아도 최근 12개월로 cap (모멘텀 지표는 단기 유지).
  // recent_trades 자체가 12개월 롤링 배포라, 장기 추이는 buildSpark 가 long_trend 로 그린다.
  // "전체"는 parseInt가 NaN이라 기본 6으로 떨어지지 않게 cap(12)으로 명시.
  const accelMonths = trendRange === "all" ? 12 : Math.min(parseInt(trendRange) || 6, 12);
  const trendCutoff = useMemo(() => {
    const now = new Date();
    const c = new Date(now.getFullYear(), now.getMonth() - accelMonths + 1, 1);
    return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}-01`;
  }, [accelMonths]);
  // 거래건수·환금성 윈도우 — 라벨("6개월 거래")과 동일한 최근 6개월 고정 (추이 기간과 무관)
  const sixMonthCutoff = useMemo(() => {
    const now = new Date();
    const c = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}-01`;
  }, []);

  // 추이 스파크라인 데이터 — 단기(≤1년)는 개별 거래(recent_trades), 장기(>1년/전체)는
  // 전체 기간 개별 실거래(ps, 압축 시계열)를 복원해 한 건 한 건 그린다(월별 중앙값 샘플링 아님).
  // ps 없는 구버전 데이터는 long_trend(월별 중앙값) fallback.
  const buildSpark = useCallback((d: AptData): { data: { date: string; price: number }[]; autoRange: boolean } => {
    const m = parseInt(trendRange) || 0;
    const isLong = trendRange === "all" || m > 12;
    if (isLong) {
      let cutDate = "";
      if (trendRange !== "all") {
        const now = new Date();
        const c = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
        cutDate = `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}-01`;
      }
      const series = d.ps
        ? unpackPriceSeries(d.ps).filter((t) => !(excludeDirect && t.direct) && !(excludeFirstFloor && t.firstFloor))
        : (d.long_trend ?? []).map(([ym, price]) => ({ date: `${String(ym).slice(0, 4)}-${String(ym).slice(4, 6)}-01`, price }));
      const data = cutDate ? series.filter((t) => t.date >= cutDate) : series;
      return { data, autoRange: true };
    }
    const data = (d.recent_trades ?? [])
      .filter((t) => t.date >= trendCutoff)
      .slice().reverse()
      .map((t) => ({ date: t.date, price: t.price }));
    return { data, autoRange: false };
  }, [trendRange, trendCutoff, excludeDirect, excludeFirstFloor]);

  // 1층·직거래 토글을 recent_trades에 적용 + count·환금·상승력 재계산 (메인/즐겨찾기/전체타입 공용)
  const applyTradeFilter = useCallback((d: AptData): AptData => {
    const all = d.recent_trades ?? [];
    const trades = all.filter((t) => {
      if (excludeDirect && t.direct) return false;
      if (excludeFirstFloor && t.floor === 1) return false;
      return true;
    });
    // recent_trades는 12개월 롤링 배포 — count·환금성은 라벨대로 최근 6개월만 집계
    const count = trades.filter((t) => t.date >= sixMonthCutoff).length;
    const liquidity = d.type_units && d.type_units > 0
      ? Math.round((count / d.type_units) * 1000) / 10
      : d.liquidity;
    const win = trades.filter((t) => t.date >= trendCutoff);
    // 상승력 — 크기(Theil-Sen) × 일관성(Kendall tau)
    const { value: accel, tau: accel_tau } = robustAccel(win, accelMonths);
    return { ...d, recent_trades: trades, count, liquidity, accel, accel_tau };
  }, [excludeDirect, excludeFirstFloor, trendCutoff, accelMonths, sixMonthCutoff]);
  const tradeFilteredData = useMemo(() => {
    const mapped = data.map(applyTradeFilter);
    calcScores(mapped, weights); // 재계산된 상승력/환금성을 종합점수에 반영
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
      if (pediaFilter === "best" && (d.pedScore == null || d.pedScore > 6)) return false;
      if (pediaFilter === "good" && (d.pedScore == null || d.pedScore > 10)) return false;
      if (pediaFilter === "ok" && (d.pedScore == null || d.pedScore > 15)) return false;
      if (parkingFilter === "good" && (d.parking_per_hh == null || d.parking_per_hh < 1.3)) return false;
      if (parkingFilter === "ok" && (d.parking_per_hh == null || d.parking_per_hh < 1.2)) return false;
      if (parkingFilter === "low" && (d.parking_per_hh == null || d.parking_per_hh < 1.1)) return false;
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
      if (sortField === "distance") {
        // 위치 미확보(저장된 거리순 복원 직후·권한 거부) 시 점수순 fallback — AptData에 distance 속성이 없어
        // 아래 공통 분기로 떨어지면 NaN comparator(무정렬)가 되는 것을 방지
        if (!myLocation) return (b.score ?? -Infinity) - (a.score ?? -Infinity);
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
  }, [tradeFilteredData, typeFilter, sortField, regionFilter, commuteFilter, pediaFilter, parkingFilter, liquidityFilter, accelFilter, priceMin, priceMax, hhMin, buildMin, tradeMin, myLocation]);

  // 필터/정렬/뷰 변경 시 점진 렌더 카운트 리셋 (스크롤 맨 위로 돌아간 효과)
  useEffect(() => { setVisibleCount(ROW_PAGE); }, [filtered, viewMode]);

  // 검색 점프 — 대상 행이 점진 렌더 범위(60행) 밖이면 그 순위까지 렌더 확장 후 스크롤.
  // 리셋 effect(위) 뒤에 선언해 같은 커밋에서 확장값이 리셋을 덮어쓰도록 한다.
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!jumpTarget) return;
    const idx = filtered.findIndex((x) => x.name === jumpTarget);
    if (idx >= 0) setVisibleCount((c) => Math.max(c, idx + 10));
    let cancelled = false;
    let tries = 0;
    const tick = () => {
      if (cancelled) return;
      const row = document.querySelector(`[data-apt="${jumpTarget}"]`);
      if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); setJumpTarget(null); return; }
      if (++tries < 10) setTimeout(tick, 100);
      else setJumpTarget(null);
    };
    const t = setTimeout(tick, 50);
    return () => { cancelled = true; clearTimeout(t); };
  }, [jumpTarget, filtered]);

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

  // 즐겨찾기 테이블 컬럼 정렬 (헤더 클릭) — 기본: 단지명 오름차순
  const [favSort, setFavSort] = useState<{ key: FavSortKey; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const sortFav = useCallback((key: FavSortKey) => {
    setFavSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  }, []);
  const favTH = (key: FavSortKey, label: string, className = "text-center") => (
    <TableHead className={cn(className, "cursor-pointer select-none hover:text-foreground")} onClick={() => sortFav(key)} title="클릭하여 정렬">
      <span className="inline-flex items-center gap-0.5">{label}{favSort.key === key && <span className="text-[9px]">{favSort.dir === "asc" ? "▲" : "▼"}</span>}</span>
    </TableHead>
  );

  const favoriteItems = useMemo(() => {
    const items = tradeFilteredData.filter((d) => favorites.has(`${d.name}|${d.atype}`));
    const byName = (a: AptData, b: AptData) => a.name.localeCompare(b.name, "ko") || a.area - b.area;
    const val = (d: AptData): number | null => {
      switch (favSort.key) {
        case "households": return d.households;
        case "avg": return d.avg;
        case "accel": return d.accel;
        case "liquidity": return d.liquidity;
        case "commuteScore": return d.commuteScore;
        case "pedScore": return d.pedScore;
        case "slope": return d.slope;
        case "parking": return d.parking_per_hh;
        default: return null;
      }
    };
    return items.sort((a, b) => {
      if (favSort.key === "name") return favSort.dir === "asc" ? byName(a, b) : -byName(a, b);
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return byName(a, b); // 둘 다 없으면 이름순
      if (va == null) return 1; // 값 없는 행은 항상 뒤로
      if (vb == null) return -1;
      const c = va - vb || byName(a, b);
      return favSort.dir === "asc" ? c : -c;
    });
  }, [tradeFilteredData, favorites, favSort]);

  // 같은 단지(name) row 그룹화 → rowspan 메타. 정렬로 같은 단지가 흩어질 수 있어
  // "연속 구간" 기준으로 span 계산 (흩어지면 각자 자기 셀 렌더, 붙어있으면 병합).
  const favoriteRowMeta = useMemo(() => {
    return favoriteItems.map((d, i) => {
      const isFirst = i === 0 || favoriteItems[i - 1]!.name !== d.name;
      if (!isFirst) return { isFirst: false, span: 1 };
      let span = 1;
      while (i + span < favoriteItems.length && favoriteItems[i + span]!.name === d.name) span++;
      return { isFirst: true, span };
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
    if (pediaFilter === "best" && (d.pedScore == null || d.pedScore > 6)) reasons.push(d.pedScore == null ? "소아과 데이터 없음" : "소아과 매우좋음 미만");
    if (pediaFilter === "good" && (d.pedScore == null || d.pedScore > 10)) reasons.push(d.pedScore == null ? "소아과 데이터 없음" : "소아과 좋음 이상 아님");
    if (pediaFilter === "ok" && (d.pedScore == null || d.pedScore > 15)) reasons.push(d.pedScore == null ? "소아과 데이터 없음" : "소아과 보통 이상 아님");
    if (parkingFilter === "good" && (d.parking_per_hh == null || d.parking_per_hh < 1.3)) reasons.push(d.parking_per_hh == null ? "주차 데이터 없음" : "주차 넉넉(≥1.3) 아님");
    if (parkingFilter === "ok" && (d.parking_per_hh == null || d.parking_per_hh < 1.2)) reasons.push(d.parking_per_hh == null ? "주차 데이터 없음" : "주차 보통 이상(≥1.2) 아님");
    if (parkingFilter === "low" && (d.parking_per_hh == null || d.parking_per_hh < 1.1)) reasons.push(d.parking_per_hh == null ? "주차 데이터 없음" : "주차 부족(<1.1)");
    if (liquidityFilter === "good" && (d.liquidity == null || d.liquidity < 7)) reasons.push(d.liquidity == null ? "환금성 데이터 없음" : `환금성 ${d.liquidity}% (좋음 미만)`);
    if (liquidityFilter === "ok" && (d.liquidity == null || d.liquidity < 4)) reasons.push(d.liquidity == null ? "환금성 데이터 없음" : `환금성 ${d.liquidity}% (보통 미만)`);
    if (liquidityFilter === "bad" && (d.liquidity == null || d.liquidity < 2)) reasons.push(d.liquidity == null ? "환금성 데이터 없음" : `환금성 ${d.liquidity}% (나쁨 미만)`);
    if (accelFilter === "good" && (d.accel == null || d.accel <= 5)) reasons.push(d.accel == null ? "상승력 데이터 없음" : `상승력 ${d.accel}% (상승 미만)`);
    if (accelFilter === "ok" && (d.accel == null || d.accel < 0)) reasons.push(d.accel == null ? "상승력 데이터 없음" : `상승력 ${d.accel}% (보합 미만)`);
    if (accelFilter === "bad" && (d.accel == null || d.accel >= 0)) reasons.push(d.accel == null ? "상승력 데이터 없음" : `상승력 ${d.accel}% (하락 아님)`);
    if (pMinVal > 0 && d.avg < pMinVal) reasons.push(`${priceMin}억 미만`);
    if (pMaxVal < Infinity && d.avg > pMaxVal) reasons.push(`${priceMax}억 초과`);
    if (hhMinVal > 0 && (d.households ?? 0) < hhMinVal) reasons.push(d.households == null ? `세대수 데이터 없음` : `${hhMin}세대 미만`);
    if (buildMinVal > 0 && d.build < buildMinVal) reasons.push(`${buildMin}년 이전`);
    if (tradeMinVal > 0 && d.count < tradeMinVal) reasons.push(`거래 ${d.count}건`);
    return reasons.length > 0 ? reasons.join(", ") : null;
  };

  const searchResults = useMemo(() => {
    const empty = { rows: [] as (AptData & { _inFilter: boolean })[], totalComplexes: 0, hiddenComplexes: 0 };
    if (!searchQuery.trim()) return empty;
    // 특수문자·공백 무시: 소문자화 후 한글/영문/숫자만 남김 (e편한세상 ↔ e-편한세상, 래미안 안양 ↔ 래미안안양)
    const norm = (s: string) => s.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
    const q = norm(searchQuery);
    if (!q) return empty;
    // 전체 데이터에서 타입별로 매칭 (필터 무관, break 없이 모두 수집 — 면적 행 단위 컷이면 동명단지가 누락됨)
    const matched: (AptData & { _inFilter: boolean })[] = [];
    for (const d of data) {
      if (d.no_trades) continue;
      const haystack = norm([d.name, d.display_name, d.dong, d.doro_juso, d.region].filter(Boolean).join(" "));
      if (!haystack.includes(q)) continue;
      matched.push({ ...d, _inFilter: filteredNames.has(d.name) });
    }
    // 정렬: 필터에 있는 것 먼저 → 단지명 → 면적 오름차순
    matched.sort((a, b) => {
      if (a._inFilter !== b._inFilter) return a._inFilter ? -1 : 1;
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.area - b.area;
    });
    // 단지(name) 단위 상한 — 한 단지의 모든 면적 행은 항상 함께 표시. 정렬이 먼저라 필터 통과 단지가 우선 노출됨.
    const MAX_COMPLEXES = 60;
    const seen = new Set<string>();
    const rows: typeof matched = [];
    for (const d of matched) {
      if (!seen.has(d.name)) {
        if (seen.size >= MAX_COMPLEXES) break;
        seen.add(d.name);
      }
      rows.push(d);
    }
    const totalComplexes = new Set(matched.map((d) => d.name)).size;
    return { rows, totalComplexes, hiddenComplexes: totalComplexes - seen.size };
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

  // ── 필터 활성 상태(기본값 이탈) — 트리거 하이라이트·모바일 배지·일괄 초기화 공용 ──
  const priceFilterOn = +priceMin > 0 || (priceMax !== "" && +priceMax < 20);
  const detailFilterCount = [
    commuteFilter !== "all", pediaFilter !== "all", parkingFilter !== "all",
    liquidityFilter !== "all", accelFilter !== "all",
    priceFilterOn, hhMin !== "0", buildMin !== "0", (+tradeMin || 0) > 0,
  ].filter(Boolean).length;
  const activeFilterCount = detailFilterCount + (typeFilter.length ? 1 : 0) + (regionFilter.length ? 1 : 0);
  const resetFilters = () => {
    setTypeFilter([]); setRegionFilter([]);
    setCommuteFilter("all"); setPediaFilter("all"); setParkingFilter("all");
    setLiquidityFilter("all"); setAccelFilter("all");
    setPriceMin("0"); setPriceMax("20"); setHhMin("0"); setBuildMin("0"); setTradeMin("0");
  };

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="max-w-7xl mx-auto px-3 py-4 sm:px-6">
        <h1 className="text-xl font-bold mb-1">아파트 매수 후보 스코어링</h1>
        {loadError && data.length === 0 && (
          <div className="mb-3 flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
            <span className="text-destructive">데이터를 불러오지 못했습니다. 네트워크 상태를 확인해 주세요.</span>
            <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={() => setReloadKey((k) => k + 1)}>재시도</Button>
          </div>
        )}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
          <p className="text-xs text-muted-foreground">
            데이터: 실거래가 (전 면적) | 최종 업데이트: {new Date().toLocaleDateString("ko-KR")}
          </p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 shrink-0 text-[11px]">
            {import.meta.env.VITE_FIREBASE_API_KEY && (
              <Suspense fallback={null}>
                <AuthButton />
              </Suspense>
            )}
            <Button
              variant="outline"
              size="sm"
              className="text-[11px] h-7 px-2"
              onClick={() => setFinanceOpen(true)}
              title="자본/연봉/대출 설정 (로그인 시 본인 계정에만 클라우드 동기화)"
            >
              💰 자금 설정
              {capital && <span className="ml-1 text-emerald-500">●</span>}
            </Button>
            <select
              value={loanProduct}
              onChange={(e) => { setLoanProduct(e.target.value as LoanProduct); localStorage.setItem("f_loanProduct", e.target.value); }}
              className="h-7 px-1.5 rounded border bg-background text-[11px]"
              title={getLoanTerms(loanProduct, household, incomeManTotal, dualIncome, parseInt(loanYears) || 30, false, parseFloat(normalRate) || 5.2).desc}
            >
              {LOAN_PRODUCT_KEYS.map((p) => {
                const t = getLoanTerms(p, household, incomeManTotal, dualIncome, parseInt(loanYears) || 30, false, parseFloat(normalRate) || 5.2);
                // 디딤돌·신생아는 소득 입력 시 정확 금리, 미입력 시 범위 표시. 보금자리·일반은 소득 무관.
                const exact = p === "normal" || p === "bogeumjari" || incomeManTotal > 0;
                const rateLabel = exact ? `${(t.rate * 100).toFixed(1)}%` : `${(t.rateMin * 100).toFixed(1)}~${(t.rateMax * 100).toFixed(1)}%`;
                return <option key={p} value={p}>{t.name} ({rateLabel}){t.eligNotes.length > 0 ? " · 자격미달" : ""}</option>;
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
              <input type="month" value={moveInMonth} onChange={(e) => { setMoveInMonth(e.target.value); localStorage.setItem("f_moveInMonth", e.target.value); }} className="h-7 px-1.5 rounded border bg-background text-[11px] tabular-nums" />
            </label>
            <ProxySetting />
            <Button variant="outline" size="sm" className="text-[11px] h-7 px-2" onClick={() => setMcOpen(true)}>다문화 통계</Button>
            <Suspense fallback={null}>
              <MolitPressViewer />
            </Suspense>

            <Dialog open={financeOpen} onOpenChange={setFinanceOpen}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>자금 / 대출 설정</DialogTitle>
                </DialogHeader>
                <p className="text-[11px] text-muted-foreground -mt-1 mb-2">⚠ 민감 정보 — 로그인하지 않으면 이 브라우저에만 저장됩니다. 로그인 시 본인 계정에만 클라우드 동기화되며, 보안 규칙상 타인은 접근할 수 없습니다.</p>
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
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1" title="미성년 자녀 수 — 디딤돌 우대(1자녀 -0.3/2자녀 -0.5/3자녀+ -0.7%p)·소득상한, 보금자리론 소득상한(1자녀 9천/2자녀+ 1억)·한도(다자녀 4억)에 반영">
                      <span className="text-xs text-muted-foreground">미성년 자녀 수</span>
                      <select value={childCount} onChange={(e) => { setChildCount(e.target.value); localStorage.setItem("f_children", e.target.value); }} className="h-8 rounded border bg-background px-2 text-sm">
                        <option value="0">없음</option>
                        <option value="1">1명</option>
                        <option value="2">2명</option>
                        <option value="3">3명 이상</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1" title="일반 주담대 적용 금리 — 2026-06 시중은행 5년 고정 하단 ~5%대, 변동 3.8~4.2% 수준. 정책상품 자격미달 시 이 금리로 계산">
                      <span className="text-xs text-muted-foreground">일반 주담대 금리 (%)</span>
                      <input type="number" step="0.1" min="0" value={normalRate} onChange={(e) => { setNormalRate(e.target.value); localStorage.setItem("f_normalRate", e.target.value); }} className="h-8 rounded border bg-background px-2 text-sm" />
                    </label>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer" title="생애최초 주택 구매자 — 취득세 200만원 감면, 디딤돌 소득 7천·한도 2.4억, 보금자리론 한도 4.2억">
                    <input type="checkbox" checked={firstTimeBuyer} onChange={(e) => { setFirstTimeBuyer(e.target.checked); localStorage.setItem("f_firstTime", String(e.target.checked)); }} className="rounded" />
                    <span className="text-sm">생애최초 주택 구매자</span>
                    <span className="text-[10px] text-muted-foreground">(취득세 -200만원 + 정책상품 한도↑)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer" title="혼인신고 7년 이내 또는 결혼예정 — 디딤돌 신혼 특례금리·소득 8.5천·한도 3.2억·주택 6억, 보금자리론 소득 8.5천·우대 -0.3%p">
                    <input type="checkbox" checked={newlywed} onChange={(e) => { setNewlywed(e.target.checked); localStorage.setItem("f_newlywed", String(e.target.checked)); }} className="rounded" />
                    <span className="text-sm">신혼부부 (혼인 7년 이내)</span>
                    <span className="text-[10px] text-muted-foreground">(디딤돌 특례금리 + 소득·한도↑)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer" title="대출접수일 기준 2년 내 출산·입양 — 신생아특례(1.8~4.5%, 한도 4억) 자격, 보금자리론 우대 -0.2%p">
                    <input type="checkbox" checked={recentBirth} onChange={(e) => { setRecentBirth(e.target.checked); localStorage.setItem("f_recentBirth", String(e.target.checked)); }} className="rounded" />
                    <span className="text-sm">2년 내 출산·입양</span>
                    <span className="text-[10px] text-muted-foreground">(신생아특례 자격)</span>
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
                        // removeItem 대신 빈 문자열 저장 — 동기화로 삭제가 타 기기에 전파되도록
                        // (snapshotLocal 은 null 키를 누락시켜 삭제가 전파되지 않음. getter 는 "" ?? "" 등가)
                        for (const k of ["capital", "income1", "income2", "extraLoan"]) localStorage.setItem(k, "");
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
                ["accel", "상승력"],
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

        {/* ───── 필터 툴바: 핵심 행(항상 표시) + 상세 행(모바일에선 접힘) ───── */}
        <div className="mb-4 rounded-lg border bg-card/40 p-2 sm:p-2.5">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <Select multiple value={typeFilter} onValueChange={(v: string[]) => setTypeFilter(v)}>
              <SelectTrigger className={cn("h-8 text-xs flex-1 min-w-[6.5rem] sm:flex-none sm:w-32", typeFilter.length > 0 && FILTER_ON)}>
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
            <Select multiple value={regionFilter} onValueChange={(v: string[]) => setRegionFilter(v)}>
              <SelectTrigger className={cn("h-8 text-xs flex-1 min-w-[6.5rem] sm:flex-none sm:w-32", regionFilter.length > 0 && FILTER_ON)}>
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
            }} items={{ score: "점수순", accel: "상승력순", liquidity: "환금성순", commuteScore: "출퇴근순", pedScore: "소아과순", avg: "현재가순", distance: "거리순" }}>
              <SelectTrigger className="h-8 text-xs flex-1 min-w-[6rem] sm:flex-none sm:w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="score">점수순</SelectItem>
                <SelectItem value="accel">상승력순</SelectItem>
                <SelectItem value="liquidity">환금성순</SelectItem>
                <SelectItem value="commuteScore">출퇴근순</SelectItem>
                <SelectItem value="pedScore">소아과순</SelectItem>
                <SelectItem value="avg">현재가순</SelectItem>
                <SelectItem value="distance">거리순</SelectItem>
              </SelectContent>
            </Select>
            <Select value={trendRange} onValueChange={(v) => v && setTrendRange(v)} items={{ "3": "추이 3개월", "6": "추이 6개월", "12": "추이 1년", "36": "추이 3년", "60": "추이 5년", all: "추이 전체" }}>
              <SelectTrigger className="h-8 text-xs flex-1 min-w-[6rem] sm:flex-none sm:w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="3">추이 3개월</SelectItem>
                <SelectItem value="6">추이 6개월</SelectItem>
                <SelectItem value="12">추이 1년</SelectItem>
                <SelectItem value="36">추이 3년</SelectItem>
                <SelectItem value="60">추이 5년</SelectItem>
                <SelectItem value="all">추이 전체</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className={cn("h-8 px-2.5 text-xs sm:hidden", filtersOpen && "bg-muted")}
              onClick={() => setFiltersOpen((o) => !o)}
            >
              <SlidersHorizontal className="h-3.5 w-3.5 mr-1" />
              상세 필터
              {detailFilterCount > 0 && (
                <span className="ml-1 inline-flex items-center justify-center min-w-[1.1rem] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold tabular-nums">{detailFilterCount}</span>
              )}
              <ChevronDown className={cn("h-3.5 w-3.5 ml-0.5 transition-transform", filtersOpen && "rotate-180")} />
            </Button>
            {activeFilterCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={resetFilters}
                title="모든 필터를 기본값으로 되돌립니다 (정렬·추이 기간·직거래/1층 제외는 유지)"
              >
                <X className="h-3.5 w-3.5 mr-0.5" />
                초기화
              </Button>
            )}
            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                <span className="font-semibold text-foreground tabular-nums">{filtered.length.toLocaleString()}</span>개 단지
              </span>
              <div className="flex h-8 rounded-lg border overflow-hidden text-xs shrink-0">
                <button
                  type="button"
                  className={cn("px-2.5 transition-colors", viewMode === "table" ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted/50")}
                  onClick={() => setViewMode("table")}
                >테이블</button>
                <button
                  type="button"
                  className={cn("px-2.5 border-l transition-colors", viewMode === "map" ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted/50")}
                  onClick={() => { setViewMode("map"); if (!myLocation) navigator.geolocation.getCurrentPosition((p) => setMyLocation({ lat: p.coords.latitude, lng: p.coords.longitude }), () => {}); }}
                >지도</button>
              </div>
              {favoriteItems.length > 1 && (
                <Button variant="outline" size="sm" className="h-8 text-xs px-2" onClick={() => setCompareOpen(true)}>
                  <span className="text-yellow-400">★</span> 추이 비교 ({favoriteItems.length})
                </Button>
              )}
            </div>
          </div>
          <div
            className={cn(
              "mt-2 border-t border-border/60 pt-2 text-xs sm:flex sm:flex-wrap sm:items-center sm:gap-x-2.5 sm:gap-y-1.5",
              filtersOpen ? "grid grid-cols-2 gap-1.5" : "hidden",
            )}
          >
            <Select value={commuteFilter} onValueChange={(v) => v && setCommuteFilter(v)} items={{ all: "출퇴근 전체", good: "출퇴근 좋음 이상", ok: "출퇴근 보통 이상" }}>
              <SelectTrigger className={cn("h-8 sm:h-7 text-xs w-full sm:w-auto", commuteFilter !== "all" && FILTER_ON)}><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="w-auto min-w-fit">
                <SelectItem value="all">출퇴근 전체</SelectItem>
                <SelectItem value="good">좋음 이상 (≤30분)</SelectItem>
                <SelectItem value="ok">보통 이상 (≤40분)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={pediaFilter} onValueChange={(v) => v && setPediaFilter(v)} items={{ all: "소아과 전체", best: "소아과 매우좋음", good: "소아과 좋음 이상", ok: "소아과 보통 이상" }}>
              <SelectTrigger className={cn("h-8 sm:h-7 text-xs w-full sm:w-auto", pediaFilter !== "all" && FILTER_ON)}><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="w-auto min-w-fit">
                <SelectItem value="all">소아과 전체</SelectItem>
                <SelectItem value="best">매우좋음</SelectItem>
                <SelectItem value="good">좋음 이상</SelectItem>
                <SelectItem value="ok">보통 이상</SelectItem>
              </SelectContent>
            </Select>
            <Select value={parkingFilter} onValueChange={(v) => v && setParkingFilter(v)} items={{ all: "주차 전체", good: "주차 넉넉", ok: "주차 보통 이상", low: "주차 부족 제외" }}>
              <SelectTrigger className={cn("h-8 sm:h-7 text-xs w-full sm:w-auto", parkingFilter !== "all" && FILTER_ON)}><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="w-auto min-w-fit">
                <SelectItem value="all">주차 전체</SelectItem>
                <SelectItem value="good">넉넉 (≥1.3대)</SelectItem>
                <SelectItem value="ok">보통 이상 (≥1.2대)</SelectItem>
                <SelectItem value="low">부족 제외 (≥1.1대)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={liquidityFilter} onValueChange={(v) => v && setLiquidityFilter(v)} items={{ all: "환금성 전체", good: "환금성 좋음 이상", ok: "환금성 보통 이상", bad: "환금성 나쁨 이상" }}>
              <SelectTrigger className={cn("h-8 sm:h-7 text-xs w-full sm:w-auto", liquidityFilter !== "all" && FILTER_ON)}><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="w-auto min-w-fit">
                <SelectItem value="all">환금성 전체</SelectItem>
                <SelectItem value="good">좋음 이상 (≥7%)</SelectItem>
                <SelectItem value="ok">보통 이상 (≥4%)</SelectItem>
                <SelectItem value="bad">나쁨 이상 (≥2%)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={accelFilter} onValueChange={(v) => v && setAccelFilter(v)} items={{ all: "상승력 전체", good: "상승력 상승", ok: "상승력 보합 이상", bad: "상승력 하락" }}>
              <SelectTrigger className={cn("h-8 sm:h-7 text-xs w-full sm:w-auto", accelFilter !== "all" && FILTER_ON)}><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="w-auto min-w-fit">
                <SelectItem value="all">상승력 전체</SelectItem>
                <SelectItem value="good">상승 (&gt;5%)</SelectItem>
                <SelectItem value="ok">보합 이상 (≥0%)</SelectItem>
                <SelectItem value="bad">하락 (&lt;0%)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={hhMin} onValueChange={(v) => v && setHhMin(v)} items={{ "0": "세대수 전체", "150": "150세대↑", "300": "300세대↑", "500": "500세대↑", "1000": "1000세대↑" }}>
              <SelectTrigger className={cn("h-8 sm:h-7 text-xs w-full sm:w-auto", hhMin !== "0" && FILTER_ON)} title="최소 세대수 (공동주택관리법 / 주택건설기준)"><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="w-auto min-w-fit">
                <SelectItem value="0">세대수 전체</SelectItem>
                <SelectItem value="150">150세대↑ (승강기/난방 시 의무관리)</SelectItem>
                <SelectItem value="300">300세대↑ (전면 의무관리)</SelectItem>
                <SelectItem value="500">500세대↑ (놀이터·경로당)</SelectItem>
                <SelectItem value="1000">1000세대↑ (대단지)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={buildMin} onValueChange={(v) => v && setBuildMin(v)} items={{ "0": "준공 전체", "1992": "1992년↑", "2005": "2005년↑", "2018": "2018년↑", "2019": "2019년↑" }}>
              <SelectTrigger className={cn("h-8 sm:h-7 text-xs w-full sm:w-auto", buildMin !== "0" && FILTER_ON)} title="최소 준공년도 (스프링클러·주차장 법적 기준)"><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="w-auto min-w-fit">
                <SelectItem value="0">준공 전체</SelectItem>
                <SelectItem value="1992">1992년↑ (16층 이상 층만 스프링클러)</SelectItem>
                <SelectItem value="2005">2005년↑ (11층+ 동 전층 스프링클러)</SelectItem>
                <SelectItem value="2018">2018년↑ (6층+ 신축 스프링클러)</SelectItem>
                <SelectItem value="2019">2019년↑ (주차칸 2.5m)</SelectItem>
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1 h-8 sm:h-7" title="최근 6개월 최소 거래 건수">
              <span className={cn("text-muted-foreground", (+tradeMin || 0) > 0 && "text-primary font-medium")}>6개월 거래</span>
              <input
                type="number"
                min="0"
                placeholder="0"
                value={tradeMin}
                onChange={(e) => setTradeMin(e.target.value)}
                className={cn("w-12 h-7 rounded border bg-background px-1.5 text-xs text-center", (+tradeMin || 0) > 0 && "border-primary/60 text-primary")}
              />
              <span className="text-muted-foreground text-[10px]">건+</span>
            </label>
            <label className="col-span-2 flex items-center gap-2 h-8 sm:h-7" title="현재가 범위 (억 단위)">
              <span className={cn("text-muted-foreground shrink-0", priceFilterOn && "text-primary font-medium")}>현재가</span>
              <span className={cn("text-[10px] tabular-nums w-20 text-center shrink-0", priceFilterOn && "text-primary")}>
                {(+priceMin === 0 && +priceMax >= 20) ? "전체" : `${priceMin}억 ~ ${+priceMax >= 20 ? "20억+" : priceMax + "억"}`}
              </span>
              {/* Slider className은 내부 Control에 적용 — Root가 flex item이라 flex-1이 안 먹어 래퍼로 폭 확보 */}
              <div className="flex-1 sm:flex-none">
                <Slider
                  className="w-full sm:w-40"
                  min={0}
                  max={20}
                  step={1}
                  value={[+priceMin || 0, priceMax === "" ? 20 : +priceMax]}
                  onValueChange={(v: readonly number[]) => { setPriceMin(String(v[0])); setPriceMax(String(v[1])); }}
                />
              </div>
            </label>
            <div className="hidden sm:block w-px h-5 bg-border/70" />
            <label className="flex items-center gap-1.5 cursor-pointer h-8 sm:h-7" title="중개인 없는 직거래 제외">
              <input type="checkbox" checked={excludeDirect} onChange={(e) => setExcludeDirect(e.target.checked)} className="rounded" />
              <span className="text-muted-foreground">직거래 제외</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer h-8 sm:h-7" title="1층 거래 제외">
              <input type="checkbox" checked={excludeFirstFloor} onChange={(e) => setExcludeFirstFloor(e.target.checked)} className="rounded" />
              <span className="text-muted-foreground">1층 제외</span>
            </label>
            <Select value={commuteSlot} onValueChange={(v) => v && setCommuteSlot(v as CommuteSlot)} items={{ early: "측정 일찍", late: "측정 늦게" }}>
              <SelectTrigger className="h-8 sm:h-7 text-xs w-full sm:w-auto" title="출퇴근 시간 측정 시간대 — 일찍(06:30/16:00) / 늦게(08:00/18:00)"><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="w-auto min-w-fit">
                <SelectItem value="early">일찍 (06:30 출근 / 16:00 퇴근)</SelectItem>
                <SelectItem value="late">늦게 (08:00 출근 / 18:00 퇴근)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {favoriteItems.length > 0 && (
          <div className="overflow-x-auto rounded-lg border mb-4">
            <Table>
              <TableHeader>
                <TableRow className="bg-primary/10">
                  <TableHead className="w-6 text-center"></TableHead>
                  {favTH("name", "즐겨찾기", "min-w-[160px]")}
                  {favTH("households", "세대수")}
                  {favTH("avg", "현재가")}
                  <TableHead className="text-center" title="네이버 실매물 중 입주가능월까지 입주 가능한 매매 최저가 (세낀 제외)">호가</TableHead>
                  <TableHead className="text-center w-20">추이</TableHead>
                  {favTH("accel", "상승력")}
                  {favTH("liquidity", "환금")}
                  {favTH("commuteScore", "출퇴근")}
                  {favTH("pedScore", "소아과")}
                  {favTH("slope", "고저차")}
                  {favTH("parking", "주차")}
                  <TableHead className="text-center">초등학교</TableHead>
                  <TableHead className="text-center">안전</TableHead>
                  <TableHead className="text-center">내진</TableHead>
                  <TableHead className="text-center">LH</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {favoriteItems.map((d, idx) => {
                  const { data: sparkData, autoRange: sparkAuto } = buildSpark(d);
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
                      <TableCell className="text-center text-sm"><PricePopover data={d} capitalMan={capital ? parseFloat(capital) * 10000 : null} extraLoanMan={extraLoan ? parseFloat(extraLoan) * 10000 : 0} income1Man={income1 ? parseFloat(income1) * 10000 : 0} income2Man={income2 ? parseFloat(income2) * 10000 : 0} loanYears={parseInt(loanYears) || 30} extraRepayYrs={parseInt(extraRepayYears) || 2} household={household} normalRatePct={parseFloat(normalRate) || 5.2} loanProduct={loanProduct} interestSubsidy={interestSubsidy} includeInterior={includeInterior} /></TableCell>
                      <TableCell className="text-center text-sm"><MoveInCell data={d} allData={tradeFilteredData} targetMonth={moveInMonth} enabled={naverColEnabled} /></TableCell>
                      <TableCell className="text-center"><TrendCell d={d} spark={sparkData} pctRange={globalPctRange} autoRange={sparkAuto} excludeDirect={excludeDirect} excludeFirstFloor={excludeFirstFloor} trendRange={trendRange} /></TableCell>
                      <TableCell className="text-center"><AccelPopover data={d} /></TableCell>
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
                <TableHead className="text-center">상승력</TableHead>
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
                const { data: sparkData, autoRange: sparkAuto } = buildSpark(d);
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
                    <TableCell className="text-center text-sm"><PricePopover data={d} capitalMan={capital ? parseFloat(capital) * 10000 : null} extraLoanMan={extraLoan ? parseFloat(extraLoan) * 10000 : 0} income1Man={income1 ? parseFloat(income1) * 10000 : 0} income2Man={income2 ? parseFloat(income2) * 10000 : 0} loanYears={parseInt(loanYears) || 30} extraRepayYrs={parseInt(extraRepayYears) || 2} household={household} normalRatePct={parseFloat(normalRate) || 5.2} loanProduct={loanProduct} interestSubsidy={interestSubsidy} includeInterior={includeInterior} /></TableCell>
                      <TableCell className="text-center text-sm"><MoveInCell data={d} allData={tradeFilteredData} targetMonth={moveInMonth} enabled={naverColEnabled} /></TableCell>
                    <TableCell className="text-center"><TrendCell d={d} spark={sparkData} pctRange={globalPctRange} autoRange={sparkAuto} excludeDirect={excludeDirect} excludeFirstFloor={excludeFirstFloor} trendRange={trendRange} /></TableCell>
                    <TableCell className="text-center"><AccelPopover data={d} /></TableCell>
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
            {searchResults.rows.length > 0 && (
              <div className="max-h-96 overflow-y-auto overscroll-contain py-1">
                {searchResults.rows.map((d: any, i) => {
                  const inFilter = d._inFilter;
                  const reason = inFilter ? null : getFilterReason(d);
                  const favKey = `${d.name}|${d.atype}`;
                  const isFav = favorites.has(favKey);
                  const prev = searchResults.rows[i - 1];
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
                          if (viewMode !== "table") setViewMode("table"); // 지도 뷰에선 행이 없음
                          setJumpTarget(d.name); // 점진 렌더 범위 밖 행도 확장 후 스크롤 (effect 처리)
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
                {searchResults.hiddenComplexes > 0 && (
                  <div className="px-4 py-2 text-center text-[11px] text-muted-foreground border-t border-border/40 mt-0.5">
                    매칭 {searchResults.totalComplexes}개 단지 중 {searchResults.totalComplexes - searchResults.hiddenComplexes}개 표시 · 외 {searchResults.hiddenComplexes}개 — 검색어를 좁혀주세요
                  </div>
                )}
              </div>
            )}
            {searchQuery && searchResults.rows.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">검색 결과 없음</div>
            )}
          </div>
        )}
        <CompareTrendChart
          open={compareOpen}
          onOpenChange={setCompareOpen}
          items={data.filter((d) => favorites.has(`${d.name}|${d.atype}`))}
          onRemove={toggleFav}
          excludeDirect={excludeDirect}
          excludeFirstFloor={excludeFirstFloor}
          trendRange={trendRange}
        />
      </div>
    </div>
  );
}
