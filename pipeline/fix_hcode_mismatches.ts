/**
 * audit_hcode_strict 결과를 받아 mismatch 단지의 hcode 및 파생 데이터 정리.
 * 중복 hcode는 ground truth에 가장 가까운 1개만 남기고 나머지 nullify.
 *
 * Usage: bun src/fix_hcode_mismatches.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");

interface AuditResult {
  summary: any;
  mismatches: { name: string; hcode: string; distance_m: number }[];
  duplicates: { hcode: string; names: string[] }[];
  no_truth: string[];
  no_polygon: string[];
}

interface CacheData {
  polygons: Record<string, { lat: number; lng: number } | null>;
  truths: Record<string, { lat: number; lng: number } | null>;
}

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function main() {
  const auditPath = join(DATA_DIR, "_hcode_strict_audit_result.json");
  if (!existsSync(auditPath)) {
    console.error("audit 결과 파일 없음. audit_hcode_strict 먼저 실행.");
    process.exit(1);
  }
  const audit: AuditResult = await Bun.file(auditPath).json();
  const cache: CacheData = await Bun.file(join(DATA_DIR, "_hcode_strict_audit.json")).json();

  // 정리 대상 단지명 집합
  const toNullify = new Set<string>();

  // 1. polygon vs truth 거리 mismatch — 모두 nullify
  for (const m of audit.mismatches) toNullify.add(m.name);

  // 2. 중복 hcode — ground truth에 가장 가까운 1개만 유지, 나머지 nullify
  for (const dup of audit.duplicates) {
    const poly = cache.polygons[dup.hcode];
    if (!poly) {
      // polygon 없으면 모두 nullify (재수집 필요)
      for (const n of dup.names) toNullify.add(n);
      continue;
    }
    // 각 단지의 truth와 polygon 거리 계산
    const ranked = dup.names
      .map((n) => {
        const t = cache.truths[n];
        return { name: n, dist: t ? haversine(poly, t) : Infinity };
      })
      .sort((a, b) => a.dist - b.dist);
    // 가장 가까운 단지 유지 (단, 500m 이내일 때만)
    const winner = ranked[0];
    if (!winner || winner.dist > 500) {
      // 모두 부적합
      for (const n of dup.names) toNullify.add(n);
    } else {
      // winner 외 nullify
      for (const r of ranked) if (r.name !== winner.name) toNullify.add(r.name);
    }
  }

  console.log(`정리 대상: ${toNullify.size}개 단지`);
  for (const n of [...toNullify].sort()) console.log(`  - ${n}`);

  // 적용
  const idPath = join(DATA_DIR, "apt_identity.json");
  const identity: any[] = await Bun.file(idPath).json();
  for (const a of identity) if (toNullify.has(a.name)) a.hcode = null;
  await Bun.write(idPath, JSON.stringify(identity, null, 2));

  // hogangnono_codes.json
  const hcPath = join(DATA_DIR, "hogangnono_codes.json");
  const hc: Record<string, string | null> = await Bun.file(hcPath).json();
  for (const n of toNullify) if (n in hc) hc[n] = null;
  await Bun.write(hcPath, JSON.stringify(hc, null, 2));

  // 파생 데이터 클리어 (재수집 대상)
  for (const fileName of ["dong_coords_naver.json", "slope_results.json", "school_map.json", "pediatric_clinics.json", "pedia_slope.json"]) {
    const p = join(DATA_DIR, fileName);
    if (!existsSync(p)) continue;
    const obj = await Bun.file(p).json() as Record<string, any>;
    let cleared = 0;
    for (const n of toNullify) {
      if (n in obj) { delete obj[n]; cleared++; }
    }
    await Bun.write(p, JSON.stringify(obj, null, 2));
    console.log(`  ${fileName}: ${cleared}건 제거`);
  }

  console.log(`\n완료: ${toNullify.size}개 단지의 hcode 및 파생 데이터 정리. collect_hcode.ts로 재수집.`);
}

main().catch(console.error);
