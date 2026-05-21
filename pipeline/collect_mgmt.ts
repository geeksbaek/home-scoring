/**
 * K-apt V2 API로 관리비 수집.
 * 공용관리비 + 개별사용료 합산으로 세대당 월 관리비 계산.
 *
 * Usage: bun src/collect_mgmt_v2.ts
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

const COMMON_BASE = "https://apis.data.go.kr/1613000/AptCmnuseManageCostServiceV2";
const INDIV_BASE = "https://apis.data.go.kr/1613000/AptIndvdlzManageCostServiceV2";

async function fetchCost(base: string, op: string, kaptCode: string, searchDate: string): Promise<any> {
  const url = `${base}/${op}?serviceKey=${API_KEY}&kaptCode=${kaptCode}&searchDate=${searchDate}&_type=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    return json.response?.body?.item ?? null;
  } catch { return null; }
}

async function getMonthlyCost(kaptCode: string, searchDate: string, households: number): Promise<number | null> {
  // 공용관리비 항목들
  const commonOps = [
    "getHsmpLaborCostInfoV2",      // 인건비
    "getHsmpGuardCostInfoV2",      // 경비비
    "getHsmpCleaningCostInfoV2",   // 청소비
    "getHsmpRepairsCostInfoV2",    // 수선비
    "getHsmpElevatorMntncCostInfoV2", // 승강기유지비
    "getHsmpFacilityMntncCostInfoV2", // 시설유지비
    "getHsmpTaxdueInfoV2",         // 제세공과금
  ];

  // 개별사용료 항목들
  const indivOps = [
    "getHsmpHeatCostInfoV2",       // 난방비
    "getHsmpHotWaterCostInfoV2",   // 급탕비
    "getHsmpElectricityCostInfoV2", // 전기료
    "getHsmpWaterCostInfoV2",      // 수도료
    "getHsmpGasRentalFeeInfoV2",   // 가스사용료
  ];

  let totalCost = 0;
  let hasData = false;

  // 공용관리비
  for (const op of commonOps) {
    const item = await fetchCost(COMMON_BASE, op, kaptCode, searchDate);
    if (item) {
      for (const [k, v] of Object.entries(item)) {
        if (k !== "kaptCode" && k !== "kaptName") {
          const n = typeof v === "number" ? v : parseFloat(v as string);
          if (n > 0) totalCost += n;
        }
      }
      hasData = true;
    }
    await sleep(50);
  }

  // 개별사용료
  for (const op of indivOps) {
    const item = await fetchCost(INDIV_BASE, op, kaptCode, searchDate);
    if (item) {
      // 개별사용료는 C(공용)와 P(전용)가 있음 → 합산
      for (const [k, v] of Object.entries(item)) {
        if (k !== "kaptCode" && k !== "kaptName") {
          const n = typeof v === "number" ? v : parseFloat(v as string);
          if (n > 0) totalCost += n;
        }
      }
      hasData = true;
    }
    await sleep(50);
  }

  if (!hasData || households <= 0) return null;
  // 원 → 만원/세대
  return Math.round(totalCost / households / 10000 * 10) / 10;
}

async function main() {
  const identity: any[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const targets = identity.filter((d) => d.kapt_code);

  const outPath = join(DATA_DIR, "mgmt_cost.json");
  const existing: Record<string, any> = existsSync(outPath) ? await Bun.file(outPath).json() : {};

  // 세대수 정보
  const kaptInfo: Record<string, any> = existsSync(join(DATA_DIR, "kapt_info.json"))
    ? await Bun.file(join(DATA_DIR, "kapt_info.json")).json() : {};

  // V4 API에서 세대수 캐시
  const hhCache: Record<string, number> = {};
  async function getHouseholds(kaptCode: string, name: string): Promise<number> {
    if (hhCache[kaptCode]) return hhCache[kaptCode];
    const hh = kaptInfo[name]?.kaptdaCnt;
    if (hh && hh > 0) { hhCache[kaptCode] = hh; return hh; }
    try {
      const url = `https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusBassInfoV4?serviceKey=${API_KEY}&kaptCode=${kaptCode}&_type=json`;
      const res = await fetch(url);
      const json = (await res.json()) as any;
      const cnt = json.response?.body?.item?.kaptdaCnt;
      if (cnt && cnt > 0) { hhCache[kaptCode] = cnt; return cnt; }
    } catch {}
    return 0; // 세대수 불명 → 스킵
  }

  const todo = targets.filter((d) => !existing[d.name]);
  console.log(`관리비 수집 (V2 API): ${todo.length}개 대상, 기존 ${Object.keys(existing).length}개\n`);

  // 최근 6개월
  const months: string[] = [];
  const now = new Date();
  for (let i = 2; i <= 7; i++) { // 1~2개월 전은 미공시일 수 있으므로 2~7개월 전
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  let fetched = 0;
  for (let i = 0; i < todo.length; i++) {
    const { name, kapt_code } = todo[i];
    const hh = await getHouseholds(kapt_code, name);
    if (hh <= 0) { console.log(` 세대수 불명, 스킵`); continue; }

    process.stdout.write(`[${i + 1}/${todo.length}] ${name}...`);

    const costs: number[] = [];
    const summerMonths = ["06", "07", "08"];
    const winterMonths = ["12", "01", "02"];
    const summers: number[] = [];
    const winters: number[] = [];

    for (const ym of months) {
      const cost = await getMonthlyCost(kapt_code, ym, hh);
      if (cost != null && cost > 0) {
        costs.push(cost);
        const mm = ym.slice(4);
        if (summerMonths.includes(mm)) summers.push(cost);
        if (winterMonths.includes(mm)) winters.push(cost);
      }
    }

    if (costs.length > 0) {
      const avg = Math.round(costs.reduce((a, b) => a + b, 0) / costs.length * 10) / 10;
      existing[name] = {
        year: avg,
        summer: summers.length > 0 ? Math.round(summers.reduce((a, b) => a + b, 0) / summers.length * 10) / 10 : avg,
        winter: winters.length > 0 ? Math.round(winters.reduce((a, b) => a + b, 0) / winters.length * 10) / 10 : avg,
      };
      fetched++;
      console.log(` ${avg}만원/월`);
    } else {
      console.log(" ✗");
    }

    // 매 건마다 저장
    await Bun.write(outPath, JSON.stringify(existing, null, 2));
  }

  await Bun.write(outPath, JSON.stringify(existing, null, 2));
  console.log(`\n수집: ${fetched}개, 전체: ${Object.keys(existing).length}개`);
}

main().catch(console.error);
