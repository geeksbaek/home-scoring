# 데이터 수집 가이드

## 실거래가

- 엔드포인트: `https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade`
- curl은 차단 → 반드시 fetch 사용
- `bun pipeline/collect.ts` — 증분 수집 / `--full` 전체 / `--since 202501` 특정월
- 중복 제거 키: 법정동+단지명+전용면적+층+거래년+거래월+거래일+금액_만원
- 필터: 전용 59~84㎡, 직거래/1층 제외 (프론트엔드에서 동적 토글 가능)

### 화성시 법정동코드
- 41591: 남양/향남/새솔
- 41593: 봉담/비봉/정남 (수집 대상 아님)
- 41595: 병점/반월/반정
- 41597: 동탄 (청계/영천/산척/여울/목동/반송/능동/장지)

## 호갱노노 코드

- API: `https://hogangnono.com/api/v2/searches/suggestions/new?query={검색어}&x={lng}&y={lat}`
- 브라우저 세션 없이 fetch 가능
- 현재 **1027/1027 전체 확보**
- 스크립트: `bun pipeline/collect_hcode.ts`, `bun pipeline/collect_hcode_v2.ts` (지역 검증)

### 검색 전략 (이름으로 안 나올 때)
1. 한글 변환 (THESHARP→더샵, e편한세상→이편한세상)
2. 마을명 추가 (엘지빌리지→성동마을엘지빌리지)
3. 도로명주소 검색
4. 법정동+이름 ("금곡동 엘지빌리지")
5. 실거래 지번 대조

### 검증
- 지역별 중심 좌표 전달 (수원 127.01/37.27, 성남 127.13/37.44, 용인 127.10/37.24, 하남 127.21/37.54, 화성 127.05/37.20)
- 검색 결과 address가 예상 시/구와 일치하는지 확인
- 짧은 이름(4자 미만)은 exact match만

## 건축물대장 전유부

- API: `https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo`
- numOfRows: API가 100으로 강제 제한 (운영계정도 동일)
- 스크립트: `bun pipeline/unit-types-parallel.ts` (50워커 병렬, `--force`로 K-apt 교체)
- 현재 **560/560 확보** (392개 정확 + 168개 비례보정)

### 주소 매칭 주의사항
- 실거래 CSV 지번 ≠ 건축물대장 지번인 경우 → Kakao geocoding으로 도로명→정확한 지번 변환
- 택지개발지구: bun=0000 ji=0000 (블록번호) → `bldNm`으로 아파트 구분 (동천자이, 동천센트럴자이 등)
- `mainPurpsCdNm`: "아파트"가 아닌 **"공동주택"**으로 등록된 경우 많음
- `etcPurps`: "공동주택(아파트)", "공동주택", "연립주택" 모두 포함 필요

### 부분 수집 문제
- 단지가 여러 지번에 걸쳐 있으면 하나의 지번만 조회됨 → 세대수 과소
- 검증: K-apt 세대수(households) 대비 70% 미만이면 부분 수집으로 판단
- 해결: 비례 보정 (각 타입 count × (K-apt총 / 건축물대장총))

## 관리비

- 공용: `AptCmnuseManageCostServiceV2` (8개 항목)
- 개별: `AptIndvdlzManageCostServiceV2` (5개 항목: 난방/급탕/전기/수도/가스)
- **주의**: 개별사용료 필드는 **문자열**로 반환 → `parseFloat` 필수
- 세대수: K-apt V4 API (`AptBasisInfoServiceV4`)에서 가져옴
- 단위: 원(단지전체) → 세대수 나누기 → 만원/세대/월
- K-apt V2 API 키: `1ff1ae432a7521066d60fe891f54e1ffaa1dc8e6c5da8681a378a8ff2f6fdb04`
- 현재 **552/560 확보**, 평균 28.3만원/세대/월

## 배정초등학교

- 학구도안내서비스 ArcGIS REST API (CAPTCHA/인증 불필요)
- 엔드포인트: `https://schoolgis.emac.kr/arcgis/rest/services/SCHZONE/EDU_LAYER_SCHOOLZONE_QUERY/MapServer/0/query`
- Point-in-polygon: 아파트 좌표 → 학구 폴리곤 매칭
- 파라미터: `geometry={lng},{lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=HAKGUDO_NAME&f=json`
- 결과: `HAKGUDO_NAME` (예: "산양초통학구역") → "산양초등학교"로 변환
- 공동학구: "갈곡초성지초공동통학구역" → "초" 기준 분리 → ["갈곡초등학교", "성지초등학교"]
- 스크립트: `bun pipeline/collect_schools.ts`
- 현재 **1027/1027 전체 확보**

## 학교폭력

- 데이터소스: 학교알리미 (schoolinfo.go.kr)
- **CAPTCHA 필수** — 학폭 건수가 있는 학교는 반드시 CAPTCHA 풀이 필요
- CAPTCHA IPC: `_captcha.png` 저장 → `_captcha_answer.txt` 응답 대기 (최대 2분)
- 0건/공시제외 학교는 CAPTCHA 없이 자동 처리
- 수집 항목: 심의건수, 유형별 8종, 피해학생 보호조치 6종, 가해학생 선도조치 9종, 특별교육
- 공시년도: 2023~2026 (2022~2025학년도)
- REGIONS: 수원4구 + 성남3구 + 용인3구 + 하남 + 화성4구 = 15개 지역
- MANUAL_SCHOOLS: 지역 검색에서 누락되는 학교 6개 수동 등록
- 스크립트: `bun pipeline/collect_violence_fast.ts` (단일 워커, 안정적)
- 현재 **164/329 학교** 수집

## 고저차

- Google Elevation API 사용 (배치 300개씩)
- 아파트 동별 좌표 필요 → 호갱노노 polygon API 또는 네이버맵 검색
- `method: "dong_naver"` — grid 방식 사용 금지
- 소아과 고저차: 아파트→소아과 간 고도 차이 (양수=오르막)
- Open-Meteo Elevation API도 대안으로 사용 가능 (무료, 정확도 낮음)

## 좌표

- 주 소스: 호갱노노 polygon API (`/api/v2/apts/{code}/polygon` → `data.buildings`)
- 보조: Kakao geocoding (`/v2/local/search/keyword.json`)
- 저장: `data/dong_coords_naver.json` — `[{dong, lat, lng}, ...]`
- 현재 **1027/1027 전체 확보**
