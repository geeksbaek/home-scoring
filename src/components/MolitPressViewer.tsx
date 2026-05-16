import { useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    let cancelled = false;
    fetch(PUBLIC_JSON_URL)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: PressRelease[]) => { if (!cancelled) setData(json); })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.body.style.overflow = "hidden";
    document.body.classList.add("molit-press-open");
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.body.classList.remove("molit-press-open");
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
  const buttonLabel = "📰 보도자료";

  useEffect(() => {
    if (!open || !selected) return;
    if (readIds.has(selected.id)) return;
    const next = new Set(readIds);
    next.add(selected.id);
    setReadIds(next);
    saveReadIds(next);
  }, [open, selected, readIds]);

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
          "relative text-[10px] h-auto py-0.5 px-2 transition-colors",
          unreadCount > 0 && "bg-blue-600 hover:bg-blue-700 text-white border-blue-600 font-semibold shadow-sm",
        )}
        onClick={() => setOpen(true)}
      >
        {buttonLabel}
        {unreadCount > 0 && (
          <span className="ml-1 inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full bg-white text-blue-600 text-[9px] font-bold tabular-nums">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 bg-background">
          <div className="h-full max-w-7xl mx-auto px-3 py-3 sm:px-6 sm:py-5 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold">📰 국토교통부 보도자료</h2>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs px-2" onClick={markAllRead}>
                    모두 읽음
                  </Button>
                )}
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => setOpen(false)}>닫기 (Esc)</Button>
              </div>
            </div>

            {err && <div className="text-xs text-red-500">로드 실패: {err}</div>}
            {!data && !err && <div className="text-xs text-muted-foreground">불러오는 중...</div>}

            {data && (
              <div className="flex-1 min-h-0 grid grid-cols-12 gap-3">
                <aside className="col-span-12 sm:col-span-4 lg:col-span-3 min-h-0 overflow-y-auto rounded border bg-card">
                  <ul className="divide-y">
                    {items.map((it) => {
                      const isActive = (selected?.id ?? null) === it.id;
                      const hasMd = it.attachments.some((a) => a.type === "pdf" && a.markdown);
                      const isUnread = !readIds.has(it.id);
                      return (
                        <li key={it.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(it.id)}
                            className={cn(
                              "w-full text-left px-3 py-2 text-xs hover:bg-muted/50",
                              isActive && "bg-muted",
                              !isUnread && !isActive && "opacity-60",
                            )}
                          >
                            <div className="flex items-center gap-1 mb-0.5">
                              {isUnread && <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" aria-label="안읽음" />}
                              <span className="text-[10px] text-muted-foreground tabular-nums">{formatDate(it.publishedDate ?? it.publishedAt)}</span>
                              {!hasMd && <span className="text-[9px] text-amber-500" title="마크다운 변환 미완료">md×</span>}
                            </div>
                            <div className={cn("line-clamp-2", isUnread ? "font-semibold" : "font-normal")}>{it.title}</div>
                            {it.subtitle && <div className="line-clamp-2 text-[11px] text-muted-foreground mt-0.5">{it.subtitle}</div>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </aside>

                <section className="col-span-12 sm:col-span-8 lg:col-span-9 min-h-0 overflow-y-auto rounded border bg-card px-4 py-4">
                  {selected ? (
                    <article>
                      <header className="mb-3 border-b pb-3">
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
                          <span>{formatDate(selected.publishedDate ?? selected.publishedAt)}</span>
                          <a href={selected.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">원문 ↗</a>
                          {body && <span className="text-emerald-500">· PDF: {body.name}</span>}
                        </div>
                        <h3 className="text-lg font-bold leading-snug">{selected.title}</h3>
                        {selected.subtitle && <p className="text-sm text-muted-foreground mt-1">{selected.subtitle}</p>}
                      </header>
                      {body ? (
                        <div className="prose prose-sm prose-invert max-w-none">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body.markdown}</ReactMarkdown>
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">
                          마크다운 변환 결과가 없습니다. RSS 요약: <br />
                          <span className="block mt-2">{selected.rssDescriptionText}</span>
                        </div>
                      )}
                    </article>
                  ) : (
                    <div className="text-xs text-muted-foreground">목록에서 항목을 선택하세요.</div>
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
