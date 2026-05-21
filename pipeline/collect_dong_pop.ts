/**
 * 행안부 행정동별 성/연령 인구 수집.
 * - 우리 단지가 속한 시군구별로 한 번 호출 → 모든 행정동 응답
 * - dongNm 으로 우리 단지 bjdong과 매칭
 * - 가족 비중 추정 지표 산출: 0~9세 비율, 30대 비율
 *
 * Usage: bun src/collect_dong_pop.ts
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const KEY = process.env.PUBLIC_DATA_API_KEY ?? Bun.env.PUBLIC_DATA_API_KEY;
if (!KEY) {
  // .env 직접 로드 (bun --env-file 미사용 시)
  const env = await Bun.file(join(ROOT, ".env")).text();
  for (const line of env.split("\n")) {
    if (line.startsWith("PUBLIC_DATA_API_KEY")) {
      const v = line.split("=", 2)[1].trim().replace(/^['"]|['"]$/g, "");
      (process.env as any).PUBLIC_DATA_API_KEY = v;
    }
  }
}
const apiKey = process.env.PUBLIC_DATA_API_KEY!;

const ENDPOINT = "https://apis.data.go.kr/1741000/admmSexdAgePpltn/selectAdmmSexdAgePpltn";

interface Item {
  ctpvNm: string;
  sggNm: string;
  dongNm: string;
  admmCd: string;
  totNmprCnt: string;
  // 0~100세 남/녀
  [k: string]: string;
}

async function fetchSigungu(sigunguCd: string, ym: string): Promise<Item[]> {
  const out: Item[] = [];
  let page = 1;
  while (true) {
    const url = ENDPOINT + "?" + new URLSearchParams({
      serviceKey: apiKey,
      type: "json",
      numOfRows: "100",
      pageNo: String(page),
      srchFrYm: ym,
      srchToYm: ym,
      lv: "3",
      regSeCd: "1",
      admmCd: sigunguCd,
    });
    const res = await fetch(url);
    const body = await res.text();
    if (!body.startsWith("{")) {
      console.error(`  ${sigunguCd} page=${page} non-JSON:`, body.slice(0, 200));
      break;
    }
    const j = JSON.parse(body);
    const head = j.Response?.head;
    if (head?.resultCode !== "0") {
      console.error(`  ${sigunguCd} ${head?.resultCode}: ${head?.resultMsg}`);
      break;
    }
    const items = j.Response.items?.item ?? [];
    const arr = Array.isArray(items) ? items : [items];
    out.push(...arr);
    const total = parseInt(head.totalCount);
    if (page * 100 >= total) break;
    page++;
  }
  return out;
}

function ratioFamilyMetrics(it: Item) {
  const tot = parseInt(it.totNmprCnt) || 0;
  if (tot === 0) return { tot, age0_9_rate: 0, age30s_rate: 0, age0_9: 0, age30s: 0 };
  const age0_9 = parseInt(it.male0AgeNmprCnt) + parseInt(it.feml0AgeNmprCnt);
  const age30s = parseInt(it.male30AgeNmprCnt) + parseInt(it.feml30AgeNmprCnt);
  return {
    tot,
    age0_9,
    age30s,
    age0_9_rate: Math.round((age0_9 / tot) * 1000) / 10,  // %, 1자리
    age30s_rate: Math.round((age30s / tot) * 1000) / 10,
  };
}

async function main() {
  const identity: any[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  // 시군구별 대표 법정동 코드 (10자리) — admmCd는 5자리 시군구 추출에 사용
  const sigunguToBjd = new Map<string, string>();
  for (const a of identity) {
    if (a.sigungu_cd && a.bjd_code && !sigunguToBjd.has(a.sigungu_cd)) {
      sigunguToBjd.set(a.sigungu_cd, a.bjd_code);
    }
  }
  console.log(`시군구 ${sigunguToBjd.size}개 호출 (대표 법정동 코드)`);

  // 가장 최근 (2026-04 — 약 1개월 전)
  const ym = "202604";
  const result: Record<string, ReturnType<typeof ratioFamilyMetrics> & { sgg: string; ctpv: string; admmCd: string }> = {};

  // raw 행정동 단위 응답 모두 수집
  const raw: Item[] = [];
  for (const [sgg, bjd] of sigunguToBjd) {
    const items = await fetchSigungu(bjd, ym);
    console.log(`  ${sgg} (${bjd}) → ${items.length} 동`);
    raw.push(...items);
    await new Promise((r) => setTimeout(r, 200));
  }

  // 우리 단지 bjdong → 매칭되는 행정동들의 인구 합산
  const ourBjdongs = new Set(identity.map((a) => a.bjdong).filter(Boolean) as string[]);
  for (const bjd of ourBjdongs) {
    // 법정동명 = "야탑동" → 행정동명 "야탑동"/"야탑1동"/"야탑2동"/.. 매칭
    const stem = bjd.replace(/동$/, "");
    const matchPattern = new RegExp(`^${stem}(\\d+)?동$`);
    const matched = raw.filter((r) => matchPattern.test(r.dongNm));
    if (matched.length === 0) continue;
    let tot = 0, age0_9 = 0, age30s = 0;
    for (const it of matched) {
      const m = ratioFamilyMetrics(it);
      tot += m.tot; age0_9 += m.age0_9; age30s += m.age30s;
    }
    result[bjd] = {
      tot,
      age0_9,
      age30s,
      age0_9_rate: tot > 0 ? Math.round((age0_9 / tot) * 1000) / 10 : 0,
      age30s_rate: tot > 0 ? Math.round((age30s / tot) * 1000) / 10 : 0,
      sgg: matched[0].sggNm,
      ctpv: matched[0].ctpvNm,
      admmCd: matched.length === 1 ? matched[0].admmCd : `${matched.length}개동합산`,
    };
  }

  // raw 행정동 데이터도 저장 (sync에서 좌표→행정동 fallback 매칭용)
  const rawByDong: Record<string, ReturnType<typeof ratioFamilyMetrics> & { sgg: string; ctpv: string; admmCd: string }> = {};
  for (const it of raw) {
    const m = ratioFamilyMetrics(it);
    rawByDong[it.dongNm] = { ...m, sgg: it.sggNm, ctpv: it.ctpvNm, admmCd: it.admmCd };
  }

  await Bun.write(join(DATA_DIR, "dong_pop.json"), JSON.stringify({ byBjdong: result, byHjdong: rawByDong, ym }, null, 2));
  console.log(`\n법정동 ${Object.keys(result).length}개 + 행정동 ${Object.keys(rawByDong).length}개 저장 → data/dong_pop.json`);
  const matchedBjdongs = [...ourBjdongs].filter((d) => result[d]);
  console.log(`우리 단지 법정동 ${ourBjdongs.size}개 중 매칭: ${matchedBjdongs.length}`);
  const unmatched = [...ourBjdongs].filter((d) => !result[d]);
  if (unmatched.length) console.log(`미매칭 샘플:`, unmatched.slice(0, 10));
}

main().catch(console.error);
