/**
 * 네이버페이 부동산 complex_no 수집.
 * naver_place_id가 있는 단지를 m.place.naver.com에서 조회하여
 * 부동산 단지(complexes) 식별자를 추출.
 *
 * Usage: bun src/collect_naver_complex.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchComplexNo(placeId: string): Promise<{ id: string | null; rateLimited: boolean }> {
  const url = `https://m.place.naver.com/place/${placeId}/home`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)" },
    });
    if (res.status === 429) return { id: null, rateLimited: true };
    if (!res.ok) return { id: null, rateLimited: false };
    const text = await res.text();
    const m = text.match(/"shapeType":"land","shapeKey":\{"__ref":"PoiInfoShapeKey:(\d+)"/);
    return { id: m ? m[1] : null, rateLimited: false };
  } catch {
    return { id: null, rateLimited: false };
  }
}

async function main() {
  const identityPath = join(DATA_DIR, "apt_identity.json");
  const identity: { name: string; naver_place_id: string | null }[] = await Bun.file(identityPath).json();

  const out: Record<string, string> = existsSync(join(DATA_DIR, "naver_complex_ids.json"))
    ? await Bun.file(join(DATA_DIR, "naver_complex_ids.json")).json()
    : {};

  const __only = process.env.ONLY_NAMES ? new Set(JSON.parse(require("node:fs").readFileSync(process.env.ONLY_NAMES,"utf8")) as string[]) : null;
  const targets = identity.filter((d) => d.naver_place_id && !out[d.name]).filter((d:any) => !__only || __only.has(d.name));
  console.log(`수집 대상: ${targets.length}개 (기존 ${Object.keys(out).length}개 보유)\n`);

  let ok = 0, miss = 0;
  for (let i = 0; i < targets.length; i++) {
    const { name, naver_place_id } = targets[i];
    let r = await fetchComplexNo(naver_place_id!);
    let backoffMs = 5000;
    while (r.rateLimited && backoffMs <= 60000) {
      console.log(`  ⚠ 429 — ${backoffMs / 1000}s 대기`);
      await sleep(backoffMs);
      r = await fetchComplexNo(naver_place_id!);
      backoffMs *= 2;
    }

    if (r.id) {
      out[name] = r.id;
      ok++;
      console.log(`[${i + 1}/${targets.length}] ${name} → ${r.id}`);
    } else {
      miss++;
      console.log(`[${i + 1}/${targets.length}] ${name} → ✗`);
    }

    if ((i + 1) % 20 === 0) {
      await Bun.write(join(DATA_DIR, "naver_complex_ids.json"), JSON.stringify(out, null, 2));
    }
    await sleep(1500);
  }

  await Bun.write(join(DATA_DIR, "naver_complex_ids.json"), JSON.stringify(out, null, 2));
  console.log(`\n수집: ${ok}개, 미확인: ${miss}개, 전체: ${Object.keys(out).length}개`);
}

main().catch(console.error);
