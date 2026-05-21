/**
 * naver_place_id가 null인 entry를 home-scoring의 원본 값으로 일괄 fallback.
 *
 * Usage: bun src/fallback_naver_place.ts
 */
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const FALLBACK_PATH = join(homedir(), "GitHub", "home-scoring", "data", "apt_identity.json");

async function main() {
  const identityPath = join(DATA_DIR, "apt_identity.json");
  const identity: any[] = await Bun.file(identityPath).json();
  const fallback: any[] = await Bun.file(FALLBACK_PATH).json();
  const fallbackById = new Map(fallback.map((e) => [e.name, e.naver_place_id]));

  let restored = 0, stillNull = 0, alreadyOk = 0;
  for (const e of identity) {
    if (e.naver_place_id) { alreadyOk++; continue; }
    const fb = fallbackById.get(e.name);
    if (fb) {
      e.naver_place_id = fb;
      restored++;
    } else {
      stillNull++;
    }
  }

  await Bun.write(identityPath, JSON.stringify(identity, null, 2));
  console.log(`복원 ${restored} / 여전히 null ${stillNull} / 기존 OK ${alreadyOk}`);
  console.log(`총 naver_place_id 보유: ${identity.filter((e) => e.naver_place_id).length}/${identity.length}`);
}

main().catch(console.error);
