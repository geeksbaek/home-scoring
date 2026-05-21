/**
 * 건축물대장 API 수집 — 내진설계, 에너지효율등급.
 * apt_identity.json + kapt_info.json의 주소에서 번/지를 추출하여 조회.
 * bjd_code가 없는 단지도 sigungu_cd + bjdong 매핑으로 처리.
 *
 * Usage:
 *   bun src/building.ts
 *   bun src/building.ts --force   # 캐시 무시하고 전체 재수집
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");

const API_KEY = process.env.PUBLIC_DATA_API_KEY!;
const BASE = "https://apis.data.go.kr/1613000/BldRgstHubService";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function qs(params: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
}

async function apiGet<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 429) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        return null;
      }
      const json = await res.json() as any;
      if (json.response?.header?.resultCode !== "00") return null;
      return json.response.body;
    } catch (e) {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

// 주소에서 번/지 추출
function parseBunJi(addr: string): { bun: string; ji: string } | null {
  const m = addr.match(/(\d+)(?:-(\d+))?\s+\S/);
  if (!m) return null;
  return {
    bun: m[1].padStart(4, "0"),
    ji: (m[2] || "0").padStart(4, "0"),
  };
}

// bjd_code 없는 단지를 위한 bjdong 코드 매핑
// sigungu_cd:bjdong → bjdongCd (5자리)
// 건축물대장 API 브루트포스 검색으로 확인된 값
const BJDONG_FALLBACK: Record<string, string> = {
  "41135:판교동": "10800",
  "41133:성남동": "10100",
  "41131:양지동": "10600",
  "41111:영화동": "13400",
  "41463:지곡동": "10600",
  "41463:하갈동": "10400",
  "41461:마평동": "10200",
  "41450:감일동": "10600",
  "41461:포곡읍 영문리": "25021",
  "41461:이동읍 송전리": "25025",
  "41461:모현읍 일산리": "25928",
  "41461:남사읍 아곡리": "25922",
  "41461:원삼면 좌항리": "25922",
  "41461:양지읍 남곡리": "26222",
  "41461:백암면 근창리": "25922",
  "41591:남양읍 남양리": "31025",
  "41591:우정읍 조암리": "25026",
  "41595:안녕동": "10500",
  "41597:능동": "11000",
  "41591:남양읍 신남리": "25026",
  "41591:향남읍 하길리": "25026",
  "41591:향남읍 행정리": "25026",
  "41595:기산동": "10500",
  "41595:송산동": "10500",
  "41591:향남읍 장짐리": "25026",
  "41595:진안동": "10500",
  "41591:송산면 육일리": "25023",
  "41591:향남읍 상신리": "25023",
  "41591:새솔동": "10100",
  "41595:능동": "10300",
};

export interface BuildingData {
  name: string;
  earthquakeDesign: boolean | null;  // 내진설계 적용
  earthquakeCapacity: string | null; // 내진능력 (예: Ⅶ-0.169g)
  energyGrade: string | null;        // 에너지효율등급
  energyEpi: number | null;          // EPI 점수
  greenGrade: string | null;         // 친환경건축물등급
  vlRat: number | null;              // 용적률
  bcRat: number | null;              // 건폐율
  platArea: number | null;           // 대지면적 (㎡)
  hhldCnt: number | null;            // 세대수
  structure: string | null;          // 구조
  useAprDay: string | null;          // 사용승인일
  parking: number | null;            // 총 주차대수 (총괄표제부 totPkngCnt 우선, 표제부 합산 fallback)
}

interface IdentityEntry {
  name: string;
  sigungu_cd: string;
  bjdong: string;
  bjd_code: string | null;
  jibun: string;
}

export async function collectBuilding() {
  const forceMode = process.argv.includes("--force");
  console.log(`건축물대장 데이터 수집 시작${forceMode ? " (전체 재수집)" : ""}`);

  const identityPath = join(DATA_DIR, "apt_identity.json");
  if (!existsSync(identityPath)) {
    console.error("apt_identity.json이 없습니다.");
    return;
  }
  const identity: IdentityEntry[] = await Bun.file(identityPath).json();

  // bjd_code 있는 단지에서 bjdong 매핑 자동 생성
  const bjdongMap: Record<string, string> = { ...BJDONG_FALLBACK };
  for (const apt of identity) {
    if (apt.bjd_code && apt.sigungu_cd && apt.bjdong) {
      const key = `${apt.sigungu_cd}:${apt.bjdong}`;
      if (!bjdongMap[key]) {
        bjdongMap[key] = apt.bjd_code.slice(5, 10);
      }
    }
  }

  const kaptData: Record<string, any> = existsSync(join(DATA_DIR, "kapt_info.json"))
    ? await Bun.file(join(DATA_DIR, "kapt_info.json")).json()
    : {};
  const beecRaw: Record<string, any> = existsSync(join(DATA_DIR, "energy_grade_beec.json"))
    ? await Bun.file(join(DATA_DIR, "energy_grade_beec.json")).json()
    : {};
  // _source, _note 제외. 값이 string이면 등급, object이면 { grade, beec_name }
  const beecData: Record<string, string> = {};
  for (const [k, v] of Object.entries(beecRaw)) {
    if (k.startsWith("_") || !v) continue;
    if (typeof v === "string") beecData[k] = v;
    else if (typeof v === "object" && (v as any).grade) beecData[k] = (v as any).grade;
  }

  // 기존 데이터
  const outPath = join(DATA_DIR, "building_info.json");
  const result: Record<string, BuildingData> = existsSync(outPath)
    ? await Bun.file(outPath).json()
    : {};

  let idx = 0;
  let newCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (const apt of identity) {
    const { name, bjd_code, jibun, sigungu_cd, bjdong } = apt;
    idx++;
    process.stdout.write(`  [${idx}/${identity.length}] ${name}...`);

    // 캐시 (내진설계 데이터가 있으면 스킵)
    if (!forceMode && result[name] && result[name].earthquakeDesign !== null) {
      console.log(" (캐시)");
      skipCount++;
      continue;
    }

    // sigunguCd, bjdongCd 결정
    let sigunguCd: string;
    let bjdongCd: string;

    if (bjd_code) {
      sigunguCd = bjd_code.slice(0, 5);
      bjdongCd = bjd_code.slice(5, 10);
    } else {
      // bjd_code 없으면 매핑에서 조회
      const key = `${sigungu_cd}:${bjdong}`;
      const mappedCd = bjdongMap[key];
      if (!mappedCd) {
        console.log(` bjdong 코드 없음 (${key})`);
        failCount++;
        continue;
      }
      sigunguCd = sigungu_cd;
      bjdongCd = mappedCd;
    }

    // 번/지: K-apt 주소에서 추출 → 실패 시 실거래가 지번 사용
    const kapt = kaptData[name];
    let parsed = kapt?.addr ? parseBunJi(kapt.addr) : null;
    if (!parsed && jibun) {
      const parts = jibun.split("-");
      parsed = { bun: parts[0].padStart(4, "0"), ji: (parts[1] || "0").padStart(4, "0") };
    }
    if (!parsed) {
      console.log(" 번/지 없음");
      failCount++;
      continue;
    }

    // 표제부 조회 (내진설계)
    async function queryTitle(bun: string, ji: string) {
      const body = await apiGet<any>(
        `${BASE}/getBrTitleInfo?${qs({
          serviceKey: API_KEY, sigunguCd, bjdongCd,
          bun, ji, numOfRows: 100, pageNo: 1, _type: "json",
        })}`
      );
      const items = body?.items?.item;
      return Array.isArray(items) ? items : items ? [items] : [];
    }

    let titles = await queryTitle(parsed.bun, parsed.ji);
    await sleep(150);

    // K-apt 주소로 못 찾으면 실거래가 지번으로 재시도
    if (titles.length === 0 && jibun) {
      const parts = jibun.split("-");
      const fallback = { bun: parts[0].padStart(4, "0"), ji: (parts[1] || "0").padStart(4, "0") };
      if (fallback.bun !== parsed.bun || fallback.ji !== parsed.ji) {
        titles = await queryTitle(fallback.bun, fallback.ji);
        await sleep(150);
      }
    }

    let eqDesign: boolean | null = null;
    let eqCap: string | null = null;
    let structure: string | null = null;
    let useAprDay: string | null = null;

    if (titles.length > 0) {
      eqDesign = titles.some((t: any) => t.rserthqkDsgnApplyYn === "1" || t.rserthqkDsgnApplyYn === "Y");
      const withCap = titles.find((t: any) => t.rserthqkAblty?.trim());
      eqCap = withCap?.rserthqkAblty?.trim() || null;
      structure = titles[0].strctCdNm?.trim() || null;
      useAprDay = titles[0].useAprDay?.trim() || null;
    }

    // 총괄표제부 조회 (에너지등급)
    async function queryRecap(bun: string, ji: string) {
      const body = await apiGet<any>(
        `${BASE}/getBrRecapTitleInfo?${qs({
          serviceKey: API_KEY, sigunguCd, bjdongCd,
          bun, ji, numOfRows: 10, pageNo: 1, _type: "json",
        })}`
      );
      const items = body?.items?.item;
      return Array.isArray(items) ? items[0] : items;
    }

    let recap = await queryRecap(parsed.bun, parsed.ji);
    await sleep(150);

    if (!recap && jibun) {
      const parts = jibun.split("-");
      const fallback = { bun: parts[0].padStart(4, "0"), ji: (parts[1] || "0").padStart(4, "0") };
      if (fallback.bun !== parsed.bun || fallback.ji !== parsed.ji) {
        recap = await queryRecap(fallback.bun, fallback.ji);
        await sleep(150);
      }
    }

    // 건축물대장에 없으면 BEEC 데이터 사용
    let energyGrade = recap?.engrGrade?.trim() || null;
    if (!energyGrade && beecData[name]) {
      energyGrade = beecData[name];
    }

    // 총괄표제부에 platArea/hhldCnt 없으면 표제부에서 fallback
    // 표제부의 hhldCnt는 동별이라 합산 필요. 공동주택 동만 합산.
    let platArea: number | null = recap?.platArea ? parseFloat(recap.platArea) : null;
    let hhldCnt: number | null = recap?.hhldCnt ? parseInt(recap.hhldCnt) : null;
    if (platArea == null && titles.length > 0) {
      const t = titles.find((x: any) => x.platArea && parseFloat(x.platArea) > 0);
      if (t) platArea = parseFloat(t.platArea);
    }
    if (hhldCnt == null && titles.length > 0) {
      const apartmentTitles = titles.filter((t: any) =>
        (t.mainPurpsCdNm || "").includes("공동주택") || (t.bldNm || "").length > 0
      );
      const sum = apartmentTitles.reduce((s: number, t: any) => s + (parseInt(t.hhldCnt) || 0), 0);
      if (sum > 0) hhldCnt = sum;
    }

    // vlRat/bcRat: 총괄표제부에 없으면 표제부에서 fallback (단지 평균)
    let vlRat: number | null = recap?.vlRat ? parseFloat(recap.vlRat) : null;
    let bcRat: number | null = recap?.bcRat ? parseFloat(recap.bcRat) : null;
    if (vlRat == null && titles.length > 0) {
      const vs = titles.map((t: any) => parseFloat(t.vlRat)).filter((v: number) => v > 0);
      if (vs.length > 0) vlRat = Math.round((vs.reduce((a: number, b: number) => a + b, 0) / vs.length) * 100) / 100;
    }
    if (bcRat == null && titles.length > 0) {
      const bs = titles.map((t: any) => parseFloat(t.bcRat)).filter((v: number) => v > 0);
      if (bs.length > 0) bcRat = Math.round((bs.reduce((a: number, b: number) => a + b, 0) / bs.length) * 100) / 100;
    }

    // 주차대수: 총괄표제부 totPkngCnt 우선 (단지 전체 합계, 부속동·상가 포함)
    // 없으면 4필드 합 (indrAuto + oudrAuto + indrMech + oudrMech)
    // 없으면 표제부 전 동 합산
    const sumPark = (x: any) =>
      (parseInt(x?.indrAutoUtcnt) || 0) +
      (parseInt(x?.oudrAutoUtcnt) || 0) +
      (parseInt(x?.indrMechUtcnt) || 0) +
      (parseInt(x?.oudrMechUtcnt) || 0);
    let parking: number | null = null;
    if (recap) {
      const tot = parseInt(recap.totPkngCnt) || 0;
      const sum = sumPark(recap);
      parking = Math.max(tot, sum) || null;
    }
    if (!parking && titles.length > 0) {
      const sum = titles.reduce((s: number, t: any) => s + sumPark(t), 0);
      if (sum > 0) parking = sum;
    }

    result[name] = {
      name,
      earthquakeDesign: eqDesign,
      earthquakeCapacity: eqCap,
      energyGrade,
      energyEpi: recap?.engrEpi || null,
      greenGrade: recap?.gnBldGrade?.trim() || null,
      vlRat,
      bcRat,
      platArea,
      hhldCnt,
      structure,
      useAprDay,
      parking,
    };

    const eq = eqDesign === true ? "Y" : eqDesign === false ? "N" : "?";
    const eg = recap?.engrGrade?.trim() || "-";
    console.log(` 내진:${eq}${eqCap ? "(" + eqCap + ")" : ""} 에너지:${eg}`);
    newCount++;

    // 매 건 저장 (크래시 대비)
    await Bun.write(outPath, JSON.stringify(result, null, 2));
  }

  const withEq = Object.values(result).filter(r => r.earthquakeDesign === true).length;
  const withoutEq = Object.values(result).filter(r => r.earthquakeDesign === false).length;
  const nullEq = Object.values(result).filter(r => r.earthquakeDesign === null).length;
  const withEnergy = Object.values(result).filter(r => r.energyGrade).length;
  console.log(`\n저장: ${outPath} (${Object.keys(result).length}개)`);
  console.log(`  신규: ${newCount} | 캐시: ${skipCount} | 실패: ${failCount}`);
  console.log(`  내진설계 적용: ${withEq}개 | 미적용: ${withoutEq}개 | 데이터없음: ${nullEq}개`);
  console.log(`  에너지등급: ${withEnergy}개`);
}

if (import.meta.main) {
  collectBuilding();
}
