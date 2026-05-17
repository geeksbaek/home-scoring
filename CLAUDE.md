# CLAUDE.md

## 작업 원칙

- **UI 변경은 반드시 직접 테스트**: Chrome DevTools MCP로 스크린샷/DOM 검사를 통해 정상 동작 확인. 문제가 있으면 자율적으로 수정. 사용자에게 테스트를 시키지 않는다.
- **데이터 수집 시 매 건 저장**: 프로세스 크래시 대비. 배치 저장 금지.
- **공휴일 데이터 제외**: 출퇴근 측정, 실거래 수집 모두 공휴일/주말 데이터 포함 금지.
- **외부 API 매칭은 좌표 검증 필수**: 이름 검색만으로 매칭하지 말 것. K-apt 주소 → 카카오 geocode → 후보 polygon 좌표 비교 (500m 이내 OK). hcode/place_id/kapt_code 모두 적용.
- **신규 데이터 수집 후 audit 실행**: `bun src/audit_hcode.ts`로 mismatch 0 확인. daily.ts에 자동 포함됨.
- **프론트엔드 기능 개발 후 자동 커밋·배포**: `home-scoring/src/` 변경 작업이 끝나면 사용자 별도 지시 없이 다음 절차를 자동 수행한다. 작업 단위가 명확히 마무리된 시점(타입 체크 통과 + UI 검증 완료)에만 실행하고, 중간 산출물 상태에서는 금지.
  1. `home-scoring`에서 변경된 소스 파일만 선택적으로 add (전체 add는 hook으로 자동 차단됨 — `.claude/hooks/block-git-add-all.sh`).
  2. 변경 내용을 요약한 한국어 커밋 메시지로 main에 commit + push.
  3. `bun run build` → `dist/`를 임시 git init → `gh-pages` 브랜치로 force push (sync.ts 배포 로직과 동일).
  4. 배포 결과 한 줄 보고 (커밋 해시, gh-pages 해시).

## 프로젝트 개요

서울특별시 25개 구 + 경기도(수원/성남/용인/하남/화성/안양) 아파트 매매 실거래가를 수집·분석하는 대시보드.
- **런타임**: Bun + TypeScript
- **프론트엔드**: React + Vite + Tailwind + shadcn/ui (base-ui) → GitHub Pages 배포
- **대상**: 약 5,900개 단지, 16,000개 (단지×면적) — 실거래가 r3 (2026-02 이후) 보유 단지 전체
- **데이터 배포**: `data-seoul.json` + `data-gyeonggi.json` + `data-index.json` 도시별 분할 (합본 `data.json`은 100MB+로 폐기). 프론트엔드는 index 로드 후 shard 병합.

## 같은 단지명 멀티 단지 분리

서울 추가로 동명단지가 폭증(현대 38개 동, 삼성 15개 동 등). `bun src/split_dup_apts.ts --apply`로 단지명+법정동 ≥5건 단위로 `이름(법정동)` 형식 분리. 분리 후 bjd_code/hcode/building/kapt 등 재수집 필요.

## 스케줄 (Claude Code Cron)

| 시각 | 작업 | 비고 |
|------|------|------|
| 05:00 | MOLIT 보도자료 수집·변환 | `cd ~/GitHub/home-scoring && bun scripts/collect_molit_press.ts --download-attachments --convert-md` (RSS 증분 + PDF → markdown via `codex` gpt-5.5 high → `public/molit_press.json`) |
| 06:30 | 출근 시간 측정 | `bun src/commute.ts` |
| 07:30 | 일일 파이프라인 | `bun src/daily.ts` (공휴일 자동 스킵) |
| 16:00 | 퇴근 시간 측정 | `bun src/commute.ts --reverse` |

## 일일 파이프라인 (`daily.ts`)

1. `collect.ts` — 실거래가 증분 수집 (마지막 거래월 - 2개월부터 백필)
2. `identity.ts` — apt_identity.json 동기화 (data.json 기반, 신규 단지 자동 추가)
3. `audit_hcode.ts` — hcode 검증, mismatch 자동 정리
4. `collect_hcode.ts` + coords/slope/schools — 누락 보강
5. `sync.ts` — 스코어링 + 배포

**주의**: 신규 단지(r3 첫 진입)는 `sync` 후 `data.json`에 등장 → identity는 다음 사이클에 추가됨. 즉시 식별자 매핑 필요 시 sync 후 identity 한 번 더 실행.

## 핵심 지침

### hcode 매칭 — 좌표 검증 필수

호갱노노 검색 API는 동명이인이 많고 지역 필터링이 부정확함.
- **단순 이름 검색 → 거리 검증 없이 매칭 절대 금지** (과거 22% 오매칭 사례)
- 매칭 절차:
  1. K-apt 도로명/지번 주소 → 카카오 geocode (ground truth 좌표)
  2. 호갱노노 검색 → 후보별 polygon 좌표 조회
  3. ground truth와 500m 이내 거리만 매칭
- 잘못된 hcode가 들어가면 dong_coords/slope/school_map이 모두 오염됨

### 실거래가 수집 — 신고 지연 백필 필수

부동산 거래 신고는 30일 이내 가능 → 지연 신고건이 사후 등록됨.
- `collect.ts` 증분수집은 **마지막 거래월 - 2개월부터** 재조회 (단순 lastMonth부터 ❌)
- 5월 진입 후에도 4월 거래가 새로 등록될 수 있음 → 백필 안 하면 누락
- `deduplicate`로 중복 자동 제거되므로 안전

### 세대수 — 건축물대장 전유부 API 우선

환금성 = 해당 타입 거래건수 / 해당 타입 세대수.
- **세대수는 건축물대장 전유부 API (`getBrExposPubuseAreaInfo`) 우선**. K-apt 범위 데이터(kaptMparea60/85/135) 사용 금지.
- K-apt는 60~85㎡를 하나로 묶어 우리 타입 분류(59/74/84)와 불일치.
- `collect_unit_types.ts`: K-apt 미등록 단지(`kapt_code` 없음, bjd_code+jibun으로 조회)도 정밀 수집.
  - `exposPubuseGbCd === "1"` (전유) + `mainPurpsCdNm` "아파트" 필터
  - 호별 area aggregate, area별 세대수
  - **같은 부지(jibun)에 단지 여럿 있으면 bldNm 정확 매칭만 허용 (fallback 금지)** — 까치마을(1단지)/(4단지) 같은 케이스 오매핑 회피
- `unit_types.ts` (구버전): K-apt 4분류 fallback, `fromKapt: true` 표시.

### 같은 단지명 멀티 단지 — 법정동 suffix로 분리

- **부동산 실거래가 데이터의 단지명은 법정동 단위로 중복 가능**: 예) "광교호반베르디움"이 이의동(555세대)과 원천동(1330세대)에 따로 존재. "현대" 같은 generic 이름은 11개 동에 산재.
- **분리 정책**: 같은 단지명 + 법정동 ≥2 + 각 5+ 거래 → `{name}({법정동})` 형식으로 분리.
- 거래 CSV의 단지명, identity entry, 모든 데이터 파일 key (kapt_info/hcode/building_info/unit_types/coords/slope/schools/소아과/mgmt 등) 일괄 갱신.
- 분리된 entry는 hcode/kapt_code/지번 등을 새로 검색 (호갱노노 좌표 검증, kakao geocode).
- 약 37개 단지명이 분리 대상, 총 63개 신규 entry 생성됨.

### 면적/atype 표시 정책

- **atype 버킷 분류는 raw 면적 그대로 비교** (`Math.round()` 금지). 84.99 → atype "84" (반올림 시 "99"로 잘못 분류됨).
- **84타입 경계 86㎡까지**: 부동산 표기상 84.x ~ 85.x는 모두 25평형(84타입). 85.00은 "99"가 아닌 "84"로 그룹화 (`a >= 86`이 "99"). 영흥숲푸르지오파크비엔 등 84.98/84.99/85.00이 같은 평면의 변형인 케이스가 다수.
- `data.json`의 `area`는 소수점 2자리 (`Math.round(a*100)/100`).
- **Chip 표시는 `Math.floor(area)` 정수**: 한 row가 atype 버킷 단위 집계라 정밀 표시는 잘못된 인상 줌.

### 네이버부동산 평면형 번호 — 배열 + 하이픈

`articlePyeongTypeNumbers`는 단지 내 raw 면적 오름차순 1-based 인덱스. **여러 평면형 번호를 하이픈으로 구분** (`?articlePyeongTypeNumbers=6-7`).
- 한 atype 버킷(예: "84")에 여러 평면형(84.7/84.96/84.97 등)이 들어가므로 모두 매핑.
- 인덱스 source: `dfAllTyped` (직거래/1층 포함 전체 거래) + `unit_types.json` (건축물대장 전유부) 합집합. dfTyped 단독 사용 금지 (1층/직거래 누락).
- `pyeong_type_nos: number[] | null` (data.json), `naverLandUrl()`이 `.join("-")` 처리.

### 건축물대장 — 표제부 fallback

`getBrRecapTitleInfo` (총괄표제부)에 vlRat/bcRat가 없으면 `getBrTitleInfo` (표제부) 평균 사용.
- 오래된 단지나 분리된 단지는 총괄표제부 미등록 케이스 있음

### 주차 — 건축물대장 우선

- **K-apt 데이터(`kaptdPcntu/kaptdPcnt`)는 부정확 케이스 다수**. 단지가 K-apt에 잘못 보고하거나 분리 등록(예: 신봉센트레빌1단지 K-apt 267 vs 실제 567).
- **건축물대장 총괄표제부의 `indrAutoUtcnt + oudrAutoUtcnt + indrMechUtcnt + oudrMechUtcnt` 우선 사용**.
- `building_info.json`에 `parking` 필드로 저장.
- sync.ts 우선순위: `building.parking > 0` → 사용, 그 외 K-apt fallback.
- `parking_per_hh`도 건축물대장 주차 / 세대수로 재계산.

### 관리비 — V2 API, 공용+개별 합산

- **공용관리비**: `AptCmnuseManageCostServiceV2` (인건비/경비/청소/수선/승강기/시설/세금/차량)
- **개별사용료**: `AptIndvdlzManageCostServiceV2` (난방/급탕/전기/수도/가스)
- 개별사용료 필드는 **문자열**로 반환됨 → `parseFloat` 필수 (`typeof v === "number"` 체크 금지)
- 단위: 원 (단지 전체) → 세대수로 나눠 만원/세대/월로 변환

### 출퇴근 — 공휴일 제외

- 한국 공휴일 + 근로자의 날(5/1) 데이터 삭제
- `commute_results.json`에서 해당 날짜 배치 제거 후 sync

## 데이터 커버리지 (2026-05-07 기준)

전체 1555개 단지 기준:

| 데이터 | 커버리지 | 비고 |
|--------|----------|------|
| 호갱노노 hcode | 1537/1555 (98.8%) | 좌표 검증 통과 |
| 좌표 | 1504/1555 (96.7%) | hcode polygon |
| 고저차 | 1504/1555 (96.7%) | Google Elevation |
| 배정초등학교 | 1504/1555 (96.7%) | 학구도안내서비스 |
| 건축물대장 세대수 | 1512/1555 (97.2%) | 건축물대장 표제부 |
| 용적률/건폐율 | 1418/1555 (91.2%) | 총괄표제부 + 표제부 fallback |
| K-apt 단지정보 | 1032/1555 (66.4%) | 150세대+ 의무관리만 등록 |
| 관리비 | 860/1555 (55.3%) | K-apt 등록 단지 중 보고분 |
| 회계감사 | 1032/1555 (66.4%) | |
| 유지관리이력 | 875/1555 (56.3%) | |
| 장기수선충당금 | 770/1555 (49.5%) | |
| 학폭 | 318/321 학교 (99%) | 4개년 완전 수집 |

### 미수집 단지 분류

- **K-apt 미등록 523개**: 150세대 미만 의무관리 미대상 (수집 불가)
- **호갱노노 미등록 18개**: 영문/숫자 단지명, 신축 단지 (수집 불가)
- **K-apt 등록되었으나 데이터 없음**: 단지가 보고하지 않은 케이스 (mgmt 169, maintenance 154 등)

## 파일 구조

### 핵심 스크립트
- `src/daily.ts` — 일일 파이프라인 (수집→검증→스코어링→배포)
- `src/identity.ts` — apt_identity.json 마스터 빌드 (data.json 기반)
- `src/audit_hcode.ts` — hcode 좌표 검증 (mismatch 자동 검출)
- `src/sync.ts` — 스코어링 + data.json + GitHub Pages 배포
- `src/commute.ts` — 출퇴근 측정 (Kakao Mobility)
- `src/collect.ts` — 실거래가 증분 수집

### 데이터 수집
- `src/collect_hcode.ts` — 호갱노노 hcode (좌표 검증 포함)
- `src/collect_coords.ts` — 동별 좌표 (hcode polygon)
- `src/collect_slope.ts` — 고저차 (Google Elevation)
- `src/collect_schools.ts` — 배정초등학교
- `src/building.ts` — 건축물대장 (vlRat/bcRat/세대수/내진)
- `src/kapt.ts` — K-apt 단지정보
- `src/collect_mgmt.ts` — 관리비 (V2 공용+개별)
- `src/collect_audit.ts` — 회계감사
- `src/collect_maintenance.ts` — 유지관리이력
- `src/collect_delinquency.ts` — 장기수선충당금
- `src/collect_pedia.ts` — 소아과 + 고저차
- `src/collect_violence.ts` — 학폭 (CAPTCHA)
- `src/collect_unit_types.ts` — 건축물대장 전유부 면적별 세대수 (정밀, 신규)
- `src/unit_types.ts` — K-apt 4분류 fallback (`fromKapt: true`)
- `src/collect_naver_complex.ts` — 네이버부동산 complex_no 매핑
- `src/fix_bjd_codes.ts` — 누락 bjd_code 카카오 보강
- `src/kapt_search.ts` — 누락 kapt_code 검색

### 주요 데이터
- `data/apt_identity.json` — 1555개 단지 마스터 (식별자 통합)
- `data/building_info.json` — 건축물대장 (vlRat/bcRat/세대수/내진/구조)
- `data/kapt_info.json` — K-apt 단지정보
- `data/dong_coords_naver.json` — 동별 좌표
- `data/slope_results.json` — 고저차
- `data/school_map.json` — 배정초등학교
- `data/unit_types.json` — 면적별 세대수 (전유부 정밀 + K-apt fallback)
- `data/naver_complex_ids.json` — 단지명 → 네이버부동산 complex_no
- `data/mgmt_cost.json` — 관리비 (만원/세대/월)
- `data/school_violence_full.json` — 학폭 4개년
- `data/commute_results.json` — 출퇴근 측정 이력
- `data/_*` — 임시/디버그 파일 (.gitignore)

## API 키

- `.env`의 `PUBLIC_DATA_API_KEY` — 실거래가, 건축물대장
- `.env`의 `KAKAO_REST_API_KEY` — geocoding, 주소→좌표, 소아과
- `.env`의 `GOOGLE_API_KEY` — Elevation API
- `home-scoring/.env`의 `VITE_GOOGLE_MAPS_KEY` — Maps JavaScript API
- `.env`의 `KAPT_API_KEY` — K-apt V2 (단지정보, 관리비, 회계감사, 유지관리 이력, 장기수선충당금 등)

## 상세 문서

- [docs/data-collection.md](docs/data-collection.md) — 데이터 수집 가이드
- [docs/file-structure.md](docs/file-structure.md) — 전체 파일/스크립트 구조
- [docs/scoring.md](docs/scoring.md) — 스코어링 로직 + 프론트엔드 구조
