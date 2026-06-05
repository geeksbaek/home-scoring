// KB부동산(kbland.kr) 실시간 시세 런타임 조회.
//
// 빌드타임 수집(collect_kb_price.ts)이 좌표검증으로 단지를 매칭해 complexNo(cno)+대표
// 면적일련번호(ano)를 정적 데이터에 심어둔다. 여기서는 그 식별자로 BasePrcInfoNew 1콜만
// 호출해 항상 당일(주간 금요일 갱신) 시세를 가져온다. 매칭은 검증된 정적값을 신뢰.
//
// CORS: api.kbland.kr은 요청 Origin을 그대로 반사(ACAO)하고 무인증. Referer/Origin/webservice
// 같은 헤더 없이도 GET이 동작하므로 브라우저 단순요청(preflight 없음)으로 호출 가능.
// 실패(네트워크/차단/구조변경) 시 null → 호출부가 정적 kb_sale로 fallback.

const KB_BASE = "https://api.kbland.kr";

export interface KbLivePrice {
  sale: number | null; // 매매 일반거래가 (만원)
  jeonse: number | null; // 전세 일반거래가 (만원)
  sale_lo: number | null; // 매매 하한가 (만원)
  asOf: string | null; // 시세기준 YYYY-MM
}

// 세션 내 동일 (cno|ano) 재호출 방지. 값(또는 실패 null)을 Promise로 메모이즈.
const cache = new Map<string, Promise<KbLivePrice | null>>();

export function fetchKbLivePrice(cno: string, ano: number): Promise<KbLivePrice | null> {
  const key = `${cno}|${ano}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const p = (async (): Promise<KbLivePrice | null> => {
    try {
      const qs = new URLSearchParams({ 단지기본일련번호: cno, 면적일련번호: String(ano) });
      const res = await fetch(`${KB_BASE}/land-price/price/BasePrcInfoNew?${qs}`, {
        headers: { Accept: "application/json" }, // 커스텀헤더 없음 → 단순요청
      });
      if (!res.ok) return null;
      const json: any = await res.json();
      const s = json?.dataBody?.data?.시세?.[0];
      if (!s || s.시세제공여부 !== "1") return null;
      const num = (v: unknown): number | null => {
        const n = typeof v === "string" ? parseFloat(v) : (v as number);
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      const ymd: string | undefined = s.시세기준년월일;
      return {
        sale: num(s.매매일반거래가),
        jeonse: num(s.전세일반거래가),
        sale_lo: num(s.매매하한가),
        asOf: ymd ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}` : null,
      };
    } catch {
      return null;
    }
  })();

  cache.set(key, p);
  // 실패(null) 캐시는 유지하지 않음 → 팝오버 재오픈 시 재시도 허용.
  p.then((r) => {
    if (r == null) cache.delete(key);
  });
  return p;
}
