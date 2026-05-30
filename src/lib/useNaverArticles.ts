import { useCallback, useEffect, useReducer, useState } from "react";

// 네이버 실매물 프록시 URL 해석 (런타임).
// 우선순위: localStorage("naverProxyUrl") > 빌드시 VITE_NAVER_PROXY_URL > 로컬 fallback.
// quick tunnel(trycloudflare) URL이 재시작마다 바뀌므로 런타임 설정 가능하게 함.
const PROXY_KEY = "naverProxyUrl";
export function getProxyUrl(): string {
  try {
    const v = localStorage.getItem(PROXY_KEY);
    if (v && v.trim()) return v.trim().replace(/\/+$/, "");
  } catch { /* ignore */ }
  return (import.meta.env.VITE_NAVER_PROXY_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
}
export function setProxyUrl(url: string) {
  try {
    const v = url.trim().replace(/\/+$/, "");
    if (v) localStorage.setItem(PROXY_KEY, v);
    else localStorage.removeItem(PROXY_KEY);
  } catch { /* ignore */ }
}

export type NaverArticle = {
  articleNo: string;
  trade: string; // A1/B1/B2/B3
  tradeName: string; // 매매/전세/월세/단기
  dealPrice: number; // 원
  warrantyPrice: number; // 보증금(전월세) 원
  rentPrice: number; // 월세 원
  mgmtFee: number; // 관리비 원
  priceChange: number; // 0=변동없음, 1=상승, 2=하락(추정)
  exclusiveArea: number | null; // 전용 ㎡
  exclusiveName: string | null; // "84B"
  supplyArea: number | null;
  dong: string | null; // "807동"
  floor: string | null; // "13/13" / "고/13"
  direction: string | null; // "SS"
  directionName: string | null; // "남"
  feature: string | null;
  directTrade: boolean;
  confirmDate: string | null; // "2026-05-27"
  verifyType: string | null; // OWNER/MOBL/DOC ...
  broker: string | null;
  elapsedYear: number | null;
  dupCount: number;
  moveIn?: { raw: string | null; immediate: boolean; date: string | null }; // 입주가능일(상세)
};

type NaverResult = {
  totalCount: number;
  count: number;
  hasNextPage: boolean;
  articles: NaverArticle[];
  cached?: boolean;
};

type State = {
  loading: boolean;
  data: NaverResult | null;
  error: string | null;
};

export function useNaverArticles() {
  const [state, setState] = useState<State>({ loading: false, data: null, error: null });

  const fetchArticles = useCallback(async (complexNo: string, pyeongTypeNos?: number[] | null, trade = "A1") => {
    setState({ loading: true, data: null, error: null });
    try {
      const qs = new URLSearchParams({ complexNo, trade });
      if (pyeongTypeNos && pyeongTypeNos.length > 0) qs.set("pyeongTypes", pyeongTypeNos.join("-"));
      const r = await fetch(`${getProxyUrl()}/articles?${qs}`, { signal: AbortSignal.timeout(12000) });
      const json = await r.json();
      if (!r.ok) throw new Error(json?.error || `proxy ${r.status}`);
      setState({ loading: false, data: json as NaverResult, error: null });
    } catch (e) {
      setState({ loading: false, data: null, error: (e as Error).message });
    }
  }, []);

  return { ...state, fetchArticles };
}

/** 730000000(원) → "7.3억" / 900000000 → "9.0억" / 5000만 → "5,000만" (현재가 컬럼과 동일 표기) */
export function formatWon(won: number): string {
  if (!won || won <= 0) return "-";
  const man = Math.round(won / 10000);
  if (man >= 10000) return `${(man / 10000).toFixed(1)}억`;
  return `${man.toLocaleString()}만`;
}

/** 매물 가격 표시: 매매=매매가, 전세=보증금, 월세=보증금/월세 */
export function formatArticlePrice(a: NaverArticle): string {
  if (a.trade === "B2") return `${formatWon(a.warrantyPrice)}/${Math.round(a.rentPrice / 10000)}`;
  if (a.trade === "B1" || a.trade === "B3") return formatWon(a.warrantyPrice);
  return formatWon(a.dealPrice);
}

/** "2026-05-27" → "5/27" */
export function formatConfirm(ymd: string | null): string {
  if (!ymd) return "";
  const m = ymd.match(/\d{4}-(\d{2})-(\d{2})/);
  return m ? `${parseInt(m[1])}/${parseInt(m[2])}` : ymd;
}

const VERIFY_LABEL: Record<string, string> = {
  OWNER: "집주인",
  MOBL: "현장확인",
  DOC: "서류확인",
  SITE: "현장확인",
};
export function verifyLabel(t: string | null): string | null {
  if (!t) return null;
  return VERIFY_LABEL[t] ?? null;
}

// ── 매물 입주가능 판별 ──────────────────────────────────────────────────
/** 매물이 targetMonth("YYYY-MM")까지 실입주 가능한가. 즉시입주=항상, 날짜=해당월≤target. */
export function isMovableBy(a: NaverArticle, targetMonth: string): boolean {
  const mi = a.moveIn;
  if (!mi) return false; // 입주정보 미확보 → 보수적으로 제외
  if (mi.immediate) return true;
  if (mi.date) return mi.date.slice(0, 7) <= targetMonth;
  return false; // 날짜 미상(협의만) → 제외
}
/** 세낀(세입자 승계) 추정: 즉시입주 아니고 미래 입주일 → 점유중. */
export function isTenant(a: NaverArticle): boolean {
  const mi = a.moveIn;
  return !!mi && !mi.immediate && !!mi.date;
}
/** 입주가능일 표시 라벨. */
export function moveInLabel(a: NaverArticle): string {
  const mi = a.moveIn;
  if (!mi || (!mi.immediate && !mi.date && !mi.raw)) return "입주미상";
  if (mi.immediate) return "즉시입주";
  if (mi.date) {
    const [y, m] = mi.date.split("-");
    return `${y.slice(2)}.${m} 입주`;
  }
  return mi.raw || "협의";
}

// ── 컬럼용 공유 스토어 (단지×평형별 1회 로드, 동시성 제한) ───────────────
type Entry = { status: "loading" | "done" | "error"; articles: NaverArticle[]; error?: string };
const _store = new Map<string, Entry>();
const _subs = new Set<() => void>();
const _queue: (() => void)[] = [];
let _active = 0;
const MAX_CONCURRENT = 2;
function _emit() { _subs.forEach((f) => f()); }
function _pump() {
  while (_active < MAX_CONCURRENT && _queue.length) {
    const job = _queue.shift()!;
    _active++;
    job();
  }
}
function keyOf(complexId: string, pyeongTypeNos: number[] | null): string {
  return `${complexId}|${pyeongTypeNos?.length ? pyeongTypeNos.join("-") : ""}`;
}
/** 단지×평형 매물(입주가능일 포함)을 1회 로드해 스토어에 채움. */
export function ensureListings(complexId: string, pyeongTypeNos: number[] | null): string {
  const key = keyOf(complexId, pyeongTypeNos);
  if (_store.has(key)) return key;
  _store.set(key, { status: "loading", articles: [] });
  _emit();
  _queue.push(() => {
    const qs = new URLSearchParams({ complexNo: complexId, trade: "A1", movein: "1" });
    if (pyeongTypeNos?.length) qs.set("pyeongTypes", pyeongTypeNos.join("-"));
    fetch(`${getProxyUrl()}/articles?${qs}`, { signal: AbortSignal.timeout(120000) })
      .then(async (r) => ({ ok: r.ok, j: await r.json() }))
      .then(({ ok, j }) => {
        if (!ok) throw new Error(j?.error || "proxy error");
        _store.set(key, { status: "done", articles: (j.articles ?? []) as NaverArticle[] });
      })
      .catch((e) => _store.set(key, { status: "error", articles: [], error: (e as Error).message }))
      .finally(() => { _active--; _emit(); _pump(); });
  });
  _pump();
  return key;
}
/** 컬럼 셀에서 사용: enabled면 로드 트리거 + 스토어 구독. */
export function useColumnListings(complexId: string | null, pyeongTypeNos: number[] | null, enabled: boolean): Entry | null {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    if (!enabled || !complexId) return;
    ensureListings(complexId, pyeongTypeNos);
    _subs.add(force);
    return () => { _subs.delete(force); };
  }, [complexId, pyeongTypeNos, enabled]);
  if (!enabled || !complexId) return null;
  return _store.get(keyOf(complexId, pyeongTypeNos)) ?? null;
}
