#!/usr/bin/env python3
"""
네이버 fin.land 실매물 동적 조회 프록시.

정적 GitHub Pages 프론트엔드가 단지 클릭 시 호출 → 이 프록시가 네이버 매물을
받아 정규화해 CORS 허용 응답으로 돌려준다.

왜 필요한가 (라이브 검증됨, 2026-05-30):
  - 네이버 매물 API는 CORS 헤더(ACAO) 미제공 → 브라우저 직접호출 불가.
  - 네이티브 TLS 스택(Bun/Node fetch, 일반 curl)은 403/429 차단.
    Chrome TLS 핑거프린트 임퍼소네이트(curl_cffi)만 통과(동일 쿠키·UA·body로 격리 검증).
  - Authorization/Bearer 토큰은 존재하지 않음 → 토큰 관리 불필요. 워밍업 쿠키 + TLS 위장만 필요.

보수적 운영 (CLAUDE.md 좌표/rate-limit 원칙):
  - complexNo allowlist(naver_complex_ids.json 값만 허용) → 임의 단지 프록시 남용 차단.
  - 단지별 TTL 캐시(기본 10분) → 같은 단지 반복 클릭은 업스트림 1회.
  - 업스트림 호출 직렬화 + 최소 간격(기본 1.2s) → IP rate-limit/차단 회피.
  - 403/429 시 세션 재워밍업 + 백오프 1회 재시도.

Usage:
  python3 pipeline/naver_proxy.py            # PORT=8787 기본
  PORT=8787 CACHE_TTL=600 MIN_INTERVAL=1.2 python3 pipeline/naver_proxy.py

의존성: curl_cffi (pip install curl_cffi). 표준 라이브러리 http.server 사용(웹프레임워크 불필요).
"""
import hmac
import json
import os
import re
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from curl_cffi import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

PORT = int(os.environ.get("PORT", "8787"))
CACHE_TTL = float(os.environ.get("CACHE_TTL", "600"))        # 단지별 캐시 수명(초)
NEG_TTL = float(os.environ.get("NEG_TTL", "60"))             # 실패 응답 캐시 수명(초)
MIN_INTERVAL = float(os.environ.get("MIN_INTERVAL", "1.2"))  # 업스트림 호출 최소 간격(초)
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "30"))           # 1~30 (네이버 제한)
MAX_PAGES = int(os.environ.get("MAX_PAGES", "20"))           # 페이지네이션 상한(20×30=600건) — 무한루프 방지
MOVEIN_TTL = float(os.environ.get("MOVEIN_TTL", "21600"))    # 매물 입주가능일 캐시 6h
DETAIL_INTERVAL = float(os.environ.get("DETAIL_INTERVAL", "0.4"))  # 상세 HTML 호출 간격
MOVEIN_CAP = int(os.environ.get("MOVEIN_CAP", "60"))         # 한 요청당 상세 조회 상한 (cap 초과 매물은 프론트서 '입주미상')
# CORS 허용 origin (브라우저 남용 차단). ALLOWED_ORIGINS 환경변수로 덮어쓰기 가능.
ALLOWED_ORIGINS = {
    o.strip() for o in os.environ.get(
        "ALLOWED_ORIGINS",
        "https://geeksbaek.github.io,http://localhost:5173,http://127.0.0.1:5173",
    ).split(",") if o.strip()
}
# 비밀 토큰: env PROXY_TOKEN 또는 data/_proxy_token(gitignored) 파일에서 로드.
# 설정돼 있으면 /articles 호출 시 X-Proxy-Token 헤더(or ?token=) 일치 필수. 공개번들엔 미포함.
def _load_token() -> str:
    t = os.environ.get("PROXY_TOKEN", "").strip()
    if t:
        return t
    f = Path(__file__).resolve().parent.parent / "data" / "_proxy_token"
    try:
        return f.read_text(encoding="utf-8").strip()
    except Exception:
        return ""
PROXY_TOKEN = _load_token()
MAX_RPM = int(os.environ.get("MAX_RPM", "120"))  # 전역 분당 요청 상한(/articles)

API_URL = "https://fin.land.naver.com/front-api/v1/complex/article/list"
ART_URL = "https://fin.land.naver.com/articles/"

TRADE_NAME = {"A1": "매매", "B1": "전세", "B2": "월세", "B3": "단기"}
DIRECTION = {
    "EE": "동", "WW": "서", "SS": "남", "NN": "북",
    "SE": "남동", "SW": "남서", "NE": "북동", "NW": "북서",
    "ES": "동남", "WS": "서남", "EN": "동북", "WN": "서북",
    "E": "동", "W": "서", "S": "남", "N": "북",
}


_ALLOWLIST_PATH = DATA_DIR / "naver_complex_ids.json"

def load_allowlist() -> set[str]:
    """naver_complex_ids.json 의 complexNo 값만 허용."""
    try:
        mapping = json.loads(_ALLOWLIST_PATH.read_text(encoding="utf-8"))
        return {str(v) for v in mapping.values() if v}
    except Exception as e:  # pragma: no cover
        print(f"[warn] allowlist 로드 실패({e}) — allowlist 비활성(모든 complexNo 허용)")
        return set()


# 핫리로드: daily 파이프라인이 매핑을 추가하면 mtime 변경 → 다음 요청에서 자동 재로드.
# (프록시 재시작 없이도 신규 매핑 단지 조회 가능 — 과거 stale allowlist로 403 막힌 버그 방지)
_allowlist_lock = threading.Lock()
ALLOWLIST = load_allowlist()
_allowlist_mtime = _ALLOWLIST_PATH.stat().st_mtime if _ALLOWLIST_PATH.exists() else 0.0
print(f"[init] allowlist {len(ALLOWLIST)}개 complexNo 로드")

def current_allowlist() -> set[str]:
    """파일 mtime이 바뀌었으면 재로드 후 반환(스레드 안전)."""
    global ALLOWLIST, _allowlist_mtime
    try:
        mtime = _ALLOWLIST_PATH.stat().st_mtime
    except OSError:
        return ALLOWLIST
    if mtime != _allowlist_mtime:
        with _allowlist_lock:
            if mtime != _allowlist_mtime:  # double-check
                ALLOWLIST = load_allowlist()
                _allowlist_mtime = mtime
                print(f"[reload] allowlist 갱신 {len(ALLOWLIST)}개 (mtime 변경 감지)", flush=True)
    return ALLOWLIST

# ── curl_cffi 세션 (Chrome TLS 임퍼소네이트) ──────────────────────────────
_session_lock = threading.Lock()
_session: requests.Session | None = None
_last_call = 0.0


def _new_session() -> requests.Session:
    s = requests.Session(impersonate="chrome")
    # 워밍업: 메인 1회 GET으로 쿠키(NNB 등) 확보. 단지별 GET 불필요(검증됨).
    s.get("https://fin.land.naver.com/", timeout=15)
    return s


def _get_session() -> requests.Session:
    global _session
    if _session is None:
        _session = _new_session()
    return _session


def _post_page(complex_no: str, trade: str, sort: str, pyeong_types: list[int], last_info: list) -> dict:
    """매물 목록 한 페이지 POST. 직렬 간격 + 403/429 재워밍업 재시도. 원본 JSON 반환.
    (호출자가 _session_lock 보유 상태로 호출 — 페이지 루프 전체를 한 락으로 직렬화)"""
    global _session, _last_call
    body = {
        "size": PAGE_SIZE,
        "complexNumber": str(complex_no),  # 반드시 문자열 (숫자면 400)
        "tradeTypes": [trade] if trade else [],
        "pyeongTypes": pyeong_types,  # 면적 오름차순 1-based 평형번호 (pyeong_type_nos)
        "dongNumbers": [],
        "userChannelType": "PC",
        "articleSortType": sort,
        "lastInfo": last_info,  # 이전 페이지 응답의 result.lastInfo (1페이지는 [])
    }
    headers = {
        "referer": f"https://fin.land.naver.com/complexes/{complex_no}",
        "content-type": "application/json",
        "accept": "application/json, text/plain, */*",
    }
    # 업스트림 최소 간격 보장(직렬) — 페이지마다 적용해 rate-limit/차단 회피
    gap = time.monotonic() - _last_call
    if gap < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - gap)
    for attempt in range(2):
        try:
            s = _get_session()
            r = s.post(API_URL, headers=headers, data=json.dumps(body), timeout=20)
            _last_call = time.monotonic()
            if r.status_code == 200:
                return r.json()
            # 403/429 → 세션 재워밍업 후 1회 재시도
            if r.status_code in (403, 429) and attempt == 0:
                time.sleep(2.0)
                _session = _new_session()
                continue
            raise RuntimeError(f"upstream HTTP {r.status_code}: {r.text[:120]}")
        except Exception:
            if attempt == 0:
                time.sleep(2.0)
                _session = _new_session()
                continue
            raise
    raise RuntimeError("unreachable")


def fetch_articles(complex_no: str, trade: str, sort: str, pyeong_types: list[int]) -> dict:
    """단지 매물 전체를 페이지네이션으로 모아 합친 원본 JSON 반환.
    네이버는 한 페이지당 최대 PAGE_SIZE(30)건만 주고 result.hasNextPage/lastInfo로 다음 페이지를 가리킨다.
    → hasNextPage가 False가 될 때까지 lastInfo를 넘겨 반복(MAX_PAGES 상한). 미구현 시 30건에서 잘려 누락."""
    merged: list = []
    last_info: list = []
    total = None
    seen_keys: set = set()  # 동일 lastInfo 반복(서버 이상) 무한루프 방지
    with _session_lock:
        for _ in range(MAX_PAGES):
            j = _post_page(complex_no, trade, sort, pyeong_types, last_info)
            res = j.get("result") or {}
            lst = res.get("list") or []
            merged.extend(lst)
            if total is None:
                total = res.get("totalCount")
            last_info = res.get("lastInfo") or []
            key = tuple(map(str, last_info))
            if not res.get("hasNextPage") or not lst or not last_info or key in seen_keys:
                break
            seen_keys.add(key)
    return {
        "result": {
            "list": merged,
            "totalCount": total if total is not None else len(merged),
            "hasNextPage": False,
            "lastInfo": [],
        }
    }


# ── 매물별 입주가능일(상세) 조회·파싱·캐시 ──────────────────────────────────
# 입주가능일은 리스트 API에 없고 매물 상세 SSR HTML에만 노출 → 매물 1건당 1콜.
# 별도 세션/락/간격으로 리스트 호출과 분리, articleNo별 장기 캐시(6h).
_DEFN_RE = re.compile(
    r'DataList_term[^>]*>입주가능일</div><div class="DataList_definition[^>]*>(.*?)</div>'
)
_mi_lock = threading.Lock()
_movein_cache: dict[str, tuple[float, dict]] = {}
_detail_lock = threading.Lock()
_detail_session: requests.Session | None = None
_last_detail = 0.0


def parse_movein(html: str) -> dict:
    """상세 HTML의 '입주가능일' 텍스트 → {raw, immediate, date(YYYY-MM-DD|None)}."""
    m = _DEFN_RE.search(html)
    if not m:
        return {"raw": None, "immediate": False, "date": None}
    raw = re.sub(r"<[^>]+>", " ", m.group(1)).strip()
    immediate = "즉시입주" in raw
    date = None
    if not immediate:
        d = re.search(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일", raw)
        if d:
            date = f"{d.group(1)}-{int(d.group(2)):02d}-{int(d.group(3)):02d}"
        else:
            d2 = re.search(r"(\d{4})년\s*(\d{1,2})월\s*(초|중|하)순", raw)
            if d2:
                day = {"초": 10, "중": 20, "하": 28}[d2.group(3)]
                date = f"{d2.group(1)}-{int(d2.group(2)):02d}-{day:02d}"
            else:
                d3 = re.search(r"(\d{4})년\s*(\d{1,2})월", raw)
                if d3:
                    date = f"{d3.group(1)}-{int(d3.group(2)):02d}-28"
    return {"raw": raw, "immediate": immediate, "date": date}


def fetch_movein(article_no: str) -> dict:
    """매물 상세에서 입주가능일 파싱. articleNo별 캐시 + 직렬 간격."""
    global _detail_session, _last_detail
    with _mi_lock:
        hit = _movein_cache.get(article_no)
        if hit and hit[0] > time.monotonic():
            return hit[1]
    with _detail_lock:
        gap = time.monotonic() - _last_detail
        if gap < DETAIL_INTERVAL:
            time.sleep(DETAIL_INTERVAL - gap)
        mi = {"raw": None, "immediate": False, "date": None}
        try:
            if _detail_session is None:
                _detail_session = _new_session()
            r = _detail_session.get(
                ART_URL + str(article_no),
                headers={"referer": "https://fin.land.naver.com/"},
                timeout=15,
            )
            _last_detail = time.monotonic()
            if r.status_code == 200:
                mi = parse_movein(r.text)
            elif r.status_code in (403, 429):
                _detail_session = _new_session()  # 다음 건을 위해 재워밍업
        except Exception:
            _detail_session = None
    with _mi_lock:
        _movein_cache[article_no] = (time.monotonic() + MOVEIN_TTL, mi)
    return mi


def enrich_movein(articles: list[dict]) -> None:
    """각 매물에 moveIn 필드 부착 (상한 MOVEIN_CAP). 가격 오름차순 우선 조회."""
    targets = [a for a in articles if a.get("articleNo")][:MOVEIN_CAP]
    for a in targets:
        a["moveIn"] = fetch_movein(str(a["articleNo"]))


def normalize(raw: dict) -> dict:
    """네이버 응답 → 프론트 표시용 압축 스키마."""
    result = raw.get("result") or {}
    articles = []
    for entry in result.get("list") or []:
        a = entry.get("representativeArticleInfo") or {}
        dup = entry.get("duplicatedArticleInfo") or {}
        space = a.get("spaceInfo") or {}
        detail = a.get("articleDetail") or {}
        price = a.get("priceInfo") or {}
        verify = a.get("verificationInfo") or {}
        broker = a.get("brokerInfo") or {}
        building = a.get("buildingInfo") or {}
        direction = detail.get("direction") or ""
        trade = a.get("tradeType") or ""
        dup_list = dup.get("articleList") or dup.get("list") or []
        articles.append({
            "articleNo": a.get("articleNumber"),
            "trade": trade,
            "tradeName": TRADE_NAME.get(trade, trade),
            "dealPrice": price.get("dealPrice") or 0,
            "warrantyPrice": price.get("warrantyPrice") or 0,
            "rentPrice": price.get("rentPrice") or 0,
            "mgmtFee": price.get("managementFeeAmount") or 0,
            "priceChange": price.get("priceChangeStatus") or 0,
            "exclusiveArea": space.get("exclusiveSpace"),
            "exclusiveName": space.get("exclusiveSpaceName"),
            "supplyArea": space.get("supplySpace"),
            "dong": a.get("dongName"),
            "floor": detail.get("floorInfo"),
            "direction": direction,
            "directionName": DIRECTION.get(direction, direction),
            "feature": detail.get("articleFeatureDescription"),
            "directTrade": bool(detail.get("directTrade")),
            "confirmDate": verify.get("articleConfirmDate"),
            "verifyType": verify.get("verificationType"),
            "broker": broker.get("brokerageName"),
            "elapsedYear": building.get("approvalElapsedYear"),
            "dupCount": len(dup_list) if isinstance(dup_list, list) else 0,
        })
    return {
        "totalCount": result.get("totalCount", len(articles)),
        "hasNextPage": bool(result.get("hasNextPage")),
        "count": len(articles),
        "articles": articles,
    }


# ── 캐시 ──────────────────────────────────────────────────────────────────
_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, dict, bool]] = {}  # key -> (expiry, payload, is_error)


def cached(key: str):
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1], hit[2]
    return None


def store(key: str, payload: dict, is_error: bool):
    ttl = NEG_TTL if is_error else CACHE_TTL
    with _cache_lock:
        _cache[key] = (time.monotonic() + ttl, payload, is_error)


# ── 전역 incoming rate-limit (/articles) ──────────────────────────────────
_rl_lock = threading.Lock()
_rl_hits: deque = deque()  # 최근 60s 요청 타임스탬프


def rate_limited() -> bool:
    now = time.monotonic()
    with _rl_lock:
        while _rl_hits and _rl_hits[0] < now - 60:
            _rl_hits.popleft()
        if len(_rl_hits) >= MAX_RPM:
            return True
        _rl_hits.append(now)
        return False


def token_ok(handler) -> bool:
    """PROXY_TOKEN 설정 시 X-Proxy-Token 헤더(or ?token=) 일치 검증(상수시간)."""
    if not PROXY_TOKEN:
        return True
    from urllib.parse import urlparse, parse_qs
    supplied = handler.headers.get("X-Proxy-Token", "")
    if not supplied:
        supplied = (parse_qs(urlparse(handler.path).query).get("token") or [""])[0]
    return hmac.compare_digest(supplied, PROXY_TOKEN)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 간결 로그
        print(f"[{self.address_string()}] {fmt % args}")

    def _cors(self):
        # 허용 origin만 ACAO 반영 → 타 웹사이트 브라우저의 프록시 남용 차단.
        # (Origin 없는 직접호출(curl)은 CORS 비적용이라 ACAO 불필요)
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type, x-proxy-token")
        self.send_header("Access-Control-Max-Age", "600")

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _stream_start(self):
        """NDJSON 스트림 응답 헤더. Content-Length 없이 연결 종료로 EOF 신호(Connection: close)."""
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()

    def _ndjson(self, obj: dict) -> bool:
        """NDJSON 한 줄 write+flush. 클라이언트 조기 종료(BrokenPipe) 시 False 반환."""
        try:
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, OSError):
            return False

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        # Chrome Private Network Access: HTTPS(github.io) → http://127.0.0.1 호출 허용
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json(200, {"ok": True, "allowlist": len(current_allowlist()), "cached": len(_cache)})
            return
        if parsed.path != "/articles":
            self._json(404, {"error": "not found"})
            return

        # 비밀 토큰 검증 (공개 URL 무단 호출 차단)
        if not token_ok(self):
            self._json(403, {"error": "invalid or missing token"})
            return
        # 전역 rate-limit (홍수 방어)
        if rate_limited():
            self._json(429, {"error": "rate limited"})
            return

        qs = parse_qs(parsed.query)
        complex_no = (qs.get("complexNo") or qs.get("complexNumber") or [""])[0].strip()
        trade = (qs.get("trade") or [""])[0].strip().upper()  # A1/B1/B2/B3 또는 빈값(전체)
        sort = (qs.get("sort") or ["PRICE_ASC"])[0].strip().upper()
        # 평형번호: "1-2" / "1,2" / "1:2" 모두 허용
        raw_pt = (qs.get("pyeongTypes") or [""])[0].strip()
        pyeong_types: list[int] = []
        for tok in raw_pt.replace("-", ",").replace(":", ",").split(","):
            if tok.strip().isdigit():
                pyeong_types.append(int(tok.strip()))
        movein = (qs.get("movein") or ["0"])[0].strip() in ("1", "true", "yes")
        # fresh=1 → 캐시 무시하고 업스트림 재조회(새로고침용). 결과는 다시 캐시에 저장.
        fresh = (qs.get("fresh") or qs.get("nocache") or ["0"])[0].strip() in ("1", "true", "yes")
        # stream=1 → NDJSON 스트림: list 먼저 → 입주가능일(movein) 건별 → done. 팝오버 즉시 표시·동적 추가용.
        stream = (qs.get("stream") or ["0"])[0].strip() in ("1", "true", "yes")

        if not complex_no:
            self._json(400, {"error": "complexNo required"})
            return
        allowlist = current_allowlist()
        if allowlist and complex_no not in allowlist:
            self._json(403, {"error": "complexNo not in allowlist"})
            return
        if trade and trade not in TRADE_NAME:
            trade = ""
        if sort not in ("PRICE_ASC", "PRICE_DESC", "DATE_DESC", "SPACE_ASC", "SPACE_DESC", "RANKING_DESC"):
            sort = "PRICE_ASC"

        key = f"{complex_no}|{trade}|{sort}|{'-'.join(map(str, pyeong_types))}|mi{int(movein)}"

        if stream:
            self._stream_articles(complex_no, trade, sort, pyeong_types, key, fresh)
            return

        if not fresh:
            hit = cached(key)
            if hit is not None:
                payload, is_err = hit
                self._json(502 if is_err else 200, {**payload, "cached": True})
                return

        try:
            raw = fetch_articles(complex_no, trade, sort, pyeong_types)
            payload = normalize(raw)
            if movein:
                enrich_movein(payload["articles"])  # 매물별 입주가능일 부착(상세 조회)
            store(key, payload, False)
            self._json(200, {**payload, "cached": False})
        except Exception as e:
            err = {"error": str(e)[:200]}
            store(key, err, True)
            self._json(502, err)

    def _stream_articles(self, complex_no, trade, sort, pyeong_types, key, fresh):
        """NDJSON 스트림: {type:list} → {type:movein}×N → {type:done}. 완료분은 캐시에 저장.
        리스트는 즉시 보내 팝오버가 바로 열리고, 느린 입주가능일(상세 조회)은 건별로 흘려보낸다."""
        # 캐시 적중(non-fresh) → 즉시 재생(list + movein + done)
        if not fresh:
            hit = cached(key)
            if hit is not None:
                payload, is_err = hit
                self._stream_start()
                if is_err:
                    self._ndjson({"type": "error", "error": payload.get("error", "error")})
                    return
                arts = payload.get("articles", [])
                if not self._ndjson({"type": "list", "totalCount": payload.get("totalCount", len(arts)),
                                     "hasNextPage": payload.get("hasNextPage", False), "count": len(arts),
                                     "articles": arts, "cached": True}):
                    return
                for a in arts:
                    if a.get("moveIn") is not None:
                        if not self._ndjson({"type": "movein", "articleNo": a.get("articleNo"), "moveIn": a["moveIn"]}):
                            return
                self._ndjson({"type": "done", "cached": True})
                return

        # 라이브 수집: 리스트 먼저 fetch (실패 시 502 JSON, 아직 스트림 시작 전)
        try:
            raw = fetch_articles(complex_no, trade, sort, pyeong_types)
            payload = normalize(raw)
        except Exception as e:
            err = {"error": str(e)[:200]}
            store(key, err, True)
            self._json(502, err)
            return

        arts = payload["articles"]
        self._stream_start()
        if not self._ndjson({"type": "list", "totalCount": payload["totalCount"],
                             "hasNextPage": payload["hasNextPage"], "count": payload["count"],
                             "articles": arts, "cached": False}):
            return  # 클라이언트 끊김 — movein 상세 조회 스킵(업스트림 부하 절감)
        # 입주가능일 건별 스트림 (가격 오름차순 우선, 상한 MOVEIN_CAP)
        for a in [x for x in arts if x.get("articleNo")][:MOVEIN_CAP]:
            mi = fetch_movein(str(a["articleNo"]))
            a["moveIn"] = mi
            if not self._ndjson({"type": "movein", "articleNo": a.get("articleNo"), "moveIn": mi}):
                return  # 끊김 — 남은 상세 조회 중단
        store(key, payload, False)  # moveIn 부착 완료분 캐시 → 다음 요청은 즉시 재생
        self._ndjson({"type": "done", "cached": False})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[ready] naver_proxy on http://127.0.0.1:{PORT}  "
          f"(TTL={CACHE_TTL}s, interval={MIN_INTERVAL}s, size={PAGE_SIZE})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[stop]")
        server.shutdown()


if __name__ == "__main__":
    main()
