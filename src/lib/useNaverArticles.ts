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
  // 기본값 = 공개 Tailscale Funnel(고정). env(VITE_NAVER_PROXY_URL)·localStorage로 덮어쓰기 가능.
  // (URL은 비밀 아님 — 접근 차단은 비밀 토큰이 담당. localhost fallback은 footgun이라 제거)
  return (import.meta.env.VITE_NAVER_PROXY_URL || "https://home-scoring.tailee49c2.ts.net").replace(/\/+$/, "");
}
export function setProxyUrl(url: string) {
  try {
    const v = url.trim().replace(/\/+$/, "");
    if (v) localStorage.setItem(PROXY_KEY, v);
    else localStorage.removeItem(PROXY_KEY);
  } catch { /* ignore */ }
}

// 프록시 비밀 토큰 (공개 번들엔 미포함 — 사용자가 브라우저별로 1회 입력, localStorage 저장).
const TOKEN_KEY = "naverProxyToken";
export function getProxyToken(): string {
  try { return (localStorage.getItem(TOKEN_KEY) || "").trim(); } catch { return ""; }
}
export function setProxyToken(token: string) {
  try {
    const v = token.trim();
    if (v) localStorage.setItem(TOKEN_KEY, v);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}
function authHeaders(): Record<string, string> {
  const t = getProxyToken();
  return t ? { "x-proxy-token": t } : {};
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
      const r = await fetch(`${getProxyUrl()}/articles?${qs}`, { headers: authHeaders(), signal: AbortSignal.timeout(12000) });
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
/**
 * 매물 설명에 '주인전세/주전' 등 → 매도 후에도 집주인이 전세로 거주 → 실입주 불가(점유 매물).
 * '주인거주/주인입주'(즉시입주 가능)와 구분하기 위해 '전세/임대' 동반 패턴만 매칭.
 * 오탐 방지: 주전자/주전부리 제외.
 */
export function isOwnerJeonse(a: NaverArticle): boolean {
  const t = a.feature || "";
  return /주인\s*전세|집주인\s*전세|주인\s*임대|소유자\s*전세|주전(?!자|부리)|주전세/.test(t);
}
/**
 * 매물 설명에 '세안고/세끼고/세낀/세승계/임대중' 등 → 세입자 점유(매수 후 승계).
 * 입주가능일이 '즉시입주'로 표기돼도 실제론 세가 껴서 실입주 불가 → 세낀으로 취급.
 * 부분일치로 [전세/월세/반전세]안고·끼고·낀·승계까지 모두 커버. 오탐 방지(세없음/공실 등은 미매칭).
 */
export function hasTenantText(a: NaverArticle): boolean {
  const t = a.feature || "";
  return /세\s*안고|세\s*끼고|세\s*낀|세\s*승계|보증금\s*승계|세입자\s*(?:있|거주|승계|존재|만기)|임대\s*중/.test(t);
}
/** 매물이 targetMonth("YYYY-MM")까지 실입주 가능한가. 즉시입주=항상, 날짜=해당월≤target. */
export function isMovableBy(a: NaverArticle, targetMonth: string): boolean {
  if (isOwnerJeonse(a)) return false; // 주인전세 → 점유 지속, 실입주 불가
  if (hasTenantText(a)) return false; // 세안고/세낀(즉시입주 표기여도) → 세입자 점유, 실입주 불가
  const mi = a.moveIn;
  if (!mi) return false; // 입주정보 미확보 → 보수적으로 제외
  if (mi.immediate) return true;
  if (mi.date) return mi.date.slice(0, 7) <= targetMonth;
  return false; // 날짜 미상(협의만) → 제외
}
/** 세낀(세입자 승계) 추정: 설명에 세안고 류 텍스트 OR 즉시입주 아니고 미래 입주일 → 점유중. */
export function isTenant(a: NaverArticle): boolean {
  if (hasTenantText(a)) return true; // 설명 기반: 즉시입주 표기여도 세안고면 세낀
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

// ── 면적(㎡) → atype 버킷 (pipeline/sync.ts:areaType와 동일해야 함) ─────────
// 네이버 평형번호는 단지 내부 평면형(84A/84B/84E…) 단위라 우리 atype 버킷과 1:1로
// 매핑되지 않는다(같은 84.98이 비연속 번호 1·2·5로 쪼개짐). 그래서 평형번호 필터 대신
// 단지 전체 매물을 받아 전용면적으로 직접 버킷 필터한다.
export function areaType(a: number): string {
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
/**
 * 단지 전체 매물 중 이 atype row에 속하는 것만.
 * data의 atype은 "거래면적 기준 버킷", area는 "대표 평형(세대수 최다)"이라 areaType(area)≠atype일 수 있다
 * (예: 98.54가 atype "99"로 라벨 — areaType은 "114"). 그래서 단순 버킷 비교 대신,
 * 단지의 atype별 대표면적(reps) 중 매물 전용면적과 **가장 가까운** atype에 배정한다.
 * reps가 없거나 1개뿐이면 areaType() 버킷 비교로 폴백.
 */
export function articlesForAtype(
  articles: NaverArticle[],
  atype: string | null,
  reps?: { atype: string; area: number | null }[],
): NaverArticle[] {
  if (!atype) return articles;
  const pts = (reps ?? []).filter((c) => c.area != null) as { atype: string; area: number }[];
  if (pts.length <= 1) {
    return articles.filter((a) => a.exclusiveArea != null && areaType(a.exclusiveArea) === atype);
  }
  return articles.filter((a) => {
    const x = a.exclusiveArea;
    if (x == null) return false;
    let best = pts[0].atype, bd = Infinity;
    for (const c of pts) {
      const dist = Math.abs(c.area - x);
      if (dist < bd) { bd = dist; best = c.atype; }
    }
    return best === atype;
  });
}

// ── 컬럼용 공유 스토어 (단지 단위 1회 로드, 동시성 제한) ──────────────────
// 단지 전체 매물을 complexId 단독 키로 캐싱 → 같은 단지의 여러 평형 row가 1회 fetch 공유.
// 평형별 표시는 각 셀에서 articlesForAtype로 필터(평형번호 미사용).
export type Entry = { status: "loading" | "done" | "error"; articles: NaverArticle[]; error?: string };
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
function keyOf(complexId: string): string {
  return complexId;
}

/**
 * NDJSON 스트림 1회 실행. 프록시가 {type:list} → {type:movein}×N → {type:done} 순서로 흘려보냄.
 * - list 도착 즉시 articles 채움(status는 loading 유지) → 팝오버가 바로 열림.
 * - movein 한 줄마다 해당 매물 입주정보 부착 후 _emit → 동적 추가.
 * 비스트림(구버전 프록시·에러) 응답이면 한방 JSON으로 폴백.
 */
async function _runStream(key: string, complexId: string, force: boolean, prevArticles: NaverArticle[]): Promise<void> {
  // pyeongTypes 미전송 → 단지 전체 매물 수신. 평형 스코핑은 표시 단계에서 면적 필터로 처리.
  const qs = new URLSearchParams({ complexNo: complexId, trade: "A1", movein: "1", stream: "1" });
  if (force) qs.set("fresh", "1");
  let articles: NaverArticle[] = prevArticles;
  const byNo = new Map<string, NaverArticle>();
  try {
    const r = await fetch(`${getProxyUrl()}/articles?${qs}`, { headers: authHeaders(), signal: AbortSignal.timeout(120000) });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !ct.includes("ndjson") || !r.body) {
      // 폴백: 구버전 프록시(한방 JSON) 또는 에러 응답
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || `proxy ${r.status}`);
      // 200이지만 JSON이 아니거나(터널 장애 HTML 등) articles 필드가 없으면 "0건"으로 오인하지 않게 에러 처리
      if (!j || !Array.isArray(j.articles)) throw new Error("프록시 응답 형식 오류");
      _store.set(key, { status: "done", articles: j.articles as NaverArticle[] });
      _emit();
      return;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { type: string; articles?: NaverArticle[]; articleNo?: string; moveIn?: NaverArticle["moveIn"]; error?: string };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "list") {
          articles = (msg.articles ?? []) as NaverArticle[];
          byNo.clear();
          for (const a of articles) byNo.set(String(a.articleNo), a);
          _store.set(key, { status: "loading", articles: [...articles] });
          _emit();
        } else if (msg.type === "movein") {
          const a = byNo.get(String(msg.articleNo));
          if (a) a.moveIn = msg.moveIn;
          _store.set(key, { status: "loading", articles: [...articles] });
          _emit();
        } else if (msg.type === "done") {
          _store.set(key, { status: "done", articles: [...articles] });
          _emit();
        } else if (msg.type === "error") {
          throw new Error(msg.error || "proxy error");
        }
      }
    }
    // 스트림이 done 없이 끊긴 경우(연결 종료 등) loading 고착 방지
    const cur = _store.get(key);
    if (cur && cur.status === "loading") { _store.set(key, { status: "done", articles: cur.articles }); _emit(); }
  } catch (e) {
    _store.set(key, { status: "error", articles, error: (e as Error).message });
    _emit();
  }
}
/**
 * 단지×평형 매물(입주가능일 포함)을 로드해 스토어에 채움. 명시적 트리거 전용(자동 호출 X).
 * - 이미 로딩 중이면 중복 트리거 무시.
 * - force=false: 이미 로드된(done/error) 항목은 재조회 안 함(캐시 사용).
 * - force=true: 강제 재조회. 직전 articles는 보존해 새로고침 중에도 팝오버 유지. 서버 캐시도 fresh=1로 우회.
 */
export function ensureListings(complexId: string, force = false): string {
  const key = keyOf(complexId);
  const existing = _store.get(key);
  if (existing && (existing.status === "loading" || !force)) return key;
  const prev = existing?.articles ?? [];
  _store.set(key, { status: "loading", articles: prev });
  _emit();
  _queue.push(() => {
    _runStream(key, complexId, force, prev)
      .finally(() => { _active--; _emit(); _pump(); });
  });
  _pump();
  return key;
}

export type ColumnListings = {
  entry: Entry | null;
  load: () => void; // 명시적 조회 (미로드 시에만)
  refresh: () => void; // 강제 재조회 (서버 캐시까지 우회)
};
/**
 * 컬럼 셀에서 사용: 스토어 구독 + 수동 트리거. **자동 로드하지 않음** — 셀에서 load()를 호출해야 조회.
 * subscribe=false면 구독/렌더 안 함(토글 off인 셀의 불필요한 리렌더 방지).
 */
export function useColumnListings(complexId: string | null, subscribe: boolean): ColumnListings {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    if (!subscribe) return;
    _subs.add(force);
    return () => { _subs.delete(force); };
  }, [subscribe]);
  const load = useCallback(() => {
    if (complexId) ensureListings(complexId, false);
  }, [complexId]);
  const refresh = useCallback(() => {
    if (complexId) ensureListings(complexId, true);
  }, [complexId]);
  const entry = subscribe && complexId ? (_store.get(keyOf(complexId)) ?? null) : null;
  return { entry, load, refresh };
}
