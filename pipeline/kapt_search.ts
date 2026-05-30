/**
 * K-apt 웹사이트에서 아파트 코드(kaptCode) 일괄 검색.
 * apt_identity.json에서 kapt_code가 없는 아파트를 찾아 매칭.
 *
 * Usage:
 *   bun src/kapt_search.ts
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const KAPT_URL = "https://www.k-apt.go.kr";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 세션 + CSRF 토큰 취득 ─────────────────────────────

let SESSION_COOKIE = "";
let CSRF_TOKEN = "";

async function initSession() {
  const res = await fetch(`${KAPT_URL}/web/main/index.do`);
  const cookies = res.headers.getSetCookie?.() || [];
  SESSION_COOKIE = cookies.map((c) => c.split(";")[0]).join("; ");
  const html = await res.text();
  const m = html.match(/name="_csrf"\s+content="([^"]+)"/);
  CSRF_TOKEN = m?.[1] ?? "";
  console.log(`세션: ${SESSION_COOKIE.substring(0, 40)}...`);
  console.log(`CSRF: ${CSRF_TOKEN.substring(0, 8)}...`);
}

// ── K-apt 검색 ────────────────────────────────────────

interface KaptResult {
  code: string;
  name: string;
  addr: string;
  bjd: string;
}

async function searchKapt(keyword: string): Promise<KaptResult[]> {
  const res = await fetch(`${KAPT_URL}/cmmn/getMinViewAptInfo.do`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-TOKEN": CSRF_TOKEN,
      "X-Requested-With": "XMLHttpRequest",
      Cookie: SESSION_COOKIE,
      Referer: `${KAPT_URL}/web/main/index.do`,
    },
    body: `keyword=${encodeURIComponent(keyword)}`,
  });
  const text = await res.text();
  const codes = [...text.matchAll(/<kaptCode>([^<]+)<\/kaptCode>/g)].map((m) => m[1]);
  const names = [...text.matchAll(/<kaptName>([^<]+)<\/kaptName>/g)].map((m) => m[1]);
  const addrs = [...text.matchAll(/<addr>([^<]+)<\/addr>/g)].map((m) => m[1].trim());
  const bjds = [...text.matchAll(/<bjdCode>([^<]+)<\/bjdCode>/g)].map((m) => m[1]);
  return codes.map((c, i) => ({ code: c, name: names[i], addr: addrs[i], bjd: bjds[i] }));
}

// ── 이름 변형 생성 ────────────────────────────────────

function generateVariations(name: string): string[] {
  const vars: string[] = [];

  const brands = [
    "힐스테이트", "래미안", "자이", "푸르지오", "롯데캐슬", "아이파크",
    "e편한세상", "더샵", "SK", "LG", "호반", "두산", "한양수자인",
    "센트럴", "한화", "금호", "대림", "현대", "우방", "동문", "삼성",
    "대우", "쌍용", "신도", "위브", "꿈에그린", "벽산", "풍림", "극동",
    "동부", "신일", "한신", "삼부", "반도", "유보라", "디이스트", "포레",
    "스위첸", "캐슬", "파크", "블루밍", "노블", "레이크", "뉴타운",
    "STX", "KCC", "나우빌", "그린뷰", "스타힐스", "스카이뷰", "SKVIEW",
    "프르지오", "아너스빌", "리버파크", "비발디", "센트레빌", "모아엘가",
    "동원로얄듀크", "에듀하이", "대방디엠시티", "서해그랑블", "노빌리티",
  ];

  // 브랜드명 앞뒤 공백
  for (const b of brands) {
    if (name.includes(b)) {
      const idx = name.indexOf(b);
      if (idx > 0) vars.push(name.slice(0, idx) + " " + name.slice(idx));
      if (idx + b.length < name.length) vars.push(name.slice(0, idx + b.length) + " " + name.slice(idx + b.length));
      // 양쪽 다
      if (idx > 0 && idx + b.length < name.length) {
        vars.push(name.slice(0, idx) + " " + b + " " + name.slice(idx + b.length));
      }
    }
  }

  // 숫자 앞에 공백
  vars.push(name.replace(/([가-힣])(\d)/g, "$1 $2"));
  // "마을" "단지" "차" 앞뒤 공백
  vars.push(name.replace(/(마을|단지|블럭|블록)/g, " $1 ").replace(/\s+/g, " ").trim());

  // "XX마을YY" → "YY" (마을 이름 제거)
  if (name.includes("마을")) {
    const afterMaeul = name.replace(/^.*?마을/, "");
    if (afterMaeul.length >= 2) vars.push(afterMaeul);
  }

  // 법정동 + 이름
  // (caller handles this via 3차 검색)

  // "아파트" 추가
  if (!name.includes("아파트")) vars.push(name + "아파트");
  // 공백 전부 제거한 버전
  if (name.includes(" ")) vars.push(name.replace(/\s/g, ""));
  // 괄호 제거
  if (name.includes("(")) vars.push(name.replace(/\([^)]*\)/g, "").trim());

  return [...new Set(vars)].filter((v) => v !== name && v.length >= 2);
}

// ── 지역 매칭 ─────────────────────────────────────────

const SIGUNGU_ADDR: Record<string, string> = {
  // 서울 25개 구
  "11110": "서울종로구",
  "11140": "서울중구",
  "11170": "서울용산구",
  "11200": "서울성동구",
  "11215": "서울광진구",
  "11230": "서울동대문구",
  "11260": "서울중랑구",
  "11290": "서울성북구",
  "11305": "서울강북구",
  "11320": "서울도봉구",
  "11350": "서울노원구",
  "11380": "서울은평구",
  "11410": "서울서대문구",
  "11440": "서울마포구",
  "11470": "서울양천구",
  "11500": "서울강서구",
  "11530": "서울구로구",
  "11545": "서울금천구",
  "11560": "서울영등포구",
  "11590": "서울동작구",
  "11620": "서울관악구",
  "11650": "서울서초구",
  "11680": "서울강남구",
  "11710": "서울송파구",
  "11740": "서울강동구",
  // 경기
  "41111": "수원장안구",
  "41113": "수원권선구",
  "41115": "수원팔달구",
  "41117": "수원영통구",
  "41131": "성남수정구",
  "41133": "성남중원구",
  "41135": "성남분당구",
  "41171": "안양만안구",
  "41173": "안양동안구",
  "41450": "하남시",
  "41461": "용인처인구",
  "41463": "용인기흥구",
  "41465": "용인수지구",
  "41591": "화성시", // 만세구
  "41595": "화성시", // 병점구
  "41597": "화성시", // 동탄구
};

function matchesRegion(addr: string, sigunguCd: string): boolean {
  const expected = SIGUNGU_ADDR[sigunguCd];
  if (!expected) return false;
  return addr.includes(expected);
}

/**
 * 후보 중 최적 매칭 선택. 시군구(구) 단위만으로는 동명/동일구 다른 단지를 잘못 고를 수 있으므로
 * (과거 광교2차E편한세상→매탄동 e편한세상 오매칭), 같은 구 내에서 법정동+지번 일치를 우선한다.
 *  1) 주소에 법정동 + 동일 지번  2) 주소에 법정동  3) 시군구만 일치(약함, fallback)
 */
function pickMatch(results: KaptResult[], entry: any): KaptResult | undefined {
  const inRegion = results.filter((r) => matchesRegion(r.addr, entry.sigungu_cd));
  if (inRegion.length === 0) return undefined;
  const bjdong = (entry.bjdong || "").trim();
  const jibun = String(entry.jibun || "").replace(/\r/g, "").trim();
  if (bjdong && jibun) {
    const re = new RegExp(`(?<!\\d)${jibun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`);
    const exact = inRegion.find((r) => r.addr.includes(bjdong) && re.test(r.addr));
    if (exact) return exact;
  }
  if (bjdong) {
    const byDong = inRegion.find((r) => r.addr.includes(bjdong));
    if (byDong) return byDong;
  }
  return inRegion[0]; // 약한 fallback (구만 일치) — 단일 후보일 때만 사실상 안전
}

// ── 메인 ──────────────────────────────────────────────

async function main() {
  const identityPath = join(DATA_DIR, "apt_identity.json");
  const identity: any[] = await Bun.file(identityPath).json();

  const targets = identity.filter((e) => !e.kapt_code && e.sigungu_cd);
  console.log(`대상: ${targets.length}개 아파트 (kapt_code 없음)\n`);

  await initSession();
  console.log("");

  let matched = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const entry = targets[i];
    const name = entry.name;
    const sigungu = entry.sigungu_cd;
    process.stdout.write(`[${i + 1}/${targets.length}] ${name}...`);

    // 1차: 원본 이름으로 검색
    let results = await searchKapt(name);
    let match = pickMatch(results, entry);

    // 2차: 변형 이름으로 검색
    if (!match) {
      const variations = generateVariations(name);
      for (const v of variations) {
        await sleep(80);
        results = await searchKapt(v);
        match = pickMatch(results, entry);
        if (match) break;
      }
    }

    // 3차: 법정동 + 이름 / 법정동 + 짧은 이름
    if (!match && entry.bjdong) {
      await sleep(80);
      results = await searchKapt(entry.bjdong + " " + name);
      match = pickMatch(results, entry);
      if (!match) {
        await sleep(80);
        const shortName = name.replace(/\d+단지$|\d+차$/, "").slice(0, 8);
        results = await searchKapt(entry.bjdong + " " + shortName);
        match = pickMatch(results, entry);
      }
    }

    // 4차: 마을이름 빼고 법정동 + 브랜드
    if (!match && name.includes("마을") && entry.bjdong) {
      const brand = name.replace(/^.*?마을/, "").replace(/아파트$/, "");
      if (brand.length >= 2) {
        await sleep(80);
        results = await searchKapt(entry.bjdong + " " + brand);
        match = pickMatch(results, entry);
      }
    }

    if (match) {
      entry.kapt_code = match.code;
      entry.kapt_name = match.name;
      entry.bjd_code = match.bjd || entry.bjd_code;
      matched++;
      console.log(` ✓ ${match.code} (${match.name})`);
    } else {
      failed++;
      console.log(" ✗");
    }

    await sleep(100);

    // 50건마다 중간 저장
    if ((i + 1) % 50 === 0) {
      await Bun.write(identityPath, JSON.stringify(identity, null, 2));
      console.log(`  --- 중간 저장 (${matched}/${i + 1}) ---`);
    }
  }

  // 최종 저장
  await Bun.write(identityPath, JSON.stringify(identity, null, 2));
  console.log(`\n매칭: ${matched}개 성공, ${failed}개 실패`);
  console.log(`전체 kapt_code 보유: ${identity.filter((e) => e.kapt_code).length}/${identity.length}`);
}

main().catch(console.error);
