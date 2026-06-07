// 즐겨찾기/설정 클라우드 동기화 엔진
//
// 앱의 모든 상태는 localStorage에 저장된다(useState + localStorage 직접, 전역
// 스토어 없음). 따라서 동기화는 React를 우회해 localStorage 레이어에서 처리한다:
//   1) localStorage.setItem/removeItem 을 monkey-patch 해 SYNC_KEYS 변경을 캡처
//      → debounce 후 Firestore `users/{uid}` 문서로 push.
//   2) 로그인 시 onSnapshot 으로 원격 문서를 source of truth 로 로컬에 적용 →
//      변경이 있으면 location.reload()로 React 상태를 클라우드 값으로 재주입.
//   3) 동일 onSnapshot 구독이 타 기기 변경도 실시간 반영.
//
// 데이터 손실 방지 장치:
//   - `pulled` 플래그: 최초 원격 pull 이 끝나기 전에는 절대 push 하지 않는다.
//     (stale 로컬이 원격 문서를 통째로 덮어쓰는 사고 차단)
//   - onSnapshot 콜백은 로컬에 미반영 편집(pushTimer 대기)이 있으면 적용을 건너뛴다.
//     (방금 한 로컬 편집이 reload 로 폐기되는 경합 차단)
//   - 에코(내 쓰기 되돌아옴)는 client-id 로 식별해 무한 reload 를 막는다.
//
// 쓰기는 setDoc(merge 없이) 전체 교체다 — 키 삭제 전파를 위해 의도된 선택이며,
// 단일 사용자·저빈도 시나리오에서 last-write-wins 를 수용한다. pull-before-push
// 가드 덕에 로컬은 항상 최신 원격을 머지한 상태에서만 push 한다.
import { auth, db, firebaseReady } from "./firebase";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, setDoc, onSnapshot, type Unsubscribe } from "firebase/firestore";

// 동기화 대상 — 즐겨찾기 + 필터/표시 설정 + 가중치 + 자금/소득.
// 자금/소득(FINANCE_KEYS)도 동기화 대상이다(사용자 요청). Firestore 보안 규칙이
// 본인 문서(users/{uid})만 read/write 허용하므로 타인은 접근할 수 없다.
const FINANCE_KEYS = ["capital", "income1", "income2", "extraLoan"] as const;
export const SYNC_KEYS = [
  "favorites",
  "weights",
  ...FINANCE_KEYS,
  "f_type_multi",
  "f_sort",
  "f_region_multi",
  "f_commute",
  "f_pedia",
  "f_parking",
  "f_commuteSlot",
  "f_trendRange",
  "f_liquidity",
  "f_accel",
  "f_priceMin",
  "f_priceMax",
  "f_hhMin",
  "f_buildMin",
  "f_tradeMin",
  "f_exDirect",
  "f_ex1F",
  "f_firstTime",
  "f_loanProduct",
  "f_interestSubsidy",
  "f_includeInterior",
  "f_naverCol",
  "f_moveInMonth",
  "loanYears",
  "extraRepayYears",
] as const;
const SYNC_SET = new Set<string>(SYNC_KEYS);

// ───────────────────────── 상태 구독 (AuthButton 표시용) ─────────────────────
export type SyncStatus = "idle" | "syncing" | "synced" | "error";
export type SyncState = { status: SyncStatus; at?: number; error?: string };
let state: SyncState = { status: "idle" };
const listeners = new Set<(s: SyncState) => void>();
function notify(next: SyncState) {
  state = next;
  for (const l of listeners) l(state);
}
export function onSyncState(l: (s: SyncState) => void): () => void {
  listeners.add(l);
  l(state);
  return () => {
    listeners.delete(l);
  };
}
export function getSyncState(): SyncState {
  return state;
}

// ───────────────────────── localStorage 패치 ────────────────────────────────
// applyRemote 가 localStorage 를 갱신할 때 push 가 재트리거되지 않도록 억제.
let applying = false;
// 패치 우회용 원본 메서드 (applyRemote/로그아웃 정리가 사용 → push 루프 차단)
let rawSet: (k: string, v: string) => void = (k, v) => localStorage.setItem(k, v);
let rawRemove: (k: string) => void = (k) => localStorage.removeItem(k);

function installPatch() {
  // 멱등성 가드는 globalThis 심볼에 둔다. (localStorage.setItem.bind() 로 캡처한
  // 함수에는 커스텀 프로퍼티가 복사되지 않아 .__synced 검사가 무력화되던 문제 +
  // Vite HMR 모듈 재평가 시 중복 설치를 모두 차단)
  const g = globalThis as { __homeScoringSyncPatched?: boolean };
  if (g.__homeScoringSyncPatched) return;
  g.__homeScoringSyncPatched = true;

  const origSet = Storage.prototype.setItem;
  const origRemove = Storage.prototype.removeItem;
  rawSet = (k, v) => origSet.call(localStorage, k, v);
  rawRemove = (k) => origRemove.call(localStorage, k);

  localStorage.setItem = function (k: string, v: string) {
    origSet.call(localStorage, k, v);
    if (!applying && SYNC_SET.has(k)) schedulePush();
  };
  localStorage.removeItem = function (k: string) {
    origRemove.call(localStorage, k);
    if (!applying && SYNC_SET.has(k)) schedulePush();
  };
}

// 세션 단위 client-id — 에코 식별용. 같은 탭 reload 시 유지(sessionStorage).
function clientId(): string {
  let id = sessionStorage.getItem("sync_client_id");
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Math.random()).slice(2) + String(performance.now());
    sessionStorage.setItem("sync_client_id", id);
  }
  return id;
}

function snapshotLocal(): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const k of SYNC_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) kv[k] = v;
  }
  return kv;
}

// 원격 kv 를 로컬에 적용. 실제 변경이 발생하면 true. (remote 에 없는 키는 보존)
function applyRemote(kv: Record<string, string>): boolean {
  let changed = false;
  applying = true;
  try {
    for (const k of SYNC_KEYS) {
      const rv = kv[k];
      if (rv === undefined) continue;
      if (rv !== localStorage.getItem(k)) {
        rawSet(k, rv);
        changed = true;
      }
    }
  } finally {
    applying = false;
  }
  return changed;
}

// ───────────────────────── push / pull ──────────────────────────────────────
let currentUser: User | null = null;
let unsub: Unsubscribe | null = null;
let pushTimer: ReturnType<typeof setTimeout> | undefined;
let pulled = false; // 최초 원격 pull 완료 전에는 push 금지 (데이터 손실 차단)

function schedulePush() {
  if (!currentUser || !db || !pulled) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1200);
}

async function pushNow() {
  pushTimer = undefined;
  if (!currentUser || !db || !pulled) return;
  try {
    notify({ status: "syncing" });
    await setDoc(doc(db, "users", currentUser.uid), {
      kv: snapshotLocal(),
      updatedAt: Date.now(),
      client: clientId(),
    });
    notify({ status: "synced", at: Date.now() });
  } catch (e) {
    notify({ status: "error", error: String(e) });
  }
}

function startSync(user: User) {
  if (!db) return;
  currentUser = user;
  pulled = false;
  notify({ status: "syncing" });
  const ref = doc(db, "users", user.uid);

  // onSnapshot 단독으로 초기 pull + 실시간 구독을 모두 처리한다.
  // (getDoc 분기를 없애 "pull 실패 후 stale push" 경로를 원천 제거)
  unsub = onSnapshot(
    ref,
    (s) => {
      // 로컬에 미반영 편집이 대기 중이면 이번 원격 적용을 건너뛴다.
      // 방금 한 편집이 reload 로 폐기되지 않도록 보호 — 곧 push 후 최신과 재동기화.
      if (pushTimer) return;

      if (!s.exists()) {
        // 첫 로그인 — 원격 문서가 없으면 현재 로컬을 업로드.
        pulled = true;
        pushNow();
        return;
      }
      const d = s.data() as { kv?: Record<string, string>; client?: string };
      if (d.client === clientId()) {
        // 내 쓰기 에코 — 적용/리로드 불필요. push 는 계속 허용.
        pulled = true;
        notify({ status: "synced", at: Date.now() });
        return;
      }
      const changed = applyRemote(d.kv ?? {});
      pulled = true;
      if (changed) {
        // 클라우드(또는 타 기기) 값 적용 → React 상태 재주입 위해 reload.
        location.reload();
        return;
      }
      notify({ status: "synced", at: Date.now() });
    },
    (e) => notify({ status: "error", error: String(e) }),
  );
}

function stopSync() {
  const wasLoggedIn = currentUser != null;
  currentUser = null;
  pulled = false;
  clearTimeout(pushTimer);
  pushTimer = undefined;
  if (unsub) {
    unsub();
    unsub = null;
  }
  // 로그인된 상태에서 빠져나온 경우(=로그아웃)에만 금융 민감정보를 로컬에서 제거.
  // 공유/공용 브라우저에서 다음 사용자에게 잔류·노출되거나, 다음 로그인 계정 문서로
  // 크로스 업로드되는 것을 차단. (초기 로드의 user=null 에서는 제거하지 않음)
  if (wasLoggedIn) {
    for (const k of FINANCE_KEYS) rawRemove(k);
  }
  notify({ status: "idle" });
}

// 로그아웃 — 금융 잔류 제거 후 sign-out, reload 로 React 상태까지 초기화.
export async function logout() {
  for (const k of FINANCE_KEYS) rawRemove(k);
  try {
    if (auth) await signOut(auth);
  } finally {
    location.reload();
  }
}

// ───────────────────────── 초기화 ───────────────────────────────────────────
let started = false;
export function initSync() {
  if (started || !firebaseReady || !auth) return;
  started = true;
  installPatch();
  onAuthStateChanged(auth, (user) => {
    if (user) startSync(user);
    else stopSync();
  });
}
