// 국회의원 재산공개(관보) → 단지 매핑
//
// 출처: 정보공개센터(opengirok)가 국회공보 정기재산공개 PDF를 정제한 구글시트.
//   - 데이터는 공직자윤리법상 공개 의무 정보(국회공보)이며, 자산 "소유" 신고 내역이다(거주지 아님).
// 매칭 정책(오매칭 금지 — CLAUDE.md):
//   1. 법정동 정확 일치
//   2. 단지명(정규화)이 재산공개 소재지 텍스트에 등장
//   3. 같은 법정동 후보 중 가장 긴 단지명 매칭 우선 (substring 오매칭 차단)
//   * 재산공개엔 좌표가 없어 좌표검증 대신 위 3중 게이트 사용.
// 채택 범위: 구분=국회의원, 재산종류=아파트, 관계=본인/배우자.

import * as XLSX from "xlsx";

// 연도별 정보공개센터 구글시트 ID (README 기준). 최신 정기공개 = 현 국회의원 거의 전체 포함.
const SHEETS: { year: number; id: string }[] = [
  { year: 2025, id: "182m4MFFj4Ho2cICo3PGy8RyxHZ3vwNklyo5yM4M5M4Q" },
];

const ROOT = `${import.meta.dir}/..`;
const CACHE_DIR = `${ROOT}/data`;

interface IdentityEntry {
  name: string;
  region: string;
  bjdong: string;
}
interface PoliticianRec {
  politician: string;
  position: string;
  relation: string;
  area: number | null;
  year: number;
}

// 단지명 정규화: 공백·특수문자 제거, 소문자, 표기 변이 흡수
function norm(s: string): string {
  return String(s || "")
    .replace(/\(.*?\)/g, "") // 분리단지 suffix "(석수동)" 등 제거
    .replace(/이편한세상/g, "e편한세상")
    .replace(/더샵/g, "더샵")
    .replace(/\s+/g, "")
    .replace(/아파트$/, "")
    .replace(/[·\-_,.]/g, "")
    .toLowerCase();
}

// 법정동 정규화 (숫자 가/동 통일은 하지 않음 — "금호동1가"는 그대로 키)
function normDong(s: string): string {
  return String(s || "").replace(/\s+/g, "").trim();
}

async function downloadSheet(id: string): Promise<XLSX.WorkBook> {
  const cache = `${CACHE_DIR}/_politician_${id}.xlsx`;
  if (!(await Bun.file(cache).exists())) {
    const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`시트 다운로드 실패 ${id}: ${res.status}`);
    await Bun.write(cache, await res.arrayBuffer());
  }
  return XLSX.readFile(cache);
}

// "서울특별시 강남구 대치동 은마아파트 건물 94.76㎡ 중33.17㎡" 류 파싱
function parseDesc(descRaw: string): { dong: string; aptText: string; area: number | null } | null {
  const desc = String(descRaw || "").replace(/\s+/g, " ").trim();
  // 면적: 첫 "숫자.숫자㎡" (지나치게 큰 토지면적/세대지분은 무시 — 첫 건물면적 채택)
  const areaMatches = [...desc.matchAll(/(\d{1,4}\.\d{1,2})\s*㎡/g)].map((m) => parseFloat(m[1]));
  const area = areaMatches.find((a) => a > 10 && a < 1000) ?? null;
  // 법정동: 시군구 뒤 첫 "XX동/가/읍/리"(뒤 숫자 허용). "건물" 이전까지에서 탐색.
  const head = desc.split(/건물|㎡/)[0];
  const tokens = head.split(" ").filter(Boolean);
  let dongIdx = -1;
  for (let k = 1; k < tokens.length; k++) {
    if (/[가-힣]+\d*(동|가|읍|리)$/.test(tokens[k])) dongIdx = k; // "금호동1가" 등 숫자 포함 법정동 허용
  }
  if (dongIdx < 0) return null;
  const dongTok = tokens[dongIdx];
  // 단지명 텍스트: 법정동 다음 ~ "건물"(또는 면적) 직전. 단지 구분 숫자(2단지/3차)는 보존.
  const afterDong = desc.slice(desc.indexOf(dongTok) + dongTok.length);
  let aptText = afterDong.includes("건물") ? afterDong.split("건물")[0] : afterDong.split("㎡")[0];
  aptText = aptText.replace(/\d+(\.\d+)?\s*$/, "").trim(); // 끝에 남은 면적 숫자만 제거
  return { dong: normDong(dongTok), aptText, area };
}

async function main() {
  const identity: IdentityEntry[] = await Bun.file(`${CACHE_DIR}/apt_identity.json`).json();
  // 법정동 → 후보 단지 (정규화 이름 길이 내림차순)
  const byDong = new Map<string, { name: string; nname: string }[]>();
  for (const e of identity) {
    const d = normDong(e.bjdong);
    if (!byDong.has(d)) byDong.set(d, []);
    byDong.get(d)!.push({ name: e.name, nname: norm(e.name) });
  }
  for (const list of byDong.values()) list.sort((a, b) => b.nname.length - a.nname.length);

  const result: Record<string, PoliticianRec[]> = {};
  let aptRows = 0,
    matched = 0;
  const unmatched: string[] = [];

  for (const { year, id } of SHEETS) {
    const wb = await downloadSheet(id);
    const ws = wb.Sheets["상세"];
    if (!ws) throw new Error(`상세 탭 없음 (${year})`);
    const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: "" });
    const H = rows[0].map((x: any) => String(x));
    const ci = (n: string) => H.indexOf(n);
    const cGroup = ci("구분"),
      cPos = ci("직위"),
      cName = ci("이름"),
      cRel = ci("본인과의 관계"),
      cKind = ci("재산의종류"),
      cDesc = ci("소재지 면적 등 권리의 명세");

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!String(r[cGroup]).includes("국회의원")) continue;
      if (!String(r[cKind]).includes("아파트")) continue;
      const rel = String(r[cRel]).trim();
      if (rel !== "본인" && rel !== "배우자") continue;
      aptRows++;
      const parsed = parseDesc(String(r[cDesc]));
      if (!parsed) {
        unmatched.push(String(r[cDesc]).replace(/\s+/g, " ").slice(0, 60));
        continue;
      }
      const cand = byDong.get(parsed.dong) || [];
      const descNorm = norm(parsed.aptText);
      let hit: { name: string; nname: string } | null = null;
      for (const c of cand) {
        if (c.nname.length < 2 || !descNorm) continue;
        // 정방향: 단지명이 재산공개에 등장 / 역방향: 재산공개 텍스트(≥4자, generic 방지)가 단지명에 등장
        if (descNorm.includes(c.nname) || (descNorm.length >= 4 && c.nname.includes(descNorm))) {
          hit = c;
          break; // 가장 긴 것부터 정렬됨
        }
      }
      if (!hit) {
        unmatched.push(`[${parsed.dong}|${parsed.aptText}] ${String(r[cDesc]).replace(/\s+/g, " ").slice(0, 45)}`);
        continue;
      }
      matched++;
      const rec: PoliticianRec = {
        politician: String(r[cName]).trim(),
        position: String(r[cPos]).replace(/\s+/g, " ").trim() || "국회의원",
        relation: rel,
        area: parsed.area,
        year,
      };
      if (!result[hit.name]) result[hit.name] = [];
      // 중복(동일 의원·관계·단지) 제거
      if (!result[hit.name].some((x) => x.politician === rec.politician && x.relation === rec.relation && x.year === rec.year)) {
        result[hit.name].push(rec);
      }
    }
  }

  // 단지별 정렬: 본인 우선
  for (const list of Object.values(result)) {
    list.sort((a, b) => (a.relation === "본인" ? -1 : 1) - (b.relation === "본인" ? -1 : 1));
  }

  const outPath = `${CACHE_DIR}/politician_residence.json`;
  await Bun.write(outPath, JSON.stringify(result, null, 2));

  const totalRecs = Object.values(result).reduce((s, l) => s + l.length, 0);
  console.log(`아파트행(본인/배우자): ${aptRows}`);
  console.log(`단지 매칭: ${matched}건 → 단지 ${Object.keys(result).length}곳, 레코드 ${totalRecs}`);
  console.log(`미매칭(지역外 포함): ${unmatched.length}`);
  console.log(`→ ${outPath}`);
  console.log(`\n=== 미매칭 샘플 30 (커버지역 추정 위주) ===`);
  unmatched
    .filter((u) => /서울|경기|수원|성남|용인|하남|화성|안양|의왕|과천/.test(u))
    .slice(0, 30)
    .forEach((u) => console.log("  ✗", u));
}

main();
