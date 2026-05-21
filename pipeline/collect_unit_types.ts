/**
 * 건축물대장 전유공용면적 API에서 면적별 세대수 수집.
 *
 * unit_types.ts (K-apt 기반)는 60/85/135㎡ 4분류라 우리 atype 분류(59/74/84 등)와 mismatch.
 * 이 스크립트는 호별 전용면적 데이터로 정밀한 unit_types를 만든다.
 *
 * 대상: kapt_code 없거나 fromKapt:true인 단지 (정밀 데이터 부재).
 *
 * Usage:
 *   bun src/collect_unit_types.ts            # 미수집 단지만
 *   bun src/collect_unit_types.ts --force    # 전체 재수집
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const API_KEY = process.env.PUBLIC_DATA_API_KEY!;
const BASE = "https://apis.data.go.kr/1613000/BldRgstHubService";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function qs(p: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])).toString();
}

async function apiGet(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
        return null;
      }
      const json = (await res.json()) as any;
      if (json.response?.header?.resultCode !== "00") return null;
      return json.response.body;
    } catch {
      if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      return null;
    }
  }
  return null;
}

interface IdentityEntry {
  name: string;
  sigungu_cd: string;
  bjdong: string;
  bjd_code: string | null;
  jibun: string;
  kapt_code: string | null;
}

function parseBunJi(jibun: string): { bun: string; ji: string } | null {
  if (!jibun) return null;
  const m = String(jibun).match(/(\d+)(?:-(\d+))?/);
  if (!m) return null;
  return { bun: m[1].padStart(4, "0"), ji: (m[2] ?? "0").padStart(4, "0") };
}

function normalize(s: string): string {
  return (s || "").replace(/[^가-힣A-Za-z0-9]/g, "").toLowerCase();
}

interface ExposItem {
  exposPubuseGbCd?: string;
  bldNm?: string;
  dongNm?: string;
  hoNm?: string;
  area?: number | string;
  mainPurpsCdNm?: string;
}

async function fetchExposAll(sigunguCd: string, bjdongCd: string, bun: string, ji: string): Promise<ExposItem[]> {
  const all: ExposItem[] = [];
  for (let page = 1; page <= 20; page++) {
    const body = await apiGet(
      `${BASE}/getBrExposPubuseAreaInfo?${qs({
        serviceKey: API_KEY, sigunguCd, bjdongCd, bun, ji,
        numOfRows: 1000, pageNo: page, _type: "json",
      })}`
    );
    if (!body) break;
    const items = body.items?.item;
    const arr: ExposItem[] = Array.isArray(items) ? items : items ? [items] : [];
    all.push(...arr);
    const total = parseInt(body.totalCount ?? "0");
    if (all.length >= total || arr.length === 0) break;
    await sleep(80);
  }
  return all;
}

interface AreaTypeEntry { area: number; count: number; }

function buildUnitTypes(rows: ExposItem[], targetName: string, allowFallback: boolean): { bldNm: string; totalUnits: number; areaTypes: AreaTypeEntry[]; matched: boolean } | null {
  // 전유 + 아파트만
  const exclusive = rows.filter((r) =>
    r.exposPubuseGbCd === "1" &&
    (r.mainPurpsCdNm || "").includes("아파트") &&
    parseFloat(String(r.area)) > 10 // 작은 부속실 노이즈 제거
  );
  if (exclusive.length === 0) return null;

  // bldNm으로 그룹핑
  const byBld = new Map<string, ExposItem[]>();
  for (const r of exclusive) {
    const bld = (r.bldNm || "").trim();
    if (!byBld.has(bld)) byBld.set(bld, []);
    byBld.get(bld)!.push(r);
  }

  // 단지명과 가장 잘 맞는 bldNm 선택
  const targetN = normalize(targetName);
  let pick: { bld: string; rows: ExposItem[]; matched: boolean } | null = null;
  for (const [bld, rs] of byBld) {
    const bldN = normalize(bld);
    if (bldN && targetN && (bldN.includes(targetN) || targetN.includes(bldN))) {
      if (!pick || rs.length > pick.rows.length) pick = { bld, rows: rs, matched: true };
    }
  }
  // 매칭 실패 시 가장 큰 그룹 (allowFallback일 때만)
  if (!pick) {
    if (!allowFallback) return null;
    const top = [...byBld.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (!top) return null;
    pick = { bld: top[0], rows: top[1], matched: false };
  }

  // 호별 area 합산 (전유부에 같은 호의 행이 여러 개 들어올 수 있음 — 안전하게)
  const perHo = new Map<string, number>();
  for (const r of pick.rows) {
    const k = `${r.dongNm}|${r.hoNm}`;
    perHo.set(k, (perHo.get(k) ?? 0) + parseFloat(String(r.area)));
  }

  // area별 호 수
  const areaCounts = new Map<number, number>();
  for (const a of perHo.values()) {
    const r = Math.round(a * 100) / 100;
    areaCounts.set(r, (areaCounts.get(r) ?? 0) + 1);
  }
  const areaTypes: AreaTypeEntry[] = [...areaCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([area, count]) => ({ area, count }));

  return { bldNm: pick.bld, totalUnits: perHo.size, areaTypes, matched: pick.matched };
}

async function main() {
  const force = process.argv.includes("--force");
  console.log(`건축물대장 전유부 면적별 세대수 수집${force ? " (전체 재수집)" : ""}\n`);

  const identity: IdentityEntry[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();

  // bjd_code 없는 단지를 위한 매핑 (building.ts와 동일 기조)
  const bjdongMap = new Map<string, string>();
  for (const apt of identity) {
    if (apt.bjd_code && apt.sigungu_cd && apt.bjdong) {
      const key = `${apt.sigungu_cd}:${apt.bjdong}`;
      if (!bjdongMap.has(key)) bjdongMap.set(key, apt.bjd_code.slice(5, 10));
    }
  }

  const utPath = join(DATA_DIR, "unit_types.json");
  const existing: Record<string, any> = existsSync(utPath) ? await Bun.file(utPath).json() : {};

  // 같은 sigungu/bjdong/jibun 부지에 단지가 여럿 있는지 (identity 기준)
  // → 같은 부지에 다른 단지가 있으면 bldNm 정확 매칭만 허용 (fallback 금지)
  const sitesCount = new Map<string, number>();
  for (const a of identity) {
    if (!a.bjd_code || !a.jibun) continue;
    const key = `${a.bjd_code}:${a.jibun}`;
    sitesCount.set(key, (sitesCount.get(key) ?? 0) + 1);
  }

  // 대상: 데이터 없거나 K-apt 기반(부정확)
  const targets = identity.filter((a) => {
    const cur = existing[a.name];
    if (force) return true;
    if (!cur) return true;
    if (cur.fromKapt) return true; // 정밀화
    return false;
  });

  console.log(`대상: ${targets.length}/${identity.length} 단지\n`);

  let ok = 0, fail = 0, skip = 0;
  for (let i = 0; i < targets.length; i++) {
    const apt = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${apt.name}...`);

    // sigungu/bjdong 결정
    let sigunguCd: string;
    let bjdongCd: string;
    if (apt.bjd_code) {
      sigunguCd = apt.bjd_code.slice(0, 5);
      bjdongCd = apt.bjd_code.slice(5, 10);
    } else {
      const key = `${apt.sigungu_cd}:${apt.bjdong}`;
      const m = bjdongMap.get(key);
      if (!m) { console.log(` ✗ bjdong 코드 없음 (${key})`); fail++; continue; }
      sigunguCd = apt.sigungu_cd;
      bjdongCd = m;
    }

    const bj = parseBunJi(apt.jibun);
    if (!bj) { console.log(" ✗ 번/지 파싱 실패"); fail++; continue; }

    const rows = await fetchExposAll(sigunguCd, bjdongCd, bj.bun, bj.ji);
    if (rows.length === 0) { console.log(" ✗ API 응답 없음"); fail++; await sleep(150); continue; }

    // 같은 부지에 다른 단지 있으면 fallback 금지
    const siteKey = apt.bjd_code ? `${apt.bjd_code}:${apt.jibun}` : "";
    const allowFallback = (sitesCount.get(siteKey) ?? 1) <= 1;

    const built = buildUnitTypes(rows, apt.name, allowFallback);
    if (!built) {
      if (!allowFallback) { console.log(" ⊘ 동일 부지 다중 단지 (bldNm 매칭 실패)"); skip++; }
      else { console.log(" ✗ 아파트 전유 row 없음"); fail++; }
      await sleep(150); continue;
    }

    existing[apt.name] = {
      name: apt.name,
      totalUnits: built.totalUnits,
      areaTypes: built.areaTypes,
    };
    await Bun.write(utPath, JSON.stringify(existing, null, 2));

    const summary = built.areaTypes.map((t) => `${t.area}㎡:${t.count}`).join(" ");
    const tag = built.matched ? "✓" : "✓ (단일부지 fallback)";
    console.log(` ${tag} "${built.bldNm}" ${built.totalUnits}세대 [${summary}]`);
    ok++;
    await sleep(150);
  }

  console.log(`\n완료: ${ok}개 수집, ${skip}개 스킵 (동일부지 다중단지), ${fail}개 실패`);
  console.log(`전체 unit_types: ${Object.keys(existing).length}개`);
  const fromBld = Object.values(existing).filter((v: any) => !v.fromKapt).length;
  const fromKapt = Object.values(existing).filter((v: any) => v.fromKapt).length;
  console.log(`  건축물대장 전유부 (정밀): ${fromBld}개`);
  console.log(`  K-apt 기반 (대분류): ${fromKapt}개`);
}

if (import.meta.main) main().catch(console.error);
