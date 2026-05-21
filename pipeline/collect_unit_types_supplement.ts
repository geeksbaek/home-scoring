/**
 * 미수집 단지 보강.
 *  1. bjd_code/jibun 누락 → 카카오 geocode로 보강
 *  2. 부지에 단지 여럿 + 단순 bldNm 매칭 실패 → 단지명 식별 키워드(공통 prefix 제거 후 잔여 substring)로 bldNm 매칭
 *  3. 건축물대장 totalCount=0 또는 fallback 거부 → K-apt 4분류 fallback
 *
 * Usage: bun src/collect_unit_types_supplement.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const API_KEY = process.env.PUBLIC_DATA_API_KEY!;
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY!;
const BASE = "https://apis.data.go.kr/1613000/BldRgstHubService";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function qs(p: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])).toString();
}

async function apiGet(url: string): Promise<any> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) { if (res.status === 429) { await sleep(2000 * (i + 1)); continue; } return null; }
      const j = (await res.json()) as any;
      if (j.response?.header?.resultCode !== "00") return null;
      return j.response.body;
    } catch { if (i < 2) await sleep(1000); else return null; }
  }
  return null;
}

async function fetchExposAll(sigunguCd: string, bjdongCd: string, bun: string, ji: string): Promise<any[]> {
  const all: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const body = await apiGet(`${BASE}/getBrExposPubuseAreaInfo?${qs({ serviceKey: API_KEY, sigunguCd, bjdongCd, bun, ji, numOfRows: 100, pageNo: page, _type: "json" })}`);
    if (!body) break;
    const items = body.items?.item;
    const arr = Array.isArray(items) ? items : items ? [items] : [];
    all.push(...arr);
    const total = parseInt(body.totalCount ?? "0");
    if (all.length >= total || arr.length === 0) break;
    await sleep(150);
  }
  return all;
}

async function kakaoGeocodeJibun(addr: string): Promise<{ bjdCode: string; bun: string; ji: string } | null> {
  try {
    const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(addr)}&size=1`;
    const r = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    const d = j.documents?.[0];
    const a = d?.address;
    if (!a?.b_code) return null;
    return { bjdCode: a.b_code, bun: a.main_address_no || "0", ji: a.sub_address_no || "0" };
  } catch { return null; }
}

function normalize(s: string): string {
  return (s || "").replace(/[^가-힣A-Za-z0-9]/g, "").toLowerCase();
}

// 같은 부지 단지들의 공통 prefix 제거 후 식별 키워드 반환
function extractKeywords(myName: string, siblings: string[]): string[] {
  const keys = new Set<string>();
  const me = normalize(myName);
  // 1. 공통 prefix
  let common = me;
  for (const s of siblings) {
    const sn = normalize(s);
    let i = 0;
    while (i < common.length && i < sn.length && common[i] === sn[i]) i++;
    common = common.slice(0, i);
  }
  if (common && common.length < me.length) {
    const rest = me.slice(common.length);
    if (rest.length >= 2) keys.add(rest);
  }
  // 2. 괄호 안 내용
  const paren = myName.match(/\(([^)]+)\)/g);
  if (paren) for (const p of paren) keys.add(normalize(p));
  // 3. 괄호 제거 후 마지막 단어 (예: "한일타운대림" → "대림" 추출 시 길이 2+)
  const stripped = myName.replace(/\([^)]*\)/g, "").trim();
  // 마을/타운/단지 등 일반 접미사 제외하고 마지막 한글 토큰
  const tokens = stripped.match(/[가-힣A-Za-z0-9]+/g) ?? [];
  for (const t of tokens) {
    const n = normalize(t);
    if (n.length >= 2 && !["아파트", "단지", "마을", "타운", "시범", "지구"].includes(t)) keys.add(n);
  }
  return [...keys].filter((k) => k.length >= 2);
}

function buildFromKapt(name: string, kaptItem: any): any | null {
  if (!kaptItem) return null;
  const total = kaptItem.kaptdaCnt || 0;
  if (total <= 0) return null;
  const u60 = kaptItem.kaptMparea60 || 0;
  const u85 = kaptItem.kaptMparea85 || 0;
  const u135 = kaptItem.kaptMparea135 || 0;
  const o136 = kaptItem.kaptMparea136 || 0;
  const areaTypes = [];
  if (u60 > 0) areaTypes.push({ area: 50, count: u60 });
  if (u85 > 0) areaTypes.push({ area: 75, count: u85 });
  if (u135 > 0) areaTypes.push({ area: 100, count: u135 });
  if (o136 > 0) areaTypes.push({ area: 150, count: o136 });
  if (areaTypes.length === 0) return null;
  return { name, totalUnits: total, areaTypes, fromKapt: true };
}

async function main() {
  const identity: any[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const utPath = join(DATA_DIR, "unit_types.json");
  const ut: Record<string, any> = await Bun.file(utPath).json();
  const kaptInfo: Record<string, any> = await Bun.file(join(DATA_DIR, "kapt_info.json")).json();

  const utNames = new Set(Object.keys(ut));
  const targets = identity.filter((a) => !utNames.has(a.name));
  console.log(`보강 대상: ${targets.length}개`);

  // 부지(`bjd_code:jibun`) → 단지명 리스트 (bldNm 키워드 추출용)
  const siteToNames = new Map<string, string[]>();
  for (const a of identity) {
    if (!a.bjd_code || !a.jibun) continue;
    const k = `${a.bjd_code}:${a.jibun}`;
    if (!siteToNames.has(k)) siteToNames.set(k, []);
    siteToNames.get(k)!.push(a.name);
  }

  let ok = 0, fallback = 0, fail = 0;

  for (let i = 0; i < targets.length; i++) {
    const apt = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${apt.name}...`);

    // 주소 보강
    let bjdCode = apt.bjd_code;
    let jibun = apt.jibun;
    if (!bjdCode || !jibun) {
      // K-apt 도로명 우선
      const k = kaptInfo[apt.name];
      const queryAddr = k?.doroJuso || k?.addr || (apt.bjdong && apt.jibun ? `경기도 ${apt.region} ${apt.bjdong} ${apt.jibun}` : null);
      if (queryAddr) {
        const g = await kakaoGeocodeJibun(queryAddr);
        if (g) {
          bjdCode = bjdCode || g.bjdCode;
          jibun = jibun || `${g.bun}${g.ji && g.ji !== "0" ? "-" + g.ji : ""}`;
          // identity 업데이트
          const idx = identity.findIndex((x) => x.name === apt.name);
          if (idx >= 0) {
            if (!identity[idx].bjd_code) identity[idx].bjd_code = bjdCode;
            if (!identity[idx].jibun) identity[idx].jibun = jibun;
          }
        }
        await sleep(80);
      }
    }
    if (!bjdCode || !jibun) {
      // K-apt fallback 시도
      const fb = buildFromKapt(apt.name, kaptInfo[apt.name]);
      if (fb) { ut[apt.name] = fb; await Bun.write(utPath, JSON.stringify(ut, null, 2)); fallback++; console.log(" ⤴ K-apt fallback"); continue; }
      console.log(" ✗ 주소 없음 + K-apt 없음");
      fail++; continue;
    }

    // 건축물대장 fetch
    const sigunguCd = bjdCode.slice(0, 5);
    const bjdongCd = bjdCode.slice(5, 10);
    const m = String(jibun).match(/(\d+)(?:-(\d+))?/);
    const bun = (m?.[1] ?? "0").padStart(4, "0");
    const ji = (m?.[2] ?? "0").padStart(4, "0");

    const rows = await fetchExposAll(sigunguCd, bjdongCd, bun, ji);
    const exclusive = rows.filter((r: any) => r.exposPubuseGbCd === "1" && (r.mainPurpsCdNm || "").includes("아파트") && parseFloat(String(r.area)) > 10);

    if (exclusive.length === 0) {
      // K-apt fallback
      const fb = buildFromKapt(apt.name, kaptInfo[apt.name]);
      if (fb) { ut[apt.name] = fb; await Bun.write(utPath, JSON.stringify(ut, null, 2)); fallback++; console.log(" ⤴ 건축물대장 빈응답 → K-apt fallback"); continue; }
      console.log(" ✗ 건축물대장 빈응답 + K-apt 없음");
      fail++; continue;
    }

    // bldNm 그룹
    const byBld = new Map<string, any[]>();
    for (const r of exclusive) {
      const bld = (r.bldNm || "").trim();
      if (!byBld.has(bld)) byBld.set(bld, []);
      byBld.get(bld)!.push(r);
    }

    // 1순위: 정확 매칭
    const targetN = normalize(apt.name);
    let pickedRows: any[] | null = null;
    let pickedBld = "";
    for (const [bld, rs] of byBld) {
      const bldN = normalize(bld);
      if (bldN && targetN && (bldN.includes(targetN) || targetN.includes(bldN))) {
        if (!pickedRows || rs.length > pickedRows.length) { pickedRows = rs; pickedBld = bld; }
      }
    }

    // 2순위: 동일 부지의 형제 단지 기반 키워드 매칭
    if (!pickedRows) {
      const siteKey = `${bjdCode}:${jibun}`;
      const siblings = (siteToNames.get(siteKey) ?? []).filter((n) => n !== apt.name);
      const keywords = extractKeywords(apt.name, siblings);
      for (const [bld, rs] of byBld) {
        const bldN = normalize(bld);
        for (const k of keywords) {
          if (bldN.includes(k)) {
            if (!pickedRows || rs.length > pickedRows.length) { pickedRows = rs; pickedBld = bld; }
            break;
          }
        }
      }
    }

    if (!pickedRows) {
      // 3순위: K-apt fallback
      const fb = buildFromKapt(apt.name, kaptInfo[apt.name]);
      if (fb) { ut[apt.name] = fb; await Bun.write(utPath, JSON.stringify(ut, null, 2)); fallback++; console.log(" ⤴ bldNm 매칭 실패 → K-apt fallback"); continue; }
      console.log(" ✗ bldNm 매칭 실패 + K-apt 없음");
      fail++; continue;
    }

    // areaTypes 생성
    const perHo = new Map<string, number>();
    for (const r of pickedRows) {
      const k = `${r.dongNm}|${r.hoNm}`;
      perHo.set(k, (perHo.get(k) ?? 0) + parseFloat(String(r.area)));
    }
    const areaCounts = new Map<number, number>();
    for (const a of perHo.values()) {
      const r = Math.round(a * 100) / 100;
      areaCounts.set(r, (areaCounts.get(r) ?? 0) + 1);
    }
    const areaTypes = [...areaCounts.entries()].sort((a, b) => a[0] - b[0]).map(([area, count]) => ({ area, count }));
    ut[apt.name] = { name: apt.name, totalUnits: perHo.size, areaTypes };
    await Bun.write(utPath, JSON.stringify(ut, null, 2));
    ok++;
    console.log(` ✓ "${pickedBld}" ${perHo.size}세대`);
    await sleep(150);
  }

  await Bun.write(join(DATA_DIR, "apt_identity.json"), JSON.stringify(identity, null, 2));

  console.log(`\n완료: ${ok} 정밀 + ${fallback} K-apt fallback + ${fail} 실패 / 총 ${targets.length}`);
}

if (import.meta.main) main().catch(console.error);
