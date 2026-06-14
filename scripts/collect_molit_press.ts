import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { spawn } from "node:child_process";

type Attachment = {
  name: string;
  type: string | null;
  url: string;
  viewerUrl: string | null;
  localPath?: string;
  markdownPath?: string;
  markdown?: string;
};

type PressRelease = {
  id: string;
  newsId: string | null;
  title: string;
  subtitle: string | null;
  ministry: string | null;
  publishedAt: string | null;
  publishedDate: string | null;
  url: string;
  rssDescription: string;
  rssDescriptionText: string;
  detailTitle: string | null;
  detailSubtitle: string | null;
  canonicalUrl: string | null;
  docViewerUrl: string | null;
  attachments: Attachment[];
  fetchedAt: string;
};

type CliOptions = {
  output: string;
  limit: number;
  since: string | null;
  keyword: string | null;
  includePolicyNews: boolean;
  detail: boolean;
  downloadAttachments: boolean;
  attachmentDir: string;
  convertMd: boolean;
  codexModel: string;
  codexEffort: string;
  dpi: number;
  publicPath: string | null;
};

type RssItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  creator: string;
  dcDate: string;
  guid: string;
};

const RSS_URL = "https://www.korea.kr/rss/dept_molit.xml";
const KOREA_BASE_URL = "https://www.korea.kr";

function usage(): never {
  console.log(`
Usage:
  bun scripts/collect_molit_press.ts [options]

Options:
  --output=PATH              Output JSON path (default: data/molit_press_releases.json)
  --limit=N                  Max new/updated records to process (default: 50)
  --since=YYYY-MM-DD         Include records published on/after this date
  --keyword=TEXT             Filter by title or RSS description text
  --include-policy-news      Include policyNewsView.do items. Default is pressReleaseView.do only.
  --no-detail                Skip korea.kr detail page fetch
  --download-attachments     Download detail-page attachments
  --attachment-dir=PATH      Attachment directory (default: data/molit_press_attachments)
  --convert-md               Convert downloaded PDF attachments to Markdown via codex CLI
  --codex-model=NAME         Codex model (default: gpt-5.5)
  --codex-effort=LEVEL       Codex reasoning effort (default: high)
  --dpi=N                    pdftoppm DPI for rasterization (default: 200)
  --public=PATH              Sync to a public JSON for frontend (inline markdown bodies). Default: public/molit_press.json. Use --public=off to disable.
  --help                     Show this help

Data is saved after every processed item so a crash preserves completed records.
`);
  process.exit(0);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    output: "data/molit_press_releases.json",
    limit: 50,
    since: null,
    keyword: null,
    includePolicyNews: false,
    detail: true,
    downloadAttachments: false,
    attachmentDir: "data/molit_press_attachments",
    convertMd: false,
    codexModel: "gpt-5.5",
    codexEffort: "high",
    dpi: 200,
    publicPath: "public/molit_press.json",
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--include-policy-news") { options.includePolicyNews = true; continue; }
    if (arg === "--no-detail") { options.detail = false; continue; }
    if (arg === "--download-attachments") { options.downloadAttachments = true; continue; }
    if (arg === "--convert-md") { options.convertMd = true; continue; }
    const [key, value] = arg.split("=", 2);
    if (value == null) throw new Error(`Unknown option or missing value: ${arg}`);
    if (key === "--output") options.output = value;
    else if (key === "--limit") options.limit = Number.parseInt(value, 10);
    else if (key === "--since") options.since = value;
    else if (key === "--keyword") options.keyword = value;
    else if (key === "--attachment-dir") options.attachmentDir = value;
    else if (key === "--codex-model") options.codexModel = value;
    else if (key === "--codex-effort") options.codexEffort = value;
    else if (key === "--dpi") options.dpi = Number.parseInt(value, 10);
    else if (key === "--public") options.publicPath = value === "off" ? null : value;
    else throw new Error(`Unknown option: ${key}`);
  }

  if (!Number.isFinite(options.limit) || options.limit < 1) {
    throw new Error("--limit must be a positive integer");
  }
  if (options.since && !/^\d{4}-\d{2}-\d{2}$/.test(options.since)) {
    throw new Error("--since must be YYYY-MM-DD");
  }
  return options;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    middot: "·",
    sim: "~",
  };

  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => named[name] ?? match);
}

function cleanText(value: string): string {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tagValue(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return "";
  const raw = match[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return decodeEntities(cdata ? cdata[1] : raw);
}

function parseRss(xml: string): RssItem[] {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item = match[1];
    return {
      title: tagValue(item, "title"),
      link: tagValue(item, "link"),
      description: tagValue(item, "description"),
      pubDate: tagValue(item, "pubDate"),
      creator: tagValue(item, "dc:creator") || tagValue(item, "creator"),
      dcDate: tagValue(item, "dc:date") || tagValue(item, "date"),
      guid: tagValue(item, "guid"),
    };
  });
}

function parseNewsId(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("newsId");
  } catch {
    return null;
  }
}

function isoFromPubDate(pubDate: string, dcDate: string): string | null {
  const source = dcDate || pubDate;
  if (!source) return null;
  const ms = Date.parse(source);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function absoluteUrl(url: string): string {
  return new URL(decodeEntities(url), KOREA_BASE_URL).toString();
}

function firstMatch(html: string, regex: RegExp): string | null {
  const match = html.match(regex);
  return match ? cleanText(match[1]) : null;
}

function parseAttachments(html: string): Attachment[] {
  const filedown = html.match(/<div class="filedown">([\s\S]*?)<\/div>\s*<!--\/\/ E: file Down -->/i)?.[1] ?? "";
  if (!filedown) return [];

  const attachments: Attachment[] = [];
  for (const match of filedown.matchAll(/<p>([\s\S]*?)<\/p>/gi)) {
    const block = match[1];
    const downloadHref = block.match(/<a[^>]+href=["']([^"']*download\.do\?[^"']+)["'][^>]*>/i)?.[1];
    if (!downloadHref) continue;

    const firstAnchor = block.match(/<a[^>]+href=["'][^"']*download\.do\?[^"']+["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "";
    const name =
      cleanText(firstAnchor)
        .replace(/^(한글파일|PDF파일|이미지파일|엑셀파일|워드파일|압축파일)/, "")
        .trim() || "attachment";
    const viewerHref = block.match(/<a[^>]+class=["']view["'][^>]+href=["']([^"']+)["']/i)?.[1] ?? null;
    const extension = extname(name).replace(".", "").toLowerCase();

    attachments.push({
      name,
      type: extension || null,
      url: absoluteUrl(downloadHref),
      viewerUrl: viewerHref ? absoluteUrl(viewerHref) : null,
    });
  }
  return attachments;
}

function parseDetail(html: string) {
  const canonicalUrl = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ?? null;
  const iframeSrc = html.match(/<iframe[^>]+id=["']content_press["'][^>]+src=["']([^"']+)["']/i)?.[1] ?? null;

  return {
    detailTitle:
      firstMatch(html, /<div class="view_title">\s*<h1>([\s\S]*?)<\/h1>/i) ??
      firstMatch(html, /<meta property=["']og:title["'] content=["']([^"']+)["']/i),
    detailSubtitle: firstMatch(html, /<div class="article_head">[\s\S]*?<h2>([\s\S]*?)<\/h2>/i),
    ministry: firstMatch(html, /<a class="gotosite"[^>]*>([\s\S]*?)<i class="tooltip">/i),
    publishedDate: firstMatch(html, /<div class="variety">[\s\S]*?<div class="info">\s*<span>([\s\S]*?)<\/span>/i),
    canonicalUrl: canonicalUrl ? absoluteUrl(canonicalUrl) : null,
    docViewerUrl: iframeSrc ? absoluteUrl(iframeSrc) : null,
    attachments: parseAttachments(html),
  };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      "User-Agent": "home-scoring-molit-press-collector/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function readExisting(path: string): Promise<PressRelease[]> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PressRelease[];
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

function safeFileName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

async function downloadAttachment(id: string, attachment: Attachment, attachmentDir: string): Promise<string> {
  const dir = join(attachmentDir, id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, safeFileName(attachment.name));
  const response = await fetch(attachment.url, {
    headers: {
      "Accept": "*/*",
      "User-Agent": "home-scoring-molit-press-collector/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`Attachment download failed: ${response.status} ${attachment.url}`);
  }
  await writeFile(path, new Uint8Array(await response.arrayBuffer()));
  return path;
}

const CODEX_PROMPT =
  "이 한국어 정부 보도자료 페이지를 정확히 Markdown으로 변환해줘. " +
  "제목은 #/##, 표는 GFM 표 문법으로 변환. " +
  "페이지 번호·로고·푸터(공공누리 등) 같은 페이지 외 정보는 제외. " +
  "다른 설명 없이 markdown 본문만 출력. 코드블록으로 감싸지 말 것.";

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function mtime(path: string): Promise<number> {
  return (await stat(path)).mtimeMs;
}

// 서브프로세스가 close 이벤트 없이 멈추면(codex가 빈 응답 후 hang 등) Promise가
// 영영 settle되지 않아 스크립트 전체가 무한 정지한다(launchd 작업이 며칠씩 hung →
// 새 인스턴스 미실행 → 자동 갱신 중단). 타임아웃으로 강제 kill + reject 해
// 호출부 try/catch가 "변환 실패"로 넘기고 파이프라인이 계속 진행되게 한다.
const SPAWN_TIMEOUT_MS = 300_000; // 5분 (codex 페이지당 변환 여유 + hang 방지)
function spawnCapture(cmd: string, args: string[], stdin?: string, timeoutMs = SPAWN_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    proc.stdout.on("data", (b) => out.push(b));
    proc.stderr.on("data", (b) => err.push(b));
    proc.on("error", (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? -1,
      });
    });
    if (stdin != null) { proc.stdin.write(stdin); proc.stdin.end(); } else { proc.stdin.end(); }
  });
}

function extractCodexBody(out: string): string {
  // codex exec 출력에서 `\ncodex\n` 다음 본문만 추출, `\ntokens used\n` 직전까지
  const startKey = "\ncodex\n";
  const startIdx = out.indexOf(startKey);
  if (startIdx === -1) return out.trim();
  const after = out.slice(startIdx + startKey.length);
  const endIdx = after.indexOf("\ntokens used\n");
  return (endIdx === -1 ? after : after.slice(0, endIdx)).trim();
}

async function convertPdfToMarkdown(pdfPath: string, options: CliOptions): Promise<string> {
  const dir = dirname(pdfPath);
  const stem = `_tmp_${Date.now()}`;
  const prefix = join(dir, stem);
  const ppm = await spawnCapture("pdftoppm", ["-r", String(options.dpi), "-png", pdfPath, prefix]);
  if (ppm.code !== 0) throw new Error(`pdftoppm failed: ${ppm.stderr}`);

  const { readdir } = await import("node:fs/promises");
  const pages = (await readdir(dir))
    .filter((f) => f.startsWith(`${stem}-`) && f.endsWith(".png"))
    .sort();

  const sections: string[] = [];
  try {
    // 순차 변환: codex CLI는 동시 호출 시 system skills 디렉토리 충돌로 빈 응답 발생
    for (const page of pages) {
      const imgPath = join(dir, page);
      const result = await spawnCapture(
        "codex",
        [
          "exec",
          "-c", `model="${options.codexModel}"`,
          "-c", `model_reasoning_effort="${options.codexEffort}"`,
          "--image", imgPath,
        ],
        CODEX_PROMPT,
      );
      const body = extractCodexBody(result.stdout);
      if (!body) throw new Error(`codex returned empty body for ${page}: ${result.stderr.slice(0, 200)}`);
      sections.push(body);
    }
    return sections.join("\n\n");
  } finally {
    for (const page of pages) await unlink(join(dir, page)).catch(() => {});
  }
}

async function convertAttachmentToMarkdown(attachment: Attachment, options: CliOptions): Promise<string | undefined> {
  if (!attachment.localPath) return undefined;
  if (attachment.type !== "pdf") return undefined;
  const mdPath = `${attachment.localPath.replace(/\.pdf$/i, "")}.md`;
  if (await exists(mdPath) && (await mtime(mdPath)) >= (await mtime(attachment.localPath))) {
    attachment.markdownPath = mdPath;
    attachment.markdown = await readFile(mdPath, "utf8");
    return mdPath;
  }
  const md = await convertPdfToMarkdown(attachment.localPath, options);
  await writeFile(mdPath, md, "utf8");
  attachment.markdownPath = mdPath;
  attachment.markdown = md;
  return mdPath;
}

function makeRecord(item: RssItem): PressRelease {
  const newsId = parseNewsId(item.link) ?? (item.creator || null);
  const id = newsId ?? (item.guid || item.link);
  const publishedAt = isoFromPubDate(item.pubDate, item.dcDate);
  const title = item.title.replace(/^\[국토교통부\]/, "").trim();

  return {
    id,
    newsId,
    title,
    subtitle: null,
    ministry: "국토교통부",
    publishedAt,
    publishedDate: publishedAt?.slice(0, 10) ?? null,
    url: item.link,
    rssDescription: item.description,
    rssDescriptionText: cleanText(item.description).replace(/\[자료제공 :.*$/, "").trim(),
    detailTitle: null,
    detailSubtitle: null,
    canonicalUrl: null,
    docViewerUrl: null,
    attachments: [],
    fetchedAt: new Date().toISOString(),
  };
}

function shouldInclude(item: RssItem, options: CliOptions): boolean {
  if (!options.includePolicyNews && !item.link.includes("/briefing/pressReleaseView.do")) return false;

  const publishedAt = isoFromPubDate(item.pubDate, item.dcDate);
  if (options.since && publishedAt && publishedAt.slice(0, 10) < options.since) return false;

  if (options.keyword) {
    const haystack = `${item.title}\n${cleanText(item.description)}`.toLowerCase();
    if (!haystack.includes(options.keyword.toLowerCase())) return false;
  }

  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const existing = await readExisting(options.output);
  const byId = new Map(existing.map((item) => [item.id, item]));

  const rss = await fetchText(RSS_URL);
  const candidates = parseRss(rss).filter((item) => shouldInclude(item, options)).slice(0, options.limit);

  console.log(`RSS candidates: ${candidates.length}`);
  for (const item of candidates) {
    const record = { ...byId.get(parseNewsId(item.link) ?? item.creator ?? item.guid ?? item.link), ...makeRecord(item) };

    if (options.detail) {
      const detailHtml = await fetchText(record.url);
      const detail = parseDetail(detailHtml);
      record.detailTitle = detail.detailTitle;
      record.detailSubtitle = detail.detailSubtitle;
      record.subtitle = detail.detailSubtitle;
      record.ministry = detail.ministry ?? record.ministry;
      record.publishedDate = detail.publishedDate ?? record.publishedDate;
      record.canonicalUrl = detail.canonicalUrl;
      record.docViewerUrl = detail.docViewerUrl;
      // 기존 attachments의 localPath/markdownPath 보존 (name 기준)
      const prev = byId.get(record.id);
      const prevByName = new Map((prev?.attachments ?? []).map((a) => [a.name, a]));
      record.attachments = detail.attachments.map((att) => {
        const old = prevByName.get(att.name);
        return old ? { ...att, localPath: old.localPath, markdownPath: old.markdownPath } : att;
      });
    }

    // 디스크 fallback: localPath 없지만 디렉토리에 이미 파일이 있으면 매칭
    for (const att of record.attachments) {
      if (!att.localPath) {
        const candidate = join(options.attachmentDir, record.id, safeFileName(att.name));
        if (await exists(candidate)) att.localPath = candidate;
      }
      if (!att.markdownPath && att.localPath && att.type === "pdf") {
        const mdCandidate = `${att.localPath.replace(/\.pdf$/i, "")}.md`;
        if (await exists(mdCandidate)) att.markdownPath = mdCandidate;
      }
    }

    if (options.downloadAttachments) {
      for (const attachment of record.attachments) {
        attachment.localPath = await downloadAttachment(record.id, attachment, options.attachmentDir);
      }
    }

    if (options.convertMd) {
      for (const attachment of record.attachments) {
        if (attachment.type !== "pdf") continue;
        if (!attachment.localPath) continue;
        try {
          await convertAttachmentToMarkdown(attachment, options);
          console.log(`  ↳ md: ${attachment.markdownPath}`);
        } catch (error) {
          console.warn(`  ↳ md 변환 실패 (${attachment.name}): ${(error as Error).message}`);
        }
      }
    }

    byId.set(record.id, record);
    const sorted = [...byId.values()].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    await writeJsonAtomic(options.output, sorted);
    console.log(`saved ${record.id} ${record.publishedDate ?? ""} ${record.title}`);
  }

  console.log(`done: ${byId.size} records in ${options.output}`);

  if (options.publicPath) {
    await syncPublic([...byId.values()].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")), options.publicPath);
  }
}

async function syncPublic(records: PressRelease[], publicPath: string): Promise<void> {
  const enriched: PressRelease[] = [];
  for (const rec of records) {
    const attachments: Attachment[] = [];
    for (const att of rec.attachments) {
      let markdown = att.markdown;
      if (!markdown && att.markdownPath && (await exists(att.markdownPath))) {
        markdown = await readFile(att.markdownPath, "utf8");
      }
      attachments.push({ ...att, markdown });
    }
    enriched.push({ ...rec, attachments });
  }
  await writeJsonAtomic(publicPath, enriched);
  const total = enriched.reduce((n, r) => n + r.attachments.filter((a) => a.markdown).length, 0);
  console.log(`synced ${publicPath} (${enriched.length} records, ${total} markdown bodies)`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { convertPdfToMarkdown, type CliOptions };
