/**
 * 학교알리미 SHL_IDF_CD 수집 — 학교명 → 학교ID 매핑.
 * 학교알리미 deep link 생성용.
 *
 * Usage: bun src/collect_school_ids.ts
 */
import { join } from "node:path";

const DATA_DIR = join(import.meta.dir, "..", "data");
const BASE = "https://www.schoolinfo.go.kr";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REGIONS: [string, string, string][] = [
  // 서울특별시 25개 구
  ["1100000000", "1111000000", "서울 종로구"],
  ["1100000000", "1114000000", "서울 중구"],
  ["1100000000", "1117000000", "서울 용산구"],
  ["1100000000", "1120000000", "서울 성동구"],
  ["1100000000", "1121500000", "서울 광진구"],
  ["1100000000", "1123000000", "서울 동대문구"],
  ["1100000000", "1126000000", "서울 중랑구"],
  ["1100000000", "1129000000", "서울 성북구"],
  ["1100000000", "1130500000", "서울 강북구"],
  ["1100000000", "1132000000", "서울 도봉구"],
  ["1100000000", "1135000000", "서울 노원구"],
  ["1100000000", "1138000000", "서울 은평구"],
  ["1100000000", "1141000000", "서울 서대문구"],
  ["1100000000", "1144000000", "서울 마포구"],
  ["1100000000", "1147000000", "서울 양천구"],
  ["1100000000", "1150000000", "서울 강서구"],
  ["1100000000", "1153000000", "서울 구로구"],
  ["1100000000", "1154500000", "서울 금천구"],
  ["1100000000", "1156000000", "서울 영등포구"],
  ["1100000000", "1159000000", "서울 동작구"],
  ["1100000000", "1162000000", "서울 관악구"],
  ["1100000000", "1165000000", "서울 서초구"],
  ["1100000000", "1168000000", "서울 강남구"],
  ["1100000000", "1171000000", "서울 송파구"],
  ["1100000000", "1174000000", "서울 강동구"],
  // 경기도
  ["4100000000", "4111700000", "수원시 영통구"],
  ["4100000000", "4111300000", "수원시 권선구"],
  ["4100000000", "4111100000", "수원시 장안구"],
  ["4100000000", "4111500000", "수원시 팔달구"],
  ["4100000000", "4113100000", "성남시 수정구"],
  ["4100000000", "4113300000", "성남시 중원구"],
  ["4100000000", "4113500000", "성남시 분당구"],
  ["4100000000", "4117100000", "안양시 만안구"],
  ["4100000000", "4117300000", "안양시 동안구"],
  ["4100000000", "4146100000", "용인시 처인구"],
  ["4100000000", "4146300000", "용인시 기흥구"],
  ["4100000000", "4146500000", "용인시 수지구"],
  ["4100000000", "4145000000", "하남시"],
  ["4100000000", "4143000000", "의왕시"],
  ["4100000000", "4129000000", "과천시"],
  ["4100000000", "4159700000", "화성시 동탄구"],
  ["4100000000", "4159500000", "화성시 병점구"],
  ["4100000000", "4159100000", "화성시 만세구"],
  ["4100000000", "4159300000", "화성시 효행구"],
];

// collect_violence.ts의 MANUAL_SCHOOLS와 동일 (지역 검색 누락분)
const MANUAL_SCHOOLS: Record<string, string> = {
  "석우초등학교": "50967d49-fee3-45c9-8d0d-131fe11b9286",
  "동탄초등학교": "721d86b4-81b8-4588-a183-f1383d41e2e2",
  "학동초등학교": "224cba6c-1246-4657-8031-6fe161a2ca7c",
  "화성반월초등학교": "a03d1971-bef6-4c6f-bb99-00c533d9a407",
  "반송초등학교": "41d4cf2c-75b2-4c0b-b60d-90917c25a9c9",
  "화남초등학교": "78f08dc1-1c68-4d44-ad76-d4005cbe0651",
};

let SESSION = "";

async function initSession() {
  const res = await fetch(`${BASE}/ei/ss/pneiss_a05_s0.do`, { redirect: "manual" });
  const cookies = res.headers.getSetCookie?.() || [];
  for (const c of cookies) {
    if (c.includes("JSESSIONID")) SESSION = c.split(";")[0];
  }
  for (const c of cookies) {
    if (c.includes("WMONID")) SESSION = c.split(";")[0] + "; " + SESSION;
  }
}

async function getSchoolList(sidoCode: string, sggCode: string, year: string) {
  const url = `${BASE}/ei/ss/pneiss_a05_s0/selectSchoolListLocation.do`;
  const body = new URLSearchParams({
    HG_JONGRYU_GB: "02",
    SIDO_CODE: sidoCode,
    SIGUNGU_CODE: sggCode,
    SULRIP_GB: "1",
    GS_HANGMOK_CD: "69",
    PNF_YR: year,
    JG_HANGMOK_CD: "97",
  });
  body.append("SULRIP_GB", "2");
  body.append("SULRIP_GB", "3");
  const res = await fetch(url, {
    method: "POST",
    headers: { Cookie: SESSION, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
    body: body.toString(),
  });
  const json = (await res.json()) as { schoolList?: { SHL_NM: string; SHL_IDF_CD: string }[] };
  return (json.schoolList || []).map((s) => ({ name: s.SHL_NM, id: s.SHL_IDF_CD }));
}

async function main() {
  await initSession();

  const ids: Record<string, string> = { ...MANUAL_SCHOOLS };

  for (const [sido, sgg, label] of REGIONS) {
    const list = await getSchoolList(sido, sgg, "2026");
    let added = 0;
    for (const s of list) {
      if (!ids[s.name]) { ids[s.name] = s.id; added++; }
    }
    console.log(`  ${label}: ${list.length}개 (신규 ${added})`);
    await sleep(100);
  }

  await Bun.write(join(DATA_DIR, "school_ids.json"), JSON.stringify(ids, null, 2));
  console.log(`\n저장: school_ids.json (${Object.keys(ids).length}개)`);

  // school_map에 있는 학교 중 ID 누락 확인
  const sm = await Bun.file(join(DATA_DIR, "school_map.json")).json() as Record<string, string[]>;
  const allSchools = new Set<string>();
  for (const arr of Object.values(sm)) for (const s of arr) allSchools.add(s);
  const missing = [...allSchools].filter((s) => !ids[s]);
  if (missing.length > 0) {
    console.log(`\nschool_map에 있으나 ID 미확인: ${missing.length}개`);
    for (const s of missing.slice(0, 20)) console.log(`  ${s}`);
  } else {
    console.log("\n✓ 모든 배정학교 ID 확인됨");
  }
}

main().catch(console.error);
