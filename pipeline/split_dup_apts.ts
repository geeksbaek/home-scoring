/**
 * 같은 단지명이 ≥2 법정동에 존재하고 각 동 거래 ≥THRESHOLD건이면
 * `{단지명}({법정동})` 형식으로 분리.
 *
 * 대상: apt_trade_filtered.csv + 모든 데이터 파일 (단지명을 키로 쓰는 모든 JSON).
 *
 * Usage:
 *   bun src/split_dup_apts.ts --plan       # 분리 대상만 출력 (write X)
 *   bun src/split_dup_apts.ts --apply      # 실제 적용
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const CSV_PATH = join(DATA_DIR, "apt_trade_filtered.csv");

const THRESHOLD = 5; // 각 동 최소 거래 수

interface Trade {
  raw: string;
  parts: string[];
  apt: string;
  dong: string;
}

async function loadTrades(): Promise<{ header: string; lines: Trade[] }> {
  const text = await Bun.file(CSV_PATH).text();
  const all = text.split("\n");
  const header = all[0];
  const cols = header.replace(/^﻿/, "").split(",");
  const idxApt = cols.indexOf("단지명");
  const idxDong = cols.indexOf("법정동");
  if (idxApt < 0 || idxDong < 0) throw new Error("단지명/법정동 컬럼 없음");
  const lines: Trade[] = [];
  for (let i = 1; i < all.length; i++) {
    const raw = all[i];
    if (!raw.trim()) continue;
    const parts = raw.split(",");
    lines.push({ raw, parts, apt: parts[idxApt], dong: parts[idxDong] });
  }
  return { header, lines };
}

function findSplits(lines: Trade[]): Map<string, { dongs: Map<string, number> }> {
  const byApt = new Map<string, Map<string, number>>();
  for (const t of lines) {
    if (!byApt.has(t.apt)) byApt.set(t.apt, new Map());
    const m = byApt.get(t.apt)!;
    m.set(t.dong, (m.get(t.dong) ?? 0) + 1);
  }
  const splits = new Map<string, { dongs: Map<string, number> }>();
  for (const [apt, m] of byApt) {
    if (m.size < 2) continue;
    const qualified = [...m.entries()].filter(([_, n]) => n >= THRESHOLD);
    if (qualified.length < 2) continue;
    splits.set(apt, { dongs: new Map(qualified) });
  }
  return splits;
}

function renameKey(name: string, dong: string): string {
  return `${name}(${dong})`;
}

async function main() {
  const plan = process.argv.includes("--plan");
  const apply = process.argv.includes("--apply");
  if (!plan && !apply) { console.log("--plan 또는 --apply 필요"); return; }

  const { header, lines } = await loadTrades();
  console.log(`CSV: ${lines.length} 거래`);

  const splits = findSplits(lines);
  console.log(`분리 대상: ${splits.size}개 단지명`);
  let totalNewEntries = 0;
  for (const [apt, { dongs }] of [...splits.entries()].sort((a, b) => b[1].dongs.size - a[1].dongs.size)) {
    const dongList = [...dongs.entries()].sort((a, b) => b[1] - a[1]);
    totalNewEntries += dongList.length;
    if (dongList.length >= 5) {
      console.log(`  ${apt}: ${dongList.length}개 동 (${dongList.slice(0, 5).map(([d, n]) => `${d}:${n}`).join(", ")}${dongList.length > 5 ? ", ..." : ""})`);
    }
  }
  console.log(`총 신규 entry: ${totalNewEntries}개`);

  if (plan) return;

  // ── apply 모드 ──
  // 1. CSV: apt → renameKey(apt, dong)
  console.log("\n[1/3] CSV 단지명 변경 중...");
  const cols = header.replace(/^﻿/, "").split(",");
  const idxApt = cols.indexOf("단지명");
  const idxDong = cols.indexOf("법정동");
  let renamed = 0;
  const newLines: string[] = [header];
  for (const t of lines) {
    if (splits.has(t.apt) && splits.get(t.apt)!.dongs.has(t.dong)) {
      t.parts[idxApt] = renameKey(t.apt, t.dong);
      renamed++;
    } else if (splits.has(t.apt)) {
      // 분리 대상이지만 거래 5 미만인 동 → 미분리 (작은 동은 마이너 데이터 흡수 가능). 이름 그대로
    }
    newLines.push(t.parts.join(","));
  }
  await Bun.write(CSV_PATH, newLines.join("\n"));
  console.log(`  CSV ${renamed}건 갱신`);

  // 2. apt_identity.json: 기존 entry 1개 → 동별로 복제. 단 bjd/jibun은 원본 그대로 (새로 fix_bjd_codes 필요)
  console.log("\n[2/3] data 파일 키 갱신 중...");
  const identityPath = join(DATA_DIR, "apt_identity.json");
  const identity: any[] = await Bun.file(identityPath).json();

  // 기존 단지 → 동별 분리 entry 생성. 원본 (.bjdong 일치하는 dong만) entry 갱신, 나머지 동은 새로 추가
  const splitNames = new Set(splits.keys());
  const out: any[] = [];
  const dongTradeMap = new Map<string, Map<string, { jibun: string; sigungu_cd: string; region: string }>>();
  // 원본 CSV에서 단지+동별 첫 거래의 jibun/sigungu_cd/region 추출
  for (const t of lines) {
    if (!splits.has(t.apt)) continue;
    if (!splits.get(t.apt)!.dongs.has(t.dong)) continue;
    const key = `${t.apt}|${t.dong}`;
    if (!dongTradeMap.has(t.apt)) dongTradeMap.set(t.apt, new Map());
    const m = dongTradeMap.get(t.apt)!;
    if (!m.has(t.dong)) {
      // parts: 시,지역명,법정동,단지명,금액_만원,전용면적,층,건축년도,거래년,거래월,거래일,거래일자,거래년월,거래유형,매수자,매도자,지역코드,지번
      m.set(t.dong, { jibun: t.parts[17], sigungu_cd: t.parts[16], region: t.parts[1] });
    }
  }

  for (const e of identity) {
    if (!splitNames.has(e.name)) { out.push(e); continue; }
    const sp = splits.get(e.name)!;
    for (const [dong] of sp.dongs) {
      const meta = dongTradeMap.get(e.name)?.get(dong);
      if (!meta) continue;
      const newName = renameKey(e.name, dong);
      out.push({
        ...e,
        name: newName,
        region: meta.region,
        sigungu_cd: meta.sigungu_cd,
        bjdong: dong,
        jibun: meta.jibun,
        bjd_code: null, // fix_bjd_codes로 재수집 필요
        kapt_code: null, // 동별로 다시 검색 필요
        hcode: null, // collect_hcode로 재수집
        naver_place_id: null,
        kakao_place_id: null,
        doro_juso: null,
        jibun_addr: null,
        kapt_name: null,
        commute_name: null,
        beec_name: null,
      });
    }
  }
  await Bun.write(identityPath, JSON.stringify(out, null, 2));
  console.log(`  apt_identity: ${identity.length} → ${out.length}`);

  // 3. 기타 데이터 파일 (단지명을 키로 쓰는 JSON): 기존 entry 삭제만. 새 entry는 다음 사이클에서 다시 수집.
  // 이유: 원본 단지의 데이터를 어떤 동에 할당해야 할지 알 수 없음. 안전하게 삭제 후 재수집.
  const dataFiles = [
    "building_info.json",
    "kapt_info.json",
    "hogangnono_codes.json",
    "dong_coords_naver.json",
    "slope_results.json",
    "school_map.json",
    "naver_complex_ids.json",
    "unit_types.json",
    "mgmt_cost.json",
    "audit_history.json",
    "maintenance_history.json",
    "repair_fund.json",
    "school_grade.json",
    "apt_hjdong.json",
  ];
  for (const fname of dataFiles) {
    const path = join(DATA_DIR, fname);
    if (!existsSync(path)) continue;
    const data = await Bun.file(path).json();
    if (Array.isArray(data)) continue; // skip arrays
    let removed = 0;
    for (const apt of splitNames) {
      if (data[apt] != null) { delete data[apt]; removed++; }
    }
    await Bun.write(path, JSON.stringify(data, null, 2));
    if (removed > 0) console.log(`  ${fname}: ${removed} entries 삭제`);
  }

  console.log("\n완료. 다음 단계:");
  console.log("  1. bun src/fix_bjd_codes.ts  (분리된 entry bjd_code 보강)");
  console.log("  2. bun src/collect_hcode.ts  (분리된 entry hcode 매칭)");
  console.log("  3. bun src/building.ts --force  (건축물대장 + parking 재수집)");
  console.log("  4. bun src/kapt_search.ts");
  console.log("  5. ... 기타 collect_* 재실행");
  console.log("  6. bun src/sync.ts");
}

main();
