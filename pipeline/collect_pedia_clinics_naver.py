#!/usr/bin/env python3
"""
소아과 거리 데이터 빌더 — pediatric_clinics.json (네이버지도 검색).

각 단지 좌표(dong_coords_naver) 기준 네이버 pcmap 검색 "소아과"
→ category "소아청소년과"만 필터(내과/가정의학과 오염 차단)
→ 반경 2km, 없으면 5km 확장 → 거리순 top 2 → road_m/walk_min 추정.

- curl_cffi Chrome TLS 임퍼소네이트 필수 (Bun fetch는 429).
- 매 건 즉시 저장(크래시 대비), 기본 모드는 미수집 단지만(resume).
- --refresh: 전체 단지 재검색. 새 결과가 있을 때만 덮어쓰고(빈 결과면 기존 유지),
  병원 목록이 바뀐 단지는 pedia_slope.json 엔트리 삭제(고저차 재계산 유도).
- 구버전 카카오 검색: pipeline/collect_pedia_clinics.ts (fallback용으로 유지).

Usage: python3 pipeline/collect_pedia_clinics_naver.py [--refresh]
"""
import json, math, os, sys, time
from pathlib import Path
from urllib.parse import quote
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


def search_clinics(lat, lng):
    """네이버 pcmap 검색 → 소아청소년과만, 거리순 top 5. 실패 시 None(기존 데이터 보존용)."""
    url = (f"https://pcmap.place.naver.com/place/list?query={quote('소아과')}"
           f"&x={lng}&y={lat}&clientX={lng}&clientY={lat}&display=50"
           f"&mapUrl=https%3A%2F%2Fmap.naver.com")
    for attempt in range(4):
        try:
            r = s.get(url, headers={"Referer": "https://map.naver.com/"}, timeout=20)
            if r.status_code == 429:
                time.sleep(8 * (attempt + 1))
                continue
            if r.status_code != 200:
                return None
            i = r.text.find("window.__APOLLO_STATE__")
            if i < 0:
                return None
            i = r.text.find("{", i)
            state, _ = json.JSONDecoder().raw_decode(r.text[i:])
            cands = []
            for v in state.values():
                if not isinstance(v, dict) or "Summary" not in str(v.get("__typename", "")):
                    continue
                if "소아청소년과" not in str(v.get("category", "")):
                    continue
                x, y = v.get("x"), v.get("y")
                if not x or not y:
                    continue
                cands.append({
                    "id": str(v.get("id", "")),
                    "name": " ".join(str(v.get("name", "")).split()),
                    "dist": haversine(lat, lng, float(y), float(x)),
                })
            cands.sort(key=lambda c: c["dist"])
            dedup, seen = [], set()
            for c in cands:
                if c["id"] in seen:
                    continue
                seen.add(c["id"])
                dedup.append(c)
            for radius in RADII:
                within = [c for c in dedup if c["dist"] <= radius]
                if within:
                    return within[:5]
            return []
        except Exception:
            time.sleep(4 * (attempt + 1))
    return None


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
