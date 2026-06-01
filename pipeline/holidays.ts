/**
 * 한국 공휴일/주말 판정 (출퇴근 측정·일일 파이프라인 공용).
 *
 * 날짜는 로컬(한국) 시간 기준으로 포맷한다 (toISOString의 UTC 변환 금지 — 날짜 밀림 방지).
 */

// 한국 공휴일 (연도별 추가 필요)
export const KR_HOLIDAYS = new Set([
  "2026-01-01", // 신정
  "2026-01-28", "2026-01-29", "2026-01-30", // 설날
  "2026-03-01", // 삼일절
  "2026-05-01", // 근로자의 날
  "2026-05-05", // 어린이날
  "2026-05-24", // 부처님오신날
  "2026-06-06", // 현충일
  "2026-08-15", // 광복절
  "2026-09-24", "2026-09-25", "2026-09-26", // 추석
  "2026-10-03", // 개천절
  "2026-10-09", // 한글날
  "2026-12-25", // 성탄절
]);

/** 로컬 시간 기준 YYYY-MM-DD */
export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** 주말(토·일) 또는 공휴일이면 true */
export function isNonBusinessDay(d: Date = new Date()): boolean {
  const day = d.getDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return true;
  return KR_HOLIDAYS.has(localDateStr(d));
}
