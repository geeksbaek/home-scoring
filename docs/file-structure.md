# 파일 구조

## 스크립트 (src/)

### 파이프라인
| 파일 | 설명 |
|------|------|
| `daily.ts` | 일일 파이프라인 (수집→스코어링→배포, 공휴일 스킵) |
| `sync.ts` | 스코어링 계산 + data.json 생성 + GitHub Pages 배포 |
| `commute.ts` | 출퇴근 시간 측정 (Kakao Mobility API) |
| `csv.ts` | CSV 파싱/쓰기, 통계 헬퍼 |

### 수집 스크립트
| 파일 | 설명 | 소스 |
|------|------|------|
| `collect.ts` | 실거래가 증분 수집 | 국토교통부 API |
| `collect_hcode.ts` | 호갱노노 코드 검색 | hogangnono.com |
| `collect_hcode_v2.ts` | 호갱노노 코드 (지역 검증) | hogangnono.com |
| `collect_geocode.ts` | 좌표 보완 | Kakao geocoding |
| `collect_coords.ts` | 동별 좌표 수집 | 호갱노노 polygon |
| `collect_naver_place.ts` | 네이버 place ID | 네이버 지도 |
| `collect_slope.ts` | 아파트 고저차 | Google Elevation |
| `collect_pedia.ts` | 소아과 거리 | Kakao Maps |
| `collect_pedia_slope.ts` | 소아과 고저차 | Google Elevation |
| `collect_schools.ts` | 배정초등학교 | 학구도안내서비스 ArcGIS |
| `collect_violence.ts` | 학폭 수집 (원본) | 학교알리미 |
| `collect_violence_fast.ts` | 학폭 수집 (CAPTCHA IPC) | 학교알리미 |
| `collect_mgmt_v2.ts` | 관리비 수집 | K-apt V2 API |
| `unit-types.ts` | 건축물대장 전유부 (순차) | 건축물대장 API |
| `unit-types-parallel.ts` | 건축물대장 전유부 (병렬) | 건축물대장 API |
| `identity.ts` | 아파트 마스터 데이터 갱신 | K-apt + 실거래 |
| `kapt_search.ts` | K-apt 코드 검색 | K-apt 웹사이트 |
| `validate_hcode.ts` | 호갱노노 코드 검증 | hogangnono.com |

## 데이터 (data/)

### 마스터
| 파일 | 설명 | 건수 |
|------|------|------|
| `apt_identity.json` | 단지 마스터 (name, region, bjdong, hcode, kapt_code, bjd_code, jibun, doro_juso) | 1,027 |
| `apt_trade_filtered.csv` | 실거래가 원본 | ~20,000+ |

### 수집 데이터
| 파일 | 설명 | 건수 |
|------|------|------|
| `hogangnono_codes.json` | 호갱노노 코드 매핑 (name→code) | 1,027 |
| `dong_coords_naver.json` | 동별 좌표 [{dong, lat, lng}] | 1,027 |
| `unit_types.json` | 면적별 세대수 (건축물대장) | 560 |
| `kapt_info.json` | K-apt 기본정보 | 560 |
| `mgmt_cost.json` | 관리비 {year, summer, winter} (만원/세대/월) | 552 |
| `slope_results.json` | 고저차 결과 | 791 |
| `pediatric_clinics.json` | 소아과 [{name, walk_min, road_m}] | 1,020 |
| `pedia_slope.json` | 소아과 고저차 [소아과1, 소아과2] (m) | 1,027 |
| `school_map.json` | 배정초등학교 (name→[학교명]) | 1,027 |
| `school_violence_full.json` | 학폭 4개년 데이터 | 164 학교 |
| `commute_results.json` | 출퇴근 측정 이력 (배치별) | 누적 |
| `safety_scores.json` | 치안/안전등급 (12 시군구) | 12 |
| `multicultural.json` | 다문화학생 현황 (5개 시, 전체학생수 포함) | 5 |
| `hgnn_names.json` | 호갱노노 표시 이름 매핑 | 20 |

## 프론트엔드 (home-scoring/)

| 파일 | 설명 |
|------|------|
| `pipeline/App.tsx` | 메인 대시보드 (필터, 테이블, 검색, 금융 계산) |
| `pipeline/components/AptMap.tsx` | Google Maps 지도 뷰 (마커 + 멀티타입 툴팁) |
| `pipeline/lib/scoring.ts` | 스코어링 로직 (가중치, 타입 분류, 라벨) |
| `public/data.json` | sync.ts 생성, 1,475개 타입 |
| `public/multicultural.json` | 다문화 통계 (sync.ts에서 복사) |
| `.env` | `VITE_GOOGLE_MAPS_KEY` (Maps JavaScript API, referer 제한) |
