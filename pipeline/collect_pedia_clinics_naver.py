#!/usr/bin/env python3
"""
소아과 거리 데이터 빌더 — pediatric_clinics.json (네이버지도 병원 검색 GraphQL).

각 단지 좌표(dong_coords_naver) 기준 pcmap-api GraphQL getNxList,
department="소아청소년과"(HIRA 진료과목 필터) + bounds box.
→ 상호/카테고리에 소아과가 없어도 진료과목 등록 기관이 잡힘
  (예: 백운밸리 연세메디의원 — category "병원,의원"이지만 소아청소년과 전문의 1인).
→ 채택 조건: category에 "소아청소년과" 포함 OR HIRA 소아청소년과 전문의 ≥1
  (진료과목만 걸어둔 내과/가정의학과 배제).
→ 반경 2km, 없으면 5km 확장 → 거리순 top 2 → road_m/walk_min 실측(도보 경로 API).

- curl_cffi Chrome TLS 임퍼소네이트 필수 (Bun fetch는 429).
- GraphQL은 x-wtm-graphql 헤더만 있으면 ncaptcha 토큰 없이 동작 (2026-06 확인).
- 매 건 즉시 저장(크래시 대비), 기본 모드는 미수집 단지만(resume).
- --refresh: 전체 단지 재검색. 새 결과가 있을 때만 덮어쓰고(빈 결과면 기존 유지),
  병원 목록이 바뀐 단지는 pedia_slope.json 엔트리 삭제(고저차 재계산 유도).
- 구버전 카카오 검색: pipeline/collect_pedia_clinics.ts (fallback용으로 유지).

도보 경로 실측 (2026-07-21 출시 카카오맵 도보 경로 조회 API):
  GET https://dapi.kakao.com/v2/local/directions/walk.json
  Authorization: KakaoAK {KAKAO_REST_API_KEY}  (geocoding과 동일 키)
  Params: origin={lng},{lat}  destination={lng},{lat}  (경도,위도 순)
  Response: routes[0].summary.{distance(m), duration(s)}
  무료 한도: 첫 앱 1,000건/일; 초과 시 ₩10/건 (2026 할인 기간)
  ※ 엔드포인트/파라미터명은 로컬에서 공식 문서(developers.kakao.com/docs/latest/ko/local/dev-guide)
    확인 후 WALK_ENDPOINT / _walk_params() 를 수정할 것 (클라우드 세션에서 docs 403)

- API 실패 또는 일일 한도 초과 시 기존 '직선거리 × 1.3 ÷ 80m/분' 추정으로 graceful fallback.
- 출력 필드 호환: straight_m / road_m / walk_min.

Usage: python3 pipeline/collect_pedia_clinics_naver.py [--refresh]
"""
import base64, json, math, os, sys, time
from datetime import date
from pathlib import Path
from curl_cffi import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CLINICS_PATH = DATA / "pediatric_clinics.json"
SLOPE_PATH = DATA / "pedia_slope.json"
WALK_QUOTA_PATH = DATA / "walk_api_quota.json"
RADII = [2000, 5000]  # 2km 무결과 시 5km 확장 (의왕백운밸리 등 신도시: 최근접 2.8km+)
REFRESH = "--refresh" in sys.argv

# ── 카카오맵 도보 경로 조회 API 설정 ─────────────────────────────────────────
# 엔드포인트: 2026-07-21 출시. 로컬에서 공식 문서 확인 후 수정 필요.
WALK_ENDPOINT = "https://dapi.kakao.com/v2/local/directions/walk.json"
KAKAO_WALK_DAILY_LIMIT = 990   # 1,000 무료/일 중 10 버퍼 확보
# ──────────────────────────────────────────────────────────────────────────────


def haversine(lat1, lng1, lat2, lng2):
    R = 6371000
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lng2 - lng1) * p / 2) ** 2)
    return round(2 * R * math.asin(math.sqrt(a)))


s = requests.Session(impersonate="chrome")


GQL = """query getNxList($input: HospitalListInput) {
  businesses: hospitals(input: $input) {
    total
    items { id name category x y hiraSpecialists { name count } }
  }
}"""
WTM = base64.b64encode(json.dumps(
    {"arg": "소아청소년과", "type": "hospital", "source": "place"},
    ensure_ascii=False).encode()).decode()


# 소아 진료과목/전문의가 있어도 '동네 소아과'로 부적합한 기관
EXCLUDE_PATTERNS = ("보건소", "보건지소", "보건분소", "보건의료원",
                    "한방", "한의원", "치과", "요양병원")


def is_pediatric(item):
    name = str(item.get("name", ""))
    cat = str(item.get("category", ""))
    if any(b in name or b in cat for b in EXCLUDE_PATTERNS):
        return False
    if "소아청소년과" in cat:
        return True
    hira = {h.get("name"): h.get("count") or 0 for h in item.get("hiraSpecialists") or []}
    ped = hira.get("소아청소년과", 0)
    if ped < 1:
        return False
    # 정신건강의학과 중심 기관(시립 정신병원 등) 배제
    if hira.get("정신건강의학과", 0) > ped:
        return False
    return True


def query_naver(lat, lng, radius):
    """GraphQL getNxList(department=소아청소년과, bounds=radius box). 실패 시 None."""
    dlat = radius / 111320
    dlng = radius / (111320 * math.cos(lat * math.pi / 180))
    bounds = f"{lng - dlng};{lat - dlat};{lng + dlng};{lat + dlat}"
    payload = [{
        "operationName": "getNxList",
        "variables": {"input": {
            "query": "소아청소년과", "display": 70, "start": 1,
            "filterBooking": False, "filterOpentime": False, "filterSpecialist": False,
            # distance 정렬: 밀집 지역에서 display 70 잘림 시 최근접 누락 방지
            "sortingOrder": "distance", "x": str(lng), "y": str(lat),
            "clientX": str(lng), "clientY": str(lat), "day": None,
            "department": "소아청소년과", "bounds": bounds,
            "deviceType": "pcmap", "isCurrentLocationSearch": True}},
        "query": GQL,
    }]
    for attempt in range(4):
        try:
            r = s.post("https://pcmap-api.place.naver.com/graphql", json=payload, headers={
                "Referer": "https://pcmap.place.naver.com/hospital/list",
                "Origin": "https://pcmap.place.naver.com",
                "Accept": "*/*", "Accept-Language": "ko",
                "x-wtm-graphql": WTM,
            }, timeout=20)
            if r.status_code == 429:
                time.sleep(8 * (attempt + 1))
                continue
            if r.status_code != 200:
                return None
            j = r.json()
            if j[0].get("errors"):
                return None
            return (j[0].get("data", {}).get("businesses") or {}).get("items") or []
        except Exception:
            time.sleep(4 * (attempt + 1))
    return None


def search_clinics(lat, lng):
    """소아청소년과 진료기관 검색, 거리순 top 5. 실패 시 None(기존 데이터 보존용)."""
    for radius in RADII:
        items = query_naver(lat, lng, radius)
        if items is None:
            return None
        cands = []
        for v in items:
            if not is_pediatric(v) or not v.get("x") or not v.get("y"):
                continue
            cat = str(v.get("category", ""))
            cands.append({
                "id": str(v.get("id", "")),
                "name": " ".join(str(v.get("name", "")).split()),
                "dist": haversine(lat, lng, float(v["y"]), float(v["x"])),
                # 종합·대학병원은 동네 소아과 용도로 후순위 (대안 없으면 채택)
                "big": any(k in cat for k in ("종합병원", "대학병원")),
                "x": v["x"],   # 경도 (Naver x = longitude)
                "y": v["y"],   # 위도 (Naver y = latitude)
            })
        cands.sort(key=lambda c: (c["big"], c["dist"]))
        dedup, seen = [], set()
        for c in cands:
            if c["id"] in seen or c["dist"] > radius:
                continue
            seen.add(c["id"])
            dedup.append(c)
        if dedup:
            return dedup[:5]
        time.sleep(0.2)
    return []


# ── 카카오맵 도보 경로 조회 API ───────────────────────────────────────────────
_kakao_walk_key = os.environ.get("KAKAO_REST_API_KEY", "")
_walk_api_count = 0    # 이번 실행에서 API 성공 호출 수
_walk_fallback_count = 0  # fallback(직선×1.3) 적용 수


def _load_quota():
    """오늘 날짜 기준 일일 사용량 로드. 날짜가 다르면 0으로 리셋."""
    today = str(date.today())
    if WALK_QUOTA_PATH.exists():
        try:
            q = json.load(open(WALK_QUOTA_PATH))
            if q.get("date") == today:
                return q
        except Exception:
            pass
    return {"date": today, "count": 0}


def _save_quota(q):
    WALK_QUOTA_PATH.write_text(json.dumps(q))


_quota = _load_quota()


def walk_route_kakao(slat, slng, dlat, dlng):
    """카카오맵 도보 경로 조회 API 호출.

    성공 시 (road_m: int, walk_min: int) 반환.
    키 미설정 / 일일 한도 초과 / 호출 실패 시 (None, None) 반환.

    API 스펙 (2026-07-21 출시):
      GET https://dapi.kakao.com/v2/local/directions/walk.json
      Authorization: KakaoAK {KAKAO_REST_API_KEY}
      origin={경도},{위도}  destination={경도},{위도}
      응답: routes[0].summary.distance(m) / duration(s)
      무료: 첫 앱 1,000건/일; 초과 ₩10/건 (2026 할인 기간)
    """
    global _quota, _walk_api_count, _walk_fallback_count
    if not _kakao_walk_key:
        _walk_fallback_count += 1
        return None, None
    if _quota["count"] >= KAKAO_WALK_DAILY_LIMIT:
        _walk_fallback_count += 1
        return None, None
    params = {
        "origin": f"{slng},{slat}",        # 카카오 좌표 형식: 경도,위도
        "destination": f"{dlng},{dlat}",
    }
    headers = {"Authorization": f"KakaoAK {_kakao_walk_key}"}
    for attempt in range(3):
        try:
            r = s.get(WALK_ENDPOINT, params=params, headers=headers, timeout=10)
            if r.status_code == 429:
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code != 200:
                _walk_fallback_count += 1
                return None, None
            j = r.json()
            routes = j.get("routes") or []
            if not routes or routes[0].get("result_code") != 0:
                _walk_fallback_count += 1
                return None, None
            summary = routes[0].get("summary", {})
            dist_m = summary.get("distance")
            dur_s = summary.get("duration")
            if dist_m is None or dur_s is None:
                _walk_fallback_count += 1
                return None, None
            _quota["count"] += 1
            _save_quota(_quota)
            _walk_api_count += 1
            return int(dist_m), max(1, round(dur_s / 60))
        except Exception:
            time.sleep(2 * (attempt + 1))
    _walk_fallback_count += 1
    return None, None
# ──────────────────────────────────────────────────────────────────────────────


def to_entry(c, apt_lat=None, apt_lng=None):
    """소아과 후보를 출력 엔트리로 변환.

    카카오맵 도보 경로 API로 road_m/walk_min 실측.
    API 실패·한도 초과 시 직선거리 × 1.3 ÷ 80m/분 추정으로 fallback.
    출력 필드: straight_m / road_m / walk_min (기존 호환 유지).
    """
    straight = c["dist"]
    road, walk_min = None, None
    if apt_lat is not None and apt_lng is not None:
        road, walk_min = walk_route_kakao(apt_lat, apt_lng, float(c["y"]), float(c["x"]))
    if road is None:  # fallback: 직선×1.3, 분당 80m
        road = round(straight * 1.3)
        walk_min = round(road / 80)
    return {"name": c["name"], "straight_m": straight,
            "road_m": road, "walk_min": walk_min}


clinics = json.load(open(CLINICS_PATH)) if CLINICS_PATH.exists() else {}
slope = json.load(open(SLOPE_PATH)) if SLOPE_PATH.exists() else {}
coords = json.load(open(DATA / "dong_coords_naver.json"))
identity = json.load(open(DATA / "apt_identity.json"))

# ONLY_NAMES=파일경로(JSON 배열) — 해당 단지만 처리 (실패분 재시도용)
only = set(json.load(open(os.environ["ONLY_NAMES"]))) if os.environ.get("ONLY_NAMES") else None

targets = []
for e in identity:
    name = e["name"]
    c = coords.get(name)
    if not c or not isinstance(c, list) or not c[0].get("lat"):
        continue
    if only is not None and name not in only:
        continue
    if only is None and not REFRESH and clinics.get(name):
        continue
    targets.append((name, c))

print(f"대상: {len(targets)}개 단지 ({'전체 refresh' if REFRESH else '미수집만'})", flush=True)
if _kakao_walk_key:
    remaining = KAKAO_WALK_DAILY_LIMIT - _quota["count"]
    print(f"도보 경로 API: 오늘 {_quota['count']}건 사용 / {remaining}건 잔여 "
          f"(일 한도 {KAKAO_WALK_DAILY_LIMIT}건, 초과분 직선×1.3 fallback)", flush=True)
    if remaining < len(targets) * 2:
        print(f"⚠️  잔여 한도({remaining}건)가 예상 호출량({len(targets) * 2}건)보다 적음 "
              f"— 한도 초과분은 자동 fallback 처리됩니다.", flush=True)
else:
    print("⚠️  KAKAO_REST_API_KEY 미설정 → 직선×1.3 추정 사용 (도보 경로 API 비활성)", flush=True)

done = saved = changed_slope = 0
for name, dongs in targets:
    lat = sum(d["lat"] for d in dongs) / len(dongs)
    lng = sum(d["lng"] for d in dongs) / len(dongs)
    result = search_clinics(lat, lng)
    done += 1

    if result is None:  # 요청 실패 — 기존 데이터 보존
        print(f"[{done}/{len(targets)}] {name}... 요청 실패(기존 유지)", flush=True)
        time.sleep(2)
        continue
    if not result:
        if not clinics.get(name):
            print(f"[{done}/{len(targets)}] {name}... 검색 결과 없음", flush=True)
        time.sleep(0.4)
        continue

    new_entries = [to_entry(c, lat, lng) for c in result[:2]]
    old = clinics.get(name) or []
    if [e["name"] for e in old] != [e["name"] for e in new_entries]:
        if name in slope:
            del slope[name]
            changed_slope += 1
        clinics[name] = new_entries
        saved += 1
        CLINICS_PATH.write_text(json.dumps(clinics, ensure_ascii=False, indent=2))
        SLOPE_PATH.write_text(json.dumps(slope, ensure_ascii=False, indent=2))
        print(f"[{done}/{len(targets)}] {name}: "
              + ", ".join(f'{e["name"]}({e["walk_min"]}분)' for e in new_entries), flush=True)
    time.sleep(0.4)

CLINICS_PATH.write_text(json.dumps(clinics, ensure_ascii=False, indent=2))
SLOPE_PATH.write_text(json.dumps(slope, ensure_ascii=False, indent=2))
print(f"\n갱신 {saved} / 처리 {done} / 고저차 재계산 대상 {changed_slope}", flush=True)
print(f"총 pediatric_clinics: {len(clinics)}개", flush=True)
if _kakao_walk_key:
    print(f"도보 경로 API — 이번 실행 성공: {_walk_api_count}건 / "
          f"fallback(직선×1.3): {_walk_fallback_count}건 / "
          f"오늘 누적: {_quota['count']}건 / 잔여: {KAKAO_WALK_DAILY_LIMIT - _quota['count']}건",
          flush=True)
