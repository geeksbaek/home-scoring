#!/usr/bin/env python3
"""
네이버부동산 단지 검색 → 좌표 검증 매칭으로 complex_no 보강.

place_id 기반 collect_naver_complex.ts가 실패한(또는 place_id 없는) 미매핑 단지를
new.land.naver.com 검색으로 찾되, **이름 검색만으로 매칭 금지(CLAUDE.md)** 원칙에 따라
후보 단지 좌표를 우리 ground truth 좌표와 비교해 500m 이내인 것만 매칭한다.

ground truth 좌표:
  1순위 — data shard(public/data-*.json)의 lat/lng (hcode polygon, 좌표검증 완료분)
  2순위 — apt_identity 주소(도로명/지번) 카카오 geocode

매칭 규칙: 검색 후보 중 ground truth와 가장 가까운 단지가 500m 이내면 채택.
  (동명 단지가 여럿이어도 좌표로 정확히 가려냄 — 백궁동양파라곤 249m vs 동양정자파라곤 16m)

Usage: python3 pipeline/collect_naver_complex_search.py
의존성: curl_cffi (네이버 native-TLS 차단 우회), .env의 KAKAO_REST_API_KEY
"""
import json, os, re, math, time, sys
import urllib.request, urllib.parse
from pathlib import Path
from curl_cffi import requests as cr

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
THRESHOLD_M = 500           # 좌표 검증 거리 상한
KEEP_TYPES = {"APT", "ABYG", "JGC", "PRE"}  # 아파트/분양권/재건축/분양 (오피스텔·빌라 제외)
REQ_INTERVAL = 0.4          # 검색 호출 간격
SAVE_EVERY = 25

def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())
load_env()
KAKAO_KEY = os.environ.get("KAKAO_REST_API_KEY", "")

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000; p = math.pi / 180
    dlat = (lat2 - lat1) * p; dlon = (lon2 - lon1) * p
    a = math.sin(dlat/2)**2 + math.cos(lat1*p)*math.cos(lat2*p)*math.sin(dlon/2)**2
    return 2 * R * math.asin(math.sqrt(a))

# ── ground truth 좌표 (shard) ─────────────────────────────────────────────
coord = {}
for f in ["public/data-seoul.json", "public/data-gyeonggi.json"]:
    for r in json.load(open(ROOT / f)):
        if r.get("lat") and r.get("lng"):
            for k in (r.get("name"), r.get("display_name")):
                if k and k not in coord:
                    coord[k] = (r["lat"], r["lng"])
print(f"[init] shard 좌표 {len(coord)}개 단지명")

_geo_cache = {}
def geocode(addr):
    if not addr or not KAKAO_KEY:
        return None
    if addr in _geo_cache:
        return _geo_cache[addr]
    try:
        req = urllib.request.Request(
            "https://dapi.kakao.com/v2/local/search/address.json?query=" + urllib.parse.quote(addr),
            headers={"Authorization": f"KakaoAK {KAKAO_KEY}"})
        docs = json.load(urllib.request.urlopen(req, timeout=10)).get("documents", [])
        res = (float(docs[0]["y"]), float(docs[0]["x"])) if docs else None
    except Exception:
        res = None
    _geo_cache[addr] = res
    return res

def ground_truth(d):
    c = coord.get(d["name"])
    if c:
        return c, "shard"
    g = geocode(d.get("doro_juso") or d.get("jibun_addr"))
    return (g, "geocode") if g else (None, None)

# ── 네이버 검색 세션 ───────────────────────────────────────────────────────
_sess = cr.Session(impersonate="chrome")
_sess.get("https://new.land.naver.com/", timeout=15)
def search(keyword):
    global _sess
    for attempt in range(3):
        try:
            r = _sess.get(
                "https://new.land.naver.com/api/search?keyword=" + urllib.parse.quote(keyword) + "&page=1",
                headers={"referer": "https://new.land.naver.com/"}, timeout=15)
            if r.status_code == 200:
                return r.json().get("complexes", []) or []
            if r.status_code in (429, 403):
                time.sleep(3 * (attempt + 1))
                _sess = cr.Session(impersonate="chrome"); _sess.get("https://new.land.naver.com/", timeout=15)
                continue
            return []
        except Exception:
            time.sleep(2)
    return []

def search_keys(d):
    """검색 키워드 후보 (우선순위): 괄호제거+법정동, 괄호제거, 원본.
    generic 분리단지(대림(등촌동) 등)는 법정동을 붙여야 올바른 후보가 검색에 노출됨."""
    name = d["name"]
    base = re.sub(r"\s+", " ", name).strip()
    stripped = re.sub(r"\(.*?\)", "", base).strip()
    # 숫자 꼬리표(번지·동수)도 제거한 코어 — 개포2차현대아파트(220) 등
    core = re.sub(r"[\(\d\-~,]+$", "", stripped).strip() or stripped
    bjd = (d.get("bjdong") or "").strip()
    keys = []
    for k in (f"{stripped} {bjd}" if bjd else None, stripped, f"{core} {bjd}" if bjd and core != stripped else None, base):
        if k and k not in keys:
            keys.append(k)
    return keys

def match(d):
    gt, src = ground_truth(d)
    if not gt:
        return None, "no_gt", None
    gy, gx = gt
    best = None
    for kw in search_keys(d):
        for c in search(kw):
            if c.get("realEstateTypeCode") not in KEEP_TYPES and not str(c.get("realEstateTypeName","")).endswith("아파트"):
                continue
            if not (c.get("latitude") and c.get("longitude")):
                continue
            dist = haversine(gy, gx, c["latitude"], c["longitude"])
            if best is None or dist < best[0]:
                best = (dist, c)
        time.sleep(REQ_INTERVAL)
        if best and best[0] <= THRESHOLD_M:
            break  # 충분히 가까운 후보 확보 → 추가 키워드 생략
    if best and best[0] <= THRESHOLD_M:
        return best[1]["complexNo"], f"{src}:{best[0]:.0f}m", best[1]
    return None, (f"far:{best[0]:.0f}m" if best else "no_cand"), None

def main():
    idn = json.load(open(DATA / "apt_identity.json"))
    out = json.load(open(DATA / "naver_complex_ids.json"))
    targets = [d for d in idn if not out.get(d["name"])]
    # ground truth 있는 것 우선 (없으면 어차피 매칭 불가)
    targets = [d for d in targets if d["name"] in coord or d.get("doro_juso") or d.get("jibun_addr")]
    print(f"[init] 미매핑 중 검증가능 대상 {len(targets)}개\n")

    audit = []
    ok = far = nogt = 0
    for i, d in enumerate(targets):
        cid, reason, c = match(d)
        if cid:
            out[d["name"]] = cid
            ok += 1
            print(f"[{i+1}/{len(targets)}] ✓ {d['name']} → {cid} ({c['complexName']}, {reason})")
            audit.append({"name": d["name"], "complexNo": cid, "matched": c["complexName"],
                          "addr": c.get("cortarAddress"), "households": c.get("totalHouseholdCount"), "reason": reason})
        else:
            if reason == "no_gt": nogt += 1
            else: far += 1
            print(f"[{i+1}/{len(targets)}] ✗ {d['name']} ({reason})")
        if (i + 1) % SAVE_EVERY == 0:
            (DATA / "naver_complex_ids.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
            (DATA / "_naver_search_audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2))
            print(f"  … 저장 ({ok} 매칭)")

    (DATA / "naver_complex_ids.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
    (DATA / "_naver_search_audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2))
    print(f"\n[done] 매칭 {ok} / 거리초과·후보없음 {far} / ground-truth없음 {nogt} / 전체 매핑 {len(out)}개")

if __name__ == "__main__":
    main()
