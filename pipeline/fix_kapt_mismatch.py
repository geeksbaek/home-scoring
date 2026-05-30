#!/usr/bin/env python3
"""
K-apt 좌표 불일치 단지의 kapt_code 재해결 (좌표 검증 필수).

원인: kapt_search.ts가 시군구(구) 단위로만 매칭 → 동명/동일구 다른 단지를 잘못 연결
      (예: 매탄동 e-편한세상에 이의동 광교2차E편한세상 kaptCode가 박힘).

재해결 절차 (CLAUDE.md '외부 API 매칭은 좌표 검증 필수'):
  1. K-apt 검색(이름 변형) → 후보 단지(kaptCode, addr, bjdCode)
  2. 각 후보 주소를 카카오 geocode → shard 실좌표(ground truth)와 거리
  3. 가장 가까운 후보가 ACCEPT_M 이내면 채택, 아니면 kapt_code=null (K-apt 미등록)
  4. apt_identity.json의 kapt_code/kapt_name/bjd_code 갱신

Usage: python3 pipeline/fix_kapt_mismatch.py [--apply]
  (--apply 없으면 dry-run: 변경 미저장, 결과만 출력)
"""
import json, os, re, math, time, sys, html
import urllib.request, urllib.parse, http.cookiejar
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
APPLY = "--apply" in sys.argv
ACCEPT_M = 600       # 후보 채택 거리 상한 (좌표 검증)
MISMATCH_M = 800     # 감사: 이 거리 초과면 kapt 좌표 불일치로 간주
for line in open(ROOT + "/.env"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())
KEY = os.environ["KAKAO_REST_API_KEY"]
KAPT = "https://www.k-apt.go.kr"

def hav(a, b, c, d):
    R = 6371000; p = math.pi/180; dlat=(c-a)*p; dlon=(d-b)*p
    x = math.sin(dlat/2)**2 + math.cos(a*p)*math.cos(c*p)*math.sin(dlon/2)**2
    return 2*R*math.asin(math.sqrt(x))

# shard ground truth
coord = {}
for f in ["public/data-seoul.json", "public/data-gyeonggi.json"]:
    for r in json.load(open(ROOT + "/" + f)):
        if r.get("lat") and r.get("lng"):
            for kk in (r.get("name"), r.get("display_name")):
                if kk and kk not in coord: coord[kk] = (r["lat"], r["lng"])

_gc = {}
def geocode(q):
    if not q: return None
    if q in _gc: return _gc[q]
    res = None
    try:
        req = urllib.request.Request("https://dapi.kakao.com/v2/local/search/address.json?query=" + urllib.parse.quote(q),
                                     headers={"Authorization": f"KakaoAK {KEY}"})
        docs = json.load(urllib.request.urlopen(req, timeout=10)).get("documents", [])
        if docs: res = (float(docs[0]["y"]), float(docs[0]["x"]))
    except Exception: pass
    _gc[q] = res; time.sleep(0.02); return res

# K-apt 세션
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
def init_session():
    r = opener.open(KAPT + "/web/main/index.do", timeout=15)
    h = r.read().decode("utf-8", "ignore")
    m = re.search(r'name="_csrf"\s+content="([^"]+)"', h)
    return m.group(1) if m else ""
CSRF = init_session()

def search_kapt(keyword):
    data = urllib.parse.urlencode({"keyword": keyword}).encode()
    req = urllib.request.Request(KAPT + "/cmmn/getMinViewAptInfo.do", data=data, headers={
        "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-TOKEN": CSRF,
        "X-Requested-With": "XMLHttpRequest", "Referer": KAPT + "/web/main/index.do"})
    try:
        t = opener.open(req, timeout=15).read().decode("utf-8", "ignore")
    except Exception:
        return []
    codes = re.findall(r"<kaptCode>([^<]+)</kaptCode>", t)
    names = re.findall(r"<kaptName>([^<]*)</kaptName>", t)
    addrs = re.findall(r"<addr>([^<]*)</addr>", t)
    bjds = re.findall(r"<bjdCode>([^<]*)</bjdCode>", t)
    out = []
    for i, c in enumerate(codes):
        out.append({"code": c, "name": html.unescape(names[i]) if i < len(names) else "",
                    "addr": html.unescape(addrs[i]).strip() if i < len(addrs) else "",
                    "bjd": bjds[i] if i < len(bjds) else ""})
    return out

def translit(s):
    """K-apt 등록명 표기 차이 흡수: e편한세상↔이편한세상 등."""
    return re.sub(r"[eE]\s*-?\s*편한세상", "이편한세상", s)

def variations(name, bjdong=""):
    base = re.sub(r"\s+", " ", name).strip()
    nop = re.sub(r"\(.*?\)", "", base).strip()
    nosuf = re.sub(r"\d+단지$|\d+차$", "", nop).strip()
    bjs = bjdong[:-1] if bjdong.endswith("동") else bjdong  # 매탄동 → 매탄
    tl = translit(nop)
    cands = [base, nop, nosuf, name.replace(" ", "")]
    if tl != nop: cands.append(tl)
    if bjdong:  # 동-접두 K-apt 등록명 대응 (매탄이편한세상 ↔ e-편한세상(매탄동))
        cands += [f"{bjdong} {nop}", f"{bjs}{nop}", f"{bjs} {nop}", f"{bjs}{tl}", f"{bjs} {tl}"]
        cands.append(bjs)  # 광역 fallback — 좌표검증이 오매칭 차단
    return list(dict.fromkeys([v for v in cands if v and len(v) >= 2]))

def unit_no(name):
    """이름의 단지/차 번호 추출 (1단지/3차 등). 없으면 None."""
    m = re.search(r"(\d+)\s*(단지|차)", name)
    return m.group(1) if m else None

def name_core(s, strip=""):
    """이름 비교용 코어: 괄호·일반어·숫자 + 법정동명 조각 제거."""
    s = re.sub(r"\(.*?\)", "", s)
    s = re.sub(r"아파트|단지|마을|임대|타운|[0-9\-~,\s차동]", "", s)
    if strip:  # 법정동명(예: 호계, 석수) 제거 — 동명 우연겹침 오매칭 방지
        s = s.replace(strip, "")
    return s

def name_overlap(a, b, bjs=""):
    """두 이름이 2글자 이상 공통 코어를 갖는가 (법정동명 제외). 매탄극동↔극동 OK, 호계마젤란↔신성호계미소지움 X."""
    ca, cb = name_core(a, bjs), name_core(b, bjs)
    if not ca or not cb: return False
    short, long = (ca, cb) if len(ca) <= len(cb) else (cb, ca)
    return any(short[i:i+2] in long for i in range(len(short) - 1)) if len(short) >= 2 else short in long

def resolve(entry):
    gt = coord.get(entry["name"])
    if not gt: return ("skip", "no_gt", None)
    bjdong = (entry.get("bjdong") or "").strip()
    bjs = bjdong[:-1] if bjdong.endswith("동") else bjdong
    jibun = (entry.get("jibun") or "").strip().rstrip("\r").strip()
    my_unit = unit_no(entry["name"])
    cands, seen = [], set()
    for kw in variations(entry["name"], bjdong):
        for c in search_kapt(kw):
            if c["code"] in seen: continue
            seen.add(c["code"]); cands.append(c)
        time.sleep(0.08)
    best = None
    jibun_best = None  # (dist, c): 법정동+지번 일치 후보 중 거리 sane한 최근접
    for c in cands:
        # 단지/차 번호 불일치 후보 배제 (판교알파리움1단지 → 2단지 오매칭 방지)
        cu = unit_no(c["name"])
        if my_unit and cu and my_unit != cu: continue
        g = geocode(c["addr"])
        if not g: continue
        dist = hav(gt[0], gt[1], g[0], g[1])
        # 강한 신호: 주소에 법정동 + 동일 지번. 단 거리 sanity(2km) — 타 도시 지번 우연일치 차단
        if (bjdong and jibun and bjdong in c["addr"]
                and re.search(rf"(?<!\d){re.escape(jibun)}(?!\d)", c["addr"]) and dist <= 2000):
            if jibun_best is None or dist < jibun_best[0]:
                jibun_best = (dist, c)
        score = dist - (200 if bjdong and bjdong in c["addr"] else 0)
        if best is None or score < best[0]:
            best = (score, dist, c)
    if jibun_best:  # 지번+법정동 일치(거리 sane) — geocode 오차 보정해 채택
        return ("fix", f"jibun+bjdong {jibun_best[0]:.0f}m", jibun_best[1])
    # geocode-only 채택은 이름 유사도 필수 (K-apt 미등록 단지를 인근 타단지로 오매칭 방지)
    if best and best[1] <= ACCEPT_M:
        if name_overlap(entry["name"], best[2]["name"], bjs):
            return ("fix", f"{best[1]:.0f}m", best[2])
        return ("null", f"name_mismatch ({best[2]['name']} {best[1]:.0f}m)", None)
    return ("null", f"none<{ACCEPT_M}m (best {best[1]:.0f}m)" if best else "no_cand", None)

def audit_mismatches():
    """kapt_info 등록주소 geocode vs shard 실좌표 거리 > MISMATCH_M 인 단지 목록."""
    kapt = json.load(open(ROOT + "/data/kapt_info.json"))
    out = []
    for n, v in kapt.items():
        gt = coord.get(n)
        if not gt:
            continue
        g = geocode(v.get("doroJuso") or v.get("addr"))
        if not g:
            continue
        dist = hav(gt[0], gt[1], g[0], g[1])
        if dist > MISMATCH_M:
            out.append({"name": n, "kaptCode": v.get("kaptCode"), "dist_m": round(dist)})
    out.sort(key=lambda x: -x["dist_m"])
    return out

def main():
    mm = audit_mismatches()
    print(f"[audit] kapt 좌표 불일치(>{MISMATCH_M}m): {len(mm)}개\n", flush=True)
    idn = json.load(open(ROOT + "/data/apt_identity.json"))
    fixes, nulls, skips = [], [], []
    for i, m in enumerate(mm):
        entries = [e for e in idn if e["name"] == m["name"]]
        if not entries: continue
        action, reason, c = resolve(entries[0])
        if action == "fix":
            old = entries[0].get("kapt_code")
            if APPLY:
                for e in entries:  # 중복 엔트리 전부 갱신
                    e["kapt_code"] = c["code"]; e["kapt_name"] = c["name"]
                    if c["bjd"]: e["bjd_code"] = c["bjd"]
            fixes.append({"name": m["name"], "old": old, "new": c["code"], "kaptName": c["name"], "addr": c["addr"], "dist": reason})
            print(f"[{i+1}/{len(mm)}] ✓FIX {m['name']}: {old}→{c['code']} ({c['name']}, {reason})", flush=True)
        elif action == "null":
            if APPLY:
                for e in entries: e["kapt_code"] = None; e["kapt_name"] = None
            nulls.append({"name": m["name"], "old": m["kaptCode"], "reason": reason})
            print(f"[{i+1}/{len(mm)}] ⊘NULL {m['name']}: {m['kaptCode']}→null ({reason})", flush=True)
        else:
            skips.append(m["name"]); print(f"[{i+1}/{len(mm)}] -skip {m['name']} ({reason})", flush=True)
    if APPLY:
        json.dump(idn, open(ROOT + "/data/apt_identity.json", "w"), ensure_ascii=False, indent=2)
    json.dump({"fixes": fixes, "nulls": nulls, "skips": skips},
              open(ROOT + "/data/_kapt_fix_result.json", "w"), ensure_ascii=False, indent=2)
    print(f"\n[{'APPLIED' if APPLY else 'DRY-RUN'}] FIX {len(fixes)} / NULL {len(nulls)} / SKIP {len(skips)}", flush=True)

if __name__ == "__main__":
    main()
