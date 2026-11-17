import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

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
  claudeModel: string;
  claudeEffort: string;
  maxCostUsd: number;
  publicPath: string | null;
  refresh: boolean;
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

// 정책브리핑 RSS는 2026-07-01 서비스 종료(korea.kr 공지 newsId=132038885).
// 대신 보도자료 목록 페이지를 국토교통부(A00006)로 걸러 긁는다.
const LIST_URL = "https://www.korea.kr/briefing/pressReleaseList.do?repCodeType=A&repCode=A00006";
const MAX_LIST_PAGES = 60;
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
  --refresh                  Re-process already-saved records too (default: only new ones)
  --no-detail                Skip korea.kr detail page fetch
  --download-attachments     Download detail-page attachments
  --attachment-dir=PATH      Attachment directory (default: data/molit_press_attachments)
  --convert-md               Convert downloaded PDF attachments to Markdown via Claude API
  --claude-model=NAME        Claude model (default: claude-opus-5-5)
  --claude-effort=LEVEL      Effort low|medium|high (default: medium)
  --max-cost-usd=N           Stop converting once this run's estimated API cost passes N (default: 5)
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
    claudeModel: "claude-opus-5-5",
    claudeEffort: "medium",
    maxCostUsd: 5,
    publicPath: "public/molit_press.json",
    refresh: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--include-policy-news") { options.includePolicyNews = true; continue; }
    if (arg === "--no-detail") { options.detail = false; continue; }
    if (arg === "--refresh") { options.refresh = true; continue; }
    if (arg === "--download-attachments") { options.downloadAttachments = true; continue; }
    if (arg === "--convert-md") { options.convertMd = true; continue; }
    const [key, value] = arg.split("=", 2);
    if (value == null) throw new Error(`Unknown option or missing value: ${arg}`);
    if (key === "--output") options.output = value;
    else if (key === "--limit") options.limit = Number.parseInt(value, 10);
    else if (key === "--since") options.since = value;
    else if (key === "--keyword") options.keyword = value;
    else if (key === "--attachment-dir") options.attachmentDir = value;
    else if (key === "--claude-model") options.claudeModel = value;
    else if (key === "--claude-effort") options.claudeEffort = value;
    else if (key === "--max-cost-usd") options.maxCostUsd = Number.parseFloat(value);
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


// 목록 페이지 <li><a href="/briefing/pressReleaseView.do?newsId=..."> <strong>제목</strong>
// <span class="lead">요약</span> <span class="source"><span>YYYY.MM.DD</span><span>부처</span>
function parseList(html: string): RssItem[] {
  const items: RssItem[] = [];
  const re = /<a href="(\/briefing\/pressReleaseView\.do\?newsId=(\d+)[^"]*)">([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const body = m[3];
    const title = cleanText(body.match(/<strong>([\s\S]*?)<\/strong>/i)?.[1] ?? "");
    const lead = body.match(/<span class="lead">([\s\S]*?)<\/span>/i)?.[1] ?? "";
    const src = body.match(/<span class="source">([\s\S]*?)<\/span>\s*<\/span>/i)?.[1] ?? "";
    const spans = [...src.matchAll(/<span>([^<]*)<\/span>/g)].map((x) => x[1].trim());
    const date = spans.find((x) => /^\d{4}[.-]\d{2}[.-]\d{2}$/.test(x)) ?? "";
    const dept = spans.find((x) => !/^\d{4}[.-]\d{2}[.-]\d{2}$/.test(x)) ?? "";
    if (!title || !date) continue;
    if (dept && dept !== "국토교통부") continue;
    items.push({
      title,
      link: `${KOREA_BASE_URL}/briefing/pressReleaseView.do?newsId=${m[2]}`,
      description: lead.trim(),
      pubDate: "",
      creator: "",
      dcDate: `${date.replace(/\./g, "-")}T09:00:00+09:00`,
      guid: m[2],
    });
  }
  return items;
}

async function fetchListItems(options: CliOptions, known: Set<string>): Promise<RssItem[]> {
  const out: RssItem[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const html = await fetchText(`${LIST_URL}&pageIndex=${page}`);
    const items = parseList(html);
    if (items.length === 0) break;
    let fresh = 0;
    let older = false;
    for (const it of items) {
      if (seen.has(it.guid)) continue;
      seen.add(it.guid);
      if (options.since && it.dcDate.slice(0, 10) < options.since) { older = true; continue; }
      if (!known.has(it.guid)) fresh++;
      out.push(it);
    }
    const wanted = out.filter((it) => options.refresh || !known.has(it.guid)).length;
    // 이미 받은 것만 나온 페이지 = 증분 끝. since 이전까지 내려갔거나 한도만큼 모았으면 멈춤.
    if (older || wanted >= options.limit || (fresh === 0 && !options.since)) break;
  }
  return out;
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

const CLAUDE_PROMPT =
  "한국어 정부 보도자료 PDF를 정확히 Markdown으로 변환한다. 모든 페이지를 순서대로, 내용을 줄이거나 요약하지 말고 옮긴다. " +
  "제목은 #/##, 표는 GFM 표 문법으로 변환. " +
  "페이지 번호·로고·푸터(공공누리 등) 같은 페이지 외 정보는 제외. " +
  "다른 설명 없이 markdown 본문만 출력. 코드블록으로 감싸지 말 것.";

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function mtime(path: string): Promise<number> {
  return (await stat(path)).mtimeMs;
}

// $/1M tokens (input, output) — 비용 상한 계산용
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};
let runCostUsd = 0;
let anthropic: Anthropic | null = null;

function apiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    // 허브 집사와 같은 키(macOS 키체인)
    return execFileSync("security", ["find-generic-password", "-s", "homehub-anthropic", "-a", "jongyeol", "-w"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

async function convertPdfToMarkdown(pdfPath: string, options: CliOptions): Promise<string> {
  if (runCostUsd >= options.maxCostUsd) {
    throw new Error(`cost cap reached ($${runCostUsd.toFixed(2)} >= $${options.maxCostUsd})`);
  }
  anthropic ??= new Anthropic({ apiKey: apiKey() });
  const data = (await readFile(pdfPath)).toString("base64");
  const withFallback = options.claudeModel !== "claude-haiku-5-5";
  const stream = anthropic.beta.messages.stream({
    model: options.claudeModel,
    max_tokens: 64000,
    output_config: { effort: options.claudeEffort as "low" | "medium" | "high" },
    ...(withFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    system: CLAUDE_PROMPT,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
        { type: "text", text: "이 보도자료 PDF 전체를 Markdown으로 변환해줘." },
      ],
    }],
  } as any);
  const msg = await stream.finalMessage();
  const [pin, pout] = PRICES[options.claudeModel] ?? PRICES["claude-opus-5-5"];
  const cost = (msg.usage.input_tokens * pin + msg.usage.output_tokens * pout) / 1e6;
  runCostUsd += cost;
  console.log(`  ↳ claude ${msg.model} in ${msg.usage.input_tokens} out ${msg.usage.output_tokens} ≈ $${cost.toFixed(3)} (run $${runCostUsd.toFixed(2)})`);
  if (msg.stop_reason === "refusal") throw new Error("claude refused");
  if (msg.stop_reason === "max_tokens") throw new Error("claude output truncated (max_tokens)");
  const body = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim()
    .replace(/^```(?:markdown|md)?\n/, "").replace(/\n```$/, "").trim();
  if (!body) throw new Error("claude returned empty body");
  return body;
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

  const listed = await fetchListItems(options, new Set(byId.keys()));
  const candidates = listed
    .filter((item) => shouldInclude(item, options))
    .filter((item) => options.refresh || !byId.has(item.guid))
    .slice(0, options.limit);

  console.log(`list items: ${listed.length}, candidates: ${candidates.length}`);
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
