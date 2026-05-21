/**
 * audit_hcode_v2 결과의 mismatch들을 직접 정정.
 * suggested_hcode로 교체 + 파생 데이터 클리어 (재수집 대상).
 *
 * Usage: bun src/fix_hcode_v2.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");

interface AuditResult {
  mismatches: { name: string; current_hcode: string; suggested_hcode: string; suggested_name: string; similarity: number }[];
}

async function main() {
  const auditPath = join(DATA_DIR, "_hcode_v2_audit_result.json");
  if (!existsSync(auditPath)) { console.error("audit v2 결과 없음"); process.exit(1); }
  const audit: AuditResult = await Bun.file(auditPath).json();

  const idPath = join(DATA_DIR, "apt_identity.json");
  const identity: any[] = await Bun.file(idPath).json();

  const hcPath = join(DATA_DIR, "hogangnono_codes.json");
  const hc: Record<string, string | null> = await Bun.file(hcPath).json();

  const fixedNames = new Set<string>();
  for (const m of audit.mismatches) {
    const apt = identity.find((a) => a.name === m.name);
    if (apt) apt.hcode = m.suggested_hcode;
    hc[m.name] = m.suggested_hcode;
    fixedNames.add(m.name);
  }
  await Bun.write(idPath, JSON.stringify(identity, null, 2));
  await Bun.write(hcPath, JSON.stringify(hc, null, 2));
  console.log(`hcode 정정: ${fixedNames.size}건`);

  // 파생 데이터 클리어
  for (const f of ["dong_coords_naver.json", "slope_results.json", "school_map.json", "pediatric_clinics.json", "pedia_slope.json"]) {
    const p = join(DATA_DIR, f);
    if (!existsSync(p)) continue;
    const obj = await Bun.file(p).json() as Record<string, any>;
    let n = 0;
    for (const name of fixedNames) if (name in obj) { delete obj[name]; n++; }
    if (n > 0) await Bun.write(p, JSON.stringify(obj, null, 2));
    console.log(`  ${f}: ${n}건 제거`);
  }
}

main().catch(console.error);
