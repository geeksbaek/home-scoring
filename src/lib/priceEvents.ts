// 실거래가 차트 이벤트 마커 — 정책 발표 등 가격에 영향을 줄 수 있는 시점을 해당 단지 차트에 세로선으로 표시.
// names는 AptData.name(동명단지 분리 후 이름) 기준. 구역 단위 발표는 구역에 속한 단지를 모두 나열.
export interface PriceEvent {
  date: string; // yyyy-mm-dd (발표일)
  label: string; // 차트 라벨/범례용 짧은 설명
  url?: string; // 출처 기사
  names: string[];
}

// 2026-09-29 성남시 분당 노후계획도시 2차 특별정비구역 5곳 선정 공고
const BUNDANG_2ND = { date: "2026-09-29", url: "https://www.kyeongin.com/article/1771678" };

export const PRICE_EVENTS: PriceEvent[] = [
  { ...BUNDANG_2ND, label: "분당 2차 정비구역 선정 · 시범단지1", names: ["시범삼성", "시범한신", "시범한양"] },
  { ...BUNDANG_2ND, label: "분당 2차 정비구역 선정 · 파크타운", names: ["파크타운(대림)", "파크타운(롯데)", "파크타운(삼익)", "파크타운(서안)"] },
  { ...BUNDANG_2ND, label: "분당 2차 정비구역 선정 · 푸른마을", names: ["푸른마을(신성)", "푸른마을(벽산)", "푸른마을(쌍용)"] },
  { ...BUNDANG_2ND, label: "분당 2차 정비구역 선정 · 한솔마을2", names: ["한솔마을(1단지)(청구)", "한솔마을(2단지)(LG)", "한솔마을(3단지)(한일)"] },
  { ...BUNDANG_2ND, label: "분당 2차 정비구역 선정 · 이매촌1", names: ["이매촌(삼성)", "이매촌(삼환)"] },
];

const byName = new Map<string, PriceEvent[]>();
for (const e of PRICE_EVENTS) for (const n of e.names) byName.set(n, [...(byName.get(n) ?? []), e]);

const NONE: PriceEvent[] = [];
export const eventsFor = (name: string): PriceEvent[] => byName.get(name) ?? NONE;
