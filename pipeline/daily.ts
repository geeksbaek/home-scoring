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
import { isNonBusinessDay, refreshHolidays } from "./holidays";

const ROOT = join(import.meta.dir, "..");

async function main() {
  const force = process.argv.includes("--force");
  const start = Date.now();
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 16).replace("T", " ");

  console.log(`\n${"═".repeat(50)}`);
  console.log(`📅 일일 파이프라인 시작: ${timestamp}`);
  console.log(`${"═".repeat(50)}\n`);

  // 공휴일 캐시 갱신 (구글 ICS) → 임시공휴일·대체공휴일 자동 반영
  const hol = await refreshHolidays();
  console.log(hol.ok ? `🗓  공휴일 캐시 갱신: ${hol.count}일` : `🗓  공휴일 ICS 조회 실패 — 캐시/하드코딩 사용(${hol.count}일)`);

  // 공휴일 체크
  if (!force && isNonBusinessDay()) {
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
  // 거래 수가 크게 줄면(파일 손상 등) 이후 단계·배포 중단 — 2026-09-13 디스크 부족으로 CSV가 83.9만→12.4만 건으로
  // 잘린 채 파이프라인이 계속 돌아 손상 데이터가 배포될 뻔한 사고 재발 방지.
  if (afterLines < beforeLines * 0.98) {
    console.log(`   ❌ 거래 수 급감 (${beforeLines} → ${afterLines}) — CSV 손상 의심, 파이프라인 중단`);
    process.exit(1);
  }

  // ── 2. identity 동기화 (신규 단지 자동 추가) ─────────
  console.log("2️⃣  identity 동기화...");
  try {
    await $`bun pipeline/identity.ts`.cwd(ROOT);
  } catch (e: any) {
    console.log(`   ⚠ identity 오류: ${e.message?.slice(0, 100)}`);
  }

  // ── 3. 식별자 검증 (신규 단지) + 파생 데이터 보강 ─────
  // 실거래 (법정동+지번)을 ground truth로 hcode·네이버 단지·K-apt를 정확 대조 (verify_identity.py).
  // 기존 audit_hcode/collect_hcode는 K-apt 주소를 truth로, 500m 거리로 검증해 마을 단지(이매촌 등)를
  // 옆 단지로 오매칭했고, 매일 같은 453건을 지웠다 다시 붙이는 루프였음 → 대체.
  console.log("3️⃣  식별자 검증...");
  try {
    for (const stage of ["truth", "hcode", "naver", "kapt", "apply"]) {
      await $`python3 pipeline/verify_identity.py ${stage}`.cwd(ROOT);
    }
    // 좌표/고저차/배정초 보강 (식별자가 바뀐 단지는 apply에서 무효화됨)
    await $`bun pipeline/collect_coords.ts`.cwd(ROOT);
    await $`python3 pipeline/verify_identity.py coords`.cwd(ROOT); // 동별 좌표 없는 단지 → 지번 좌표
    await $`bun pipeline/collect_slope.ts`.cwd(ROOT);
    await $`bun pipeline/collect_schools.ts`.cwd(ROOT);
  } catch (e: any) {
    console.log(`   ⚠ 식별자 검증 오류: ${e.message?.slice(0, 100)}`);
  }

  // ── 3.5 KB부동산 시세 (신규 단지 증분 + 금요일 전체 갱신) ──
  // KB 시세는 주간(금요일) 갱신 → 금요일엔 --refresh-price로 전체 재조회.
  console.log("3️⃣.5  KB부동산 시세 수집...");
  try {
    const isFriday = now.getDay() === 5;
    // 신규 단지 증분은 매일. 금요일(KB 갱신일)엔 전체 시세 갱신 + 미매칭 단지 재시도.
    await $`bun pipeline/collect_kb_price.ts`.cwd(ROOT);
    if (isFriday) {
      await $`bun pipeline/collect_kb_price.ts --retry-failed`.cwd(ROOT);
      await $`bun pipeline/collect_kb_price.ts --refresh-price`.cwd(ROOT);
    }
  } catch (e: any) {
    console.log(`   ⚠ KB시세 오류: ${e.message?.slice(0, 100)}`);
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
    // 합본 data.json은 폐기됨 → data-index.json의 shard를 합쳐서 요약
    const idx = await Bun.file(join(scoringDir, "public", "data-index.json")).json();
    const dataJson: any[] = [];
    for (const s of idx.shards) dataJson.push(...(await Bun.file(join(scoringDir, "public", s.url)).json()));

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
