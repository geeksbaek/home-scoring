// 로그인 / 클라우드 동기화 버튼 (헤더)
//
// firebaseReady === false (=.env 미설정/fork)이면 아무것도 렌더하지 않는다.
// 로그인 전: 구글 로그인 메뉴. 로그인 후: 계정 + 동기화 상태 + 로그아웃.
// (애플 로그인은 provider 설정 전까지 UI에서 숨김 — firebase.ts의 appleProvider/아래
//  AppleIcon 복원 + Apple 버튼 추가로 되살릴 수 있다.)
import { useEffect, useState } from "react";
import { signInWithPopup, onAuthStateChanged, type User } from "firebase/auth";
import { auth, googleProvider, firebaseReady } from "@/lib/firebase";
import { initSync, onSyncState, logout, type SyncState } from "@/lib/sync";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const SYNC_LABEL: Record<SyncState["status"], string> = {
  idle: "",
  syncing: "동기화 중…",
  synced: "동기화됨",
  error: "동기화 오류",
};

export default function AuthButton() {
  const [user, setUser] = useState<User | null>(null);
  const [sync, setSync] = useState<SyncState>({ status: "idle" });
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!firebaseReady || !auth) return;
    initSync(); // localStorage 패치 + auth 상태 구독 (idempotent)
    const offAuth = onAuthStateChanged(auth, setUser);
    const offSync = onSyncState(setSync);
    return () => {
      offAuth();
      offSync();
    };
  }, []);

  if (!firebaseReady) return null;

  const login = async (provider: typeof googleProvider) => {
    setErr(null);
    try {
      await signInWithPopup(auth!, provider);
      setOpen(false);
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code ?? "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return;
      if (code === "auth/operation-not-allowed") setErr("이 로그인 방식이 Firebase 콘솔에서 아직 활성화되지 않았습니다.");
      else setErr("로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    }
  };

  // ── 로그인 상태 ──
  if (user) {
    const label = SYNC_LABEL[sync.status];
    const photo = user.photoURL;
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="flex items-center gap-1.5 rounded border border-border px-2 py-0.5 text-[10px] hover:bg-accent"
          title={`${user.email ?? "로그인됨"}${label ? ` · ${label}` : ""}`}
        >
          {photo ? (
            <img src={photo} alt="" className="h-4 w-4 rounded-full" referrerPolicy="no-referrer" />
          ) : (
            <span className="grid h-4 w-4 place-items-center rounded-full bg-primary/20 text-[8px]">
              {(user.displayName ?? user.email ?? "?").slice(0, 1).toUpperCase()}
            </span>
          )}
          <span
            className={
              sync.status === "error"
                ? "text-destructive"
                : sync.status === "syncing"
                  ? "text-amber-500"
                  : "text-emerald-500"
            }
          >
            {sync.status === "error" ? "⚠" : "☁"}
          </span>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-3 text-xs">
          <div className="mb-2">
            <div className="font-medium truncate">{user.displayName ?? "로그인됨"}</div>
            {user.email && <div className="text-muted-foreground truncate">{user.email}</div>}
          </div>
          <div className="mb-2 flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>{sync.status === "error" ? "⚠" : "☁"}</span>
            <span>{label || "대기 중"}</span>
          </div>
          <p className="mb-2 text-[10px] text-muted-foreground leading-relaxed">
            즐겨찾기·필터·가중치와 자금/소득 설정이 본인 계정에만 클라우드 동기화됩니다. (보안 규칙상 타인 접근 불가)
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              logout();
            }}
            className="w-full rounded border border-border px-2 py-1 text-[11px] hover:bg-accent"
          >
            로그아웃
          </button>
        </PopoverContent>
      </Popover>
    );
  }

  // ── 로그아웃 상태 ──
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] hover:bg-accent" title="로그인하면 즐겨찾기·설정이 기기 간 동기화됩니다">
        <span>☁</span>
        <span>로그인</span>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-3 text-xs">
        <p className="mb-2 text-[11px] text-muted-foreground leading-relaxed">
          로그인하면 즐겨찾기·필터·가중치와 자금/소득 설정이 본인 계정에만 클라우드 동기화됩니다.
        </p>
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => login(googleProvider)}
            className="flex w-full items-center justify-center gap-2 rounded border border-border bg-white px-2 py-1.5 text-[12px] font-medium text-neutral-800 hover:bg-neutral-100"
          >
            <GoogleIcon />
            Google로 계속
          </button>
          {/* 애플 로그인은 provider 설정 후 복원 */}
        </div>
        {err && <p className="mt-2 text-[10px] text-destructive">{err}</p>}
      </PopoverContent>
    </Popover>
  );
}

function GoogleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.94H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.06l3.01-2.34z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

