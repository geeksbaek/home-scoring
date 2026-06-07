# 로그인 & 클라우드 동기화 (Firebase)

즐겨찾기와 필터·가중치 설정을 구글/애플 로그인으로 기기 간 동기화한다.
GitHub Pages 정적 배포라 서버가 없어 **Firebase(Auth + Firestore)** 클라이언트 SDK만으로 동작한다.

## 동작 개요

- 모든 앱 상태는 `localStorage`에 저장된다. 동기화 레이어(`src/lib/sync.ts`)가
  `localStorage.setItem`을 monkey-patch 해 **동기화 대상 키 변경을 감지** → debounce 후
  Firestore `users/{uid}` 문서로 push 한다.
- **로그인 시** Firestore 문서를 source of truth 로 로컬에 적용하고, 변경이 있으면
  `location.reload()` 로 React 상태를 클라우드 값으로 재주입한다.
- `onSnapshot` 으로 타 기기 변경을 실시간 수신한다. 내가 쓴 변경의 에코는
  문서에 기록한 client-id 로 차단해 무한 reload 를 막는다.
- **`.env` 의 `VITE_FIREBASE_*` 가 비어 있으면 로그인 버튼이 아예 렌더되지 않는다**
  (graceful degradation — fork/로컬 개발 시 그대로 동작).

## 동기화 대상

- `favorites`, `weights`, 모든 `f_*` 필터, `loanYears`, `extraRepayYears`,
  그리고 **자금/소득 민감정보**(`capital`, `income1`, `income2`, `extraLoan`)
  (`src/lib/sync.ts` 의 `SYNC_KEYS`).
- 자금/소득은 사용자 요청으로 동기화 대상에 포함된다. **Firestore 보안 규칙이
  본인 문서(`users/{uid}`)만 read/write 를 허용하므로 타인은 접근할 수 없다.**
  자금 설정 UI 도 "로그인 시 본인 계정에만 클라우드 동기화"로 문구를 맞췄다.

## Firebase 콘솔 설정 (최초 1회)

1. **프로젝트 생성** — https://console.firebase.google.com 에서 새 프로젝트 생성.
2. **웹 앱 등록** — 프로젝트 설정 ⚙ > 일반 > 내 앱 > 웹(`</>`) 추가 →
   표시되는 `firebaseConfig` 값을 `.env` 의 `VITE_FIREBASE_*` 에 채운다:
   | firebaseConfig | .env |
   |---|---|
   | `apiKey` | `VITE_FIREBASE_API_KEY` |
   | `authDomain` | `VITE_FIREBASE_AUTH_DOMAIN` |
   | `projectId` | `VITE_FIREBASE_PROJECT_ID` |
   | `storageBucket` | `VITE_FIREBASE_STORAGE_BUCKET` |
   | `messagingSenderId` | `VITE_FIREBASE_MESSAGING_SENDER_ID` |
   | `appId` | `VITE_FIREBASE_APP_ID` |
3. **Authentication > Sign-in method**
   - **Google**: 사용 설정 → 저장. (별도 작업 없음)
   - **Apple**: 사용 설정. Apple Developer 에서 아래를 발급해 입력한다.
     - Services ID (예: `com.example.homescoring.web`)
     - Apple Team ID, Key ID, `.p8` 개인 키
     - Apple 측 **Return URL** = `https://<authDomain>/__/auth/handler`
       (authDomain 은 보통 `<projectId>.firebaseapp.com`)
4. **Authentication > Settings > Authorized domains** 에 배포 도메인 추가:
   - `geeksbaek.github.io` (GitHub Pages)
   - `localhost` 는 기본 포함됨.
5. **Firestore Database** 생성(반드시 **프로덕션 모드** — 테스트 모드는 30일간 전체
   공개라 금융정보가 노출됨) 후 보안 규칙 게시. 두 방법 중 하나:
   - **CLI 권장**: `firebase use <projectId>` (또는 `.firebaserc` 의 `default` 채우기)
     후 `firebase deploy --only firestore:rules`. repo 의 `firebase.json` 이
     `firestore.rules` 를 가리키므로 커밋된 규칙이 그대로 배포되어 드리프트가 없다.
   - **콘솔 수동**: Firestore > 규칙 탭에 `firestore.rules` 내용을 붙여넣고 게시.
   배포 후 콘솔에서 규칙이 `request.auth.uid == uid` 로 본인 문서만 허용하는지 확인.

## 보안 메모

- `VITE_FIREBASE_API_KEY` 는 비밀이 아니다(클라이언트에 노출되는 식별자). 실제 접근 통제는
  **Firestore 보안 규칙 + Authorized domains** 가 담당한다 → `firestore.rules` 가 본인 문서만
  허용하므로 타인 데이터 접근 불가.
- 자금/소득 민감정보도 Firestore 에 저장되지만, 보안 규칙상 **각 사용자는 자기
  문서만 접근**할 수 있어 타인에게 노출되지 않는다. 전송 구간은 HTTPS 로 암호화된다.
