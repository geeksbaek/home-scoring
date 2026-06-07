#!/usr/bin/env python3
"""
네이버 부동산 단지별 주차 정보 수집 (세대당 주차대수 ground truth).
fin.land 단지 페이지 RSC 스트림에서 parkingInfo 추출.
- curl_cffi Chrome TLS 임퍼소네이트 필수(네이티브 fetch는 403).
- 매 건 즉시 저장(크래시 대비), 재실행 시 수집분 스킵(resume).
- 값 없는 단지도 null 기록 → 재수집 안 함. 429는 백오프 재시도.
Usage: python3 pipeline/collect_naver_parking.py
"""
import json, re, time, sys, os
from pathlib import Path
from curl_cffi import requests

ROOT = Path(__file__).resolve().parent.parent
IDS = json.load(open(ROOT / "data/naver_complex_ids.json"))
OUT = ROOT / "data/naver_parking.json"
out = json.load(open(OUT)) if OUT.exists() else {}

RE_TOT = re.compile(r'totalParkingCount\\?"\s*:\s*([0-9]+)')
RE_PH  = re.compile(r'parkingCountPerHousehold\\?"\s*:\s*([0-9.]+)')

s = requests.Session(impersonate="chrome")
s.get("https://fin.land.naver.com/", timeout=15)

def fetch(cno):
    for attempt in range(4):
        try:
            r = s.get(f"https://fin.land.naver.com/complexes/{cno}", timeout=20)
            if r.status_code == 429:
                time.sleep(5 * (attempt + 1)); continue
            if r.status_code != 200:
                return ("err", r.status_code)
            t = RE_TOT.search(r.text); p = RE_PH.search(r.text)
            # perHh==0은 네이버 '데이터 없음' sentinel → null 기록
            if p and float(p.group(1)) > 0:
                return ("ok", {"total": int(t.group(1)) if t else None,
                               "perHh": float(p.group(1)), "cno": str(cno)})
            return ("none", None)
        except Exception as e:
            time.sleep(3 * (attempt + 1))
    return ("fail", None)

items = list(IDS.items())
todo = [(n, c) for n, c in items if n not in out]
print(f"전체 {len(items)} / 미수집 {len(todo)}", flush=True)
done = 0
for name, cno in todo:
    status, val = fetch(cno)
    out[name] = val if status == "ok" else None
    done += 1
    if done % 25 == 0:
        OUT.write_text(json.dumps(out, ensure_ascii=False))
        ok = sum(1 for v in out.values() if v)
        print(f"  {done}/{len(todo)} (누적 성공 {ok})", flush=True)
    time.sleep(1.3)
OUT.write_text(json.dumps(out, ensure_ascii=False))
ok = sum(1 for v in out.values() if v)
print(f"완료: {len(out)}개 기록, 주차값 보유 {ok}개", flush=True)
