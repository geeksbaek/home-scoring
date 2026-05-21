/**
 * 학교알리미 OPEN API — 학년별·학급별 학생수 수집.
 * 우리 단지가 속한 시군구 14개 × 초등학교(02) 호출 → 우리 배정초 매칭.
 * 결과 저장: data/school_grade.json
 *   - 학교명 → { total, grade1, grade2, ..., grade6, classes1~6, lower3_rate, schoolCode, addr }
 *   - lower3_rate = (1+2+3학년) / 전체 — 어린 자녀 비중
 *
 * Usage: bun src/collect_school_grade.ts
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");

// .env 직접 로드
if (!process.env.SCHOOLINFO_API_KEY) {
  for (const line of (await Bun.file(join(ROOT, ".env")).text()).split("\n")) {
    if (line.startsWith("SCHOOLINFO_API_KEY")) {
      const v = line.split("=", 2)[1].trim().replace(/^['"]|['"]$/g, "");
      (process.env as any).SCHOOLINFO_API_KEY = v;
    }
  }
}
const KEY = process.env.SCHOOLINFO_API_KEY!;

const ENDPOINT = "https://www.schoolinfo.go.kr/openApi.do";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SchoolRow {
  SCHUL_NM: string;
  SCHUL_CODE: string;
  ADRCD_NM: string;
  ADRCD_CD: string;
  COL_S_SUM: number;
  COL_S1: number; COL_S2: number; COL_S3: number; COL_S4: number; COL_S5: number; COL_S6: number; COL_S7: number; COL_S8: number;
  COL_C_SUM: number;
  COL_C1: number; COL_C2: number; COL_C3: number; COL_C4: number; COL_C5: number; COL_C6: number; COL_C7: number; COL_C8: number;
}

async function fetchSigungu(sidoCode: string, sggCode: string, year: string): Promise<SchoolRow[]> {
  const url = ENDPOINT + "?" + new URLSearchParams({
    apiKey: KEY,
    apiType: "09",  // 학년별·학급별 학생수
    sidoCode,
    sggCode,
    schulKndCode: "02",  // 초등학교
    pbanYr: year,
  });
  const res = await fetch(url);
  const j = await res.json();
  if (j.resultCode !== "success") {
    console.warn(`  ${sggCode} ${year} fail: ${j.resultMsg}`);
    return [];
  }
  return j.list ?? [];
}

async function main() {
  const identity: any[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const schoolMap: Record<string, string[]> = await Bun.file(join(DATA_DIR, "school_map.json")).json();

  const ourSchools = new Set<string>();
  for (const v of Object.values(schoolMap)) for (const s of v) ourSchools.add(s);
  console.log(`우리 배정초 ${ourSchools.size}개`);

  // 시군구 코드 (sidoCode + sggCode 분리)
  // 화성시는 구별(41591/41595/41597) 호출 시 동탄2 등이 누락되므로 통합 코드(41590)로 호출.
  // 효행구(41593)는 구별 데이터 일부 보유 — 보강 위해 같이 호출.
  const sigungus = [...new Set(identity.map((a) => a.sigungu_cd).filter(Boolean))].sort() as string[];
  const expanded = new Set<string>();
  for (const s of sigungus) {
    if (s.startsWith("4159")) {
      expanded.add("41590"); // 화성시 통합
      expanded.add("41593"); // 효행구
    } else {
      expanded.add(s);
    }
  }
  const calls: { sido: string; sgg: string }[] = [...expanded].sort().map((s) => ({ sido: s.slice(0, 2), sgg: s }));

  console.log(`시군구 ${calls.length}개 호출 (초등학교, ${"2025"}년)`);

  const all: SchoolRow[] = [];
  for (const c of calls) {
    const rows = await fetchSigungu(c.sido, c.sgg, "2025");
    console.log(`  ${c.sgg} → ${rows.length} 학교`);
    all.push(...rows);
    await sleep(150);
  }

  // 우리 배정초 학교명과 매칭 (학교명 중복 시 첫 응답 유지)
  const result: Record<string, any> = {};
  for (const r of all) {
    if (!ourSchools.has(r.SCHUL_NM)) continue;
    if (result[r.SCHUL_NM]) continue;
    const lower3 = (r.COL_S1 ?? 0) + (r.COL_S2 ?? 0) + (r.COL_S3 ?? 0);
    const total = r.COL_S_SUM ?? 0;
    result[r.SCHUL_NM] = {
      schoolCode: r.SCHUL_CODE,
      addr: r.ADRCD_NM,
      total,
      grade1: r.COL_S1, grade2: r.COL_S2, grade3: r.COL_S3,
      grade4: r.COL_S4, grade5: r.COL_S5, grade6: r.COL_S6,
      classes_total: r.COL_C_SUM,
      lower3,
      lower3_rate: total > 0 ? Math.round((lower3 / total) * 1000) / 10 : 0,  // %
    };
  }

  await Bun.write(join(DATA_DIR, "school_grade.json"), JSON.stringify(result, null, 2));
  console.log(`\n저장: ${Object.keys(result).length} / ${ourSchools.size}개 우리 학교 매칭`);
  const unmatched = [...ourSchools].filter((s) => !result[s]);
  if (unmatched.length) console.log(`미매칭 샘플:`, unmatched.slice(0, 10));

  // 빠른 통계
  const sorted = Object.entries(result).sort((a: any, b: any) => b[1].lower3_rate - a[1].lower3_rate);
  console.log(`\n어린자녀 비율(1~3학년/전체) 상위 5:`);
  for (const [n, v] of sorted.slice(0, 5)) console.log(`  ${(v as any).lower3_rate}% ${n} (전체 ${(v as any).total})`);
  console.log(`하위 5:`);
  for (const [n, v] of sorted.slice(-5)) console.log(`  ${(v as any).lower3_rate}% ${n} (전체 ${(v as any).total})`);
}

main().catch(console.error);
