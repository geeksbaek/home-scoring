/**
 * 학구도안내서비스 ArcGIS API로 배정초등학교 조회.
 * 아파트 좌표 → point-in-polygon → 학구명에서 학교 이름 추출.
 *
 * Usage: bun src/collect_schools.ts
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ARCGIS_URL =
  "https://schoolgis.emac.kr/arcgis/rest/services/SCHZONE/EDU_LAYER_SCHOOLZONE_QUERY/MapServer/0/query";

async function querySchoolZone(
  lat: number,
  lng: number
): Promise<{ name: string; zoneId: string; zoneClass: string } | null> {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "HAKGUDO_ID,HAKGUDO_NAME,HAKGUDO_CLASS",
    returnGeometry: "false",
    f: "json",
  });

  try {
    const res = await fetch(`${ARCGIS_URL}?${params}`);
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const features = json.features ?? [];
    if (features.length === 0) return null;

    // 여러 학구가 겹칠 수 있음 (공동학구)
    const results = features.map((f: any) => ({
      name: f.attributes.HAKGUDO_NAME as string,
      zoneId: f.attributes.HAKGUDO_ID as string,
      zoneClass: f.attributes.HAKGUDO_CLASS as string,
    }));

    // 일반학구(0) 우선, 공동학구(1)는 보조
    return results.find((r: any) => r.zoneClass === "0") ?? results[0];
  } catch {
    return null;
  }
}

function extractSchoolNames(zoneName: string): string[] {
  // "산양초통학구역" → ["산양초등학교"]
  // "성복초효자초공동통학구역" → ["성복초등학교", "효자초등학교"]
  // "수원금호초호매실초공동(일방)초등학교통학구역" → ["수원금호초등학교", "호매실초등학교"]
  // "화성청계초여울초공동통학구역[화성청계초:...,여울초:...]초등학교" → 대괄호 주석 제거
  let name = zoneName
    .replace(/\[[^\]]*\]/g, "") // 대괄호 주석 제거
    .replace(/통학구역.*$/, "") // 통학구역 뒤 텍스트 제거
    .replace(/초등학교$/, "")
    .replace(/\(공동\)$/, "")
    .replace(/공동\([^)]*\)$/, "")
    .replace(/공동$/, "")
    .replace(/학구$/, "")
    .trim();

  // "성복초효자초" 같이 "초" 토큰이 여럿이면 각각 분리
  const matches = [...name.matchAll(/([가-힣A-Za-z0-9]+?초)(?=[가-힣A-Za-z0-9]+?초|$)/g)];
  if (matches.length >= 2) {
    return matches.map((m) => m[1] + "등학교");
  }
  // 단일 학교
  if (name.endsWith("초")) name += "등학교";
  else if (!name.includes("초등학교")) name += "초등학교";
  return [name];
}

function extractSchoolName(zoneName: string): string {
  return extractSchoolNames(zoneName)[0] ?? "";
}

async function main() {
  const identity: any[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const coordsPath = join(DATA_DIR, "dong_coords_naver.json");
  const coords: Record<string, any[]> = existsSync(coordsPath)
    ? await Bun.file(coordsPath).json()
    : {};

  const schoolMapPath = join(DATA_DIR, "school_map.json");
  const schoolMap: Record<string, string[]> = existsSync(schoolMapPath)
    ? await Bun.file(schoolMapPath).json()
    : {};

  // 좌표가 있고 학교 매핑이 없는 아파트
  const targets = identity.filter((e) => {
    if (schoolMap[e.name] && schoolMap[e.name].length > 0) return false;
    const c = coords[e.name];
    if (!c || !Array.isArray(c) || c.length === 0) return false;
    return true;
  });

  console.log(`배정학교 조회: ${targets.length}개 대상 (기존 ${Object.keys(schoolMap).length}개)\n`);

  let found = 0, notFound = 0, error = 0;

  for (let i = 0; i < targets.length; i++) {
    const entry = targets[i];
    const c = coords[entry.name];
    // 첫 번째 동 좌표 사용 (center 또는 첫 번째 건물)
    const point = c[0];
    if (!point || !point.lat || !point.lng) {
      notFound++;
      continue;
    }

    process.stdout.write(`[${i + 1}/${targets.length}] ${entry.name}...`);

    const result = await querySchoolZone(point.lat, point.lng);

    if (result) {
      const names = extractSchoolNames(result.name);
      schoolMap[entry.name] = names;
      found++;
      console.log(` ${names.join(",")} (${result.name})`);
    } else {
      // 여러 동 좌표로 재시도
      let foundAlt = false;
      for (let j = 1; j < Math.min(c.length, 5); j++) {
        const alt = c[j];
        if (!alt?.lat || !alt?.lng) continue;
        const altResult = await querySchoolZone(alt.lat, alt.lng);
        if (altResult) {
          const names = extractSchoolNames(altResult.name);
          schoolMap[entry.name] = names;
          found++;
          foundAlt = true;
          console.log(` ${names.join(",")} (${altResult.name}, 동${j + 1})`);
          break;
        }
        await sleep(100);
      }
      if (!foundAlt) {
        notFound++;
        console.log(" ✗");
      }
    }

    await sleep(80);

    if ((i + 1) % 100 === 0) {
      await Bun.write(schoolMapPath, JSON.stringify(schoolMap, null, 2));
      console.log(`  --- 중간 저장 (${Object.keys(schoolMap).length}개) ---`);
    }
  }

  await Bun.write(schoolMapPath, JSON.stringify(schoolMap, null, 2));

  // 공동학구 확인: 모든 아파트에 대해 공동학구도 추가 조회
  console.log(`\n--- 공동학구 추가 조회 ---`);
  let jointFound = 0;
  const allTargets = identity.filter((e) => {
    const c = coords[e.name];
    return c && Array.isArray(c) && c.length > 0 && schoolMap[e.name]?.length === 1;
  });

  for (let i = 0; i < allTargets.length; i++) {
    const entry = allTargets[i];
    const c = coords[entry.name];
    const point = c[0];
    if (!point?.lat || !point?.lng) continue;

    const params = new URLSearchParams({
      geometry: `${point.lng},${point.lat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "HAKGUDO_ID,HAKGUDO_NAME,HAKGUDO_CLASS",
      returnGeometry: "false",
      f: "json",
    });

    try {
      const res = await fetch(`${ARCGIS_URL}?${params}`);
      const json = (await res.json()) as any;
      const features = json.features ?? [];

      if (features.length > 1) {
        // 여러 학구에 겹침 (공동학구 포함)
        const schools = features
          .flatMap((f: any) => extractSchoolNames(f.attributes.HAKGUDO_NAME))
          .filter((s: string, idx: number, arr: string[]) => arr.indexOf(s) === idx);

        if (schools.length > schoolMap[entry.name].length) {
          schoolMap[entry.name] = schools;
          jointFound++;
          if (jointFound <= 20) {
            console.log(`  ${entry.name}: ${schools.join(", ")}`);
          }
        }
      }
    } catch {}

    await sleep(50);

    if ((i + 1) % 200 === 0) {
      await Bun.write(schoolMapPath, JSON.stringify(schoolMap, null, 2));
    }
  }

  await Bun.write(schoolMapPath, JSON.stringify(schoolMap, null, 2));
  console.log(`\n찾음: ${found}개, 못 찾음: ${notFound}개, 공동학구: ${jointFound}개`);
  console.log(`최종 school_map: ${Object.keys(schoolMap).length}개`);
}

main().catch(console.error);
