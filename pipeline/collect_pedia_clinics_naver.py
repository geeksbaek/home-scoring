#!/usr/bin/env python3
"""
소아과 거리 데이터 빌더 — pediatric_clinics.json (네이버지도 병원 검색 GraphQL).

각 단지 좌표(dong_coords_naver) 기준 pcmap-api GraphQL getNxList,
department="소아청소년과"(HIRA 진료과목 필터) + bounds box.
→ 상호/카테고리에 소아과가 없어도 진료과목 등록 기관이 잡힘
  (예: 백운밸리 연세메디의원 — category "병원,의원"이지만 소아청소년과 전문의 1인).
→ 채택 조건: category에 "소아청소년과" 포함 OR HIRA 소아청소년과 전문의 ≥1
  (진료과목만 걸어둔 내과/가정의학과 배제).
→ 반경 2km, 없으면 5km 확장 → 거리순 top 2 → road_m/walk_min 추정.

- curl_cffi Chrome TLS 임퍼소네이트 필수 (Bun fetch는 429).
- GraphQL은 x-wtm-graphql 헤더만 있으면 ncaptcha 토큰 없이 동작 (2026-06 확인).
- 매 건 즉시 저장(크래시 대비), 기본 모드는 미수집 단지만(resume).
- --refresh: 전체 단지 재검색. 새 결과가 있을 때만 덮어쓰고(빈 결과면 기존 유지),
  병원 목록이 바뀐 단지는 pedia_slope.json 엔트리 삭제(고저차 재계산 유도).
- 구버전 카카오 검색: pipeline/collect_pedia_clinics.ts (fallback용으로 유지).

Usage: python3 pipeline/collect_pedia_clinics_naver.py [--refresh]
"""
import base64, json, math, os, sys, time
from pathlib import Path
from curl_cffi import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CLINICS_PATH = DATA / "pediatric_clinics.json"
SLOPE_PATH = DATA / "pedia_slope.json"
RADII = [2000, 5000]  # 2km 무결과 시 5km 확장 (의왕백운밸리 등 신도시: 최근접 2.8km+)
REFRESH = "--refresh" in sys.argv


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


def is_pediatric(item):
    if "소아청소년과" in str(item.get("category", "")):
        return True
    return any(h.get("name") == "소아청소년과" and (h.get("count") or 0) >= 1
               for h in item.get("hiraSpecialists") or [])


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


def to_entry(c):
    road = round(c["dist"] * 1.3)  # 도로 보정 1.3배
    return {"name": c["name"], "straight_m": c["dist"],
            "road_m": road, "walk_min": round(road / 80)}  # 분당 80m


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

    new_entries = [to_entry(c) for c in result[:2]]
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
