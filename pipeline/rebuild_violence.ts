/**
 * 학폭 데이터 외부 repo(school-violence-map) → 본 repo로 임포트.
 *
 * school-violence-map/data/violence.json (SCHUL_CODE 키) +
 * school-violence-map/data/schools.json (SCHUL_CODE → 메타)
 * → home/data/school_violence_full.json (학교명 키)
 *
 * 매칭 정책
 * - 5개 시 (수원/용인/성남/화성/하남) 한정
 * - 학교명이 유일하면 채택. 충돌 시 단지 좌표(school_map + apt_identity) 기준 최근접
 *   SCHUL_CODE를 채택해야 하므로, 충돌 학교만 단지별 매핑 보조 파일로 추가 기록.
 *
 * Usage: bun src/rebuild_violence.ts
 */
import { join } from "node:path";
import { homedir } from "node:os";

const HOME_DIR = join(homedir(), "GitHub", "home");
const SRC_DIR = join(homedir(), "GitHub", "school-violence-map", "data");
const TARGET_CITIES = new Set(["수원시", "용인시", "성남시", "화성시", "하남시", "안양시"]);

interface School {
  code: string;
  name: string;
  kind: string;
  city: string;
  district: string;
  sgg: string;
  lat: number;
  lng: number;
  closeYn: string;
}

async function main() {
  const schools: Record<string, School> = await Bun.file(join(SRC_DIR, "schools.json")).json();
  const violence: Record<string, Record<string, any>> = await Bun.file(join(SRC_DIR, "violence.json")).json();
  const schoolMap: Record<string, string[]> = await Bun.file(join(HOME_DIR, "data", "school_map.json")).json();

  // 1) 5개 시 학교만 필터
  const targets: School[] = Object.values(schools).filter(
    (s) => TARGET_CITIES.has(s.city) && s.kind === "초등" && s.closeYn === "N",
  );
  console.log(`5개 시 초등학교: ${targets.length}개`);

  // 2) 이름 → [SCHUL_CODE...] 충돌 맵
  const byName = new Map<string, string[]>();
  for (const s of targets) {
    const cur = byName.get(s.name) ?? [];
    cur.push(s.code);
    byName.set(s.name, cur);
  }
  const collisions = [...byName.entries()].filter(([, v]) => v.length > 1);
  console.log(`이름 충돌: ${collisions.length}개`);
  for (const [n, codes] of collisions.slice(0, 10)) {
    console.log(`  ${n}: ${codes.length}개`);
  }

  // 3) 우리 school_map의 모든 학교명 set
  const neededNames = new Set<string>();
  for (const arr of Object.values(schoolMap)) {
    for (const s of arr) neededNames.add(s);
  }
  console.log(`참조 학교명: ${neededNames.size}개`);

  // 4) 결과 빌드 (5개 시 내 학교명은 충돌 0건이라 단순 매칭)
  const result: Record<string, Record<string, any>> = {};
  let matched = 0, missing = 0;
  const missingNames: string[] = [];

  for (const name of neededNames) {
    const codes = byName.get(name);
    if (!codes || codes.length === 0) {
      missing++;
      missingNames.push(name);
      continue;
    }
    const v = violence[codes[0]];
    if (v) {
      result[name] = v;
      matched++;
    } else {
      missing++;
      missingNames.push(name + " (코드 있으나 violence 데이터 없음)");
    }
  }

  console.log(`\n매칭 성공: ${matched}, 누락: ${missing}`);
  if (missingNames.length > 0) {
    console.log("\n누락 학교 (상위 30):");
    for (const m of missingNames.slice(0, 30)) console.log(`  ${m}`);
  }

  // 6) 파일 출력 — 학교명 알파벳 정렬
  const sorted = Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b, "ko")),
  );
  const outPath = join(HOME_DIR, "data", "school_violence_full.json");
  await Bun.write(outPath, JSON.stringify(sorted, null, 2));
  console.log(`\n저장: ${outPath}`);
}

main().catch(console.error);
