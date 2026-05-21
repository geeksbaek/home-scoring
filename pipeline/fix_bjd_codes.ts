/**
 * bjd_code 누락된 단지의 정확한 법정동 코드를 카카오 주소 API로 보강.
 * apt_identity.json의 jibun_addr / doro_juso를 카카오에 질의하여 b_code 추출.
 *
 * Usage: bun src/fix_bjd_codes.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function searchAddress(query: string): Promise<{ bcode: string; lawAddr: string } | null> {
  // 주소 검색 API: 정확한 법정동 코드(b_code) 반환
  const endpoints = [
    `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}`,
    `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=1`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
      if (!res.ok) continue;
      const json = (await res.json()) as any;
      const doc = json.documents?.[0];
      if (!doc) continue;
      // address API
      const addr = doc.address || doc.road_address;
      if (addr?.b_code) {
        return { bcode: addr.b_code, lawAddr: addr.address_name || "" };
      }
      // keyword API
      if (doc.address?.b_code) {
        return { bcode: doc.address.b_code, lawAddr: doc.address.address_name || "" };
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function main() {
  const identity: any[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const building: Record<string, any> = await Bun.file(join(DATA_DIR, "building_info.json")).json();

  const targets = identity.filter((apt) => !apt.bjd_code);

  console.log(`bjd_code 보강 대상: ${targets.length}개\n`);

  // bjd_code 매핑 결과 저장
  const updates: { name: string; bjdCode: string; lawAddr: string; query: string }[] = [];
  let success = 0;

  for (let i = 0; i < targets.length; i++) {
    const apt = targets[i];
    const region = apt.region || "";
    const sidoPrefix = region.startsWith("서울") ? "" : "경기도 ";
    const queries = [
      apt.doro_juso,
      apt.jibun_addr,
      // region + bjdong + 지번
      apt.bjdong && apt.jibun ? `${sidoPrefix}${region} ${apt.bjdong} ${apt.jibun}` : null,
      apt.bjdong ? `${sidoPrefix}${region} ${apt.bjdong}` : null,
      apt.bjdong ? `${region} ${apt.bjdong}` : null,
    ].filter(Boolean) as string[];

    process.stdout.write(`[${i + 1}/${targets.length}] ${apt.name}...`);

    let result: { bcode: string; lawAddr: string } | null = null;
    let usedQuery = "";
    for (const q of queries) {
      result = await searchAddress(q);
      if (result) { usedQuery = q; break; }
      await sleep(50);
    }

    if (result) {
      success++;
      updates.push({ name: apt.name, bjdCode: result.bcode, lawAddr: result.lawAddr, query: usedQuery });
      // identity에 bjd_code 업데이트
      apt.bjd_code = result.bcode;
      console.log(` → ${result.bcode} (${result.lawAddr})`);
      // 매 건 저장 (크래시 대비)
      await Bun.write(join(DATA_DIR, "apt_identity.json"), JSON.stringify(identity, null, 2));
    } else {
      console.log(" 실패");
    }
    await sleep(100);
  }

  // identity 저장
  await Bun.write(join(DATA_DIR, "apt_identity.json"), JSON.stringify(identity, null, 2));
  await Bun.write(join(DATA_DIR, "_bjd_fix_log.json"), JSON.stringify(updates, null, 2));

  console.log(`\n완료: ${success}/${targets.length}개 보강`);
  console.log(`apt_identity.json 업데이트 됨. 다음 단계: bun src/building.ts (캐시 무효화 필요)`);
}

main().catch(console.error);
