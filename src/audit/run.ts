#!/usr/bin/env node
/**
 * Agent-legibility audit of Adyen's developer surfaces.
 *
 *   npm run audit            # fetch live surfaces (cached under .cache/)
 *   npm run audit:offline    # re-analyse from cache only
 *
 * Writes AUDIT.md, audit/report.json, audit/pages.json, audit/snippets.json
 * and data/llms-checkout.txt (a generated Markdown index of the Checkout API).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAll, fetchCached, readBody, USER_AGENT } from "./fetch.js";
import { analysePage, parseLlmsTxt, parseSitemap } from "./parse.js";
import { buildFindings, type CrawlRun } from "./checks.js";
import { renderAuditMarkdown } from "./report.js";
import { renderLlmsCheckout } from "./llms-checkout.js";
import { parseTestCards } from "./test-cards.js";
import type { AuditReport, PageAnalysis } from "./types.js";
import type { OpenApiDoc } from "./openapi.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(ROOT, ".cache");

const SOURCES = {
  llmsTxt: "https://docs.adyen.com/llms.txt",
  llmsFullTxt: "https://docs.adyen.com/llms-full.txt",
  sitemap: "https://docs.adyen.com/sitemap.xml",
  robots: "https://docs.adyen.com/robots.txt",
  openapiRepo: "https://github.com/Adyen/adyen-openapi",
  officialMcpReadme: "https://raw.githubusercontent.com/Adyen/adyen-mcp/main/README.md",
};

async function headSize(url: string, offline: boolean): Promise<number> {
  const metaUrl = `${url}#HEAD`;
  const cached = await fetchCached(metaUrl, { cacheDir: CACHE, offline: true });
  if (offline || cached.status === 200) return cached.bytes;
  const head = await fetch(url, { method: "HEAD", headers: { "user-agent": USER_AGENT } });
  let len = Number(head.headers.get("content-length") ?? 0);
  if (!len) {
    // No Content-Length (chunked). Stream the body once and count bytes.
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    len = Buffer.byteLength(await res.text());
  }
  const res = head;
  await writeFile(join(CACHE, `${(await import("./fetch.js")).cacheKey(metaUrl)}.json`), JSON.stringify({ url: metaUrl, status: res.status, contentType: res.headers.get("content-type") ?? "", finalUrl: url, bytes: len }));
  return len;
}

async function latestCheckoutSpec(offline: boolean): Promise<{ spec: OpenApiDoc; version: string }> {
  const list = await fetchCached("https://api.github.com/repos/Adyen/adyen-openapi/contents/json", { cacheDir: CACHE, offline });
  if (list.status !== 200) throw new Error(`could not list adyen-openapi/json (HTTP ${list.status})`);
  const files = JSON.parse(await readBody(list)) as { name: string }[];
  const versions = files
    .map((f) => /^CheckoutService-v(\d+)\.json$/.exec(f.name)?.[1])
    .filter((v): v is string => Boolean(v))
    .map(Number)
    .sort((a, b) => b - a);
  const version = String(versions[0]);
  const spec = await fetchCached(`https://raw.githubusercontent.com/Adyen/adyen-openapi/main/json/CheckoutService-v${version}.json`, { cacheDir: CACHE, offline });
  if (spec.status !== 200) throw new Error(`could not fetch CheckoutService-v${version}.json`);
  return { spec: JSON.parse(await readBody(spec)) as OpenApiDoc, version };
}

async function sdkCheckoutVersion(): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(join(ROOT, "node_modules/@adyen/api-library/lib/src/services/checkout/paymentsApi.js"), "utf8");
    return /checkout-test\.adyen\.com\/v(\d+)/.exec(src)?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const offline = process.argv.includes("--offline");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
  const started = Date.now();
  await mkdir(CACHE, { recursive: true });
  await mkdir(join(ROOT, "audit"), { recursive: true });
  await mkdir(join(ROOT, "data"), { recursive: true });

  const log = (msg: string): void => console.error(`[audit] ${msg}`);

  const [llms, sitemap, robots, mcpReadme] = await Promise.all([
    fetchCached(SOURCES.llmsTxt, { cacheDir: CACHE, offline }),
    fetchCached(SOURCES.sitemap, { cacheDir: CACHE, offline }),
    fetchCached(SOURCES.robots, { cacheDir: CACHE, offline }),
    fetchCached(SOURCES.officialMcpReadme, { cacheDir: CACHE, offline }),
  ]);
  for (const [name, r] of Object.entries({ llms, sitemap, robots, mcpReadme })) {
    if (r.status !== 200) throw new Error(`${name}: HTTP ${r.status} ${r.error ?? ""}`);
  }
  const llmsEntries = parseLlmsTxt(await readBody(llms));
  const sitemapUrls = parseSitemap(await readBody(sitemap));
  const robotsTxt = await readBody(robots);
  const officialMcpReadme = await readBody(mcpReadme);
  log(`llms.txt: ${llmsEntries.length} entries; sitemap: ${sitemapUrls.length} urls`);

  const llmsFullBytes = await headSize(SOURCES.llmsFullTxt, offline);
  log(`llms-full.txt: ${llmsFullBytes} bytes`);

  const { spec: checkoutSpec, version: checkoutLatestVersion } = await latestCheckoutSpec(offline);
  log(`Checkout spec v${checkoutLatestVersion}`);

  const urls = llmsEntries.map((e) => e.url).slice(0, limit);
  let lastPct = -1;
  const records = await fetchAll(urls, {
    cacheDir: CACHE,
    offline,
    concurrency: Number(process.env.AUDIT_CONCURRENCY ?? 3),
    delayMs: Number(process.env.AUDIT_DELAY_MS ?? 400),
    onProgress: (d, t) => {
      const p = Math.floor((100 * d) / t);
      if (p !== lastPct && p % 5 === 0) {
        lastPct = p;
        log(`fetched ${d}/${t}`);
      }
    },
  });

  const crawlRunsPath = join(ROOT, "audit", "crawl-runs.json");
  let crawlRuns: CrawlRun[] = [];
  try {
    crawlRuns = JSON.parse(await readFile(crawlRunsPath, "utf8")) as CrawlRun[];
  } catch {
    crawlRuns = [];
  }
  if (!offline) {
    const statusCounts: Record<string, number> = {};
    for (const r of records) statusCounts[String(r.status)] = (statusCounts[String(r.status)] ?? 0) + 1;
    crawlRuns.push({
      run: crawlRuns.length + 1,
      startedAt: new Date(started).toISOString(),
      concurrency: Number(process.env.AUDIT_CONCURRENCY ?? 3),
      delayMs: Number(process.env.AUDIT_DELAY_MS ?? 400),
      retries: 3,
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      statusCounts,
      challengePages: records.filter((r) => r.cfMitigated === "challenge" || r.status === 429).length,
    });
    await writeFile(crawlRunsPath, JSON.stringify(crawlRuns, null, 1));
  }

  const analyses: PageAnalysis[] = [];
  for (const r of records) {
    if (r.status !== 200 || !/text\/(plain|markdown)/i.test(r.contentType)) continue;
    analyses.push(analysePage(r.url, await readBody(r)));
  }
  log(`analysed ${analyses.length} markdown pages`);

  const { findings, totals, snippetResults, exampleChecks } = buildFindings({
    llmsEntries,
    llmsFullBytes,
    sitemapUrls,
    robotsTxt,
    records,
    analyses,
    checkoutSpec,
    checkoutLatestVersion,
    officialMcpReadme,
    sdkCheckoutVersion: await sdkCheckoutVersion(),
    crawlRuns,
    now: new Date(),
  });

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    source: SOURCES,
    totals: { ...totals, elapsedSeconds: Math.round((Date.now() - started) / 1000) },
    findings,
  };

  await writeFile(join(ROOT, "AUDIT.md"), renderAuditMarkdown(report));
  await writeFile(join(ROOT, "audit", "report.json"), JSON.stringify(report, null, 2));
  await writeFile(
    join(ROOT, "audit", "pages.json"),
    JSON.stringify(
      analyses.map((a) => ({
        url: a.url,
        title: a.title,
        lastModified: a.lastModified,
        bytes: a.bytes,
        approxTokens: a.approxTokens,
        codeBlocks: a.codeBlocks.length,
        unlabelledFences: a.unlabelledFences,
        checkoutVersions: a.checkoutVersions,
        relativeLinks: a.relativeLinks.length,
      })),
      null,
      1,
    ),
  );
  await writeFile(join(ROOT, "audit", "snippets.json"), JSON.stringify({ results: snippetResults.filter((r) => !r.ok), exampleChecks }, null, 1));
  await writeFile(join(ROOT, "data", "llms-checkout.txt"), renderLlmsCheckout(checkoutSpec, checkoutLatestVersion));
  await writeFile(join(ROOT, "data", "llms-index.json"), JSON.stringify(llmsEntries, null, 0));

  const testCardsUrl = "https://docs.adyen.com/development-resources/test-cards-and-credentials/test-card-numbers.md";
  const testCardsRec = records.find((r) => r.url === testCardsUrl);
  if (testCardsRec && testCardsRec.status === 200) {
    const md = await readBody(testCardsRec);
    const cards = parseTestCards(md);
    await writeFile(
      join(ROOT, "data", "test-cards.json"),
      JSON.stringify({ source: testCardsUrl, fetchedAt: testCardsRec.fetchedAt ?? report.generatedAt, count: cards.length, cards }, null, 1),
    );
    log(`test cards: ${cards.length}`);
  }

  log(`done: ${findings.length} findings (${totals.high} high, ${totals.medium} medium) in ${report.totals.elapsedSeconds}s`);
  console.log(JSON.stringify(report.totals, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
