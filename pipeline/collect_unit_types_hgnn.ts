/**
 * 호갱노노 페이지 스크래핑으로 unit_types 보강.
 * __HGNN_DATA__ JSON에서 area별 (private_area, total_household) 추출.
 *
 * 대상: API 보강(supplement) 후에도 unit_types 미수집 단지 중 hcode 보유.
 *
 * Usage: bun src/collect_unit_types_hgnn.ts
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AreaEntry { private_area: number; total_household: number; }

async function fetchAreas(hcode: string): Promise<AreaEntry[] | null> {
  try {
    const res = await fetch(`https://hogangnono.com/apt/${hcode}`, {
      headers: { "user-agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const startTag = `<script id="__HGNN_DATA__" type="application/json">`;
    const start = html.indexOf(startTag);
    if (start < 0) return null;
    const after = start + startTag.length;
    const end = html.indexOf("</script>", after);
    const data = JSON.parse(html.slice(after, end).trim());

    // 메인 단지 데이터만 추출. nearbyStartApts 등 인근 단지 path 배제.
    const seen = new Map<number, AreaEntry>();
    function walk(o: any, path: string = ""): void {
      if (!o || typeof o !== "object") return;
      // 인근 단지/즐겨찾기/추천 등 외부 단지 데이터 스킵
      if (/nearby|recommend|favorit|similar|relatedApt/i.test(path)) return;
      if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) walk(o[i], `${path}[${i}]`); return; }
      if (typeof o.id === "number" && typeof o.private_area === "number" && typeof o.total_household === "number") {
        if (!seen.has(o.id)) seen.set(o.id, { private_area: o.private_area, total_household: o.total_household });
      }
      for (const k of Object.keys(o)) walk(o[k], `${path}.${k}`);
    }
    walk(data);
    return [...seen.values()];
  } catch { return null; }
}

async function main() {
  const identity: any[] = await Bun.file(join(DATA_DIR, "apt_identity.json")).json();
  const utPath = join(DATA_DIR, "unit_types.json");
  const ut: Record<string, any> = await Bun.file(utPath).json();
  const utNames = new Set(Object.keys(ut));

  // 미수집 + hcode 보유
  const targets = identity.filter((a) => !utNames.has(a.name) && a.hcode);
  console.log(`hcode 보유 미수집: ${targets.length}개`);

  // 같은 hcode 묶인 단지 그룹 (한일타운 4개 등)
  const byHcode = new Map<string, string[]>();
  for (const a of targets) {
    if (!byHcode.has(a.hcode)) byHcode.set(a.hcode, []);
    byHcode.get(a.hcode)!.push(a.name);
  }

  let ok = 0, fail = 0;
  let i = 0;
  for (const [hcode, names] of byHcode) {
    i++;
    process.stdout.write(`[${i}/${byHcode.size}] hcode=${hcode} (${names.length}단지)...`);
    const areas = await fetchAreas(hcode);
    if (!areas || areas.length === 0) { console.log(" ✗ 데이터 없음"); fail += names.length; await sleep(500); continue; }

    // area별 세대수 정리 (소수점 2자리 정규화)
    const grouped = new Map<number, number>();
    for (const a of areas) {
      const r = Math.round(a.private_area * 100) / 100;
      grouped.set(r, (grouped.get(r) ?? 0) + a.total_household);
    }
    const areaTypes = [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([area, count]) => ({ area, count }));
    const total = areaTypes.reduce((s, t) => s + t.count, 0);

    for (const n of names) {
      ut[n] = { name: n, totalUnits: total, areaTypes, fromHgnn: true };
      ok++;
    }
    await Bun.write(utPath, JSON.stringify(ut, null, 2));
    console.log(` ✓ ${total}세대 (${areaTypes.length}타입) → ${names.length}단지에 적용`);
    await sleep(800);
  }

  console.log(`\n완료: ${ok}건 적용, ${fail}건 실패`);
}

if (import.meta.main) main().catch(console.error);
