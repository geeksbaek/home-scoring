/**
 * K-apt 기본정보 API에서 면적대별 세대수 수집.
 * 건축물대장 API 한도 초과 시 대안으로 사용.
 *
 * K-apt: 60㎡이하, 85㎡이하, 135㎡이하, 136㎡이상 (4분류)
 * → 우리 타입 매핑: "small" = 60~85㎡ 구간, "84" = 동일 구간
 *   실제로는 59~84㎡ 범위이므로 85㎡이하 - 60㎡이하 = 해당 타입 세대수
 *
 * Usage:
 *   bun src/unit_types_kapt.ts
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const API_KEY = process.env.PUBLIC_DATA_API_KEY!;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("K-apt 면적대별 세대수 수집 (unit_types 보완)\n");

  const identityPath = join(DATA_DIR, "apt_identity.json");
  const identity: { name: string; kapt_code: string | null }[] = await Bun.file(identityPath).json();
  const targets = identity.filter((d) => d.kapt_code);

  // 기존 unit_types (건축물대장 기반, 정확)
  const utPath = join(DATA_DIR, "unit_types.json");
  const existing: Record<string, any> = existsSync(utPath) ? await Bun.file(utPath).json() : {};

  let fetched = 0;
  let skipped = 0;

  for (let i = 0; i < targets.length; i++) {
    const { name, kapt_code } = targets[i];

    // 건축물대장 기반 데이터가 이미 있으면 건너뜀
    if (existing[name] && existing[name].totalUnits > 0 && !existing[name].fromKapt) {
      skipped++;
      continue;
    }

    process.stdout.write(`[${i + 1}/${targets.length}] ${name}...`);

    const res = await fetch(
      `https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusBassInfoV4?serviceKey=${API_KEY}&kaptCode=${kapt_code}`
    );
    const json = (await res.json()) as any;
    const item = json.response?.body?.item;

    if (!item) {
      console.log(" ✗ 기본정보 없음");
      await sleep(100);
      continue;
    }

    const total = item.kaptdaCnt || 0;
    const under60 = item.kaptMparea60 || 0;
    const under85 = item.kaptMparea85 || 0;
    const under135 = item.kaptMparea135 || 0;
    const over136 = item.kaptMparea136 || 0;

    // 면적 구간별 세대수 (K-apt 필드는 이미 구간별, 누적 아님)
    const areaTypes = [];
    if (under60 > 0) areaTypes.push({ area: 50, count: under60 }); // 60㎡이하
    if (under85 > 0) areaTypes.push({ area: 75, count: under85 }); // 60~85㎡
    if (under135 > 0) areaTypes.push({ area: 100, count: under135 }); // 85~135㎡
    if (over136 > 0) areaTypes.push({ area: 150, count: over136 }); // 136㎡이상

    existing[name] = {
      name,
      totalUnits: total,
      areaTypes,
      fromKapt: true, // K-apt 기반 (대분류) 표시
    };

    fetched++;
    console.log(` ${total}세대 [60이하:${under60} 85이하:${under85} 135이하:${under135} 136이상:${over136}]`);

    await sleep(100);

    // 매 건 저장 (크래시 대비)
    await Bun.write(utPath, JSON.stringify(existing, null, 2));
  }

  await Bun.write(utPath, JSON.stringify(existing, null, 2));
  console.log(`\n수집: ${fetched}개, 건너뜀: ${skipped}개 (건축물대장 데이터 보유)`);
  console.log(`전체 unit_types: ${Object.keys(existing).length}개`);
  console.log(`  건축물대장 기반 (정확): ${Object.values(existing).filter((v: any) => !v.fromKapt).length}개`);
  console.log(`  K-apt 기반 (대분류): ${Object.values(existing).filter((v: any) => v.fromKapt).length}개`);
}

main().catch(console.error);
