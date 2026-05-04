import { useEffect, useMemo, useState } from "react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Card, CardContent } from "@/components/ui/card";
import {
  type AptData, pedScore, commuteScore, calcScores,
  commuteLabel, pedLabel, parkingLabel, liquidityLabel, mgmtCostLabel, naverMapUrl, type Label,
} from "@/lib/scoring";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";

const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);

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

function AccelBadge({ value }: { value: number }) {
  const cls = value > 5 ? "text-emerald-500" : value < 0 ? "text-red-500" : "text-foreground";
  return <span className={cn("font-medium", cls)}>{value > 0 ? "+" : ""}{value}%</span>;
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

function CommutePopover({ data }: { data: AptData }) {
  const label = commuteLabel(data.commuteScore);
  const color = (m: number) =>
    m <= 30 ? "text-emerald-500" : m <= 40 ? "text-foreground" : m <= 50 ? "text-amber-500" : "text-red-500";
  return (
    <Popover>
      <PopoverTrigger><span className="cursor-pointer"><LabelBadge label={label} /></span></PopoverTrigger>
      <PopoverContent className="w-56 text-xs">
        <p className="font-semibold mb-2">출퇴근 상세</p>
        <div className="flex justify-between"><span className="text-muted-foreground">출근 평균</span><span>{data.morning ? `${data.morning}분` : "-"}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">퇴근 평균</span><span>{data.evening ? `${data.evening}분` : "-"}</span></div>
        {data.morning_details?.length > 0 && (
          <div className="mt-2"><p className="font-semibold text-muted-foreground mb-1">출근 기록</p>
            {data.morning_details.map((t, i) => <div key={i} className="flex justify-between"><span>{t.date.slice(5)} ({t.weekday}) {t.time ?? ""}</span><span className={color(t.minutes)}>{t.minutes}분</span></div>)}
          </div>
        )}
        {data.evening_details?.length > 0 && (
          <div className="mt-2"><p className="font-semibold text-muted-foreground mb-1">퇴근 기록</p>
            {data.evening_details.map((t, i) => <div key={i} className="flex justify-between"><span>{t.date.slice(5)} ({t.weekday}) {t.time ?? ""}</span><span className={color(t.minutes)}>{t.minutes}분</span></div>)}
          </div>
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
    v == null ? "" : Math.abs(v) >= 10 ? "text-red-400" : Math.abs(v) >= 5 ? "text-amber-400" : "text-emerald-400";
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

function calcAffordability(priceMan: number, capitalMan: number, extraLoanLimit: number, income1Man: number, income2Man: number, years: number, extraRepayYrs: number, areaSqm?: number) {
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
  const taxExempt = 200; // 생애최초 감면 200만원
  const netTax = Math.max(0, totalTax - taxExempt);

  // 중개보수 (0.4% + VAT 10%)
  let brokerRate: number;
  if (priceMan <= 5000) brokerRate = 0.006;
  else if (priceMan <= 20000) brokerRate = 0.005;
  else if (priceMan <= 90000) brokerRate = 0.004;
  else if (priceMan <= 120000) brokerRate = 0.005;
  else brokerRate = 0.006;
  const broker = Math.round(priceMan * brokerRate * 1.1);

  // 대출: LTV 70%, 최대 6억
  const ltvMax = Math.min(Math.round(priceMan * 0.7), 60000);
  // 추가대출 없이 먼저 필요자금 계산
  const dsrMaxNone = incomeMan && incomeMan > 0 ? calcDsrMaxLoan(incomeMan, 0, 0.055, 0.045, Math.min(years, 40)) : null;
  const maxLoanBase = dsrMaxNone != null ? Math.min(ltvMax, dsrMaxNone) : ltvMax;
  const shortfall = Math.max(0, priceMan + netTax + broker - maxLoanBase - capitalMan);

  // 실제 추가대출 = 모자란 금액, 한도 이내
  const extraLoanMan = Math.min(shortfall, extraLoanLimit);

  // DSR 기반 한도 (실제 추가대출 반영)
  const dsrMax = incomeMan && incomeMan > 0 ? calcDsrMaxLoan(incomeMan, extraLoanMan, 0.055, 0.045, Math.min(years, 40)) : null;
  const maxLoan = dsrMax != null ? Math.min(ltvMax, dsrMax) : ltvMax;
  const dsrLimited = dsrMax != null && dsrMax < ltvMax;

  // 총 자본금 = 보유자본 + 실제 추가대출
  const totalCapital = capitalMan + extraLoanMan;

  // 필요자금
  const required = priceMan + netTax + broker - maxLoan;
  const affordable = totalCapital >= required;

  // 월납입금/이자총액
  const mortgageRate = 0.045; // 주담대 4.5%
  const extraRate = 0.055; // 추가/신용대출 5.5%
  const months = years * 12;
  const mr = mortgageRate / 12;
  const mortgageMonthly = maxLoan > 0 ? Math.round(maxLoan * mr / (1 - Math.pow(1 + mr, -months))) : 0;
  const mortgageTotalInterest = maxLoan > 0 ? mortgageMonthly * months - maxLoan : 0;
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

  return { taxRate, acqTax, eduTax, ruralTax, totalTax, netTax, broker, ltvMax, dsrMax, maxLoan, dsrLimited, totalCapital, extraLoanMan, required, affordable, totalMonthly, mortgageMonthly, extraMonthly, mortgageRate, extraRate, totalInterest, extraRepayMonthly, extraRepayYrs, netMonthlyIncome, netMonthlyParental, repayRatio, repayRatioParental, years };
}

function PricePopover({ data, capitalMan, extraLoanMan, income1Man, income2Man, loanYears, extraRepayYrs }: { data: AptData; capitalMan: number | null; extraLoanMan: number; income1Man: number; income2Man: number; loanYears: number; extraRepayYrs: number }) {
  const priceText = `${(data.avg / 10000).toFixed(1)}억`;
  const aff = capitalMan != null ? calcAffordability(data.avg, capitalMan, extraLoanMan, income1Man, income2Man, loanYears, extraRepayYrs, data.area) : null;
  const color = aff ? (aff.affordable ? (aff.extraLoanMan > 0 ? "text-amber-500" : "text-emerald-500") : "text-red-400") : "";

  return (
    <Popover>
      <PopoverTrigger className={cn("cursor-pointer underline decoration-dotted underline-offset-4", color)}>{priceText}</PopoverTrigger>
      <PopoverContent className="w-64 text-xs max-h-80 overflow-y-auto">
        {aff && (
          <div className="mb-2 pb-2 border-b">
            <p className="font-semibold mb-1">{aff.affordable ? "구매 가능" : "자금 부족"}</p>
            <div className="space-y-0.5">
              <div className="flex justify-between"><span className="text-muted-foreground">매매가</span><span>{priceText}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">취득세 ({(aff.taxRate * 100).toFixed(1)}%+교육{aff.ruralTax > 0 ? "+농특" : ""})</span><span>{aff.netTax.toLocaleString()}만원</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">중개보수 (0.44%)</span><span>{aff.broker.toLocaleString()}만원</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">생애최초 감면</span><span className="text-emerald-500">-200만원</span></div>
              <div className="flex justify-between border-t pt-0.5"><span className="text-muted-foreground">총 비용</span><span>{((data.avg + aff.netTax + aff.broker) / 10000).toFixed(1)}억</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">LTV 한도 (70%, 6억)</span><span>-{(aff.ltvMax / 10000).toFixed(1)}억</span></div>
              {aff.dsrMax != null && <div className="flex justify-between"><span className="text-muted-foreground">DSR 한도 (40%)</span><span className={aff.dsrLimited ? "text-amber-500" : ""}>-{(aff.dsrMax / 10000).toFixed(1)}억</span></div>}
              {aff.dsrLimited && <p className="text-[10px] text-amber-500">DSR에 의해 대출 제한</p>}
              {aff.extraLoanMan > 0 && <div className="flex justify-between"><span className="text-muted-foreground">추가대출</span><span>+{(aff.extraLoanMan / 10000).toFixed(1)}억</span></div>}
              <div className="flex justify-between font-medium border-t pt-0.5"><span>필요 자본금</span><span className={aff.affordable ? "text-emerald-500" : "text-red-400"}>{(aff.required / 10000).toFixed(1)}억 {aff.extraLoanMan > 0 ? `(보유 ${(aff.totalCapital / 10000).toFixed(1)}억)` : ""}</span></div>
            </div>
            <div className="mt-2 pt-2 border-t space-y-0.5">
              <p className="font-semibold mb-0.5">월 상환 ({aff.years}년)</p>
              <div className="flex justify-between"><span className="text-muted-foreground">주담대 원리금 ({(aff.mortgageRate * 100).toFixed(1)}%)</span><span>{aff.mortgageMonthly.toLocaleString()}만원</span></div>
              {aff.extraMonthly > 0 && <div className="flex justify-between"><span className="text-muted-foreground">추가대출 이자 ({(aff.extraRate * 100).toFixed(1)}%)</span><span>{aff.extraMonthly.toLocaleString()}만원</span></div>}
              <div className="flex justify-between font-medium"><span>월 납입 합계</span><span>{aff.totalMonthly.toLocaleString()}만원</span></div>
              <div className="flex justify-between text-muted-foreground"><span>{aff.years}년 이자 총액</span><span>{(aff.totalInterest / 10000).toFixed(1)}억</span></div>
              {aff.repayRatio != null && (
                <div className="mt-1 pt-1 border-t space-y-0.5">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">상환비율 (세후{aff.netMonthlyIncome?.toLocaleString()}만)</span>
                    <span className={aff.repayRatio <= 0.25 ? "text-emerald-500" : aff.repayRatio <= 0.33 ? "" : "text-amber-500"}>{(aff.repayRatio * 100).toFixed(0)}% {aff.repayRatio <= 0.25 ? "안전" : aff.repayRatio <= 0.33 ? "적정" : "부담"}</span>
                  </div>
                  {aff.repayRatioParental != null && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">육아휴직 시 (세후{aff.netMonthlyParental?.toLocaleString()}만)</span>
                      <span className={aff.repayRatioParental! <= 0.25 ? "text-emerald-500" : aff.repayRatioParental! <= 0.33 ? "" : aff.repayRatioParental! <= 0.5 ? "text-amber-500" : "text-red-400"}>{(aff.repayRatioParental! * 100).toFixed(0)}% {aff.repayRatioParental! <= 0.25 ? "안전" : aff.repayRatioParental! <= 0.33 ? "적정" : aff.repayRatioParental! <= 0.5 ? "부담" : "위험"}</span>
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
  return (
    <Popover>
      <PopoverTrigger><span className="cursor-pointer"><AccelBadge value={data.accel} /></span></PopoverTrigger>
      <PopoverContent className="w-52 text-xs">
        <p className="font-semibold mb-2">가속도 계산</p>
        <p className="text-muted-foreground">(최근3개월 - 이전3개월) / 이전3개월</p>
        <div className="mt-2 flex justify-between"><span className="text-muted-foreground">최근3개월</span><span>{(data.r3_avg / 10000).toFixed(1)}억</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">이전3개월</span><span>{(data.p3_avg / 10000).toFixed(1)}억</span></div>
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
          <div className="flex justify-between"><span className="text-muted-foreground">{data.atype}타입 세대수</span><span>{Math.round(data.count / v * 100)}세대</span></div>
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

function MgmtCostCell({ data }: { data: AptData }) {
  const mc = data.mgmt_cost;
  if (mc == null) return <span className="text-muted-foreground text-xs">-</span>;
  const g = data.energy_grade;
  return (
    <Popover>
      <PopoverTrigger className="cursor-pointer"><LabelText label={mgmtCostLabel(mc)} /></PopoverTrigger>
      <PopoverContent className="w-56 text-xs">
        <p className="font-semibold mb-1">관리비 ({data.area}㎡ 기준)</p>
        <div className="space-y-0.5">
          <div className="flex justify-between"><span className="text-muted-foreground">연평균</span><span className="font-medium">{mc}만원/월</span></div>
          {data.mgmt_summer != null && <div className="flex justify-between"><span className="text-muted-foreground">여름</span><span>{data.mgmt_summer}만원</span></div>}
          {data.mgmt_winter != null && <div className="flex justify-between"><span className="text-muted-foreground">겨울</span><span>{data.mgmt_winter}만원</span></div>}
        </div>
        {g && (
          <div className="mt-2 pt-2 border-t">
            <p className="font-semibold mb-1">에너지효율등급: {g}</p>
            <div className="text-muted-foreground text-[10px] space-y-0.5">
              <div className="flex justify-between"><span>1+++</span><span>60 미만 kWh/㎡</span></div>
              <div className="flex justify-between"><span>1++</span><span>60~90</span></div>
              <div className="flex justify-between"><span>1+</span><span>90~120</span></div>
              <div className="flex justify-between"><span>1</span><span>120~150</span></div>
              <div className="flex justify-between"><span>2</span><span>150~200</span></div>
              <div className="flex justify-between"><span>3</span><span>200~250</span></div>
            </div>
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
      <PopoverTrigger className={cn("cursor-pointer text-xs font-medium", applied ? "text-emerald-500" : "text-red-400")}>
        {applied ? "적용" : "미적용"}
      </PopoverTrigger>
      <PopoverContent className="w-52 text-xs">
        <p className="font-semibold mb-2">내진설계</p>
        <div className="flex justify-between"><span className="text-muted-foreground">적용 여부</span><span className={applied ? "text-emerald-500" : "text-red-400"}>{applied ? "적용" : "미적용"}</span></div>
        {data.eq_capacity && <div className="flex justify-between"><span className="text-muted-foreground">내진능력</span><span>{data.eq_capacity}</span></div>}
        <div className="mt-2 pt-2 border-t text-muted-foreground text-[10px] space-y-1">
          <p>지진 발생 시 건물 붕괴를 방지하는 구조 설계</p>
          <div>
            <p className="font-semibold text-foreground/70">내진능력 읽는 법 (예: Ⅶ-0.169g)</p>
            <p>Ⅶ = MMI 진도 7 (벽 균열, 서 있기 어려움)</p>
            <p>0.169g = 최대지반가속도 (중력의 16.9%)</p>
            <p>숫자가 클수록 강한 지진을 견딤</p>
          </div>
          <div>
            <p className="font-semibold text-foreground/70">의무 적용 기준</p>
            <p>~2005: 6층 이상 (기준 낮음)</p>
            <p>2005~2017: 3층+, 연면적 1만㎡ 이상</p>
            <p>2017~: 2층 이상 모든 건축물</p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface MulticulturalCity {
  total: number; domestic: number; midEntry: number; foreign: number;
  countries: Record<string, { domestic: number; midEntry: number; foreign: number }>;
}
type MulticulturalData = Record<string, MulticulturalCity>;

function SchoolCell({ data }: { data: AptData }) {
  if (!data.schools || data.schools.length === 0) return <span className="text-muted-foreground text-xs">-</span>;
  const sv = data.school_violence ?? {};
  const totalViolence = Object.values(sv).reduce((sum, v) => sum + v.total, 0);
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger className="text-xs text-left cursor-default max-w-[80px] truncate block">
          {data.schools[0].replace("초등학교", "초")}
          {data.schools.length > 1 && <span className="text-muted-foreground"> +{data.schools.length - 1}</span>}
          {totalViolence > 0 && <span className="text-destructive ml-0.5">({totalViolence})</span>}
        </TooltipTrigger>
        <TooltipContent className="text-xs max-w-[320px]" side="left">
          <p className="font-semibold mb-2">배정 초등학교</p>
          <div className="flex flex-col gap-2">
            {data.schools.map((s) => {
              const v = sv[s];
              return (
                <div key={s} className="rounded-md bg-background/50 px-2 py-1.5">
                  <div className="font-medium mb-1">{s}</div>
                  {v ? (
                    v.total > 0 ? (
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-destructive font-semibold">학폭 심의 {v.total}건</span>
                          <span className="text-muted-foreground">(2024학년도)</span>
                        </div>
                        <div className="flex gap-3 text-muted-foreground">
                          <span>1학기 <span className={v.s1 > 0 ? "text-destructive" : ""}>{v.s1}건</span></span>
                          <span>2학기 <span className={v.s2 > 0 ? "text-destructive" : ""}>{v.s2}건</span></span>
                        </div>
                      </div>
                    ) : (
                      <span className="text-green-500">학폭 심의 0건</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">데이터 미조회</span>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-muted-foreground mt-2 text-[10px]">출처: 학교알리미 학교폭력대책심의위원회 심의 결과</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function MulticulturalPanel({ mc }: { mc: MulticulturalData }) {
  const [selected, setSelected] = useState<string>("수원시");
  const targets = ["수원시", "성남시", "용인시", "하남시", "화성시"];
  const items = targets.filter((c) => mc[c]).map((c) => ({ city: c, ...mc[c] }));
  if (items.length === 0) return <p className="text-xs text-muted-foreground">데이터 로딩 중...</p>;

  const maxTotal = Math.max(...items.map((d) => d.total));
  const detail = mc[selected];
  const topCountries = detail
    ? Object.entries(detail.countries)
        .map(([c, v]) => ({ country: c, domestic: v.domestic, midEntry: v.midEntry, foreign: v.foreign, total: v.domestic + v.midEntry + v.foreign }))
        .filter((d) => d.total > 0)
        .sort((a, b) => b.total - a.total)
    : [];

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">경기도교육청 2024 기준, 초등학교 다문화학생 수 (시 클릭 시 국적별 상세)</p>
      <div className="space-y-3">
        {items.map((d) => (
          <div key={d.city} className="space-y-1 cursor-pointer" onClick={() => setSelected(d.city)}>
            <div className="flex justify-between text-sm">
              <span className={cn("font-medium", selected === d.city && "text-primary")}>{d.city}</span>
              <span className="text-muted-foreground text-xs">
                {d.total.toLocaleString()}명
                <span className="ml-1 text-[10px]">(국내{d.domestic} 중도{d.midEntry} 외국{d.foreign})</span>
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
                  <div className="bg-blue-500 h-full" style={{ width: `${(d.domestic / topCountries[0].total) * 100}%` }} />
                  <div className="bg-amber-500 h-full" style={{ width: `${(d.midEntry / topCountries[0].total) * 100}%` }} />
                  <div className="bg-red-400 h-full" style={{ width: `${(d.foreign / topCountries[0].total) * 100}%` }} />
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

type SortKey = "score" | "accel" | "liquidity" | "commuteScore" | "pedScore" | "slope" | "avg" | "build" | "name";

export default function App() {
  const [data, setData] = useState<AptData[]>([]);
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortField, setSortField] = useState<SortKey>("score");
  const [regionFilter, setRegionFilter] = useState("all");
  const [commuteFilter, setCommuteFilter] = useState("all");
  const [capital, setCapital] = useState<string>(() => localStorage.getItem("capital") ?? "");
  const [income1, setIncome1] = useState<string>(() => localStorage.getItem("income1") ?? "");
  const [income2, setIncome2] = useState<string>(() => localStorage.getItem("income2") ?? "");
  const [extraLoan, setExtraLoan] = useState<string>(() => localStorage.getItem("extraLoan") ?? "");
  const [loanYears, setLoanYears] = useState<string>(() => localStorage.getItem("loanYears") ?? "30");
  const [extraRepayYears, setExtraRepayYears] = useState<string>(() => localStorage.getItem("extraRepayYears") ?? "2");
  const [infoOpen, setInfoOpen] = useState(false);
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

  useEffect(() => {
    fetch(import.meta.env.BASE_URL + "data.json")
      .then((r) => r.json())
      .then((raw: AptData[]) => {
        raw.forEach((d) => { d.pedScore = pedScore(d); d.commuteScore = commuteScore(d); d.score = 0; });
        calcScores(raw);
        setData(raw);
      });
    fetch(import.meta.env.BASE_URL + "multicultural.json")
      .then((r) => r.json())
      .then(setMulticultural)
      .catch(() => {});
  }, []);

  const regions = useMemo(() => [...new Set(data.map((d) => d.region.split(" ")[0]))].sort(), [data]);

  const filtered = useMemo(() => {
    let f = data.filter((d) => {
      if (typeFilter === "84") return d.atype === "84";
      if (typeFilter === "small") return d.atype !== "84";
      return true;
    });
    if (regionFilter !== "all") f = f.filter((d) => d.region.includes(regionFilter));
    if (commuteFilter === "good") f = f.filter((d) => d.commuteScore != null && d.commuteScore <= 30);
    else if (commuteFilter === "ok") f = f.filter((d) => d.commuteScore != null && d.commuteScore <= 40);

    f.sort((a, b) => {
      const va = a[sortField] ?? (["commuteScore", "pedScore", "slope", "avg"].includes(sortField) ? Infinity : -Infinity);
      const vb = b[sortField] ?? (["commuteScore", "pedScore", "slope", "avg"].includes(sortField) ? Infinity : -Infinity);
      if (sortField === "name") return String(va).localeCompare(String(vb));
      if (["commuteScore", "pedScore", "slope", "avg"].includes(sortField)) return (va as number) - (vb as number);
      return (vb as number) - (va as number);
    });
    return f;
  }, [data, typeFilter, sortField, regionFilter, commuteFilter]);

  const favoriteItems = useMemo(() => data.filter((d) => favorites.has(`${d.name}|${d.atype}`)), [data, favorites]);

  const globalPctRange = useMemo(() => {
    const aptMaxes: number[] = [];
    for (const d of data) {
      const prices = d.recent_trades?.map((t) => t.price) ?? [];
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
  }, [data]);

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="max-w-7xl mx-auto px-3 py-4 sm:px-6">
        <h1 className="text-xl font-bold mb-1">아파트 매수 후보 스코어링</h1>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
          <p className="text-xs text-muted-foreground">
            데이터: 2021-01~2026-04 실거래가 (전용 59~85㎡) | 최종 업데이트: {new Date().toLocaleDateString("ko-KR")}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 shrink-0">
            <div className="flex items-center gap-1">
              <label className="text-[10px] text-muted-foreground">자본금</label>
              <input type="number" step="0.1" placeholder="억" value={capital} onChange={(e) => { setCapital(e.target.value); localStorage.setItem("capital", e.target.value); }} className="w-14 text-xs bg-background border border-border rounded px-1.5 py-0.5 text-right" />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-[10px] text-muted-foreground">연봉1</label>
              <input type="number" step="0.01" placeholder="억" value={income1} onChange={(e) => { setIncome1(e.target.value); localStorage.setItem("income1", e.target.value); }} className="w-14 text-xs bg-background border border-border rounded px-1.5 py-0.5 text-right" />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-[10px] text-muted-foreground">연봉2</label>
              <input type="number" step="0.01" placeholder="억" value={income2} onChange={(e) => { setIncome2(e.target.value); localStorage.setItem("income2", e.target.value); }} className="w-14 text-xs bg-background border border-border rounded px-1.5 py-0.5 text-right" />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-[10px] text-muted-foreground">추가대출한도</label>
              <input type="number" step="0.1" placeholder="억" value={extraLoan} onChange={(e) => { setExtraLoan(e.target.value); localStorage.setItem("extraLoan", e.target.value); }} className="w-14 text-xs bg-background border border-border rounded px-1.5 py-0.5 text-right" />
            </div>
            <span className="text-[10px] text-muted-foreground">억</span>
            <select value={loanYears} onChange={(e) => { setLoanYears(e.target.value); localStorage.setItem("loanYears", e.target.value); }} className="text-xs bg-background border border-border rounded px-1 py-0.5">
              <option value="20">주담대20년</option>
              <option value="30">주담대30년</option>
              <option value="40">주담대40년</option>
              <option value="50">주담대50년</option>
            </select>
            <select value={extraRepayYears} onChange={(e) => { setExtraRepayYears(e.target.value); localStorage.setItem("extraRepayYears", e.target.value); }} className="text-xs bg-background border border-border rounded px-1 py-0.5">
              <option value="1">추가1년</option>
              <option value="2">추가2년</option>
              <option value="3">추가3년</option>
              <option value="5">추가5년</option>
            </select>
            <button className="text-[10px] text-muted-foreground border border-border rounded px-2 py-0.5 hover:text-foreground" onClick={() => { caches.keys().then(k => Promise.all(k.map(n => caches.delete(n)))).finally(() => location.reload()); }}>캐시 초기화</button>
            <Dialog open={mcOpen} onOpenChange={setMcOpen}>
              <DialogTrigger render={<Button variant="outline" size="sm" className="text-[10px] h-auto py-0.5 px-2" />}>다문화 통계</DialogTrigger>
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
            필터/스코어링 기준
            <ChevronDown className={cn("h-4 w-4 transition-transform", infoOpen && "rotate-180")} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Card className="mb-4">
              <CardContent className="text-xs text-muted-foreground space-y-3 pt-4">
                <div>
                  <p className="font-semibold text-foreground mb-1">필터 조건</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 items-center">
                    <span><Badge variant="destructive" className="text-[10px] mr-1">가격</Badge>최근 1개월 평균 7~9억</span>
                    <span><Badge variant="destructive" className="text-[10px] mr-1">세대수</Badge>500세대 이상</span>
                    <span><Badge variant="destructive" className="text-[10px] mr-1">스프링클러</Badge>2005년 이후 준공</span>
                    <span><Badge variant="destructive" className="text-[10px] mr-1">거래량</Badge>최근 6개월 3건+</span>
                  </div>
                </div>
                <div>
                  <p className="font-semibold text-foreground mb-1">스코어링 가중치</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 items-center">
                    <span><Badge className="text-[10px] mr-1">가속도 35%</Badge>최근 3개월 vs 이전 3개월</span>
                    <span><Badge className="text-[10px] mr-1">환금성 25%</Badge>거래건수 / 해당타입 세대수</span>
                    <span><Badge className="text-[10px] mr-1">신축도 20%</Badge>건축년도 기반</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </CollapsibleContent>
        </Collapsible>

        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <Select value={typeFilter} onValueChange={(v) => v && setTypeFilter(v)}>
            <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체</SelectItem>
              <SelectItem value="84">84~85㎡</SelectItem>
              <SelectItem value="small">59~76㎡</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sortField} onValueChange={(v) => v && setSortField(v as SortKey)}>
            <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="score">점수순</SelectItem>
              <SelectItem value="accel">가속도순</SelectItem>
              <SelectItem value="liquidity">환금성순</SelectItem>
              <SelectItem value="commuteScore">출퇴근순</SelectItem>
              <SelectItem value="pedScore">소아과순</SelectItem>
              <SelectItem value="avg">현재가순</SelectItem>
            </SelectContent>
          </Select>
          <Select value={regionFilter} onValueChange={(v) => v && setRegionFilter(v)}>
            <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체 지역</SelectItem>
              {regions.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={commuteFilter} onValueChange={(v) => v && setCommuteFilter(v)}>
            <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">출퇴근 전체</SelectItem>
              <SelectItem value="good">좋음 이상</SelectItem>
              <SelectItem value="ok">보통 이상</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">{filtered.length}개 단지</span>
        </div>

        {favoriteItems.length > 0 && (
          <div className="overflow-x-auto rounded-lg border mb-4">
            <Table>
              <TableHeader>
                <TableRow className="bg-primary/10">
                  <TableHead className="w-6 text-center"></TableHead>
                  <TableHead className="min-w-[160px]">즐겨찾기</TableHead>
                  <TableHead className="text-center">현재가</TableHead>
                  <TableHead className="text-center w-20">추이</TableHead>
                  <TableHead className="text-center">가속도</TableHead>
                  <TableHead className="text-center">환금</TableHead>
                  <TableHead className="text-center">출퇴근</TableHead>
                  <TableHead className="text-center">소아과</TableHead>
                  <TableHead className="text-center">고저차</TableHead>
                  <TableHead className="text-center">주차</TableHead>
                  <TableHead className="text-center">관리비</TableHead>
                  <TableHead className="text-center">내진</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {favoriteItems.map((d) => {
                  const sparkData = d.recent_trades?.slice().reverse().map((t) => ({ date: t.date, price: t.price })) ?? [];
                  const favKey = `${d.name}|${d.atype}`;
                  return (
                    <TableRow key={`fav-${favKey}`} className="bg-primary/5">
                      <TableCell className="text-center cursor-pointer" onClick={() => toggleFav(favKey)}>★</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <div>
                            <span className="text-muted-foreground text-[11px] mr-1">{d.region.split(" ")[0]}</span>
                            <span className="font-medium text-sm">{d.display_name}</span>
                            <Badge variant="outline" className={cn("ml-1 text-[10px]", d.atype === "84" ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : d.atype === "74" ? "bg-amber-500/10 text-amber-500 border-amber-500/20" : "bg-red-500/10 text-red-500 border-red-500/20")}>{d.area}㎡</Badge>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-center text-sm"><PricePopover data={d} capitalMan={capital ? parseFloat(capital) * 10000 : null} extraLoanMan={extraLoan ? parseFloat(extraLoan) * 10000 : 0} income1Man={income1 ? parseFloat(income1) * 10000 : 0} income2Man={income2 ? parseFloat(income2) * 10000 : 0} loanYears={parseInt(loanYears) || 30} extraRepayYrs={parseInt(extraRepayYears) || 2} /></TableCell>
                      <TableCell className="text-center"><Sparkline data={sparkData} pctRange={globalPctRange} /></TableCell>
                      <TableCell className="text-center"><AccelPopover data={d} /></TableCell>
                      <TableCell className="text-center"><LiquidityCell data={d} /></TableCell>
                      <TableCell className="text-center"><CommutePopover data={d} /></TableCell>
                      <TableCell className="text-center"><PedPopover data={d} /></TableCell>
                      <TableCell className="text-center"><SlopePopover data={d} /></TableCell>
                      <TableCell className="text-center"><ParkingCell data={d} /></TableCell>
                      <TableCell className="text-center"><MgmtCostCell data={d} /></TableCell>
                      <TableCell className="text-center"><EqCell data={d} /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="w-6 text-center"></TableHead>
                <TableHead className="w-8 text-center">#</TableHead>
                <TableHead className="min-w-[160px]">단지명</TableHead>
                <TableHead className="text-center">현재가</TableHead>
                <TableHead className="text-center w-20">추이</TableHead>
                <TableHead className="text-center">가속도</TableHead>
                <TableHead className="text-center">환금</TableHead>
                <TableHead className="text-center">출퇴근</TableHead>
                <TableHead className="text-center">소아과</TableHead>
                <TableHead className="text-center">고저차</TableHead>
                <TableHead className="text-center">주차</TableHead>
                <TableHead className="text-center">관리비</TableHead>
                <TableHead className="text-center">초등학교</TableHead>
                <TableHead className="text-center">내진</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((d, i) => {
                const sparkData = d.recent_trades
                  ?.slice()
                  .reverse()
                  .map((t) => ({ date: t.date, price: t.price })) ?? [];
                const favKey = `${d.name}|${d.atype}`;
                const isFav = favorites.has(favKey);
                return (
                  <TableRow key={favKey} className={isFav ? "bg-primary/5" : ""}>
                    <TableCell className="text-center cursor-pointer" onClick={() => toggleFav(favKey)}>{isFav ? "★" : "☆"}</TableCell>
                    <TableCell className="text-center text-muted-foreground text-xs">{i + 1}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <div>
                          <span className="text-muted-foreground text-[11px] mr-1">{d.region.split(" ")[0]}</span>
                          <Popover>
                            <PopoverTrigger className="cursor-pointer font-medium text-sm hover:underline decoration-dotted underline-offset-4">{d.display_name}</PopoverTrigger>
                            <PopoverContent className="w-64 text-xs">
                              <p className="font-semibold mb-2">단지 정보</p>
                              {d.doro_juso && <p className="text-muted-foreground mb-2">{d.doro_juso}</p>}
                              <div className="space-y-0.5">
                                {d.households != null && <div className="flex justify-between"><span className="text-muted-foreground">세대수</span><span>{d.households.toLocaleString()}세대</span></div>}
                                {d.dong_count != null && <div className="flex justify-between"><span className="text-muted-foreground">동수</span><span>{d.dong_count}동</span></div>}
                                {d.top_floor != null && <div className="flex justify-between"><span className="text-muted-foreground">최고층</span><span>{d.top_floor}층</span></div>}
                                {d.structure && <div className="flex justify-between"><span className="text-muted-foreground">구조</span><span>{d.structure}</span></div>}
                                {d.heat_type && <div className="flex justify-between"><span className="text-muted-foreground">난방</span><span>{d.heat_type}</span></div>}
                                {d.use_date && <div className="flex justify-between"><span className="text-muted-foreground">사용승인</span><span>{d.use_date.slice(0, 4)}.{d.use_date.slice(4, 6)}.{d.use_date.slice(6, 8)}</span></div>}
                                {d.cctv != null && d.cctv > 0 && <div className="flex justify-between"><span className="text-muted-foreground">CCTV</span><span>{d.cctv}대</span></div>}
                                {d.eq_design != null && <div className="flex justify-between"><span className="text-muted-foreground">내진설계</span><span className={d.eq_design ? "text-emerald-500" : "text-red-400"}>{d.eq_design ? "적용" : "미적용"}{d.eq_capacity ? ` (${d.eq_capacity})` : ""}</span></div>}
                              </div>
                              {d.education && (
                                <div className="mt-2 pt-2 border-t">
                                  <p className="text-muted-foreground">교육시설</p>
                                  <p className="mt-0.5">{d.education}</p>
                                </div>
                              )}
                            </PopoverContent>
                          </Popover>
                          <Badge variant="outline" className={cn("ml-1 text-[10px]", d.atype === "84" ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : d.atype === "74" ? "bg-amber-500/10 text-amber-500 border-amber-500/20" : "bg-red-500/10 text-red-500 border-red-500/20")}>{d.area}㎡</Badge>
                          <span className="text-muted-foreground text-[10px] ml-0.5">({d.build})</span>
                        </div>
                        <div className="flex gap-2 text-[10px]">
                          {d.hcode
                            ? <a href={`https://hogangnono.com/apt/${d.hcode}`} target="_blank" rel="noopener" className="text-primary hover:underline">호갱노노</a>
                            : <a href={`https://new.land.naver.com/search?query=${encodeURIComponent(d.name)}`} target="_blank" rel="noopener" className="text-muted-foreground hover:underline">네이버부동산</a>
                          }
                          <a href={naverMapUrl(d.naver_place_id, `${d.name} ${d.dong}`, isMobile)} target="_blank" rel="noopener" className="text-primary hover:underline">네이버지도</a>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-center text-sm"><PricePopover data={d} capitalMan={capital ? parseFloat(capital) * 10000 : null} extraLoanMan={extraLoan ? parseFloat(extraLoan) * 10000 : 0} income1Man={income1 ? parseFloat(income1) * 10000 : 0} income2Man={income2 ? parseFloat(income2) * 10000 : 0} loanYears={parseInt(loanYears) || 30} extraRepayYrs={parseInt(extraRepayYears) || 2} /></TableCell>
                    <TableCell className="text-center"><Sparkline data={sparkData} pctRange={globalPctRange} /></TableCell>
                    <TableCell className="text-center"><AccelPopover data={d} /></TableCell>
                    <TableCell className="text-center"><LiquidityCell data={d} /></TableCell>
                    <TableCell className="text-center"><CommutePopover data={d} /></TableCell>
                    <TableCell className="text-center"><PedPopover data={d} /></TableCell>
                    <TableCell className="text-center"><SlopePopover data={d} /></TableCell>
                    <TableCell className="text-center"><ParkingCell data={d} /></TableCell>
                    <TableCell className="text-center"><MgmtCostCell data={d} /></TableCell>
                    <TableCell className="text-center"><SchoolCell data={d} /></TableCell>
                    <TableCell className="text-center"><EqCell data={d} /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
