/**
 * 서울 25개 구 + 경기(수원/성남/안양/용인/하남/화성/의왕/과천) 아파트 실거래가 수집 — 전 면적.
 *
 * Usage:
 *   bun src/collect.ts          # 증분 수집
 *   bun src/collect.ts --full   # 전체 12개월 재수집
 *   bun src/collect.ts --since 202501
 */

import { XMLParser } from "fast-xml-parser";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Trade, readCsv, writeCsv, deduplicate } from "./csv";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const OUT_PATH = join(DATA_DIR, "apt_trade_filtered.csv");

const API_KEY = process.env.PUBLIC_DATA_API_KEY!;
const BASE_URL =
  "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade";

const REGIONS: Record<string, string> = {
  // 서울특별시 25개 구
  "11110": "서울특별시 종로구",
  "11140": "서울특별시 중구",
  "11170": "서울특별시 용산구",
  "11200": "서울특별시 성동구",
  "11215": "서울특별시 광진구",
  "11230": "서울특별시 동대문구",
  "11260": "서울특별시 중랑구",
  "11290": "서울특별시 성북구",
  "11305": "서울특별시 강북구",
  "11320": "서울특별시 도봉구",
  "11350": "서울특별시 노원구",
  "11380": "서울특별시 은평구",
  "11410": "서울특별시 서대문구",
  "11440": "서울특별시 마포구",
  "11470": "서울특별시 양천구",
  "11500": "서울특별시 강서구",
  "11530": "서울특별시 구로구",
  "11545": "서울특별시 금천구",
  "11560": "서울특별시 영등포구",
  "11590": "서울특별시 동작구",
  "11620": "서울특별시 관악구",
  "11650": "서울특별시 서초구",
  "11680": "서울특별시 강남구",
  "11710": "서울특별시 송파구",
  "11740": "서울특별시 강동구",
  // 경기도
  "41111": "수원시 장안구",
  "41113": "수원시 권선구",
  "41115": "수원시 팔달구",
  "41117": "수원시 영통구",
  "41131": "성남시 중원구",
  "41133": "성남시 수정구",
  "41135": "성남시 분당구",
  "41171": "안양시 만안구",
  "41173": "안양시 동안구",
  "41461": "용인시 처인구",
  "41463": "용인시 기흥구",
  "41465": "용인시 수지구",
  "41450": "하남시",
  "41591": "화성시",
  "41595": "화성시",
  "41597": "화성시",
  "41430": "의왕시",
  "41290": "과천시",
};

const xmlParser = new XMLParser({ trimValues: true, parseTagValue: false });

// ── API 호출 ───────────────────────────────────────────

interface RawItem {
  [key: string]: string;
}

async function fetchPage(
  code: string,
  ym: string,
  page = 1,
  rows = 1000,
): Promise<RawItem[]> {
  const params = new URLSearchParams({
    serviceKey: API_KEY,
    LAWD_CD: code,
    DEAL_YMD: ym,
    numOfRows: String(rows),
    pageNo: String(page),
  });
  const res = await fetch(`${BASE_URL}?${params}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const text = await res.text();
  const parsed = xmlParser.parse(text);
  const items = parsed?.response?.body?.items?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

// ── 유틸 ───────────────────────────────────────────────

function generateMonths(startYm: string, endYm: string): string[] {
  const months: string[] = [];
  let ym = parseInt(startYm);
  const end = parseInt(endYm);
  while (ym <= end) {
    months.push(String(ym));
    let year = Math.floor(ym / 100);
    let month = (ym % 100) + 1;
    if (month > 12) { year++; month = 1; }
    ym = year * 100 + month;
  }
  return months;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ── 변환 ───────────────────────────────────────────────

function transformRows(
  rawRows: (RawItem & { 지역코드: string; 지역명: string })[],
): Trade[] {
  const result: Trade[] = [];
  for (const r of rawRows) {
    const price = parseInt((r.dealAmount ?? "0").replace(/,/g, ""));
    const area = parseFloat(r.excluUseAr ?? "0");
    if (area <= 0) continue;

    const year = parseInt(r.dealYear ?? "0");
    const month = parseInt(r.dealMonth ?? "0");
    const day = parseInt(r.dealDay ?? "0");
    const floor = parseInt(r.floor ?? "") || 0;
    const buildYear = parseInt(r.buildYear ?? "") || 0;
    const region = r.지역명 ?? "";
    const city = region.includes(" ") ? region.split(" ")[0] : region;

    result.push({
      시: city,
      지역명: region,
      법정동: (r.umdNm ?? "").trim(),
      단지명: (r.aptNm ?? "").trim(),
      금액_만원: price,
      전용면적: area,
      층: floor,
      건축년도: buildYear,
      거래년: year,
      거래월: month,
      거래일: day,
      거래일자: `${year}-${pad2(month)}-${pad2(day)}`,
      거래년월: `${year}-${pad2(month)}`,
      거래유형: (r.dealingGbn ?? "").trim(),
      매수자: (r.buyerGbn ?? "").trim(),
      매도자: (r.slerGbn ?? "").trim(),
      지역코드: r.지역코드,
      지번: (r.jibun ?? "").trim(),
    });
  }
  return result;
}

// ── 수집 ───────────────────────────────────────────────

async function collect(startYm: string, endYm: string) {
  const months = generateMonths(startYm, endYm);
  const allRows: (RawItem & { 지역코드: string; 지역명: string })[] = [];
  const entries = Object.entries(REGIONS);
  const totalCalls = entries.length * months.length;
  let callCount = 0;

  for (const [code, name] of entries) {
    for (const ym of months) {
      callCount++;
      let page = 1;
      const monthRows: RawItem[] = [];
      while (true) {
        const rows = await fetchPage(code, ym, page);
        if (rows.length === 0) break;
        monthRows.push(...rows);
        if (rows.length < 1000) break;
        page++;
      }
      for (const row of monthRows) {
        (row as any).지역코드 = code;
        (row as any).지역명 = name;
      }
      allRows.push(...(monthRows as any));

      if (callCount % 20 === 0) {
        console.log(
          `  진행: ${callCount}/${totalCalls} (${Math.floor((callCount * 100) / totalCalls)}%)`,
        );
      }
    }
  }
  return allRows;
}

// ── 메인 ───────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const now = new Date();
  const endYm = `${now.getFullYear()}${pad2(now.getMonth() + 1)}`;

  let startYm: string | undefined;

  if (since) {
    startYm = since;
    console.log(`[커스텀 수집] ${startYm} ~ ${endYm}`);
  } else if (full || !existsSync(OUT_PATH)) {
    const startYear =
      now.getMonth() + 1 < 12 ? now.getFullYear() - 1 : now.getFullYear();
    const startMonth = now.getMonth() + 1 < 12 ? now.getMonth() + 2 : 1;
    startYm = `${startYear}${pad2(startMonth)}`;
    console.log(`[전체 수집] ${startYm} ~ ${endYm}`);
  }

  if (startYm && (since || full || !existsSync(OUT_PATH))) {
    const raw = await collect(startYm, endYm);
    console.log(`\n수집: ${raw.length}건`);
    const newRows = transformRows(raw);

    if (existsSync(OUT_PATH) && since) {
      const existing = await readCsv(OUT_PATH);
      const combined = deduplicate([...existing, ...newRows]);
      const removed = existing.length + newRows.length - combined.length;
      console.log(
        `중복 제거: ${existing.length + newRows.length} → ${combined.length}건 (${removed}건 제거)`,
      );
      await writeCsv(OUT_PATH, combined);
      console.log(`저장: ${OUT_PATH} (${combined.length}건)`);
    } else {
      const deduped = deduplicate(newRows);
      await writeCsv(OUT_PATH, deduped);
      console.log(`저장: ${OUT_PATH} (${deduped.length}건)`);
    }
  } else {
    // 증분 수집
    const existing = await readCsv(OUT_PATH);
    let lastYear = 0;
    let lastMonth = 0;
    for (const r of existing) {
      if (r.거래년 > lastYear || (r.거래년 === lastYear && r.거래월 > lastMonth)) {
        lastYear = r.거래년;
        lastMonth = r.거래월;
      }
    }
    // 신고 지연 백필: 마지막 거래월 - 2개월부터 재조회 (한국 부동산 거래 신고는 30일 이내, 지연 신고 흡수)
    let backfillYear = lastYear;
    let backfillMonth = lastMonth - 2;
    if (backfillMonth <= 0) { backfillYear--; backfillMonth += 12; }
    startYm = `${backfillYear}${pad2(backfillMonth)}`;
    console.log(`[증분 수집] ${startYm} ~ ${endYm} (마지막 거래: ${lastYear}-${pad2(lastMonth)}, 2개월 백필)`);

    const raw = await collect(startYm, endYm);
    console.log(`\n신규 수집: ${raw.length}건`);
    const newRows = transformRows(raw);
    const combined = deduplicate([...existing, ...newRows]);
    const removed = existing.length + newRows.length - combined.length;
    console.log(
      `중복 제거: ${existing.length + newRows.length} → ${combined.length}건 (${removed}건 제거)`,
    );
    await writeCsv(OUT_PATH, combined);
    console.log(`저장: ${OUT_PATH} (${combined.length}건)`);
  }

  // 요약
  const result = await readCsv(OUT_PATH);
  const byCityMap = new Map<string, { count: number; sum: number }>();
  for (const r of result) {
    const s = byCityMap.get(r.시) ?? { count: 0, sum: 0 };
    s.count++;
    s.sum += r.금액_만원;
    byCityMap.set(r.시, s);
  }
  console.log(`\n=== 시별 요약 (총 ${result.length}건) ===`);
  for (const [city, s] of byCityMap) {
    console.log(
      `  ${city}: ${s.count}건, 평균 ${(s.sum / s.count / 10000).toFixed(1)}억`,
    );
  }
}

main();
