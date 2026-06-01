/**
 * 후보 단지 ↔ 판교아지트 출퇴근 시간 측정 (Kakao Mobility API).
 *
 * Usage:
 *   bun src/commute.ts            # 출근 방향 (집→판교)
 *   bun src/commute.ts --reverse  # 퇴근 방향 (판교→집)
 */

import { join } from "node:path";
import { sync } from "./sync";
import { isNonBusinessDay } from "./holidays";

const ROOT = join(import.meta.dir, "..");
const OUT_PATH = join(ROOT, "data", "commute_results.json");
// 단지 좌표 캐시 (좌표는 불변 → 매일 geocode 5,300+회 생략). query가 바뀌면 무효화.
const COORDS_CACHE_PATH = join(ROOT, "data", "commute_coords_cache.json");

// 병렬 측정 동시성. 카카오 directions는 동시 50+에서 순간 rate limit(code -10)이 발생하므로
// 안전선(24)을 유지 → 5,300+개를 ~30초에 측정(과거 순차 49분 대비). QPS 초과 -10은
// kakaoJson의 backoff 재시도로 흡수(일일 quota 소진과 구분).
const CONCURRENCY = 24;

// 단지 목록 소스: data.json은 도시별 shard로 분할됨 (data-seoul.json + data-gyeonggi.json).
// data-index.json의 shards[].url을 모두 병합 로드 → 신규 shard 추가 시 자동 대응.
const PUBLIC_DIR = join(ROOT, "public");
const DATA_INDEX = join(PUBLIC_DIR, "data-index.json");

// 카카오 길찾기 무료 할당량은 앱(REST API 키) 단위 일 10,000건.
// 단지 5,300+개 × 출퇴근 2회 = 일 10,700+건 → 키 1개로는 초과.
// KAKAO_REST_API_KEY_2가 있으면 호출마다 라운드로빈해 합산 할당량을 2배로.
const KAKAO_KEYS = [
  process.env.KAKAO_REST_API_KEY,
  process.env.KAKAO_REST_API_KEY_2,
].filter((k): k is string => !!k);
if (KAKAO_KEYS.length === 0) throw new Error("KAKAO_REST_API_KEY 미설정");

/** 모든 카카오 키가 할당량 초과(code -10)된 경우. 측정 중단 + 불완전 batch 저장 금지. */
class QuotaExceededError extends Error {}

// 카카오 키별 권한/할당량은 서비스(navi=길찾기, local=좌표검색)마다 별개다.
// 예: 새 앱 키가 navi(directions)는 되지만 local(OPEN_MAP_AND_LOCAL)은 비활성(403)일 수 있음.
type Service = "navi" | "local";
let keyIdx = 0;
const exhausted = new Set<number>(); // navi 일일 quota 소진(code -10)된 키
const localDisabled = new Set<number>(); // local(카카오맵) 서비스 비활성(403)인 키

// 서비스별로 사용 불가 키를 건너뛰며 라운드로빈. 가용 키 없으면 QuotaExceededError.
function nextKeyIdx(service: Service): number {
  const blocked = service === "navi" ? exhausted : localDisabled;
  for (let i = 0; i < KAKAO_KEYS.length; i++) {
    const idx = keyIdx % KAKAO_KEYS.length;
    keyIdx++;
    if (!blocked.has(idx)) return idx;
  }
  throw new QuotaExceededError(
    service === "navi"
      ? "모든 카카오 키 길찾기 할당량 초과"
      : "좌표검색(카카오맵) 가능한 카카오 키 없음",
  );
}

// 카카오 JSON GET. 서비스별 키 로테이션 + 권한/할당량 처리.
//
// - navi code -10: (a)일일 quota 소진 또는 (b)순간 QPS 초과(rate limit) 양쪽에 쓰임.
//   -10이면 backoff 재시도. (b)면 회복, (a)면 계속 -10 → MAX_RETRY 후 그 키 소진 확정.
// - local 403(OPEN_MAP_AND_LOCAL disabled): 그 키는 좌표검색 불가 → localDisabled 처리 후 다른 키.
async function kakaoJson(buildUrl: () => string, service: Service): Promise<any> {
  const MAX_RETRY = 4; // backoff 250·500·750·1000ms
  let attempt = 0;
  while (true) {
    const idx = nextKeyIdx(service); // 가용 키 없으면 QuotaExceededError throw
    const res = await fetch(buildUrl(), {
      headers: { Authorization: `KakaoAK ${KAKAO_KEYS[idx]}` },
    });
    const data = await res.json();

    // local 서비스 권한 없음 → 그 키 좌표검색 제외하고 다른 키로
    if (res.status === 403) {
      if (!localDisabled.has(idx)) {
        localDisabled.add(idx);
        console.warn(`  ⚠ 키 #${idx + 1} 좌표검색(카카오맵) 비활성 — 다른 키로`);
      }
      attempt = 0;
      continue;
    }

    if (!(res.status === 400 && data?.code === -10)) return data;

    if (attempt < MAX_RETRY) {
      attempt++;
      await sleep(250 * attempt); // 순간 rate limit이면 backoff 후 회복
      continue;
    }
    // 재시도 후에도 -10 → 이 키는 길찾기 일일 quota 소진으로 확정
    if (!exhausted.has(idx)) {
      exhausted.add(idx);
      console.warn(
        `  ⚠ 키 #${idx + 1} 길찾기 일일 할당량 소진 — 남은 ${KAKAO_KEYS.length - exhausted.size}개 키로 계속`,
      );
    }
    attempt = 0; // 다음 가용 키로 처음부터 (모두 소진이면 nextKeyIdx가 throw)
  }
}

const DESTINATION = "판교역로 166";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// data shard(들)에서 아파트 목록 자동 생성
async function loadCandidates(): Promise<[string, string][]> {
  const index: { shards: { url: string }[] } = await Bun.file(DATA_INDEX).json();
  const data: { name: string; dong: string; region: string; doro_juso: string | null }[] = [];
  for (const shard of index.shards) {
    const rows = await Bun.file(join(PUBLIC_DIR, shard.url)).json();
    data.push(...rows);
  }

  const seen = new Set<string>();
  const candidates: [string, string][] = [];
  for (const d of data) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    // 도로명주소 우선, 없으면 지역+법정동+단지명
    const query = d.doro_juso || `${d.region} ${d.dong} ${d.name}`;
    candidates.push([d.name, query]);
  }
  return candidates;
}

// 하드코딩 후보 (레거시, data.json에 없는 경우 fallback)
const LEGACY_CANDIDATES: [name: string, query: string][] = [
  ["힐스테이트구성", "용인시 기흥구 언남동 힐스테이트구성"],
  ["힐스테이트동탄", "화성시 목동 힐스테이트동탄"],
  ["호반 써밋 수원", "수원시 권선구 금곡동 호반 써밋 수원"],
  ["호수공원역 센트럴시티", "화성시 산척동 호수공원역 센트럴시티"],
  ["신흥덕롯데캐슬레이시티", "용인시 기흥구 신갈동 신흥덕롯데캐슬레이시티"],
  ["동탄역푸르지오", "화성시 영천동 동탄역푸르지오"],
  ["동탄2하우스디더레이크", "화성시 송동 동탄2하우스디더레이크"],
  ["한신더휴", "화성시 목동 한신더휴"],
  ["수원역푸르지오자이", "수원시 팔달구 고등동 수원역푸르지오자이"],
  ["기흥역파크푸르지오", "용인시 기흥구 구갈동 기흥역파크푸르지오"],
  ["수원하늘채더퍼스트1단지", "수원시 권선구 곡반정동 수원하늘채더퍼스트"],
  ["동탄역더샵센트럴시티2차", "화성시 여울동 동탄역더샵센트럴시티2차"],
  ["광교더포레스트", "수원시 영통구 하동 광교더포레스트"],
  ["KCC스위첸아파트", "화성시 청계동 KCC스위첸"],
  ["더레이크시티부영2단지", "화성시 산척동 더레이크시티부영2단지"],
  ["화서역푸르지오더에듀포레", "수원시 장안구 천천동 화서역푸르지오더에듀포레"],
  ["힐스테이트푸르지오수원", "수원시 팔달구 매교동 힐스테이트푸르지오수원"],
  ["수원화서역동문굿모닝힐", "수원시 팔달구 화서동 수원화서역동문굿모닝힐"],
  ["더레이크시티부영5단지", "화성시 산척동 더레이크시티부영5단지"],
  ["동탄레이크자연앤푸르지오", "화성시 장지동 동탄레이크자연앤푸르지오"],
  ["동탄역대방디엠시티더센텀", "화성시 영천동 동탄역대방디엠시티더센텀"],
  ["북수원자이렉스비아", "수원시 장안구 정자동 북수원자이렉스비아"],
  ["한양수자인성남마크뷰", "성남시 수정구 금광동 한양수자인성남마크뷰"],
  ["동탄역동원로얄듀크1차", "화성시 영천동 동탄역동원로얄듀크"],
  ["동천파크자이", "용인시 수지구 동천동 동천파크자이"],
  ["영통아이파크캐슬3단지", "수원시 영통구 망포동 영통아이파크캐슬3단지"],
  ["금호어울림레이크", "화성시 장지동 금호어울림레이크"],
  ["매교역푸르지오SKVIEW", "수원시 팔달구 매교동 매교역푸르지오"],
  ["광교역참누리포레스트", "수원시 영통구 이의동 광교역참누리포레스트"],
  ["반정아이파크캐슬5단지", "화성시 반정동 반정아이파크캐슬5단지"],
  ["가천대역두산위브", "성남시 중원구 태평동 가천대역두산위브"],
  ["수원센트럴아이파크자이", "수원시 팔달구 인계동 수원센트럴아이파크자이"],
  ["신동탄포레자이", "화성시 반월동 신동탄포레자이"],
  ["래미안금광", "성남시 수정구 금광동 래미안금광"],
  ["만현마을쌍용1차", "용인시 수지구 상현동 만현마을쌍용1차"],
  ["신봉마을LG자이1차", "용인시 수지구 신봉동 신봉마을LG자이1차"],
  ["현암마을대우넷씨빌", "용인시 수지구 죽전동 현암마을대우넷씨빌"],
  ["매탄위브하늘채", "수원시 영통구 매탄동 매탄위브하늘채"],
  ["새터마을죽전힐스테이트", "용인시 수지구 죽전동 새터마을죽전힐스테이트"],
  ["영통아이파크캐슬1단지", "수원시 영통구 망포동 영통아이파크캐슬1단지"],
  ["영통아이파크캐슬2단지", "수원시 영통구 망포동 영통아이파크캐슬2단지"],
  ["힐스테이트광교산", "용인시 수지구 신봉동 힐스테이트광교산"],
  ["하남덕풍역파크어울림", "하남시 덕풍동 하남덕풍역파크어울림"],
  ["동탄역센트럴푸르지오", "화성시 청계동 동탄역센트럴푸르지오"],
  ["반도유보라아이비파크3", "화성시 동탄 반도유보라아이비파크3"],
  ["동탄역중흥에스클래스", "화성시 여울동 동탄역중흥에스클래스"],
  ["중흥에스클래스에듀하이", "화성시 산척동 중흥에스클래스에듀하이"],
  ["동탄역 호반 써밋", "화성시 청계동 동탄역호반써밋"],
  ["동탄역모아미래도", "화성시 청계동 동탄역모아미래도"],
  ["동탄역대원칸타빌포레지움", "화성시 청계동 동탄역대원칸타빌포레지움"],
  ["동탄역신안인스빌리베라2차", "화성시 청계동 동탄역신안인스빌리베라2차"],
  ["동탄역신안인스빌리베라1차", "화성시 청계동 동탄역신안인스빌리베라1차"],
  ["동탄역센트럴상록아파트", "화성시 영천동 동탄역센트럴상록아파트"],
  ["서광교파크스위첸", "수원시 장안구 연무동 서광교파크스위첸"],
  ["영통SKVIEW", "수원시 영통구 망포동 영통SKVIEW"],
  ["용인동백두산위브더제니스", "용인시 기흥구 동백동 용인동백두산위브더제니스"],
  ["보정동샬레파인비스타", "용인시 기흥구 보정동 보정동샬레파인비스타"],
  ["더샵동천포레스트", "용인시 수지구 동천동 더샵동천포레스트"],
  ["한양수자인", "용인시 기흥구 영덕동 한양수자인"],
  ["솔빛마을신도브래뉴", "화성시 반송동 솔빛마을신도브래뉴"],
  ["솔빛마을쌍용예가", "화성시 반송동 솔빛마을쌍용예가"],
  ["호반베르디움더센트럴", "수원시 권선구 금곡동 호반베르디움더센트럴"],
  ["흥덕마을7단지힐스테이트", "용인시 기흥구 영덕동 흥덕마을7단지힐스테이트"],
  ["흥덕마을자연앤스위첸", "용인시 기흥구 영덕동 흥덕마을자연앤스위첸"],
  ["신봉마을자이3차", "용인시 수지구 신봉동 신봉마을자이3차"],
  ["반정아이파크캐슬4단지", "화성시 반정동 반정아이파크캐슬4단지"],
  ["병점역아이파크캐슬", "화성시 병점동 병점역아이파크캐슬"],
  ["에코타운(B블럭)", "하남시 신장동 에코타운B블럭"],
  ["기흥역 롯데캐슬 레이시티", "용인시 기흥구 구갈동 기흥역롯데캐슬레이시티"],
  ["꽃메마을힐스테이트4차2단지", "용인시 수지구 죽전동 꽃메마을힐스테이트4차2단지"],
  ["만현마을3단지성원쌍떼빌", "용인시 수지구 상현동 만현마을3단지성원쌍떼빌"],
  ["상현마을현대성우1차", "용인시 수지구 상현동 상현마을현대성우1차"],
  ["성복역리버파크", "용인시 수지구 상현동 성복역리버파크"],
  ["행원마을동아솔레시티", "용인시 기흥구 보정동 행원마을동아솔레시티"],
  ["수지푸르지오월드마크", "용인시 수지구 풍덕천동 수지푸르지오월드마크"],
  ["하남힐즈파크푸르지오2단지", "하남시 풍산동 하남힐즈파크푸르지오2단지"],
  ["나노시티역롯데캐슬", "화성시 반월동 나노시티역롯데캐슬"],
  ["한화포레나동탄호수", "화성시 장지동 한화포레나동탄호수"],
  ["가천대역동부센트레빌2단지", "성남시 중원구 태평동 가천대역동부센트레빌2단지"],
  ["광교 해모로 아파트", "수원시 영통구 이의동 광교해모로"],
  ["광교LAKEPARK한양수자인", "수원시 영통구 하동 광교레이크파크한양수자인"],
  ["광교대광로제비앙", "수원시 영통구 이의동 광교대광로제비앙"],
  ["광교레이크포레", "용인시 수지구 상현동 광교레이크포레"],
  ["광교모아엘가레이크뷰", "수원시 영통구 하동 광교모아엘가레이크뷰"],
  ["광교모아엘가레이크파크", "수원시 영통구 하동 광교모아엘가레이크파크"],
  ["광교산자이", "용인시 수지구 신봉동 광교산자이"],
  ["광교상현마을현대", "용인시 수지구 상현동 광교상현마을현대"],
  ["광교쌍용포레듀엔(2-C)", "용인시 수지구 상현동 광교쌍용포레듀엔"],
  ["기흥더샵프라임뷰", "용인시 기흥구 신갈동 기흥더샵프라임뷰"],
  ["기흥역더샵", "용인시 기흥구 구갈동 기흥역더샵"],
  ["기흥역지웰푸르지오", "용인시 기흥구 구갈동 기흥역지웰푸르지오"],
  ["꽃메마을힐스테이트(4차3단지)", "용인시 수지구 죽전동 꽃메마을힐스테이트4차3단지"],
  ["꽃메마을힐스테이트(4차4단지)", "용인시 수지구 죽전동 꽃메마을힐스테이트4차4단지"],
  ["꿈동산신안", "하남시 창우동 꿈동산신안"],
  ["나루마을한화꿈에그린우림필유", "화성시 반송동 나루마을한화꿈에그린"],
  ["내대지마을건영캐스빌", "용인시 수지구 죽전동 내대지마을건영캐스빌"],
  ["대명강변타운", "하남시 신장동 대명강변타운"],
  ["대지마을죽전현대홈타운2차", "용인시 수지구 죽전동 대지마을죽전현대홈타운2차"],
  ["더레이크시티부영1단지", "화성시 산척동 더레이크시티부영1단지"],
  ["더리버하임", "용인시 수지구 죽전동 더리버하임"],
  ["더샵광교산퍼스트파크", "수원시 장안구 조원동 더샵광교산퍼스트파크"],
  ["도담마을롯데캐슬", "용인시 수지구 죽전동 도담마을롯데캐슬"],
  ["도현마을현대", "용인시 기흥구 신갈동 도현마을현대"],
  ["동문그린", "용인시 수지구 동천동 동문그린"],
  ["동부", "용인시 기흥구 풍덕천동 동부"],
  ["동성1차", "용인시 수지구 죽전동 동성1차"],
  ["동천마을영풍아파트", "용인시 수지구 동천동 동천마을영풍"],
  ["동탄시범다은마을 메타역 롯데캐슬", "화성시 반송동 시범다은마을롯데캐슬"],
  ["동탄시범다은마을 월드메르디앙 반도유보라", "화성시 반송동 시범다은마을반도유보라"],
  ["동탄역경남아너스빌", "화성시 영천동 동탄역경남아너스빌"],
  ["동탄호수자이파밀리에", "화성시 장지동 동탄호수자이파밀리에"],
  ["두산", "성남시 중원구 신흥동 두산아파트"],
  ["래미안노블클래스1단지", "수원시 팔달구 인계동 래미안노블클래스1단지"],
  ["래미안영통마크원1단지", "수원시 영통구 신동 래미안영통마크원1단지"],
  ["래미안영통마크원2단지", "수원시 영통구 신동 래미안영통마크원2단지"],
  ["만현마을9단지엘지자이", "용인시 수지구 상현동 만현마을9단지엘지자이"],
  ["미도", "성남시 중원구 단대동 미도아파트"],
  ["미사강변트래지안", "하남시 망월동 미사강변트래지안"],
  ["벽산블루밍4단지", "용인시 수지구 죽전동 벽산블루밍4단지"],
  ["보뜨랑벽산", "용인시 수지구 동천동 보뜨랑벽산"],
  ["블루밍구성더센트럴", "용인시 기흥구 마북동 블루밍구성더센트럴"],
  ["삼부", "성남시 중원구 수진동 삼부아파트"],
  ["서홍마을4", "용인시 수지구 신봉동 서홍마을4"],
  ["서홍마을한화꿈에그린", "용인시 수지구 신봉동 서홍마을한화꿈에그린"],
  ["성남자이", "성남시 수정구 하대원동 성남자이"],
  ["성동마을수지자이", "용인시 수지구 성복동 성동마을수지자이"],
  ["성복아이파크", "용인시 수지구 성복동 성복아이파크"],
  ["수원 SK SKY VIEW", "수원시 장안구 정자동 수원SK스카이뷰"],
  ["수원모아미래도센트럴타운1단지", "수원시 권선구 금곡동 수원모아미래도센트럴타운1단지"],
  ["수원모아미래도센트럴타운2단지", "수원시 권선구 금곡동 수원모아미래도센트럴타운2단지"],
  ["수지삼성4차", "용인시 수지구 풍덕천동 수지삼성4차"],
  ["시범다은마을삼성래미안", "화성시 반송동 시범다은마을삼성래미안"],
  ["시범다은마을포스코더샵", "화성시 반송동 시범다은마을포스코더샵"],
  ["시범한빛마을금호어울림", "화성시 반송동 시범한빛마을금호어울림"],
  ["시범한빛마을동탄아이파크", "화성시 반송동 시범한빛마을동탄아이파크아파트"],
  ["시범한빛마을삼부르네상스", "화성시 반송동 시범한빛마을삼부르네상스"],
  ["시범한빛마을한화꿈에그린", "화성시 반송동 시범한빛마을한화꿈에그린"],
  ["신나무실극동", "수원시 영통구 영통동 신나무실극동"],
  ["신나무실풍림", "수원시 영통구 영통동 신나무실풍림"],
  ["신봉동일하이빌4단지", "용인시 수지구 신봉동 신봉동일하이빌4단지"],
  ["신촌마을상록데시앙", "용인시 기흥구 보정동 신촌마을상록데시앙"],
  ["써니벨리", "용인시 수지구 동천동 써니벨리"],
  ["아튼빌", "성남시 수정구 하대원동 아튼빌"],
  ["연원마을삼성명가타운", "용인시 기흥구 보정동 연원마을삼성명가타운"],
  ["영통롯데캐슬엘클래스1단지", "수원시 영통구 망포동 영통롯데캐슬엘클래스1단지"],
  ["영통롯데캐슬엘클래스2단지", "수원시 영통구 망포동 영통롯데캐슬엘클래스2단지"],
  ["영통에듀파크(321동~327동)", "수원시 영통구 영통동 영통에듀파크"],
  ["영통에듀파크(331동~337동)", "수원시 영통구 영통동 영통에듀파크"],
  ["용인수지휴엔하임", "용인시 수지구 상현동 용인수지휴엔하임"],
  ["우남퍼스트빌", "용인시 수지구 신봉동 우남퍼스트빌"],
  ["우미이노스빌", "용인시 수지구 동천동 우미이노스빌"],
  ["은행주공", "성남시 수정구 은행동 은행주공"],
  ["인현마을힐스테이트(7차1단지)", "용인시 수지구 죽전동 인현마을힐스테이트7차1단지"],
  ["장미마을삼성래미안2", "용인시 기흥구 언남동 장미마을삼성래미안2"],
  ["진모루마을현대", "하남시 덕풍동 진모루마을현대"],
  ["진산마을성원상떼빌아파트", "용인시 수지구 상현동 진산마을성원상떼빌"],
  ["진흥더블파크", "성남시 중원구 단대동 진흥더블파크"],
  ["청구", "성남시 중원구 신흥동 청구아파트"],
  ["파크시엘", "용인시 기흥구 신갈동 파크시엘"],
  ["풍산아파트", "용인시 수지구 상현동 풍산아파트"],
  ["한화 포레나 동탄호수", "화성시 장지동 한화포레나동탄호수"],
  ["행림마을진로", "용인시 수지구 동천동 행림마을진로"],
  ["현대", "수원시 장안구 풍덕천동 현대아파트"],
  ["현암마을동성2차", "용인시 수지구 죽전동 현암마을동성2차"],
  ["호반써밋레이크파크", "용인시 기흥구 영덕동 호반써밋레이크파크"],
  ["화서주공3단지", "수원시 팔달구 화서동 화서주공3단지"],
  ["화서주공4단지", "수원시 팔달구 화서동 화서주공4단지"],
  ["흥덕우미린 레이크포레", "용인시 기흥구 영덕동 흥덕우미린레이크포레"],
  ["힐스테이트서천", "용인시 기흥구 서천동 힐스테이트서천"],
];

// (LEGACY_CANDIDATES는 data.json 로드 실패 시 fallback으로만 사용)

// ── API ────────────────────────────────────────────────

interface GeoResult {
  lat: number;
  lng: number;
  name: string;
}

async function geocode(query: string): Promise<GeoResult | null> {
  for (const endpoint of [
    "https://dapi.kakao.com/v2/local/search/keyword.json",
    "https://dapi.kakao.com/v2/local/search/address.json",
  ]) {
    const params = new URLSearchParams({ query, size: "1" });
    const data = await kakaoJson(() => `${endpoint}?${params}`, "local");
    if (data.documents?.length) {
      const doc = data.documents[0];
      return {
        lat: parseFloat(doc.y),
        lng: parseFloat(doc.x),
        name: doc.place_name ?? doc.address_name ?? "",
      };
    }
  }
  return null;
}

// 단지 좌표 캐시 (name → {lat,lng,query}). 좌표는 불변이라 매일 geocode를 생략한다.
// query(도로명주소)가 바뀐 단지만 재조회.
let coordsCache: Record<string, { lat: number; lng: number; query: string }> = {};
async function loadCoordsCache() {
  const f = Bun.file(COORDS_CACHE_PATH);
  if (await f.exists()) {
    try {
      coordsCache = await f.json();
    } catch {
      coordsCache = {};
    }
  }
}
async function geocodeCached(name: string, query: string): Promise<GeoResult | null> {
  const c = coordsCache[name];
  if (c && c.query === query) return { lat: c.lat, lng: c.lng, name };
  const g = await geocode(query);
  if (g) coordsCache[name] = { lat: g.lat, lng: g.lng, query };
  return g;
}

async function driveTime(
  sLat: number,
  sLng: number,
  gLat: number,
  gLng: number,
): Promise<{ minutes: number; distance: number } | null> {
  const params = new URLSearchParams({
    origin: `${sLng},${sLat}`,
    destination: `${gLng},${gLat}`,
    priority: "RECOMMEND",
  });
  const data = await kakaoJson(
    () => `https://apis-navi.kakaomobility.com/v1/directions?${params}`,
    "navi",
  );
  const summary = data.routes?.[0]?.summary;
  if (!summary) return null;
  return {
    minutes: Math.floor(summary.duration / 60),
    distance: summary.distance,
  };
}

// ── 메인 ───────────────────────────────────────────────

const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

interface Measurement {
  name: string;
  minutes: number;
  distance_km: number;
  at: string; // 실제 측정 시각 "HH:MM" (병렬 측정이라 단지마다 다를 수 있음 → 시각 정직 기록)
}

async function main() {
  const reverse = process.argv.includes("--reverse");
  const force = process.argv.includes("--force");
  const direction = reverse ? "퇴근" : "출근";
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  // --limit=N: 앞 N개만 측정하는 테스트 모드. 저장/배포 생략(실데이터 비오염).
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
  const testMode = Number.isFinite(limit);

  const now = new Date();

  // 출퇴근 측정은 평일만 (주말·공휴일은 교통 패턴이 달라 통계 오염).
  if (!force && isNonBusinessDay(now)) {
    console.log("⏭  주말/공휴일 — 출퇴근 측정 스킵 (--force로 강제 실행 가능)");
    return;
  }
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${hhmm(now)}`;
  const weekday = weekdays[now.getDay()];

  console.log(
    `[${timestamp} (${weekday})] ${direction} 시간 측정 시작${testMode ? ` (테스트 ${limit}건)` : ""}`,
  );
  console.log(`${reverse ? "출발지" : "목적지"}: ${DESTINATION}`);

  await loadCoordsCache();
  const dest = await geocode(DESTINATION);
  if (!dest) {
    console.log("ERROR: 판교아지트 좌표 조회 실패");
    return;
  }
  console.log(
    `판교아지트 좌표: ${dest.name} (${dest.lat.toFixed(4)}, ${dest.lng.toFixed(4)})\n`,
  );

  // 후보 목록: data.json 기반 (실패 시 레거시 목록)
  let candidates: [string, string][];
  try {
    candidates = await loadCandidates();
    console.log(`data.json에서 ${candidates.length}개 아파트 로드`);
  } catch {
    const seen = new Set<string>();
    candidates = LEGACY_CANDIDATES.filter(([name]) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
    console.log(`data.json 로드 실패, 레거시 목록 ${candidates.length}개 사용`);
  }
  if (testMode) candidates = candidates.slice(0, limit);

  // 병렬 측정 (동시성 CONCURRENCY). 좌표는 캐시 우선 → directions만 호출.
  const measured: Measurement[] = [];
  const started = new Date();
  let next = 0;
  let fatal: QuotaExceededError | null = null;

  async function worker() {
    while (true) {
      if (fatal) return;
      const i = next++;
      if (i >= candidates.length) return;
      const [name, query] = candidates[i];
      try {
        const geo = await geocodeCached(name, query);
        if (!geo) {
          console.log(`  SKIP ${name}: 좌표 조회 실패`);
          continue;
        }
        const dt = reverse
          ? await driveTime(dest.lat, dest.lng, geo.lat, geo.lng)
          : await driveTime(geo.lat, geo.lng, dest.lat, dest.lng);
        if (!dt) {
          console.log(`  SKIP ${name}: 경로 조회 실패`);
          continue;
        }
        measured.push({
          name,
          minutes: dt.minutes,
          distance_km: Math.round((dt.distance / 1000) * 10) / 10,
          at: hhmm(new Date()),
        });
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          fatal = e;
          return;
        }
        throw e;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const ended = new Date();
  const elapsed = Math.round((ended.getTime() - started.getTime()) / 1000);

  // 좌표 캐시 저장 (신규 단지 좌표 반영)
  await Bun.write(COORDS_CACHE_PATH, JSON.stringify(coordsCache));

  if (fatal) {
    // 모든 키 일일 할당량 소진 → 불완전 batch는 통계를 왜곡하므로 저장/배포하지 않고 종료.
    console.error(
      `\n⛔ 카카오 길찾기 일일 할당량 초과(키 ${KAKAO_KEYS.length}개 모두 소진): ${fatal.message}\n` +
        `   ${measured.length}/${candidates.length}건만 측정됨 — 불완전 batch는 저장하지 않습니다.\n` +
        `   해결: 키 추가(.env KAKAO_REST_API_KEY_3...) 또는 측정 대상/주기 조정.`,
    );
    process.exit(1);
  }

  // 측정 시각 분포 (윈도우가 좁을수록 단지 간 비교가 공정)
  const ats = measured.map((m) => m.at).sort();
  console.log(
    `\n측정 완료: ${measured.length}/${candidates.length}건, ${elapsed}초 (${ats[0]}~${ats[ats.length - 1]})`,
  );

  if (testMode) {
    console.log("테스트 모드 — 저장/배포 생략. 샘플:");
    for (const m of measured.slice(0, 8))
      console.log(`  ${m.name}: ${m.minutes}분 ${m.distance_km}km @${m.at}`);
    return;
  }

  // 기존 결과에 추가
  const historyFile = Bun.file(OUT_PATH);
  const history: any[] = (await historyFile.exists())
    ? await historyFile.json()
    : [];

  history.push({
    timestamp,
    started: hhmm(started),
    ended: hhmm(ended),
    weekday,
    direction,
    destination: dest.name,
    destination_query: DESTINATION,
    results: measured,
  });

  await Bun.write(OUT_PATH, JSON.stringify(history, null, 2));
  console.log(`저장: ${OUT_PATH} (총 ${history.length}회 측정)`);

  // 스코어링 배포
  await sync();
}

main();
