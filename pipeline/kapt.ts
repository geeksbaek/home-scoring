/**
 * K-apt (공동주택관리정보시스템) 데이터 수집.
 *
 * Usage:
 *   bun src/kapt.ts
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");

const API_KEY = process.env.PUBLIC_DATA_API_KEY!;
const BASE = "https://apis.data.go.kr/1613000";

// 시군구 코드 (fetchAllApts에서 사용하지 않지만 참조용으로 보존)
// "41111"~"41117" 수원시, "41131"~"41135" 성남시, "41461"~"41465" 용인시
// "41450" 하남시, "41591"/"41595"/"41597" 화성시

// ── API 헬퍼 ──────────────────────────────────────────

async function apiGet<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  ✗ ${res.status} ${url.split("?")[0].split("/").pop()}`);
    return null;
  }
  const json = await res.json() as any;
  if (json.response?.header?.resultCode !== "00") {
    console.error(`  ✗ ${json.response?.header?.resultMsg}`);
    return null;
  }
  return json.response.body;
}

function qs(params: Record<string, string | number>): string {
  return new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 기본정보 + 상세정보 수집 ─────────────────────────

interface KaptBasicInfo {
  kaptCode: string;
  kaptName: string;
  kaptAddr: string;
  doroJuso: string;
  bjdCode: string;
  kaptUsedate: string;     // 사용승인일
  kaptdaCnt: number;       // 세대수
  kaptDongCnt: string;     // 동수
  kaptTopFloor: number;    // 최고층
  codeSaleNm: string;      // 분양구분
  codeHeatNm: string;      // 난방방식
  kaptMparea60: number;    // 60㎡이하 세대수
  kaptMparea85: number;    // 85㎡이하 세대수
  kaptMparea135: number;   // 135㎡이하 세대수
}

interface KaptDetailInfo {
  kaptCode: string;
  kaptdPcntu: string;      // 총 주차대수
  kaptdEcnt: number;       // 승강기 수
  kaptdCccnt: string;      // CCTV 수
  codeStr: string;         // 구조
  subwayLine: string | null;
  subwayStation: string | null;
  educationFacility: string | null;
  welfareFacility: string | null;
}

async function fetchBasicInfo(kaptCode: string): Promise<KaptBasicInfo | null> {
  const body = await apiGet<any>(
    `${BASE}/AptBasisInfoServiceV4/getAphusBassInfoV4?${qs({
      serviceKey: API_KEY,
      kaptCode,
    })}`
  );
  return body?.item ?? null;
}

async function fetchDetailInfo(kaptCode: string): Promise<KaptDetailInfo | null> {
  const body = await apiGet<any>(
    `${BASE}/AptBasisInfoServiceV4/getAphusDtlInfoV4?${qs({
      serviceKey: API_KEY,
      kaptCode,
    })}`
  );
  return body?.item ?? null;
}

// ── 3. 장기수선충당금 ────────────────────────────────

async function fetchRepairFund(kaptCode: string, ym: string): Promise<number | null> {
  const body = await apiGet<any>(
    `${BASE}/AptRepairsCostServiceV2/getHsmpReserveBalanceInfoV2?${qs({
      serviceKey: API_KEY,
      kaptCode,
      searchDate: ym,
    })}`
  );
  return body?.item?.sTot ?? null;
}

// ── 4. 에너지 사용량 ─────────────────────────────────

interface EnergyInfo {
  heat: number;     // 난방 (Mcal)
  waterHot: number; // 급탕 (Mcal)
  elect: number;    // 전기 (kWh)
  waterCool: number; // 수도 (톤)
  gas: number;      // 가스 (m3)
}

async function fetchEnergy(kaptCode: string, ym: string): Promise<EnergyInfo | null> {
  const body = await apiGet<any>(
    `${BASE}/ApHusEnergyUseInfoOfferServiceV2/getHsmpApHusUsgQtyInfoSearchV2?${qs({
      serviceKey: API_KEY,
      kaptCode,
      reqDate: ym,
    })}`
  );
  if (!body?.item) return null;
  const i = body.item;
  return {
    heat: i.heat ?? 0,
    waterHot: i.waterHot ?? 0,
    elect: i.elect ?? 0,
    waterCool: i.waterCool ?? 0,
    gas: i.gas ?? 0,
  };
}

// ── 메인 ──────────────────────────────────────────────

export interface KaptData {
  kaptCode: string;
  name: string;
  bjdCode: string;
  addr: string;
  doroJuso: string;
  useDate: string;
  households: number;
  dongCount: number;
  topFloor: number;
  heatType: string;
  structure: string;
  parkingTotal: number;
  parkingPerHh: number;
  elevatorCount: number;
  cctvCount: number;
  subwayLine: string | null;
  subwayStation: string | null;
  education: string | null;
  repairFund: number | null;
  energy: EnergyInfo | null;
}

async function loadJson<T>(name: string, fallback: T): Promise<T> {
  const path = join(DATA_DIR, name);
  if (!existsSync(path)) return fallback;
  return Bun.file(path).json();
}

export async function collectKapt() {
  console.log("K-apt 데이터 수집 시작");

  // apt_identity.json에서 kapt_code 조회
  const identityPath = join(DATA_DIR, "apt_identity.json");
  if (!existsSync(identityPath)) {
    console.error("apt_identity.json이 없습니다. 먼저 bun src/identity.ts를 실행하세요.");
    return;
  }
  const identity: { name: string; kapt_code: string | null }[] = await Bun.file(identityPath).json();
  const targets = identity.filter((d) => d.kapt_code);
  console.log(`  대상: ${targets.length}개 (identity 기준)`);

  // 기존 데이터 로드
  const existing = await loadJson<Record<string, KaptData>>("kapt_info.json", {});

  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth()).padStart(2, "0")}`;

  const result: Record<string, KaptData> = {};
  let idx = 0;

  for (const { name, kapt_code } of targets) {
    idx++;
    const kaptCode = kapt_code!;
    process.stdout.write(`  [${idx}/${targets.length}] ${name}...`);

    // 캐시
    if (existing[name] && existing[name].parkingTotal > 0) {
      result[name] = existing[name];
      console.log(" (캐시)");
      continue;
    }

    const basic = await fetchBasicInfo(kaptCode);
    await sleep(100);
    const detail = await fetchDetailInfo(kaptCode);
    await sleep(100);
    const fund = await fetchRepairFund(kaptCode, ym);
    await sleep(100);
    const energy = await fetchEnergy(kaptCode, ym);
    await sleep(100);

    if (!basic) {
      console.log(" ✗ 기본정보 없음");
      continue;
    }

    const households = basic.kaptdaCnt || 0;
    const parkU = parseInt(detail?.kaptdPcntu || "0") || 0; // 자주식
    const parkM = parseInt(detail?.kaptdPcnt || "0") || 0;  // 기계식
    const parking = parkU + parkM;

    result[name] = {
      kaptCode: kaptCode,
      name,
      bjdCode: basic.bjdCode || "",
      addr: basic.kaptAddr || "",
      doroJuso: basic.doroJuso || "",
      useDate: basic.kaptUsedate || "",
      households,
      dongCount: parseInt(basic.kaptDongCnt || "0") || 0,
      topFloor: basic.kaptTopFloor || 0,
      heatType: basic.codeHeatNm || "",
      structure: detail?.codeStr || "",
      parkingTotal: parking,
      parkingPerHh: households > 0 ? Math.round((parking / households) * 100) / 100 : 0,
      elevatorCount: detail?.kaptdEcnt || 0,
      cctvCount: parseInt(detail?.kaptdCccnt || "0") || 0,
      subwayLine: detail?.subwayLine || null,
      subwayStation: detail?.subwayStation || null,
      education: detail?.educationFacility || null,
      repairFund: fund,
      energy,
    };

    console.log(` ✓ 주차${parking} 승강기${detail?.kaptdEcnt || 0}`);
  }

  // 저장
  const outPath = join(DATA_DIR, "kapt_info.json");
  await Bun.write(outPath, JSON.stringify(result, null, 2));
  console.log(`\n저장: ${outPath} (${Object.keys(result).length}개)`);
}

if (import.meta.main) {
  collectKapt();
}
