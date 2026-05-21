import Papa from "papaparse";
import { existsSync } from "node:fs";

export interface Trade {
  시: string;
  지역명: string;
  법정동: string;
  단지명: string;
  금액_만원: number;
  전용면적: number;
  층: number;
  건축년도: number;
  거래년: number;
  거래월: number;
  거래일: number;
  거래일자: string;
  거래년월: string;
  거래유형: string;
  매수자: string;
  매도자: string;
  지역코드: string;
  지번: string;
}

const CSV_COLS: (keyof Trade)[] = [
  "시", "지역명", "법정동", "단지명", "금액_만원", "전용면적", "층",
  "건축년도", "거래년", "거래월", "거래일", "거래일자", "거래년월",
  "거래유형", "매수자", "매도자", "지역코드", "지번",
];

export const DEDUP_COLS: (keyof Trade)[] = [
  "법정동", "단지명", "전용면적", "층", "거래년", "거래월", "거래일", "금액_만원",
];

function parseRow(r: Record<string, string>): Trade {
  return {
    시: r.시 ?? "",
    지역명: r.지역명 ?? "",
    법정동: r.법정동 ?? "",
    단지명: r.단지명 ?? "",
    금액_만원: parseInt(r.금액_만원) || 0,
    전용면적: parseFloat(r.전용면적) || 0,
    층: parseInt(r.층) || 0,
    건축년도: parseInt(r.건축년도) || 0,
    거래년: parseInt(r.거래년) || 0,
    거래월: parseInt(r.거래월) || 0,
    거래일: parseInt(r.거래일) || 0,
    거래일자: r.거래일자 ?? "",
    거래년월: r.거래년월 ?? "",
    거래유형: r.거래유형 ?? "",
    매수자: r.매수자 ?? "",
    매도자: r.매도자 ?? "",
    지역코드: r.지역코드 ?? "",
    지번: r.지번 ?? "",
  };
}

export async function readCsv(path: string): Promise<Trade[]> {
  if (!existsSync(path)) return [];
  const text = await Bun.file(path).text();
  const stripped = text.replace(/^\uFEFF/, "");
  const { data } = Papa.parse<Record<string, string>>(stripped, {
    header: true,
    skipEmptyLines: true,
  });
  return data.map(parseRow);
}

export async function writeCsv(path: string, rows: Trade[]) {
  const csv = "\uFEFF" + Papa.unparse(rows, { columns: CSV_COLS as string[] });
  await Bun.write(path, csv);
}

export function deduplicate(rows: Trade[]): Trade[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = DEDUP_COLS.map((col) => String(row[col])).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- 통계 헬퍼 ---

export function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mode<T>(arr: T[]): T {
  const counts = new Map<T, number>();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = arr[0];
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return best;
}

export function groupBy<T>(arr: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const key = keyFn(item);
    const group = map.get(key);
    if (group) group.push(item);
    else map.set(key, [item]);
  }
  return map;
}
