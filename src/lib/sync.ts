// 즐겨찾기/설정 클라우드 동기화 엔진
//
// 앱의 모든 상태는 localStorage에 저장된다(useState + localStorage 직접, 전역
// 스토어 없음). 따라서 동기화는 React를 우회해 localStorage 레이어에서 처리한다:
//   1) localStorage.setItem/removeItem 을 monkey-patch 해 동기화 키 변경을 캡처
//      → debounce 후 Firestore `users/{uid}` 문서로 push.
//   2) 로그인 시 onSnapshot 으로 원격 문서를 source of truth 로 로컬에 적용 →
//      변경이 있으면 "cloudsync" 이벤트를 디스패치해 App 이 React 상태를 재주입.
//   3) 동일 onSnapshot 구독이 타 기기 변경도 실시간 반영한다(페이지 reload 없이).
//
// 데이터 손실/핑퐁 방지 장치:
//   - `pulled` 플래그: 최초 원격 pull 이 끝나기 전에는 절대 push 하지 않는다.
//   - **동일값 재기록은 push 하지 않는다(prev === next 면 skip)**: 마운트 시
//     App 의 useEffect 들이 모든 f_* 키를 같은 값으로 다시 setItem 하는데, 이게
//     stale push 를 일으켜 다른 기기의 최신 변경을 덮어쓰던 문제를 차단한다.
//   - 에코(내 쓰기 되돌아옴)는 client-id 로 식별해 무시한다.
import { auth, db, firebaseReady } from "./firebase";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, setDoc, onSnapshot, type Unsubscribe } from "firebase/firestore";

// 동기화 대상 — 즐겨찾기 + 필터/표시 설정 + 가중치 + 자금/소득 + 프록시 설정.
// 자금/소득(FINANCE_KEYS)과 프록시 토큰도 동기화 대상이다(사용자 요청).
// Firestore 보안 규칙이 본인 문서(users/{uid})만 read/write 허용하므로 타인 접근 불가.
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
  "naverProxyUrl",
  "naverProxyToken",
] as const;
const SYNC_SET = new Set<string>(SYNC_KEYS);
// KB 시세 수동 입력값은 단지×타입별 동적 키(`kb:{name}|{atype}`) → prefix 로 매칭.
const KB_PREFIX = "kb:";
// 미push 로컬변경 시각(ms). reload로 pushTimer가 사라져도 살아남아, 다음 로드에서
// "로컬이 원격보다 최신"임을 판별하는 근거가 된다. 동기화 대상 키 아님(SYNC_KEYS/kb: 제외).
const PENDING_TS_KEY = "_sync_pending_ts";
function isSyncKey(k: string): boolean {
  return SYNC_SET.has(k) || k.startsWith(KB_PREFIX);
}

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

// 원격 변경을 로컬에 적용한 뒤, App 이 React 상태를 재주입하도록 신호.
export const CLOUD_SYNC_EVENT = "cloudsync";
function emitCloudSync() {
  try {
    window.dispatchEvent(new CustomEvent(CLOUD_SYNC_EVENT));
  } catch {
    /* SSR/비브라우저 가드 */
  }
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
    // 값이 실제로 바뀐 경우에만 push 예약. 동일값 재기록(마운트 useEffect 등)은 무시.
    const prev = localStorage.getItem(k);
    origSet.call(localStorage, k, v);
    if (!applying && prev !== v && isSyncKey(k)) schedulePush();
  };
  localStorage.removeItem = function (k: string) {
    const had = localStorage.getItem(k) !== null;
    origRemove.call(localStorage, k);
    if (!applying && had && isSyncKey(k)) schedulePush();
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

// 동기화 대상 키 전체(고정 SYNC_KEYS + 현재 존재하는 kb:* 동적 키) 수집.
function allLocalKeys(): string[] {
  const keys = new Set<string>(SYNC_KEYS);
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(KB_PREFIX)) keys.add(k);
  }
  return [...keys];
}

function snapshotLocal(): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const k of allLocalKeys()) {
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
    // 고정 키 + remote 에 담겨온 kb:* 키 모두 적용 대상.
    const keys = new Set<string>(SYNC_KEYS);
    for (const k of Object.keys(kv)) if (k.startsWith(KB_PREFIX)) keys.add(k);
    for (const k of keys) {
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
const DEBOUNCE_MS = 800;

function schedulePush() {
  if (!currentUser || !db || !pulled) return;
  // 미push 변경 시각 기록 → reload로 timer가 유실돼도 다음 로드에서 로컬 우선 판별 근거.
  rawSet(PENDING_TS_KEY, String(Date.now()));
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, DEBOUNCE_MS);
}

async function pushNow() {
  pushTimer = undefined;
  if (!currentUser || !db || !pulled) return;
  const ts = localStorage.getItem(PENDING_TS_KEY); // push 직전 dirty 스냅샷
  try {
    notify({ status: "syncing" });
    await setDoc(doc(db, "users", currentUser.uid), {
      kv: snapshotLocal(),
      updatedAt: Date.now(),
      client: clientId(),
    });
    // push 도중 새 변경이 없었으면 dirty 해제(있었으면 그 변경이 다시 push 예약돼 마커 유지).
    if (localStorage.getItem(PENDING_TS_KEY) === ts) rawRemove(PENDING_TS_KEY);
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
  unsub = onSnapshot(
    ref,
    (s) => {
      // 로컬에 미반영 편집이 대기 중이면 이번 원격 적용을 건너뛴다.
      if (pushTimer) return;

      if (!s.exists()) {
        // 첫 로그인 — 원격 문서가 없으면 현재 로컬을 업로드.
        pulled = true;
        pushNow();
        return;
      }
      const d = s.data() as { kv?: Record<string, string>; client?: string; updatedAt?: number };
      if (d.client === clientId()) {
        // 내 쓰기 에코 — 적용 불필요. push 는 계속 허용.
        pulled = true;
        rawRemove(PENDING_TS_KEY);
        notify({ status: "synced", at: Date.now() });
        return;
      }
      // reload 등으로 pushTimer가 유실됐어도, 미push 로컬변경이 원격보다 최신이면
      // 로컬을 우선 업로드한다(= stale 원격이 방금 바꾼 필터값을 덮어쓰는 현상 차단).
      const pendingTs = Number(localStorage.getItem(PENDING_TS_KEY) || 0);
      if (pendingTs > Number(d.updatedAt || 0)) {
        pulled = true;
        pushNow();
        return;
      }
      const changed = applyRemote(d.kv ?? {});
      pulled = true;
      rawRemove(PENDING_TS_KEY); // 원격을 source of truth 로 채택 → dirty 해제
      if (changed) emitCloudSync(); // React 상태 재주입 (reload 없이 실시간 반영)
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
  // 탭 숨김/이탈 직전 대기 중 push 를 즉시 flush → 변경 직후 새로고침/이탈에도 유실 최소화.
  // (완전 유실 시에도 PENDING_TS_KEY 기반으로 다음 로드에서 로컬이 복구됨.)
  if (typeof document !== "undefined") {
    const flush = () => {
      if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = undefined;
        pushNow();
      }
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);
  }
  onAuthStateChanged(auth, (user) => {
    if (user) startSync(user);
    else stopSync();
  });
}
