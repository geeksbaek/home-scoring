/**
 * 매일 아침 실거래가 수집 + 스코어링 갱신 파이프라인.
 * 공휴일 자동 스킵, 빌드 실패 재시도.
 *
 * Usage:
 *   bun pipeline/daily.ts
 *   bun pipeline/daily.ts --force   # 공휴일이어도 강제 실행
 */

import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");

// 한국 공휴일 (연도별 추가 필요)
const HOLIDAYS_2026 = new Set([
  "2026-01-01", // 신정
  "2026-01-28", "2026-01-29", "2026-01-30", // 설날
  "2026-03-01", // 삼일절
  "2026-05-01", // 근로자의 날
  "2026-05-05", // 어린이날
  "2026-05-24", // 부처님오신날
  "2026-06-06", // 현충일
  "2026-08-15", // 광복절
  "2026-09-24", "2026-09-25", "2026-09-26", // 추석
  "2026-10-03", // 개천절
  "2026-10-09", // 한글날
  "2026-12-25", // 성탄절
]);

function isHoliday(): boolean {
  const now = new Date();
  const day = now.getDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return true;
  const dateStr = now.toISOString().slice(0, 10);
  return HOLIDAYS_2026.has(dateStr);
}

async function main() {
  const force = process.argv.includes("--force");
  const start = Date.now();
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 16).replace("T", " ");

  console.log(`\n${"═".repeat(50)}`);
  console.log(`📅 일일 파이프라인 시작: ${timestamp}`);
  console.log(`${"═".repeat(50)}\n`);

  // 공휴일 체크
  if (!force && isHoliday()) {
    console.log("⏭  공휴일/주말 — 스킵 (--force로 강제 실행 가능)");
    return;
  }

  // ── 1. 실거래가 증분 수집 ────────────────────────────
  console.log("1️⃣  실거래가 증분 수집...");

  const csvPath = join(ROOT, "data", "apt_trade_filtered.csv");
  const beforeLines = (await Bun.file(csvPath).text()).split("\n").length - 1;

  try {
    await $`bun pipeline/collect.ts`.cwd(ROOT);
  } catch (e: any) {
    console.log(`   ⚠ 수집 오류: ${e.message?.slice(0, 100)}`);
  }

  const afterLines = (await Bun.file(csvPath).text()).split("\n").length - 1;
  const newTrades = afterLines - beforeLines;
  console.log(`   수집 완료: 신규 ${newTrades}건 (총 ${afterLines}건)\n`);

  // ── 2. identity 동기화 (신규 단지 자동 추가) ─────────
  console.log("2️⃣  identity 동기화...");
  try {
    await $`bun pipeline/identity.ts`.cwd(ROOT);
  } catch (e: any) {
    console.log(`   ⚠ identity 오류: ${e.message?.slice(0, 100)}`);
  }

  // ── 3. hcode 검증 + 신규 수집 ────────────────────────
  console.log("3️⃣  hcode 검증...");
  try {
    await $`bun pipeline/audit_hcode.ts`.cwd(ROOT);
    const audit = await Bun.file(join(ROOT, "data", "_hcode_audit.json")).json();
    if ((audit.mismatches?.length ?? 0) > 0) {
      console.log(`   ⚠ ${audit.mismatches.length}건 mismatch — 자동 정리 후 재수집`);
      await $`bun -e ${`
        const audit = await Bun.file("data/_hcode_audit.json").json();
        const identity = await Bun.file("data/apt_identity.json").json();
        const coords = await Bun.file("data/dong_coords_naver.json").json();
        const slope = await Bun.file("data/slope_results.json").json();
        const sm = await Bun.file("data/school_map.json").json();
        const hc = await Bun.file("data/hogangnono_codes.json").json();
        const bad = new Set(audit.mismatches.map(m => m.name));
        for (const a of identity) if (bad.has(a.name)) a.hcode = null;
        for (const n of bad) { delete coords[n]; delete slope[n]; delete sm[n]; delete hc[n]; }
        await Bun.write("data/apt_identity.json", JSON.stringify(identity, null, 2));
        await Bun.write("data/dong_coords_naver.json", JSON.stringify(coords, null, 2));
        await Bun.write("data/slope_results.json", JSON.stringify(slope, null, 2));
        await Bun.write("data/school_map.json", JSON.stringify(sm, null, 2));
        await Bun.write("data/hogangnono_codes.json", JSON.stringify(hc, null, 2));
      `}`.cwd(ROOT);
    }
    // 누락된 hcode 수집 (검증된 매칭만)
    await $`bun pipeline/collect_hcode.ts`.cwd(ROOT);
    // 좌표/고저차/배정초 보강
    await $`bun pipeline/collect_coords.ts`.cwd(ROOT);
    await $`bun pipeline/collect_slope.ts`.cwd(ROOT);
    await $`bun pipeline/collect_schools.ts`.cwd(ROOT);
  } catch (e: any) {
    console.log(`   ⚠ hcode 검증 오류: ${e.message?.slice(0, 100)}`);
  }

  // ── 4. 스코어링 재생성 + 배포 ────────────────────────
  console.log("4️⃣  스코어링 재생성 + 배포...");
  try {
    await $`bun pipeline/sync.ts`.cwd(ROOT);
    console.log("   sync 완료\n");
  } catch (e: any) {
    console.log(`   ⚠ sync 오류: ${e.message?.slice(0, 100)}`);
    // 재시도
    console.log("   재시도...");
    try {
      await $`bun pipeline/sync.ts`.cwd(ROOT);
      console.log("   재시도 성공\n");
    } catch {
      console.log("   ❌ sync 최종 실패\n");
    }
  }

  // ── 5. 빌드 + 배포 (sync.ts 빌드 실패 시 수동) ──────
  const scoringDir = join(ROOT, "..", "home-scoring");
  const distIndex = join(scoringDir, "dist", "index.html");
  if (!(await Bun.file(distIndex).exists())) {
    console.log("   빌드 재시도...");
    try {
      await $`node_modules/.bin/vite build`.cwd(scoringDir);
      await $`npx gh-pages -d dist`.cwd(scoringDir);
      console.log("   수동 빌드+배포 완료\n");
    } catch {
      console.log("   ❌ 빌드 최종 실패\n");
    }
  }

  // ── 6. 결과 보고 ─────────────────────────────────────
  console.log("6️⃣  결과 보고");

  try {
    const dataJson = await Bun.file(join(scoringDir, "public", "data.json")).json();

    const recentCutoff = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const recentlyTraded = dataJson.filter((d: any) =>
      d.recent_trades?.some((t: any) => t.date >= recentCutoff)
    );

    const sorted = [...dataJson].filter((d: any) => d.accel != null).sort((a: any, b: any) => b.accel - a.accel);
    const top5 = sorted.slice(0, 5);
    const bottom5 = sorted.slice(-5).reverse();

    console.log(`\n   📊 요약`);
    console.log(`   ├ 총 아파트: ${dataJson.length}개`);
    console.log(`   ├ 신규 거래: ${newTrades}건`);
    console.log(`   ├ 최근 7일 거래 단지: ${recentlyTraded.length}개`);
    console.log(`   │`);
    console.log(`   ├ 🔺 가속도 상위 5`);
    for (const d of top5) {
      console.log(`   │  ${d.display_name || d.name} (${d.atype}㎡) ${d.accel > 0 ? "+" : ""}${d.accel}%  ${Math.round(d.avg / 10000)}억`);
    }
    console.log(`   │`);
    console.log(`   ├ 🔻 가속도 하위 5`);
    for (const d of bottom5) {
      console.log(`   │  ${d.display_name || d.name} (${d.atype}㎡) ${d.accel > 0 ? "+" : ""}${d.accel}%  ${Math.round(d.avg / 10000)}억`);
    }

    // 데이터 커버리지
    const hasMgmt = dataJson.filter((d: any) => d.mgmt_cost != null).length;
    const hasCommute = dataJson.filter((d: any) => d.commuteScore != null).length;
    const hasViolence = dataJson.filter((d: any) => d.school_violence && Object.keys(d.school_violence).length > 0).length;
    console.log(`   │`);
    console.log(`   ├ 📋 데이터 커버리지`);
    console.log(`   │  관리비: ${hasMgmt}/${dataJson.length} | 출퇴근: ${hasCommute}/${dataJson.length} | 학폭: ${hasViolence}/${dataJson.length}`);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`   │`);
    console.log(`   └ ⏱  소요시간: ${elapsed}초`);
  } catch {
    console.log("   결과 보고 실패");
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`✅ 일일 파이프라인 완료`);
  console.log(`${"═".repeat(50)}\n`);
}

main().catch((e) => {
  console.error("❌ 파이프라인 실패:", e.message);
  process.exit(1);
});
