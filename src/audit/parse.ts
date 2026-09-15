import type { CodeBlock, LlmsEntry, PageAnalysis } from "./types.js";

/** Parse an llms.txt index (the llmstxt.org format) into entries. */
export function parseLlmsTxt(text: string): LlmsEntry[] {
  const entries: LlmsEntry[] = [];
  let section = "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      continue;
    }
    const m = /^- \[([^\]]*)\]\(([^)\s]+)\)(?::\s*(.*))?$/.exec(line);
    if (m) {
      entries.push({ section, title: m[1], url: m[2], description: (m[3] ?? "").trim(), line: i + 1 });
    }
  }
  return entries;
}

/** Extract <loc> URLs from a sitemap.xml. */
export function parseSitemap(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Canonical page id: strip scheme/host, `.md`, trailing slash, anchors, query. */
export function pageId(url: string): string {
  let u = url.trim();
  u = u.replace(/^https?:\/\/docs\.adyen\.com/, "");
  u = u.split("#")[0].split("?")[0];
  if (u.endsWith(".md")) u = u.slice(0, -3);
  if (u.length > 1 && u.endsWith("/")) u = u.slice(0, -1);
  if (u === "") u = "/";
  return u;
}

export function parseFrontmatter(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!md.startsWith("---")) return out;
  const end = md.indexOf("\n---", 3);
  if (end < 0) return out;
  for (const line of md.slice(3, end).split("\n")) {
    const m = /^([A-Za-z_]+):\s*"?(.*?)"?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Extract fenced code blocks. Returns blocks plus fence bookkeeping. */
export function extractCodeBlocks(md: string): { blocks: CodeBlock[]; unlabelled: number; unclosed: boolean } {
  const lines = md.split("\n");
  const blocks: CodeBlock[] = [];
  let unlabelled = 0;
  let open: { lang: string; line: number; buf: string[]; context: string } | null = null;
  const prose: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([A-Za-z0-9_+#.-]*)/.exec(line);
    if (fence) {
      if (!open) {
        const lang = fence[1].toLowerCase();
        if (!lang) unlabelled++;
        open = { lang, line: i + 1, buf: [], context: prose.slice(-40).join("\n") };
      } else {
        blocks.push({ lang: open.lang, code: open.buf.join("\n"), line: open.line, context: open.context });
        open = null;
      }
      continue;
    }
    if (open) open.buf.push(line);
    else if (line.trim()) prose.push(line);
  }
  return { blocks, unlabelled, unclosed: open !== null };
}

const LINK_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function analysePage(url: string, md: string): PageAnalysis {
  const fm = parseFrontmatter(md);
  const { blocks, unlabelled, unclosed } = extractCodeBlocks(md);

  const relativeLinks: string[] = [];
  const absoluteDocsLinks: string[] = [];
  const externalLinks: string[] = [];
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(md)) !== null) {
    const href = m[1];
    if (href.startsWith("/")) relativeLinks.push(href);
    else if (/^https?:\/\/docs\.adyen\.com/.test(href)) absoluteDocsLinks.push(href);
    else if (/^https?:\/\//.test(href)) externalLinks.push(href);
  }

  const htmlTags = (md.match(/<\/?(div|span|table|tr|td|img|br|p|a|ul|li|iframe|script)\b[^>]*>/g) ?? []).length;
  // Docs-template markup that leaked into the rendered Markdown, e.g. {hint:...}value{/hint} inside JSON examples.
  const templateMarkers = (md.match(/\{\{[^}]*\}\}|\{%[^%]*%\}|\{hint:[^}]*\}|\{\/hint\}/g) ?? []).length;

  const checkoutVersions: Record<string, number> = {};
  const vre = /checkout(?:-test)?\.adyen\.com\/v(\d+)\//g;
  while ((m = vre.exec(md)) !== null) checkoutVersions[`v${m[1]}`] = (checkoutVersions[`v${m[1]}`] ?? 0) + 1;

  const apiExplorerLinks = Array.from(
    new Set((md.match(/https?:\/\/docs\.adyen\.com\/api-explorer\/(?:\\[()]|[^)\s"'>])+/g) ?? []).map((l) => l.replace(/\\([()])/g, "$1"))),
  );

  return {
    url,
    title: fm.title ?? "",
    lastModified: fm.last_modified,
    bytes: Buffer.byteLength(md, "utf8"),
    approxTokens: Math.round(Buffer.byteLength(md, "utf8") / 4),
    codeBlocks: blocks,
    unlabelledFences: unlabelled,
    unclosedFence: unclosed,
    relativeLinks,
    absoluteDocsLinks,
    externalLinks,
    htmlTags,
    templateMarkers,
    checkoutVersions,
    apiExplorerLinks,
  };
}
