/**
 * 유지관리 이력 수집 (K-apt V2 API).
 *
 * 6개 오퍼레이션으로 단지별 수선이력(외부/내부/승강기/배관/난방/옥외)을 수집.
 * 각 단지의 주요 설비 최근 수선일과 잔여기간을 추출.
 *
 * Usage: bun src/collect_maintenance.ts
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
const BASE = "https://apis.data.go.kr/1613000/ApHusMntMngHistInfoOfferServiceV2";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OPS = [
  { op: "getBuldExtrlMntncHistInfoSearchV2", label: "건물외부" },
  { op: "getBuldInnerMntncHistInfoSearchV2", label: "건물내부" },
  { op: "getElctyExtgElvtrMntncHistInfoSearchV2", label: "전기소화승강기" },
  { op: "getWspSnitatGasMntncHistInfoSearchV2", label: "급수위생가스" },
  { op: "getHeatHotWtrEqpMntncHistInfoSearchV2", label: "난방급탕" },
  { op: "getOutHousSbrsMntncHistInfoSearchV2", label: "옥외부대" },
];

interface MaintItem {
  category: string;       // 대분류
  subcategory: string;    // 공사종별
  method: string;         // 수선방법
  completedDate: string;  // 공사완료일
  cost: number;           // 공사비용
  elapsedYears: number;   // 경과기간(년)
  remainingYears: number; // 잔여기간(년)
}

interface MaintData {
  items: MaintItem[];
  summary: {
    totalCost: number;
    recentYear: string | null;    // 가장 최근 공사일
    elevatorRemaining: number | null;  // 승강기 잔여기간
    pipingRemaining: number | null;    // 배관 잔여기간
    waterproofRemaining: number | null; // 방수 잔여기간
  };
}

async function fetchOp(op: string, kaptCode: string): Promise<any[]> {
  try {
    const url = `${BASE}/${op}?serviceKey=${API_KEY}&kaptCode=${kaptCode}&_type=json`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    const items = json.response?.body?.items;
    if (!items) return [];
    if (Array.isArray(items)) return items;
    if (items.item) return Array.isArray(items.item) ? items.item : [items.item];
    return [];
  } catch {
    return [];
  }
}

async function processApt(kaptCode: string): Promise<MaintData | null> {
  const allItems: MaintItem[] = [];

  for (const { op } of OPS) {
    const raw = await fetchOp(op, kaptCode);
    for (const r of raw) {
      allItems.push({
        category: r.parentParentName?.trim() || "",
        subcategory: r.parentName?.trim() || "",
        method: r.subject?.trim() || "",
        completedDate: r.mnthEtime?.trim() || "",
        cost: parseInt(r.costType) || 0,
        elapsedYears: parseFloat(r.useYear) || 0,
        remainingYears: parseFloat(r.remainingYear) || 0,
      });
    }
    await sleep(100);
  }

  if (allItems.length === 0) return null;

  // 요약 계산
  const totalCost = allItems.reduce((s, i) => s + i.cost, 0);
  const dates = allItems.filter(i => i.completedDate).map(i => i.completedDate).sort();
  const recentYear = dates.length > 0 ? dates[dates.length - 1] : null;

  // 승강기 잔여기간 (최소값)
  const elevator = allItems.filter(i =>
    i.category.includes("승강기") || i.subcategory.includes("승강기")
  );
  const elevatorRemaining = elevator.length > 0
    ? Math.min(...elevator.map(i => i.remainingYears))
    : null;

  // 배관 잔여기간
  const piping = allItems.filter(i =>
    i.subcategory.includes("배관") || i.subcategory.includes("급수") || i.subcategory.includes("급배수")
  );
  const pipingRemaining = piping.length > 0
    ? Math.min(...piping.map(i => i.remainingYears))
    : null;

  // 방수 잔여기간
  const waterproof = allItems.filter(i =>
    i.subcategory.includes("방수") || i.category.includes("방수")
  );
  const waterproofRemaining = waterproof.length > 0
    ? Math.min(...waterproof.map(i => i.remainingYears))
    : null;

  return {
    items: allItems,
    summary: { totalCost, recentYear, elevatorRemaining, pipingRemaining, waterproofRemaining },
  };
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

  const outPath = join(DATA_DIR, "maintenance_history.json");
  const existing: Record<string, MaintData> = existsSync(outPath)
    ? await Bun.file(outPath).json()
    : {};

  const todo = uniqueTargets.filter((d) => !existing[d.name]);
  console.log(`유지관리 이력 수집: ${todo.length}개 대상, 기존 ${Object.keys(existing).length}개\n`);

  if (todo.length === 0) {
    console.log("수집 완료됨.");
    return;
  }

  let fetched = 0;
  for (let i = 0; i < todo.length; i++) {
    const { name, kapt_code } = todo[i];
    process.stdout.write(`[${i + 1}/${todo.length}] ${name}...`);

    const data = await processApt(kapt_code);
    if (data) {
      existing[name] = data;
      fetched++;
      const s = data.summary;
      const parts = [`${data.items.length}건`];
      if (s.elevatorRemaining != null) parts.push(`승강기 잔여${s.elevatorRemaining}년`);
      if (s.pipingRemaining != null) parts.push(`배관 잔여${s.pipingRemaining}년`);
      if (s.waterproofRemaining != null) parts.push(`방수 잔여${s.waterproofRemaining}년`);
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
