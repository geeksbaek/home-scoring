// Firebase 초기화 — 즐겨찾기/설정 클라우드 동기화용 (Auth + Firestore)
//
// config는 Vite 빌드타임 env(`VITE_FIREBASE_*`)에서 주입된다. GitHub Pages 정적
// 배포라 서버가 없으므로 클라이언트 SDK만으로 동작한다. config가 비어 있으면
// (= 로컬 개발 중 .env 미설정, 또는 fork) `firebaseReady === false`가 되어
// 로그인 UI 자체가 렌더되지 않는다 — graceful degradation.
import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, OAuthProvider, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

// Auth + Firestore에 필수인 최소 키만 확인 (storageBucket 등은 옵션)
export const firebaseReady = Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

if (firebaseReady) {
  app = initializeApp(config as Required<typeof config>);
  authInstance = getAuth(app);
  dbInstance = getFirestore(app);
}

export const auth = authInstance;
export const db = dbInstance;

// 구글 — 기본 OAuth. account chooser 강제로 다계정 사용자 편의.
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

// 애플 — OAuthProvider("apple.com"). 이메일/이름 스코프 요청.
export const appleProvider = new OAuthProvider("apple.com");
appleProvider.addScope("email");
appleProvider.addScope("name");
