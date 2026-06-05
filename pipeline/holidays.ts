/**
 * 한국 공휴일/주말 판정 (출퇴근 측정·일일 파이프라인 공용).
 *
 * 공휴일 소스: 구글 공개 "대한민국의 휴일" 캘린더 ICS 피드.
 *   - API 키·활용신청 불필요. 임시공휴일(지방선거일 등)·대체공휴일까지 자동 포함.
 *   - VEVENT DESCRIPTION이 "공휴일"로 시작하는 것만 채택 (어버이날·스승의날 등 "기념일" 제외).
 *   - 조회 결과는 data/holidays_cache.json에 캐시 → isNonBusinessDay는 캐시를 동기 참조.
 *   - 네트워크 실패·캐시 부재 시 하드코딩 KR_HOLIDAYS로 fallback.
 *   - daily.ts·commute.ts 진입점에서 refreshHolidays()를 await 호출해 매 실행 캐시 갱신.
 *
 * 날짜는 로컬(한국) 시간 기준으로 포맷한다 (toISOString의 UTC 변환 금지 — 날짜 밀림 방지).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CACHE_PATH = join(import.meta.dir, "..", "data", "holidays_cache.json");

const GOOGLE_HOLIDAY_ICS =
  "https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics";

// 하드코딩 fallback (ICS 조회 실패·캐시 부재 대비, 최소 안전망).
// 주된 소스는 구글 ICS 캐시 — 여기는 매년 수동 갱신 부담을 지지 않도록 최소만 유지.
export const KR_HOLIDAYS = new Set([
  "2026-01-01", // 신정
  "2026-01-28", "2026-01-29", "2026-01-30", // 설날
  "2026-03-01", // 삼일절
  "2026-05-01", // 근로자의 날
  "2026-05-05", // 어린이날
  "2026-05-24", // 부처님오신날
  "2026-05-25", // 부처님오신날 대체공휴일 (5/24 일요일)
  "2026-06-03", // 제9회 전국동시지방선거
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

/** 캐시 파일에서 공휴일 날짜 Set 동기 로드 (모듈 초기화 시 1회) */
function loadCachedHolidays(): Set<string> {
  try {
    if (existsSync(CACHE_PATH)) {
      const j = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      if (Array.isArray(j?.dates)) return new Set<string>(j.dates);
    }
  } catch {
    // 손상된 캐시는 무시하고 하드코딩 fallback 사용
  }
  return new Set<string>();
}

let cachedHolidays = loadCachedHolidays();

/**
 * 구글 공개 공휴일 캘린더(ICS)에서 '공휴일' 분류 날짜만 추출.
 * DESCRIPTION이 "공휴일"로 시작하는 VEVENT만 채택 (기념일 제외).
 */
export async function fetchGoogleHolidays(): Promise<Set<string>> {
  const res = await fetch(GOOGLE_HOLIDAY_ICS);
  if (!res.ok) throw new Error(`ICS fetch ${res.status}`);
  const text = await res.text();
  const dates = new Set<string>();
  for (const ev of text.split("BEGIN:VEVENT").slice(1)) {
    const date = ev.match(/DTSTART[^:]*:(\d{8})/)?.[1];
    if (!date) continue;
    // RFC5545 line folding(다음 줄 공백 시작) 고려해 DESCRIPTION 추출
    const descRaw = ev.match(/DESCRIPTION:((?:.|\n )*?)(?:\r?\n[A-Z])/)?.[1];
    const desc = descRaw?.replace(/\r?\n /g, "").trim() ?? "";
    if (!desc.startsWith("공휴일")) continue; // "기념일"(어버이날·스승의날 등) 제외
    dates.add(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`);
  }
  return dates;
}

/**
 * 구글 ICS 조회 → data/holidays_cache.json 갱신 + 메모리 캐시 반영.
 * 실패 시 기존 캐시/하드코딩 유지(throw 안 함). daily·commute 진입점에서 호출.
 */
export async function refreshHolidays(): Promise<{ ok: boolean; count: number }> {
  try {
    const dates = await fetchGoogleHolidays();
    if (dates.size === 0) throw new Error("빈 공휴일 목록");
    const sorted = [...dates].sort();
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ fetchedAt: localDateStr(new Date()), source: "google-ics", dates: sorted }, null, 2),
    );
    cachedHolidays = dates;
    return { ok: true, count: dates.size };
  } catch {
    return { ok: false, count: cachedHolidays.size };
  }
}

/** 주말(토·일) 또는 공휴일이면 true. 공휴일은 ICS 캐시 ∪ 하드코딩 fallback. */
export function isNonBusinessDay(d: Date = new Date()): boolean {
  const day = d.getDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return true;
  const s = localDateStr(d);
  return cachedHolidays.has(s) || KR_HOLIDAYS.has(s);
}
