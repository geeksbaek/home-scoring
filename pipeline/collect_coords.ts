/**
 * 호갱노노 polygon API로 아파트 동별 좌표 수집.
 * 호갱노노 웹사이트 세션 필요 (먼저 아무 아파트 페이지 방문).
 *
 * Usage: bun src/collect_coords.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DongCoord {
  dong: number | string;
  lat: number;
  lng: number;
}

async function fetchPolygon(hcode: string): Promise<DongCoord[]> {
  const url = `https://hogangnono.com/api/v2/apts/${hcode}/polygon`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    const buildings = json.data?.buildings ?? [];
    return buildings
      .filter((b: any) => b.centerWgs84?.x && b.centerWgs84?.y)
      .map((b: any) => ({
        dong: b.buldNmDc || b.dongNm || "?",
        lat: b.centerWgs84.y,
        lng: b.centerWgs84.x,
      }));
  } catch { return []; }
}

async function main() {
  const identity: { name: string; hcode: string | null }[] =
    await Bun.file(join(DATA_DIR, "apt_identity.json")).json();

  const outPath = join(DATA_DIR, "dong_coords_naver.json");
  const existing: Record<string, DongCoord[]> = existsSync(outPath) ? await Bun.file(outPath).json() : {};

  const targets = identity.filter((e) => e.hcode && !existing[e.name]);
  console.log(`동별 좌표 수집: ${targets.length}개 대상, 기존 ${Object.keys(existing).length}개\n`);

  // 먼저 호갱노노 아무 페이지 방문해서 세션 활성화
  try {
    await fetch(`https://hogangnono.com/apt/${targets[0]?.hcode ?? "5c072"}`);
    await sleep(500);
  } catch {}

  let fetched = 0, empty = 0;

  for (let i = 0; i < targets.length; i++) {
    const { name, hcode } = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${name}...`);

    const coords = await fetchPolygon(hcode!);

    if (coords.length > 0) {
      existing[name] = coords;
      fetched++;
      console.log(` ${coords.length}동`);
    } else {
      empty++;
      console.log(" 건물 없음");
    }

    await sleep(100);

    if ((i + 1) % 100 === 0) {
      await Bun.write(outPath, JSON.stringify(existing, null, 2));
      console.log(`  --- 중간 저장 (${Object.keys(existing).length}개) ---`);
    }
  }

  await Bun.write(outPath, JSON.stringify(existing, null, 2));
  console.log(`\n좌표 수집: ${fetched}개, 건물 없음: ${empty}개`);
  console.log(`전체: ${Object.keys(existing).length}개`);
}

main().catch(console.error);
