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
  commuteLabel, pedLabel, parkingLabel, naverMapUrl, type Label,
} from "@/lib/scoring";
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

function AccelBadge({ value }: { value: number }) {
  const cls = value > 5 ? "text-emerald-500" : value < 0 ? "text-red-500" : "text-foreground";
  return <span className={cn("font-medium", cls)}>{value > 0 ? "+" : ""}{value}%</span>;
}

function Sparkline({ data }: { data: { date: string; price: number }[] }) {
  if (!data.length) return null;
  const prices = data.map((d) => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const w = 80, h = 24, pad = 2;
  const points = data.map((d, i) => {
    const x = pad + (i / Math.max(data.length - 1, 1)) * (w - pad * 2);
    const y = h - pad - ((d.price - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  }).join(" ");
  const last = prices[prices.length - 1];
  const first = prices[0];
  const color = last >= first ? "#4ade80" : "#f87171";
  return (
    <svg width={w} height={h} className="inline-block">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
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

function PricePopover({ data }: { data: AptData }) {
  if (!data.recent_trades?.length) return <span>{(data.avg / 10000).toFixed(1)}억</span>;
  return (
    <Popover>
      <PopoverTrigger className="cursor-pointer underline decoration-dotted underline-offset-4">{(data.avg / 10000).toFixed(1)}억</PopoverTrigger>
      <PopoverContent className="w-60 text-xs">
        <p className="font-semibold mb-2">최근 거래 (4월~)</p>
        <table className="w-full text-xs">
          <thead><tr className="text-muted-foreground"><th className="text-left pb-1">날짜</th><th>가격</th><th>층</th><th>면적</th></tr></thead>
          <tbody>{data.recent_trades.map((t, i) => <tr key={i}><td className="text-left">{t.date.slice(5)}</td><td>{t.price}억</td><td>{t.floor}층</td><td>{t.area}㎡</td></tr>)}</tbody>
        </table>
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

function ParkingCell({ data }: { data: AptData }) {
  const v = data.parking_per_hh;
  if (v == null) return <span className="text-muted-foreground text-xs">-</span>;
  const label = parkingLabel(v);
  return (
    <Popover>
      <PopoverTrigger className="cursor-pointer"><LabelBadge label={label} /></PopoverTrigger>
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

type SortKey = "score" | "accel" | "liquidity" | "commuteScore" | "pedScore" | "slope" | "avg" | "build" | "name";

export default function App() {
  const [data, setData] = useState<AptData[]>([]);
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortField, setSortField] = useState<SortKey>("score");
  const [regionFilter, setRegionFilter] = useState("all");
  const [commuteFilter, setCommuteFilter] = useState("all");
  const [infoOpen, setInfoOpen] = useState(false);
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
      // 즐겨찾기 상단 pin
      const aFav = favorites.has(`${a.name}|${a.atype}`) ? 1 : 0;
      const bFav = favorites.has(`${b.name}|${b.atype}`) ? 1 : 0;
      if (aFav !== bFav) return bFav - aFav;

      const va = a[sortField] ?? (["commuteScore", "pedScore", "slope", "avg"].includes(sortField) ? Infinity : -Infinity);
      const vb = b[sortField] ?? (["commuteScore", "pedScore", "slope", "avg"].includes(sortField) ? Infinity : -Infinity);
      if (sortField === "name") return String(va).localeCompare(String(vb));
      if (["commuteScore", "pedScore", "slope", "avg"].includes(sortField)) return (va as number) - (vb as number);
      return (vb as number) - (va as number);
    });
    return f;
  }, [data, typeFilter, sortField, regionFilter, commuteFilter, favorites]);

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="max-w-7xl mx-auto px-3 py-4 sm:px-6">
        <h1 className="text-xl font-bold mb-1">아파트 매수 후보 스코어링</h1>
        <p className="text-xs text-muted-foreground mb-4">
          데이터: 2021-01~2026-04 실거래가 (전용 59~85㎡) | 최종 업데이트: {new Date().toLocaleDateString("ko-KR")}
        </p>

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
                <TableHead className="text-center">출퇴근<br />용이성</TableHead>
                <TableHead className="text-center">소아과<br />접근성</TableHead>
                <TableHead className="text-center hidden sm:table-cell">고저차</TableHead>
                <TableHead className="text-center hidden sm:table-cell">주차</TableHead>
                <TableHead className="text-center">점수</TableHead>
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
                            <PopoverTrigger className="cursor-pointer font-medium text-sm hover:underline decoration-dotted underline-offset-4">{d.name}</PopoverTrigger>
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
                              </div>
                              {d.education && (
                                <div className="mt-2 pt-2 border-t">
                                  <p className="text-muted-foreground">교육시설</p>
                                  <p className="mt-0.5">{d.education}</p>
                                </div>
                              )}
                            </PopoverContent>
                          </Popover>
                          {d.atype !== "84" && <Badge variant="outline" className="ml-1 text-[10px] bg-emerald-500/10 text-emerald-500 border-emerald-500/20">{d.area}㎡</Badge>}
                          <span className="text-muted-foreground text-[10px] ml-0.5">({d.build})</span>
                        </div>
                        <div className="flex gap-2 text-[10px]">
                          {d.hcode
                            ? <a href={`https://hogangnono.com/apt/${d.hcode}`} target="_blank" rel="noopener" className="text-primary hover:underline">호갱노노</a>
                            : <a href={`https://new.land.naver.com/search?query=${encodeURIComponent(d.name)}`} target="_blank" rel="noopener" className="text-muted-foreground hover:underline">네이버부동산</a>
                          }
                          <a href={naverMapUrl(`${d.name} ${d.dong}`, isMobile)} target="_blank" rel="noopener" className="text-primary hover:underline">네이버지도</a>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-center text-sm"><PricePopover data={d} /></TableCell>
                    <TableCell className="text-center"><Sparkline data={sparkData} /></TableCell>
                    <TableCell className="text-center"><AccelPopover data={d} /></TableCell>
                    <TableCell className="text-center text-xs">{d.liquidity ? `${d.liquidity}%${d.liq_approx ? "*" : ""}` : "-"}</TableCell>
                    <TableCell className="text-center"><CommutePopover data={d} /></TableCell>
                    <TableCell className="text-center"><PedPopover data={d} /></TableCell>
                    <TableCell className="text-center hidden sm:table-cell"><SlopePopover data={d} /></TableCell>
                    <TableCell className="text-center hidden sm:table-cell"><ParkingCell data={d} /></TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-1">
                        <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(d.score / 80 * 100, 100)}%` }} />
                        </div>
                        <span className="text-xs font-medium w-6">{d.score}</span>
                      </div>
                    </TableCell>
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
