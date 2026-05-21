/**
 * Google Elevation API로 아파트 고저차 계산.
 * dong_coords_naver.json의 동별 좌표를 사용.
 *
 * Usage: bun src/collect_slope.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const GOOGLE_KEY = process.env.GOOGLE_API_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ElevResult {
  diff_m: number;
  method: string;
  min_m: number;
  max_m: number;
  points: number;
  dong_elevations: { dong: string | number; elev: number }[];
}

async function getElevations(coords: { lat: number; lng: number }[]): Promise<number[]> {
  // Google Elevation API: 최대 512개 좌표
  const locations = coords.map((c) => `${c.lat},${c.lng}`).join("|");
  const url = `https://maps.googleapis.com/maps/api/elevation/json?locations=${locations}&key=${GOOGLE_KEY}`;
  const res = await fetch(url);
  const json = (await res.json()) as any;
  if (json.status !== "OK") return [];
  return json.results.map((r: any) => Math.round(r.elevation * 10) / 10);
}

async function main() {
  const coordsPath = join(DATA_DIR, "dong_coords_naver.json");
  const coords: Record<string, { dong: string | number; lat: number; lng: number }[]> =
    await Bun.file(coordsPath).json();

  const outPath = join(DATA_DIR, "slope_results.json");
  const existing: Record<string, ElevResult> = existsSync(outPath) ? await Bun.file(outPath).json() : {};

  const targets = Object.entries(coords).filter(([name, dongs]) => !existing[name] && Array.isArray(dongs) && dongs.length > 0);
  console.log(`고저차 계산: ${targets.length}개 대상, 기존 ${Object.keys(existing).length}개\n`);

  let done = 0;

  // 배치 처리: 여러 아파트의 좌표를 모아서 한 번에 요청 (API 호출 절약)
  let batch: { name: string; dongLabel: string | number; lat: number; lng: number }[] = [];
  const batchNames: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const [name, dongCoords] = targets[i];
    for (const dc of dongCoords) {
      batch.push({ name, dongLabel: dc.dong, lat: dc.lat, lng: dc.lng });
    }
    batchNames.push(name);

    // 300개씩 또는 마지막에 일괄 요청
    if (batch.length >= 300 || i === targets.length - 1) {
      process.stdout.write(`[${i + 1}/${targets.length}] ${batch.length}개 좌표...`);

      const elevations = await getElevations(batch.map((b) => ({ lat: b.lat, lng: b.lng })));

      if (elevations.length === batch.length) {
        // 아파트별로 분리
        let idx = 0;
        for (const bName of batchNames) {
          const dongs = coords[bName];
          const elevs: { dong: string | number; elev: number }[] = [];
          for (const dc of dongs) {
            elevs.push({ dong: dc.dong, elev: elevations[idx++] });
          }
          const min = Math.min(...elevs.map((e) => e.elev));
          const max = Math.max(...elevs.map((e) => e.elev));
          existing[bName] = {
            diff_m: Math.round((max - min) * 10) / 10,
            method: "dong_naver",
            min_m: min,
            max_m: max,
            points: elevs.length,
            dong_elevations: elevs,
          };
          done++;
        }
        console.log(` ${batchNames.length}개 완료`);
      } else {
        console.log(` ✗ API 에러 (${elevations.length}/${batch.length})`);
      }

      batch = [];
      batchNames.length = 0;
      await sleep(200);

      // 100개마다 중간 저장
      if (done % 100 < 20) {
        await Bun.write(outPath, JSON.stringify(existing, null, 2));
      }
    }
  }

  await Bun.write(outPath, JSON.stringify(existing, null, 2));
  console.log(`\n계산 완료: ${done}개, 전체: ${Object.keys(existing).length}개`);
}

main().catch(console.error);
