import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Attachment = {
  name: string;
  type: string | null;
  url: string;
  viewerUrl: string | null;
  markdown?: string;
};

type PressRelease = {
  id: string;
  title: string;
  subtitle: string | null;
  publishedAt: string | null;
  publishedDate: string | null;
  url: string;
  rssDescriptionText: string;
  attachments: Attachment[];
};

const PUBLIC_JSON_URL = `${import.meta.env.BASE_URL ?? "/"}molit_press.json`.replace(/\/+/g, "/");

function formatDate(value: string | null): string {
  if (!value) return "";
  if (/^\d{4}\.\d{2}\.\d{2}/.test(value)) return value.slice(0, 10);
  return value.slice(0, 10);
}

function pickPdfMarkdown(attachments: Attachment[]): { name: string; markdown: string } | null {
  const pdf = attachments.find((a) => a.type === "pdf" && a.markdown);
  return pdf && pdf.markdown ? { name: pdf.name, markdown: pdf.markdown } : null;
}

const READ_STORAGE_KEY = "molit_press_read_ids_v1";

function loadReadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((v) => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveReadIds(ids: Set<string>) {
  try {
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore quota errors
  }
}

export default function MolitPressViewer() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PressRelease[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(() => loadReadIds());
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  // 모바일(sm 미만)은 목록 ⇄ 본문 단일 패널 전환식. sm+ 에선 항상 양 패널.
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const articleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(PUBLIC_JSON_URL)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: PressRelease[]) => { if (!cancelled) setData(json); })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, []);

  const items = useMemo(() => data ?? [], [data]);
  const selected = useMemo(
    () => items.find((it) => it.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
  );
  const body = selected ? pickPdfMarkdown(selected.attachments) : null;
  const unreadCount = useMemo(
    () => items.reduce((n, it) => n + (readIds.has(it.id) ? 0 : 1), 0),
    [items, readIds],
  );

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (unreadOnly && readIds.has(it.id) && it.id !== selected?.id) return false;
      if (!q) return true;
      return `${it.title} ${it.subtitle ?? ""}`.toLowerCase().includes(q);
    });
  }, [items, query, unreadOnly, readIds, selected]);

  // 목록은 최신순 — dir +1 = 더 오래된 글, -1 = 더 최신 글
  const navigate = useCallback((dir: 1 | -1) => {
    if (filteredItems.length === 0) return;
    const idx = filteredItems.findIndex((it) => it.id === selected?.id);
    const next = idx === -1 ? 0 : Math.min(Math.max(idx + dir, 0), filteredItems.length - 1);
    setSelectedId(filteredItems[next].id);
    setMobilePane("detail");
  }, [filteredItems, selected]);
  const selectedIdx = filteredItems.findIndex((it) => it.id === selected?.id);

  // 본문 스크롤 잠금 (뷰어 열림 동안)
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    document.body.classList.add("molit-press-open");
    return () => {
      document.body.style.overflow = "";
      document.body.classList.remove("molit-press-open");
    };
  }, [open]);

  // 키보드: Esc 닫기(모바일 본문에선 목록으로), ←/→ 최신/과거 글 이동
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (window.matchMedia("(max-width: 639px)").matches && mobilePane === "detail") setMobilePane("list");
        else setOpen(false);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); navigate(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); navigate(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, mobilePane, navigate]);

  // 글 변경 시 본문 맨 위로 + 목록에서 선택 항목 보이게
  useEffect(() => {
    if (!open || !selected) return;
    articleRef.current?.scrollTo({ top: 0 });
    document.getElementById(`molit-press-${selected.id}`)?.scrollIntoView({ block: "nearest" });
  }, [open, selected]);

  // 실제로 본문이 보일 때만 읽음 처리 (모바일 목록 화면에선 미처리)
  useEffect(() => {
    if (!open || !selected) return;
    const desktop = window.matchMedia("(min-width: 640px)").matches;
    if (!desktop && mobilePane !== "detail") return;
    if (readIds.has(selected.id)) return;
    const next = new Set(readIds);
    next.add(selected.id);
    setReadIds(next);
    saveReadIds(next);
  }, [open, selected, mobilePane, readIds]);

  const markAllRead = () => {
    if (items.length === 0) return;
    const next = new Set(readIds);
    for (const it of items) next.add(it.id);
    setReadIds(next);
    saveReadIds(next);
  };

  return (
    <>
      <Button
        variant={unreadCount > 0 ? "default" : "outline"}
        size="sm"
        className={cn(
          "relative text-[11px] h-7 px-2 transition-colors",
          unreadCount > 0 && "bg-blue-600 hover:bg-blue-700 text-white border-blue-600 font-semibold shadow-sm",
        )}
        onClick={() => { setOpen(true); setMobilePane("list"); }}
      >
        📰 보도자료
        {unreadCount > 0 && (
          <span className="ml-1 inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full bg-white text-blue-600 text-[9px] font-bold tabular-nums">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 bg-background">
          <div className="h-full max-w-7xl mx-auto px-2.5 py-2.5 sm:px-6 sm:py-5 flex flex-col gap-2.5 sm:gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {mobilePane === "detail" && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs shrink-0 sm:hidden" onClick={() => setMobilePane("list")}>
                  ← 목록
                </Button>
              )}
              <h2 className="text-base font-bold truncate">📰 국토교통부 보도자료</h2>
              {data && (
                <span className="text-[11px] text-muted-foreground whitespace-nowrap hidden sm:inline">
                  {items.length}건{unreadCount > 0 && ` · 안읽음 ${unreadCount}`}
                </span>
              )}
              <div className="ml-auto flex items-center gap-1.5 shrink-0">
                {unreadCount > 0 && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs px-2" onClick={markAllRead}>
                    모두 읽음
                  </Button>
                )}
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => setOpen(false)}>
                  닫기 <span className="hidden sm:inline ml-0.5">(Esc)</span>
                </Button>
              </div>
            </div>

            {err && <div className="text-xs text-red-500">로드 실패: {err}</div>}
            {!data && !err && <div className="text-xs text-muted-foreground">불러오는 중...</div>}

            {data && (
              <div className="flex-1 min-h-0 flex gap-3">
                {/* 목록 패널 */}
                <aside
                  className={cn(
                    "min-h-0 flex-col rounded-lg border bg-card w-full sm:w-72 lg:w-80 xl:w-96 shrink-0",
                    mobilePane === "detail" ? "hidden sm:flex" : "flex",
                  )}
                >
                  <div className="p-2 border-b flex items-center gap-1.5 shrink-0">
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="제목·부제 검색..."
                      className="flex-1 min-w-0 h-7 rounded border bg-background px-2 text-xs outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      onClick={() => setUnreadOnly((v) => !v)}
                      className={cn(
                        "h-7 px-2 rounded border text-[11px] whitespace-nowrap transition-colors",
                        unreadOnly ? "border-blue-500/60 bg-blue-500/15 text-blue-400 font-medium" : "text-muted-foreground hover:bg-muted/50",
                      )}
                      title="안 읽은 글만 표시"
                    >
                      안읽음
                    </button>
                  </div>
                  <ul className="flex-1 min-h-0 overflow-y-auto divide-y overscroll-contain">
                    {filteredItems.length === 0 && (
                      <li className="px-3 py-6 text-xs text-muted-foreground text-center">
                        {query ? "검색 결과가 없습니다" : "안 읽은 글이 없습니다"}
                      </li>
                    )}
                    {filteredItems.map((it) => {
                      const isActive = (selected?.id ?? null) === it.id;
                      const hasMd = it.attachments.some((a) => a.type === "pdf" && a.markdown);
                      const isUnread = !readIds.has(it.id);
                      return (
                        <li key={it.id} id={`molit-press-${it.id}`}>
                          <button
                            type="button"
                            onClick={() => { setSelectedId(it.id); setMobilePane("detail"); }}
                            className={cn(
                              "w-full text-left px-3 py-2.5 sm:py-2 text-xs transition-colors hover:bg-muted/50 border-l-2 border-l-transparent",
                              isActive && "bg-muted border-l-primary",
                              !isUnread && !isActive && "opacity-55",
                            )}
                          >
                            <div className="flex items-center gap-1.5 mb-0.5">
                              {isUnread && <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" aria-label="안읽음" />}
                              <span className="text-[10px] text-muted-foreground tabular-nums">{formatDate(it.publishedDate ?? it.publishedAt)}</span>
                              {!hasMd && <span className="text-[9px] text-amber-500" title="본문 변환 전 — 원문 링크로 확인">변환 전</span>}
                            </div>
                            <div className={cn("line-clamp-2 leading-snug", isUnread ? "font-semibold" : "font-normal")}>{it.title}</div>
                            {it.subtitle && <div className="line-clamp-1 text-[11px] text-muted-foreground mt-0.5">{it.subtitle}</div>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </aside>

                {/* 본문 패널 */}
                <section
                  className={cn(
                    "min-h-0 flex-1 flex-col rounded-lg border bg-card min-w-0",
                    mobilePane === "list" ? "hidden sm:flex" : "flex",
                  )}
                >
                  {selected ? (
                    <>
                      <header className="px-3 sm:px-5 py-3 border-b shrink-0">
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1.5">
                          <span className="tabular-nums">{formatDate(selected.publishedDate ?? selected.publishedAt)}</span>
                          <a href={selected.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline shrink-0">원문 ↗</a>
                          <div className="ml-auto flex items-center gap-1 shrink-0">
                            <Button
                              variant="outline" size="sm" className="h-6 px-1.5 text-[11px]"
                              disabled={selectedIdx <= 0}
                              onClick={() => navigate(-1)}
                              title="더 최신 글 (←)"
                            >← 최신</Button>
                            <Button
                              variant="outline" size="sm" className="h-6 px-1.5 text-[11px]"
                              disabled={selectedIdx === -1 || selectedIdx >= filteredItems.length - 1}
                              onClick={() => navigate(1)}
                              title="더 오래된 글 (→)"
                            >과거 →</Button>
                          </div>
                        </div>
                        <h3 className="text-base sm:text-lg font-bold leading-snug">{selected.title}</h3>
                        {selected.subtitle && <p className="text-xs sm:text-sm text-muted-foreground mt-1">{selected.subtitle}</p>}
                        {selected.attachments.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {selected.attachments.map((a, i) => (
                              <a
                                key={i}
                                href={a.viewerUrl ?? a.url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 max-w-[16rem] rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                                title={a.name}
                              >
                                📎 <span className="truncate">{a.name}</span>
                              </a>
                            ))}
                          </div>
                        )}
                      </header>
                      <div ref={articleRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 sm:px-5 py-4">
                        {body ? (
                          <div className="prose prose-sm prose-invert max-w-none [&_table]:text-xs [&_table]:block [&_table]:overflow-x-auto">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body.markdown}</ReactMarkdown>
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground leading-relaxed">
                            <p className="mb-2 text-amber-500">아직 본문(PDF → 마크다운) 변환 전입니다. 아래 RSS 요약 또는 상단 원문 링크를 확인하세요.</p>
                            <p>{selected.rssDescriptionText}</p>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">목록에서 항목을 선택하세요.</div>
                  )}
                </section>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
