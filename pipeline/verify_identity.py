"""
단지 식별자 검증·재매칭 — MOLIT 실거래의 (시군구 + 법정동 + 지번)을 ground truth로.

배경: 여러 단지가 모인 마을(이매촌·무지개·까치마을 등)에서 K-apt가 대표 단지 하나로 잘못 묶이고,
그 주소를 truth 삼아 hcode·네이버 단지까지 옆 단지로 오매칭(500m 거리 검증은 인접 단지를 못 거름).
→ 단지명/K-apt 주소가 아닌, 실거래 신고의 지번으로 각 식별자를 정확 대조한다.

단계 (각 단계 결과는 data/_verify_{stage}.json, API 응답은 data/_vi_cache/ 에 캐시 → 재실행 시 이어서):
  truth : 카카오 지번 geocode → 좌표 + 법정동코드(b_code). 지번 본번/부번 일치 확인.
  hcode : 호갱노노 검색 후보 중 주소 (법정동, 지번) 정확 일치 → 없으면 단지 polygon이 truth 좌표를 포함하는지.
  naver : 네이버부동산 단지 (legalDivisionNumber, jibun) 정확 일치 → 없으면 검증된 hcode polygon 안의 단지.
  kapt  : K-apt 주소 (법정동, 지번) 정확 일치 확인 (불일치면 해제 — K-apt 없는 단지는 건축물대장 fallback).

Usage: python3 pipeline/verify_identity.py {truth|hcode|naver|kapt} [--only names.json]
"""
import json, os, re, sys, time, math
from pathlib import Path
from curl_cffi import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "_vi_cache"
CACHE.mkdir(exist_ok=True)

ENV = {}
for line in (ROOT / ".env").read_text().splitlines():
    m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.strip())
    if m: ENV[m.group(1)] = m.group(2).strip().strip('"')
KAKAO_KEYS = [ENV[k] for k in ("KAKAO_REST_API_KEY", "KAKAO_REST_API_KEY_2", "KAKAO_REST_API_KEY_3") if ENV.get(k)]


def load(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def save(path, obj):
    # 임시 파일 → rename (디스크 부족 시 기존 파일 보존)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False))
    os.replace(tmp, path)


def norm_jibun(j):
    j = (j or "").strip().replace(" ", "")
    m = re.match(r"^(산)?0*(\d+)(?:-0*(\d+))?$", j)
    if not m: return j
    return (m.group(1) or "") + m.group(2) + (f"-{m.group(3)}" if m.group(3) and m.group(3) != "0" else "")


def haversine(lat1, lng1, lat2, lng2):
    r = 6371000; t = math.radians
    a = math.sin(t(lat2 - lat1) / 2) ** 2 + math.cos(t(lat1)) * math.cos(t(lat2)) * math.sin(t(lng2 - lng1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def in_ring(lat, lng, ring):
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]["x"], ring[i]["y"]
        x2, y2 = ring[(i + 1) % n]["x"], ring[(i + 1) % n]["y"]
        if (y1 > lat) != (y2 > lat) and lng < (x2 - x1) * (lat - y1) / (y2 - y1 + 1e-15) + x1:
            inside = not inside
    return inside


def poly_dist(lat, lng, rings):
    """점이 polygon 안이면 0, 밖이면 가장 가까운 꼭짓점까지 거리(m, 근사)."""
    if any(in_ring(lat, lng, r) for r in rings): return 0.0
    best = float("inf")
    for r in rings:
        for p in r: best = min(best, haversine(lat, lng, p["y"], p["x"]))
    return best


# ── HTTP ──────────────────────────────────────────────
S = requests.Session(impersonate="chrome")
_kakao_i = 0


def get_json(url, headers=None, tries=4, sleep=0.0):
    for a in range(tries):
        try:
            r = S.get(url, headers=headers or {}, timeout=20)
            if r.status_code == 429:
                time.sleep(5 * (a + 1)); continue
            if r.status_code != 200: return None
            time.sleep(sleep)
            return r.json()
        except Exception:
            time.sleep(2 * (a + 1))
    return None


# 카카오맵(local) 비활성(403) 키 — 한 번 403이면 제외하고 캐시에 기록해 다음 실행에서도 호출 안 함
# (비활성 키를 계속 부르면 카카오가 "API 호출 에러 발생 중" 경고 메일 발송)
KAKAO_OFF = CACHE / "kakao_off.json"
_kakao_off = set(i for i, k in enumerate(KAKAO_KEYS) if k[-6:] in load(KAKAO_OFF, []))


def kakao_address(q):
    """카카오 주소검색 첫 문서. 키 라운드로빈, 403 키는 제외 (비활성 키 반복 호출 시 카카오가 경고 메일 발송)."""
    global _kakao_i
    for _ in range(len(KAKAO_KEYS)):
        i = _kakao_i % len(KAKAO_KEYS); _kakao_i += 1
        if i in _kakao_off: continue
        try:
            r = S.get("https://dapi.kakao.com/v2/local/search/address.json?size=1&query=" + requests.utils.quote(q),
                      headers={"Authorization": f"KakaoAK {KAKAO_KEYS[i]}"}, timeout=20)
        except Exception:
            continue
        if r.status_code in (401, 403):
            _kakao_off.add(i); save(KAKAO_OFF, [KAKAO_KEYS[j][-6:] for j in _kakao_off])
            print(f"  ⚠ 카카오 키 #{i + 1} 카카오맵 비활성({r.status_code}) — 제외", flush=True); continue
        if r.status_code == 200:
            return ((r.json().get("documents") or [None])[0]) or {}
    return None


# ── identity / truth ─────────────────────────────────
IDN = json.loads((DATA / "apt_identity.json").read_text())
ONLY = None
if "--only" in sys.argv:
    ONLY = set(json.loads(Path(sys.argv[sys.argv.index("--only") + 1]).read_text()))
TARGETS = [a for a in IDN if ONLY is None or a["name"] in ONLY]

TRUTH_PATH = DATA / "_verify_truth.json"


def stage_truth():
    out = load(TRUTH_PATH, {})
    todo = [a for a in TARGETS if a["name"] not in out]
    print(f"truth: 대상 {len(TARGETS)} / 미수집 {len(todo)}", flush=True)
    for i, a in enumerate(todo):
        q = f"{a['region']} {a['bjdong']} {a['jibun']}"
        doc = kakao_address(q)
        rec = None
        if doc and doc.get("address"):
            ad = doc["address"]
            jb = ad.get("main_address_no", "") + (f"-{ad['sub_address_no']}" if ad.get("sub_address_no") else "")
            if ad.get("mountain_yn") == "Y": jb = "산" + jb
            rec = {
                "lat": float(ad["y"]), "lng": float(ad["x"]), "b_code": ad.get("b_code"),
                "dong": ad.get("region_3depth_name"), "jibun": jb,
                # 지번까지 정확히 찍혔는지 (법정동 시군구 일치 + 본번/부번 일치)
                "exact": norm_jibun(jb) == norm_jibun(a["jibun"]) and (ad.get("b_code") or "").startswith(a["sigungu_cd"][:4]),
            }
        out[a["name"]] = rec
        if (i + 1) % 100 == 0:
            save(TRUTH_PATH, out); print(f"  {i + 1}/{len(todo)}", flush=True)
    save(TRUTH_PATH, out)
    ok = sum(1 for a in TARGETS if (out.get(a["name"]) or {}).get("exact"))
    print(f"truth 완료: 정확 {ok} / {len(TARGETS)}", flush=True)


def truth_of(name):
    t = load_truth().get(name)
    return t if t and t.get("exact") else None


_truth = None


def load_truth():
    global _truth
    if _truth is None: _truth = load(TRUTH_PATH, {})
    return _truth


# ── 호갱노노 ─────────────────────────────────────────
HOG_SEARCH = CACHE / "hog_search.json"
HOG_POLY = CACHE / "hog_poly.json"
_hs = load(HOG_SEARCH, {})
_hp = load(HOG_POLY, {})


def hog_search(q, lat, lng):
    if q not in _hs:
        j = get_json(f"https://hogangnono.com/api/v2/searches/suggestions/new?query={requests.utils.quote(q)}&x={lng}&y={lat}", sleep=0.08)
        lst = (((j or {}).get("data") or {}).get("matched") or {}).get("apt", {}).get("list") or []
        _hs[q] = [{"id": r.get("id"), "name": r.get("name"), "address": r.get("address"),
                   "household": r.get("household"), "loc": r.get("location")} for r in lst]
    return _hs[q]


def hog_poly(h):
    if h not in _hp:
        j = get_json(f"https://hogangnono.com/api/v2/apts/{h}/polygon", sleep=0.05)
        d = (j or {}).get("data") or {}
        rings = []
        for grp in d.get("groupPolygons") or []:
            for poly in grp:
                for ring in poly:
                    if ring: rings.append(ring)
        if not rings:  # 단지 경계 없으면 동 footprint로 대체
            for b in d.get("buildings") or []:
                for poly in b.get("shape") or []:
                    for ring in (poly if poly and isinstance(poly[0], list) else [poly]):
                        if ring: rings.append(ring)
        _hp[h] = rings
    return _hp[h]


def addr_match(address, dong, jibun):
    """'경기도 성남시 분당구 이매동 122' 형태 주소가 (법정동, 지번)과 정확히 일치하는지."""
    if not address: return False
    m = re.search(r"(?:^|\s)" + re.escape(dong) + r"\s+(산?\s?\d+(?:-\d+)?)(?:\s|$)", address)
    return bool(m) and norm_jibun(m.group(1)) == norm_jibun(jibun)


def queries_for(a):
    name = a["name"]
    base = re.sub(r"\([^)]*\)", "", name).strip()
    parens = [p for p in re.findall(r"\(([^)]*)\)", name) if p and p != a["bjdong"]]
    qs = [f"{a['bjdong']} {base}"]
    if parens:
        qs += [f"{base} {' '.join(parens)}", f"{base}{''.join(parens)}", f"{base}{parens[0]}", f"{a['bjdong']} {base}{parens[0]}"]
    qs += [base, name]
    seen, out = set(), []
    for q in qs:
        if q.strip() and q not in seen: seen.add(q); out.append(q)
    return out


def _nk(s):
    return re.sub(r"[\s()\-·.,]|아파트|마을", "", s or "")


def name_keys(a):
    """단지명 비교 키 — 괄호 제거/연결, 공백·'아파트'·'마을' 제거."""
    base = re.sub(r"\([^)]*\)", "", a["name"]).strip()
    parens = [p for p in re.findall(r"\(([^)]*)\)", a["name"]) if p and p != a["bjdong"]]
    keys = {base, base + "".join(parens)} | {base + p for p in parens}
    return {_nk(k) for k in keys if _nk(k)}


def name_dist_pick(a, t, cands, lat_of, lng_of, name_of, max_m=500):
    """지번·polygon 검증이 모두 안 될 때 마지막 수단: 정규화 이름 완전 일치 + truth에서 max_m 이내 후보가 유일할 때만."""
    keys = name_keys(a)
    hits = [c for c in cands if _nk(name_of(c)) in keys and haversine(t["lat"], t["lng"], lat_of(c), lng_of(c)) <= max_m]
    return hits[0] if len(hits) == 1 else None


def stage_hcode():
    path = DATA / "_verify_hcode.json"
    out = load(path, {})
    todo = pending(out)
    print(f"hcode: 대상 {len(TARGETS)} / 미처리 {len(todo)}", flush=True)
    for i, a in enumerate(todo):
        name, cur = a["name"], a.get("hcode")
        t = truth_of(name)
        if not t:
            out[name] = {"status": "no_truth", "old": cur, "new": cur}
        else:
            cands, exact = {}, []
            for q in queries_for(a):
                for c in hog_search(q, t["lat"], t["lng"]):
                    if c["id"] and c["id"] not in cands: cands[c["id"]] = c
                exact = [c for c in cands.values() if addr_match(c["address"], a["bjdong"], a["jibun"])]
                if exact: break
            rec = {"old": cur}
            if len(exact) == 1:
                rec.update(status="ok" if exact[0]["id"] == cur else "fixed", new=exact[0]["id"], via="addr", cand=exact[0]["name"])
            elif len(exact) > 1:
                # 같은 지번 여러 후보 → truth 좌표를 포함하는 polygon 우선, 없으면 가장 가까운 것
                best = min(exact, key=lambda c: poly_dist(t["lat"], t["lng"], hog_poly(c["id"])))
                rec.update(status="ok" if best["id"] == cur else "fixed", new=best["id"], via="addr+poly", cand=best["name"])
            else:
                # 지번 불일치(여러 필지 단지 등) → 현재 hcode polygon이 truth를 포함하면 유지
                if cur and poly_dist(t["lat"], t["lng"], hog_poly(cur)) <= 30:
                    rec.update(status="ok_poly", new=cur, via="poly")
                else:
                    inside = [c for c in cands.values() if c.get("loc") and haversine(t["lat"], t["lng"], c["loc"]["lat"], c["loc"]["lon"]) < 1500
                              and poly_dist(t["lat"], t["lng"], hog_poly(c["id"])) <= 30]
                    nd = name_dist_pick(a, t, [c for c in cands.values() if c.get("loc")],
                                        lambda c: c["loc"]["lat"], lambda c: c["loc"]["lon"], lambda c: c["name"])
                    if len(inside) == 1:
                        rec.update(status="fixed_poly" if inside[0]["id"] != cur else "ok_poly", new=inside[0]["id"], via="poly", cand=inside[0]["name"])
                    elif nd:
                        rec.update(status="ok_name" if nd["id"] == cur else "fixed_name", new=nd["id"], via="name+dist", cand=nd["name"])
                    else:
                        rec.update(status="unresolved", new=None, ncand=len(inside))
            out[name] = rec
        if (i + 1) % 50 == 0:
            save(path, out); save(HOG_SEARCH, _hs); save(HOG_POLY, _hp)
            print(f"  {i + 1}/{len(todo)}", flush=True)
    save(path, out); save(HOG_SEARCH, _hs); save(HOG_POLY, _hp)
    summarize("hcode", out)


# ── 네이버부동산 ──────────────────────────────────────
NV_DETAIL = CACHE / "naver_detail.json"
NV_LIST = CACHE / "naver_list.json"
_nd = load(NV_DETAIL, {})
_nl = load(NV_LIST, {})
_warm = False


def nv_warm():
    global _warm
    if not _warm:
        S.get("https://fin.land.naver.com/", timeout=15); _warm = True


def nv_detail(cno):
    cno = str(cno)
    if cno not in _nd:
        nv_warm()
        j = get_json(f"https://fin.land.naver.com/front-api/v1/complex?complexNumber={cno}",
                     headers={"Referer": f"https://fin.land.naver.com/complexes/{cno}"}, sleep=0.35)
        r = (j or {}).get("result")
        _nd[cno] = None if not r else {
            "name": r.get("name"), "type": r.get("type"),
            "bcode": (r.get("address") or {}).get("legalDivisionNumber"),
            "dong": (r.get("address") or {}).get("sector"), "jibun": (r.get("address") or {}).get("jibun"),
            "lat": (r.get("coordinates") or {}).get("yCoordinate"), "lng": (r.get("coordinates") or {}).get("xCoordinate"),
            "hh": r.get("totalHouseholdNumber"), "parking": r.get("parkingInfo"),
        }
    return _nd[cno]


def nv_list(bcode):
    if bcode not in _nl:
        j = get_json(f"https://m.land.naver.com/complex/ajax/complexListByCortarNo?cortarNo={bcode}",
                     headers={"Referer": "https://m.land.naver.com/"}, sleep=0.3)
        _nl[bcode] = [{"id": c["hscpNo"], "name": c["hscpNm"], "lat": float(c["lat"]), "lng": float(c["lng"])}
                      for c in ((j or {}).get("result") or [])]
    # 읍·면의 리(里) 코드로는 목록이 비어 있음 → 네이버는 읍·면 코드(끝 2자리 00) 단위로 관리
    if not _nl[bcode] and not bcode.endswith("00"):
        return nv_list(bcode[:8] + "00")
    return _nl[bcode]


def nv_exact(d, t, a):
    """네이버 단지 주소 == 실거래 (법정동, 지번). 읍·면 지역은 네이버가 읍 코드(…00)만 주므로
    코드 앞 8자리 + 리 이름(sector 끝 단어)까지 같아야 인정 (같은 읍의 다른 리에 같은 지번이 흔함)."""
    if not d: return False
    # 읍·면 지역은 jibun에 리 이름이 붙어 옴: sector "향남읍", jibun "행정리 480"
    parts = (d["jibun"] or "").split()
    num = parts[-1] if parts else ""
    ri = parts[-2] if len(parts) >= 2 else ((d["dong"] or "").split() or [""])[-1]
    if norm_jibun(num) != norm_jibun(a["jibun"]): return False
    if d["bcode"] == t["b_code"]: return True
    return bool(d["bcode"]) and d["bcode"].endswith("00") and d["bcode"][:8] == (t["b_code"] or "")[:8] \
        and ri == a["bjdong"].split()[-1]


def lcs_len(x, y):
    """정규화한 두 이름의 최장 공통 부분문자열 길이."""
    x, y = _nk(x), _nk(y)
    best = 0
    for i in range(len(x)):
        for j in range(i + best + 1, len(x) + 1):
            if x[i:j] in y: best = j - i
            else: break
    return best


def keep_near(a, t, lat, lng, name, min_lcs, max_m=200):
    """정확·polygon·이름 검증이 모두 안 된 기존 네이버 매핑: truth 200m 이내 + 이름 min_lcs자 이상 겹치면 유지
    (네이버가 여러 단지를 1개로 묶은 '푸른벽산,신성,쌍용' 등). 단 이웃 단지 오매칭을 막기 위해
    괄호 브랜드(효자촌(대우)의 '대우')는 후보명에 있어야 하고, 차수·단지 번호가 서로 다르면 제외."""
    if lat is None or haversine(t["lat"], t["lng"], lat, lng) > max_m or lcs_len(a["name"], name) < min_lcs:
        return False
    brands = [p for p in re.findall(r"\(([^)]*)\)", a["name"]) if p and p != a["bjdong"] and not re.search(r"\d|동$", p)]
    if any(_nk(b) not in _nk(name) for b in brands): return False
    base = re.sub(r"\([^)]*\)", "", a["name"])
    mine = set(re.findall(r"(\d+)\s*(?:차|단지)", base))
    theirs = set(re.findall(r"(\d+)\s*(?:차|단지)", name))
    return not (mine and theirs and not (mine & theirs))


def _tokens(s):
    return set(re.findall(r"[가-힣]+|[a-z]+|\d+", (s or "").lower().replace("아파트", "")))


def token_pick(a, t, cands, max_m=300):
    """네이버가 여러 단지를 하나로 묶은 경우(현대10,13,14차 등): 단지명 토큰(괄호의 동·호수 제외)이
    후보 이름에 모두 있고 truth에서 max_m 이내인 후보가 유일할 때만."""
    base = re.sub(r"\([^)]*\)", "", a["name"])
    parens = [p for p in re.findall(r"\(([^)]*)\)", a["name"]) if p and p != a["bjdong"] and not re.search(r"\d|동$", p)]
    need = _tokens(base + " " + " ".join(parens)) - {"차", "단지"}
    if not need: return None
    hits = [c for c in cands if need <= _tokens(c["name"]) and haversine(t["lat"], t["lng"], c["lat"], c["lng"]) <= max_m]
    return hits[0] if len(hits) == 1 else None


def stage_naver():
    path = DATA / "_verify_naver.json"
    ids = load(DATA / "naver_complex_ids.json", {})
    hv = load(DATA / "_verify_hcode.json", {})
    out = load(path, {})
    todo = pending(out)
    print(f"naver: 대상 {len(TARGETS)} / 미처리 {len(todo)}", flush=True)
    for i, a in enumerate(todo):
        name, cur = a["name"], ids.get(a["name"])
        t = truth_of(name)
        if not t:
            out[name] = {"status": "no_truth", "old": cur, "new": cur}
        elif cur and nv_exact(nv_detail(cur), t, a):
            out[name] = {"status": "ok", "old": cur, "new": cur, "via": "addr"}
        else:
            cands = sorted(nv_list(t["b_code"]), key=lambda c: haversine(t["lat"], t["lng"], c["lat"], c["lng"]))
            exact = [c for c in cands[:8] if nv_exact(nv_detail(c["id"]), t, a)]
            rec = {"old": cur}
            if exact:
                rec.update(status="fixed" if exact[0]["id"] != cur else "ok", new=exact[0]["id"], via="addr", cand=exact[0]["name"])
            else:
                # 지번 불일치 → 검증된 hcode polygon 안에 중심좌표가 있는 네이버 단지
                h = (hv.get(name) or {}).get("new") if (hv.get(name) or {}).get("status", "").startswith(("ok", "fixed")) else None
                rings = hog_poly(h) if h else []
                inside = [c for c in cands[:15] if rings and poly_dist(c["lat"], c["lng"], rings) <= 20]
                nd = name_dist_pick(a, t, cands, lambda c: c["lat"], lambda c: c["lng"], lambda c: c["name"])
                tk = None if nd else token_pick(a, t, cands[:15])
                if len(inside) == 1:
                    rec.update(status="ok_poly" if inside[0]["id"] == cur else "fixed_poly", new=inside[0]["id"], via="hpoly", cand=inside[0]["name"])
                elif nd:
                    rec.update(status="ok_name" if nd["id"] == cur else "fixed_name", new=nd["id"], via="name+dist", cand=nd["name"])
                elif tk:
                    rec.update(status="ok_name" if tk["id"] == cur else "fixed_name", new=tk["id"], via="tokens+dist", cand=tk["name"])
                elif cur and (od := nv_detail(cur)) and keep_near(a, t, od["lat"], od["lng"], od["name"], 2):
                    rec.update(status="kept_near", new=cur, via="near+name", cand=od["name"])
                else:
                    rec.update(status="unresolved", new=None, ncand=len(inside), hcode=h)
            out[name] = rec
        if (i + 1) % 50 == 0:
            save(path, out); save(NV_DETAIL, _nd); save(NV_LIST, _nl); save(HOG_POLY, _hp)
            print(f"  {i + 1}/{len(todo)}", flush=True)
    save(path, out); save(NV_DETAIL, _nd); save(NV_LIST, _nl); save(HOG_POLY, _hp)
    summarize("naver", out)


# ── K-apt ────────────────────────────────────────────
KAPT_GEO = CACHE / "kapt_geo.json"


def stage_kapt():
    """K-apt 주소 (법정동, 지번) 정확 일치 → ok.
    같은 K-apt 코드에 정확 일치하는 '주인' 단지가 따로 있으면 이 단지는 오매칭(이매촌 8개 → 이매촌청구 유형).
    주인이 없으면 K-apt 주소는 신도시 가지번·지번 누락('목동  힐스테이트동탄', '735-')이 흔하므로
    K-apt 도로명 주소 좌표가 검증된 hcode polygon 안이거나 실거래 지번 150m 이내면 ok."""
    path = DATA / "_verify_kapt.json"
    kapt = load(DATA / "kapt_info.json", {})
    hv = load(DATA / "_verify_hcode.json", {})
    geo = load(KAPT_GEO, {})
    exact = {}
    for a in TARGETS:
        code = a.get("kapt_code")
        if not code: continue
        addr = (kapt.get(a["name"]) or {}).get("addr") or a.get("jibun_addr") or ""
        exact[a["name"]] = addr_match(re.sub(r"(\d)-(\s|$)", r"\1\2", addr), a["bjdong"], a["jibun"])
    owners = {a.get("kapt_code") for a in TARGETS if exact.get(a["name"])}
    out = {}
    for a in TARGETS:
        name, code = a["name"], a.get("kapt_code")
        if not code: continue
        k = kapt.get(name) or {}
        addr = k.get("addr") or a.get("jibun_addr") or ""
        if exact[name]:
            out[name] = {"status": "ok", "old": code, "new": code}; continue
        # K-apt 단지명 = 법정동(+지번) 뒤 부분 ("… 창곡동  위례역푸르지오6단지아파트", "… 태평동 50-1 가천대역 두산위브 아파트")
        dong = a["bjdong"].split()[-1]
        m = re.search(re.escape(dong) + r"\s+(?:산?\d+(?:-\d*)?\s+)?(.*)$", addr)
        kname = _nk(m.group(1)) if m else ""
        if code in owners:
            # 공동관리 K-apt('래미안노블클래스1단지2단지', '정자느티마을3단지4단지')는 이름에 자기 단지 번호가 있으면 유지
            ords = set(re.findall(r"\d+(?:차|단지)", _nk(name)))
            if ords and ords <= set(re.findall(r"\d+(?:차|단지)", kname)) and lcs_len(name, kname) >= 4:
                out[name] = {"status": "ok_joint", "old": code, "new": code, "kapt_addr": addr}
            else:
                out[name] = {"status": "mismatch", "old": code, "new": None, "kapt_addr": addr, "why": "owner"}
            continue
        t = truth_of(name)
        q = k.get("doroJuso") or a.get("doro_juso") or addr
        if q not in geo:
            d = kakao_address(q) or {}
            geo[q] = {"lat": float(d["y"]), "lng": float(d["x"])} if d.get("y") else None
            save(KAPT_GEO, geo)
        g = geo[q]
        h = (hv.get(name) or {}).get("new")
        near = bool(t and g) and (haversine(t["lat"], t["lng"], g["lat"], g["lng"]) <= 150
                                   or (h and poly_dist(g["lat"], g["lng"], hog_poly(h)) <= 30))
        # 신도시 가지번 등으로 좌표가 어긋난 같은 단지 구제: 같은 법정동 + 단지명 5자 이상 포함관계
        # + K-apt 쪽에만 있는 차수 없음 (감일한라비발디 ↔ 감일한라비발디2차 같은 건 제외)
        mine = _nk(re.sub(r"\([^)]*\)", "", name))
        extra_ord = set(re.findall(r"\d+(?:차|단지)", kname)) - set(re.findall(r"\d+(?:차|단지)", mine))
        same_name = bool(m) and not extra_ord and bool(kname) and (
            kname == mine and len(mine) >= 3 or min(len(kname), len(mine)) >= 5 and (kname in mine or mine in kname))
        if near:
            out[name] = {"status": "ok_geo", "old": code, "new": code}
        elif same_name:
            out[name] = {"status": "ok_name", "old": code, "new": code, "kapt_addr": addr}
        else:
            out[name] = {"status": "mismatch", "old": code, "new": None, "kapt_addr": addr, "why": "far" if t and g else "no_geo"}
    save(path, out); save(HOG_POLY, _hp)
    summarize("kapt", out)


# ── 반영 ─────────────────────────────────────────────
# 식별자가 바뀌면 그 식별자로 수집한 파생 데이터도 무효화 → daily의 collect_* 가 누락분으로 재수집.
DEP_HCODE = ["dong_coords_naver.json", "slope_results.json", "school_map.json", "pediatric_clinics.json", "pedia_slope.json"]
DEP_KAPT = ["kapt_info.json", "building_info.json", "unit_types.json", "mgmt_cost.json", "repair_fund.json",
            "maintenance_history.json", "audit_history.json"]
ROAD_CACHE = CACHE / "kakao_road.json"


def kakao_road(q):
    """지번 주소 → 도로명 주소 (출퇴근 출발지·표시용 doro_juso 교정)."""
    rc = load(ROAD_CACHE, {})
    if q not in rc:
        rc[q] = ((kakao_address(q) or {}).get("road_address") or {}).get("address_name")
        save(ROAD_CACHE, rc)
    return rc[q]


def stage_apply():
    truth = load(TRUTH_PATH, {})
    hv, nv, kv = (load(DATA / f"_verify_{s}.json", {}) for s in ("hcode", "naver", "kapt"))
    hc = load(DATA / "hogangnono_codes.json", {})
    ids = load(DATA / "naver_complex_ids.json", {})
    npk = load(DATA / "naver_parking.json", {})
    kbi = load(DATA / "kb_complex_ids.json", {})
    kbp = load(DATA / "kb_price.json", {})
    deps = {f: load(DATA / f, {}) for f in DEP_HCODE + DEP_KAPT + ["commute_coords_cache.json"]}
    ch = {"hcode": [], "naver": [], "kapt": [], "kb": []}

    for a in IDN:
        n = a["name"]
        t = truth.get(n) if (truth.get(n) or {}).get("exact") else None
        # hcode
        h = hv.get(n)
        if h and h["status"] != "no_truth" and h.get("new") != a.get("hcode"):
            a["hcode"] = h["new"]
            if h["new"]: hc[n] = h["new"]
            else: hc.pop(n, None)
            for f in DEP_HCODE: deps[f].pop(n, None)
            ch["hcode"].append(n)
        # 네이버 단지 (+ 같은 응답의 주차 정보로 naver_parking 갱신)
        v = nv.get(n)
        if v and v["status"] != "no_truth" and v.get("new") != ids.get(n):
            if v["new"]:
                ids[n] = v["new"]
                p = ((_nd.get(str(v["new"])) or {}).get("parking") or {})
                npk[n] = {"total": p.get("totalParkingCount"), "perHh": p.get("parkingCountPerHousehold"), "cno": str(v["new"])} \
                    if p.get("parkingCountPerHousehold") else None
            else:
                ids.pop(n, None); npk.pop(n, None)
            # 기존 단지번호는 이름 검색한 네이버 장소(place)에서 뽑은 것 → 단지가 틀렸으면 장소도 틀림.
            # ""로 비워 지도 링크는 단지명 검색으로 대체 (identity.ts는 ""를 재검색하지 않음)
            if v.get("old") and a.get("naver_place_id"): a["naver_place_id"] = ""
            ch["naver"].append(n)
        # K-apt 오매칭 해제 → 주소는 실거래 지번 기준으로, 파생 데이터 무효화
        k = kv.get(n)
        if k and k["status"] == "mismatch" and a.get("kapt_code"):
            a["kapt_code"] = None; a["kapt_name"] = None
            a["jibun_addr"] = f"{a['region']} {a['bjdong']} {a['jibun']}"
            a["doro_juso"] = kakao_road(a["jibun_addr"]) if t else None
            if t: a["bjd_code"] = t["b_code"]
            for f in DEP_KAPT: deps[f].pop(n, None)
            deps["commute_coords_cache.json"].pop(n, None)
            ch["kapt"].append(n)
        # KB: 매칭 단지의 (법정동코드, 지번) 정확 일치면 유지. 법정동이 다르면 오매칭.
        # 같은 법정동·다른 지번(여러 필지 단지)은 KB 좌표가 검증된 hcode polygon 안일 때만 유지.
        kb = kbi.get(n)
        kb_bad = False
        if t and kb and not (kb.get("bubcode") == t["b_code"] and norm_jibun(kb.get("arno")) == norm_jibun(a["jibun"])):
            hh = a.get("hcode")
            kb_bad = kb.get("bubcode") != t["b_code"] or not hh or kb.get("lat") is None \
                or poly_dist(kb["lat"], kb["lng"], hog_poly(hh)) > 30
        if kb_bad:
            kbi.pop(n, None)
            for key in [x for x in kbp if x.split("|")[0] == n]: kbp.pop(key)
            ch["kb"].append(n)

    save(DATA / "apt_identity.json", IDN)
    save(DATA / "hogangnono_codes.json", hc)
    save(DATA / "naver_complex_ids.json", ids)
    save(DATA / "naver_parking.json", npk)
    save(DATA / "kb_complex_ids.json", kbi)
    save(DATA / "kb_price.json", kbp)
    for f, d in deps.items(): save(DATA / f, d)
    save(HOG_POLY, _hp)
    save(DATA / "_verify_applied.json", ch)
    print("apply: " + ", ".join(f"{k} {len(v)}" for k, v in ch.items()), flush=True)


def pending(out):
    """미처리 단지. --redo면 unresolved도 다시(다른 단계 결과가 새로 생겼을 때 fallback 재시도)."""
    redo = "--redo" in sys.argv
    return [a for a in TARGETS if a["name"] not in out or (redo and out[a["name"]].get("status") == "unresolved")]


def summarize(label, out):
    from collections import Counter
    c = Counter(v["status"] for n, v in out.items() if ONLY is None or n in ONLY)
    print(f"{label} 결과: {dict(c)}", flush=True)


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else ""
    {"truth": stage_truth, "hcode": stage_hcode, "naver": stage_naver, "kapt": stage_kapt, "apply": stage_apply}[stage]()
