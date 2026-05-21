/**
 * 회계감사 이력 수집 (공공데이터포털 API).
 *
 * 단지별 회계감사 이행 여부, 감사 의견, 연간 수입/지출을 수집.
 *
 * Usage: bun src/collect_audit.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const API_KEY = process.env.PUBLIC_DATA_API_KEY!;
const BASE = "https://apis.data.go.kr/1613000/AptAccnutReportService2";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AuditData {
  audited: boolean;            // 감사 이행 여부
  opinion: string | null;      // 감사 의견 (적정/한정/부적정/의견거절)
  company: string | null;      // 감사 업체명
  annualIncome: number | null;  // 연간 관리수입 (원)
  annualCost: number | null;    // 연간 관리비용 (원)
  netProfit: number | null;     // 당기순이익 (원)
  year: string;                 // 회계연도
}

async function fetchAudit(kaptCode: string, year: string): Promise<AuditData | null> {
  try {
    const url = `${BASE}/getHsmpAccnutReportInfoV5?serviceKey=${API_KEY}&kaptCode=${kaptCode}&audtYear=${year}&_type=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const item = json.response?.body?.item;
    if (!item) return null;

    const audited = item.audtYn === "Y" || item.audtYn === "1";
    return {
      audited,
      opinion: item.audtOpinion?.trim() || null,
      company: item.audtCompanyName?.trim() || null,
      annualIncome: item.byyrIncomeTot ? parseInt(item.byyrIncomeTot) : null,
      annualCost: item.byyrCostTot ? parseInt(item.byyrCostTot) : null,
      netProfit: item.netProfit ? parseInt(item.netProfit) : null,
      year,
    };
  } catch {
    return null;
  }
}

async function main() {
  const identity: any[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const targets = identity.filter((d) => d.kapt_code);
  const seen = new Set<string>();
  const uniqueTargets = targets.filter((d) => {
    if (seen.has(d.name)) return false;
    seen.add(d.name);
    return true;
  });

  const outPath = join(DATA_DIR, "audit_history.json");
  const existing: Record<string, AuditData> = existsSync(outPath)
    ? await Bun.file(outPath).json()
    : {};

  const todo = uniqueTargets.filter((d) => !existing[d.name]);
  console.log(`회계감사 이력 수집: ${todo.length}개 대상, 기존 ${Object.keys(existing).length}개\n`);

  if (todo.length === 0) {
    console.log("수집 완료됨.");
    return;
  }

  // 최근 3년 중 가장 최근 감사 데이터 사용
  const years = ["2024", "2023", "2022"];

  let fetched = 0;
  for (let i = 0; i < todo.length; i++) {
    const { name, kapt_code } = todo[i];
    process.stdout.write(`[${i + 1}/${todo.length}] ${name}...`);

    let data: AuditData | null = null;
    for (const year of years) {
      data = await fetchAudit(kapt_code, year);
      if (data) break;
      await sleep(100);
    }

    if (data) {
      existing[name] = data;
      fetched++;
      const parts = [data.year + "년"];
      if (data.audited) parts.push("감사완료");
      else parts.push("미실시");
      if (data.opinion) parts.push(data.opinion);
      if (data.annualIncome) parts.push(`수입 ${(data.annualIncome / 100000000).toFixed(1)}억`);
      console.log(` ${parts.join(", ")}`);
    } else {
      console.log(" 데이터 없음");
    }

    // 매 건 저장
    await Bun.write(outPath, JSON.stringify(existing, null, 2));
    await sleep(50);
  }

  console.log(`\n수집: ${fetched}개, 전체: ${Object.keys(existing).length}개`);
}

main().catch(console.error);
