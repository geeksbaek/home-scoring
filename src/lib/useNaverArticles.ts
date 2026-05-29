import { useCallback, useState } from "react";

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

/** 730000000(원) → "7억 3,000" / 900000000 → "9억" / 5000만 → "5,000만" */
export function formatWon(won: number): string {
  if (!won || won <= 0) return "-";
  const man = Math.round(won / 10000);
  const eok = Math.floor(man / 10000);
  const rest = man % 10000;
  if (eok > 0 && rest > 0) return `${eok}억 ${rest.toLocaleString()}`;
  if (eok > 0) return `${eok}억`;
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
