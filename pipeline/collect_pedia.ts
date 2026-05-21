/**
 * 소아과 고저차 계산.
 * 1. 아파트 좌표 (dong_coords)
 * 2. 소아과 좌표 (Kakao 키워드 검색으로 재확인)
 * 3. Google Elevation API로 양쪽 고도 조회
 * 4. 차이 = 소아과고도 - 아파트고도 (양수=오르막)
 *
 * Usage: GOOGLE_API_KEY=xxx KAKAO_REST_API_KEY=xxx bun src/collect_pedia_slope.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const GOOGLE_KEY = process.env.GOOGLE_API_KEY!;
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function searchClinicCoord(clinicName: string, aptLat: number, aptLng: number): Promise<{ lat: number; lng: number } | null> {
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(clinicName)}&x=${aptLng}&y=${aptLat}&radius=5000&sort=distance&size=1`;
  try {
    const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
    const json = (await res.json()) as any;
    const doc = json.documents?.[0];
    if (doc) return { lat: parseFloat(doc.y), lng: parseFloat(doc.x) };
  } catch {}
  return null;
}

async function getElevations(points: { lat: number; lng: number }[]): Promise<number[]> {
  if (points.length === 0) return [];
  const lats = points.map((p) => p.lat).join(",");
  const lngs = points.map((p) => p.lng).join(",");
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`;
  try {
    const res = await fetch(url);
    const json = (await res.json()) as any;
    return (json.elevation ?? []).map((e: number) => Math.round(e * 10) / 10);
  } catch { return []; }
}

async function main() {
  const pedia: Record<string, { name: string; straight_m: number; road_m: number; walk_min: number }[]> =
    await Bun.file(join(DATA_DIR, "pediatric_clinics.json")).json();
  const coords: Record<string, any[]> = await Bun.file(join(DATA_DIR, "dong_coords_naver.json")).json();

  const outPath = join(DATA_DIR, "pedia_slope.json");
  const existing: Record<string, number[]> = existsSync(outPath) ? await Bun.file(outPath).json() : {};

  const targets = Object.entries(pedia).filter(([name, clinics]) => {
    if (!clinics || clinics.length === 0) return false;
    if (existing[name]) return false;
    const c = coords[name];
    return c && Array.isArray(c) && c.length > 0 && c[0].lat;
  });

  console.log(`소아과 고저차: ${targets.length}개 대상, 기존 ${Object.keys(existing).length}개\n`);

  // 배치 처리: 아파트+소아과 좌표를 모아서 Elevation API 호출
  const BATCH = 30;
  let done = 0;

  for (let b = 0; b < targets.length; b += BATCH) {
    const batch = targets.slice(b, b + BATCH);

    // 1단계: 각 아파트의 소아과 좌표를 Kakao로 검색
    const batchData: { name: string; aptCoord: { lat: number; lng: number }; clinicCoords: ({ lat: number; lng: number } | null)[] }[] = [];

    for (const [name, clinics] of batch) {
      const c = coords[name];
      const aptCoord = { lat: c[0].lat, lng: c[0].lng };
      const clinicCoords: ({ lat: number; lng: number } | null)[] = [];

      for (const clinic of clinics.slice(0, 2)) {
        const coord = await searchClinicCoord(clinic.name, aptCoord.lat, aptCoord.lng);
        clinicCoords.push(coord);
        await sleep(50);
      }

      batchData.push({ name, aptCoord, clinicCoords });
    }

    // 2단계: 모든 포인트 모아서 Elevation API 배치 호출
    const allPoints: { lat: number; lng: number }[] = [];
    const indexMap: { batchIdx: number; type: "apt" | "clinic"; clinicIdx: number }[] = [];

    for (let i = 0; i < batchData.length; i++) {
      const d = batchData[i];
      allPoints.push(d.aptCoord);
      indexMap.push({ batchIdx: i, type: "apt", clinicIdx: -1 });

      for (let j = 0; j < d.clinicCoords.length; j++) {
        if (d.clinicCoords[j]) {
          allPoints.push(d.clinicCoords[j]!);
          indexMap.push({ batchIdx: i, type: "clinic", clinicIdx: j });
        }
      }
    }

    // Elevation API는 최대 512개 포인트
    const elevations = await getElevations(allPoints);
    if (elevations.length !== allPoints.length) {
      console.log(`  Elevation API 오류 (${elevations.length}/${allPoints.length})`);
      await sleep(1000);
      continue;
    }

    // 3단계: 고저차 계산
    for (let i = 0; i < batchData.length; i++) {
      const d = batchData[i];
      let aptElev = 0;
      const slopes: number[] = [];

      for (let k = 0; k < indexMap.length; k++) {
        const m = indexMap[k];
        if (m.batchIdx !== i) continue;
        if (m.type === "apt") aptElev = elevations[k];
        if (m.type === "clinic") {
          slopes[m.clinicIdx] = Math.round((elevations[k] - aptElev) * 10) / 10;
        }
      }

      if (slopes.length > 0) {
        existing[d.name] = slopes;
        done++;
        process.stdout.write(`[${b + i + 1}/${targets.length}] ${d.name}: ${slopes.map(s => (s > 0 ? "+" : "") + s + "m").join(", ")}\n`);
      }
    }

    await Bun.write(outPath, JSON.stringify(existing, null, 2));
    await sleep(200);
  }

  console.log(`\n완료: ${done}개, 전체: ${Object.keys(existing).length}개`);
}

main().catch(console.error);
