/**
 * 장기수선충당금 데이터 수집 (K-apt V2 API).
 *
 * 국토교통부_공동주택관리비(장기수선충당금)정보서비스 V2 API를 사용하여
 * 단지별 장기수선충당금 현황을 수집한다.
 *
 * 수집 항목:
 *   - sLevy  (월부과액): 매월 세대에 부과하는 장기수선충당금 (원, 단지 전체)
 *   - sTot   (충당금잔액): 누적 적립 잔액 (원)
 *   - sUse   (월사용액): 실제 수선에 사용한 금액 (원)
 *   - sPer   (적립요율): 장기수선계획 대비 적립 비율 (%)
 *
 *
 * Usage: bun src/collect_delinquency.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
if (!process.env.KAPT_API_KEY) {
  for (const line of (await Bun.file(join(ROOT, ".env")).text()).split("\n")) {
    if (line.startsWith("KAPT_API_KEY")) (process.env as any).KAPT_API_KEY = line.split("=", 2)[1].trim().replace(/^['"]|['"]$/g, "");
  }
}
const API_KEY = process.env.KAPT_API_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BASE = "https://apis.data.go.kr/1613000/AptRepairsCostServiceV2";

async function fetchItem(op: string, kaptCode: string, searchDate: string): Promise<any> {
  const url = `${BASE}/${op}?serviceKey=${API_KEY}&kaptCode=${kaptCode}&searchDate=${searchDate}&_type=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    return json.response?.body?.item ?? null;
  } catch {
    return null;
  }
}

interface RepairFundData {
  balance_per_hh: number; // 세대당 충당금 잔액 (만원)
  levy_per_hh: number; // 세대당 월 부과액 (원)
  reserve_rate: number | null; // 적립요율 (%)
  months_collected: number; // 수집된 월 수
}

async function main() {
  const identity: any[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const targets = identity.filter((d) => d.kapt_code);
  // 이름 중복 제거 (같은 kapt_code → 하나만)
  const seen = new Set<string>();
  const uniqueTargets = targets.filter((d) => {
    if (seen.has(d.name)) return false;
    seen.add(d.name);
    return true;
  });

  const outPath = join(DATA_DIR, "repair_fund.json");
  const existing: Record<string, RepairFundData> = existsSync(outPath)
    ? await Bun.file(outPath).json()
    : {};

  // 세대수 정보
  const kaptInfo: Record<string, any> = existsSync(join(DATA_DIR, "kapt_info.json"))
    ? await Bun.file(join(DATA_DIR, "kapt_info.json")).json()
    : {};

  const todo = uniqueTargets.filter((d) => !existing[d.name]);
  console.log(
    `장기수선충당금 수집: ${todo.length}개 대상, 기존 ${Object.keys(existing).length}개\n`,
  );

  if (todo.length === 0) {
    console.log("수집 완료됨.");
    return;
  }

  // 최근 8개월 (오래된 것부터, 2~9개월 전)
  const months: string[] = [];
  const now = new Date();
  for (let i = 9; i >= 2; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`,
    );
  }

  interface MonthData {
    ym: string;
    sLevy: number;
    sUse: number;
    sTot: number;
    sPer: number | null;
  }

  async function processOne(target: { name: string; kapt_code: string }, idx: number, total: number): Promise<RepairFundData | null> {
    const { name, kapt_code } = target;
    const hh = kaptInfo[name]?.households ?? 0;

    if (hh <= 0) {
      console.log(`[${idx}/${total}] ${name}... 세대수 불명, 스킵`);
      return null;
    }

    // 모든 월/오퍼레이션을 한번에 병렬 요청
    const allRequests = months.map(async (ym) => {
      const [levy, use, balance, rate] = await Promise.all([
        fetchItem("getHsmpMonthFeeInfoV2", kapt_code, ym),
        fetchItem("getHsmpMonthRetalFeeInfoV2", kapt_code, ym),
        fetchItem("getHsmpReserveBalanceInfoV2", kapt_code, ym),
        fetchItem("getHsmpAccumulationTariffInfoV2", kapt_code, ym),
      ]);
      return { ym, levy, use, balance, rate };
    });
    const allResults = await Promise.all(allRequests);

    const monthlyData: MonthData[] = [];
    for (const { ym, levy, use, balance, rate } of allResults) {
      const sLevy = parseFloat(String(levy?.sLevy ?? 0));
      const sUse = parseFloat(String(use?.sUse ?? 0));
      const sTot = parseFloat(String(balance?.sTot ?? 0));
      const sPer = rate?.sPer != null ? parseFloat(String(rate.sPer)) : null;
      if (sLevy > 0 || sTot > 0) {
        monthlyData.push({ ym, sLevy, sUse, sTot, sPer });
      }
    }

    if (monthlyData.length === 0) {
      console.log(`[${idx}/${total}] ${name}... 데이터 없음`);
      return null;
    }

    const latest = monthlyData[monthlyData.length - 1];
    const balancePerHh = Math.round((latest.sTot / hh / 10000) * 10) / 10;
    const levyPerHh = latest.sLevy > 0 ? Math.round(latest.sLevy / hh) : 0;

    let reserveRate: number | null = null;
    for (let j = monthlyData.length - 1; j >= 0; j--) {
      // 적립요율은 부과 대비 적립비율 → 100% 초과는 사실상 불가. 200% 초과는 API 가비지로 폐기.
      if (monthlyData[j].sPer != null && monthlyData[j].sPer! > 0 && monthlyData[j].sPer! <= 200) {
        reserveRate = Math.round(monthlyData[j].sPer! * 10) / 10;
        break;
      }
    }

    const result: RepairFundData = {
      balance_per_hh: balancePerHh,
      levy_per_hh: levyPerHh,
      reserve_rate: reserveRate,
      months_collected: monthlyData.length,
    };

    const parts = [`잔액 ${balancePerHh}만/세대`, `부과 ${levyPerHh.toLocaleString()}원/세대`];
    if (reserveRate != null) parts.push(`적립률 ${reserveRate}%`);
    console.log(`[${idx}/${total}] ${name}... ${parts.join(", ")}`);

    return result;
  }

  // 3개씩 병렬 처리
  const CONCURRENCY = 3;
  let fetched = 0;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((t, j) => processOne(t, i + j + 1, todo.length)),
    );
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) {
        existing[batch[j].name] = results[j]!;
        fetched++;
      }
    }
    // 매 배치 저장 (크래시 대비)
    await Bun.write(outPath, JSON.stringify(existing, null, 2));
    await sleep(50);
  }

  await Bun.write(outPath, JSON.stringify(existing, null, 2));
  console.log(
    `\n수집: ${fetched}개, 전체: ${Object.keys(existing).length}개`,
  );
}

main().catch(console.error);
