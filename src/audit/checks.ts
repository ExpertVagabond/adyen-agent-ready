import type { Finding, LlmsEntry, PageAnalysis, PageRecord } from "./types.js";
import { pageId } from "./parse.js";
import {
  checkExample,
  explorerLinkToEndpoint,
  guessEndpointFromContext,
  listEndpoints,
  parseOfficialMcpReadme,
  type ExampleCheck,
  type OpenApiDoc,
} from "./openapi.js";
import { lintSnippets, type SnippetResult } from "./snippets.js";

export interface AuditInputs {
  llmsEntries: LlmsEntry[];
  llmsFullBytes: number;
  sitemapUrls: string[];
  robotsTxt: string;
  records: PageRecord[];
  analyses: PageAnalysis[];
  checkoutSpec: OpenApiDoc;
  checkoutLatestVersion: string;
  officialMcpReadme: string;
  sdkCheckoutVersion: string;
  crawlRuns: CrawlRun[];
  now: Date;
}

export interface CrawlRun {
  run: number;
  startedAt: string;
  concurrency: number;
  delayMs: number;
  retries: number;
  elapsedSeconds: number;
  statusCounts: Record<string, number>;
  challengePages: number;
  note?: string;
}

const MAX_EVIDENCE = 8;

function pct(n: number, d: number): string {
  return d === 0 ? "0%" : `${((100 * n) / d).toFixed(1)}%`;
}

function sortByCountDesc<T>(items: T[], key: (t: T) => number): T[] {
  return [...items].sort((a, b) => key(b) - key(a));
}

export function buildFindings(input: AuditInputs): { findings: Finding[]; totals: Record<string, number | string>; snippetResults: SnippetResult[]; exampleChecks: ExampleCheck[] } {
  const findings: Finding[] = [];
  const { llmsEntries, records, analyses, checkoutSpec } = input;
  const byUrl = new Map(analyses.map((a) => [a.url, a]));
  const llmsIds = new Set(llmsEntries.map((e) => pageId(e.url)));
  const sitemapIds = new Set(input.sitemapUrls.map(pageId));

  // ---------------------------------------------------------------- 1. index integrity
  const seen = new Map<string, number>();
  for (const e of llmsEntries) seen.set(e.url, (seen.get(e.url) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, c]) => c > 1);
  const noDesc = llmsEntries.filter((e) => !e.description);
  const notMd = llmsEntries.filter((e) => !e.url.endsWith(".md"));
  if (dupes.length || noDesc.length || notMd.length) {
    findings.push({
      id: "LLMS-INDEX",
      title: "llms.txt index hygiene: duplicate URLs and entries without a description",
      severity: "low",
      surface: "llms.txt",
      agentImpact:
        "An agent picking pages from llms.txt uses the one-line description to decide what to fetch. Entries without one are opaque; duplicates waste retrieval budget.",
      metrics: { entries: llmsEntries.length, duplicateUrls: dupes.length, entriesWithoutDescription: noDesc.length, entriesNotMarkdown: notMd.length },
      evidence: [
        ...dupes.slice(0, 3).map(([u, c]) => ({ url: u, note: `listed ${c} times` })),
        ...noDesc.slice(0, MAX_EVIDENCE - 3).map((e) => ({ url: e.url, note: `line ${e.line}: no description ("${e.title}")` })),
      ],
      recommendation: "Generate llms.txt from the same source of truth as the page frontmatter so every entry carries `description`, and dedupe on canonical URL.",
    });
  }

  // ---------------------------------------------------------------- 2. sitemap vs llms.txt drift
  const inSitemapNotLlms = [...sitemapIds].filter((id) => !llmsIds.has(id) && !id.startsWith("/api-explorer"));
  const inLlmsNotSitemap = [...llmsIds].filter((id) => !sitemapIds.has(id));
  if (inSitemapNotLlms.length || inLlmsNotSitemap.length) {
    findings.push({
      id: "LLMS-SITEMAP-DRIFT",
      title: "llms.txt and sitemap.xml disagree on which pages exist",
      severity: "medium",
      surface: "llms.txt",
      agentImpact:
        "Two machine-readable indexes of the same site disagree. An agent that trusts llms.txt never sees pages only the sitemap lists, and vice versa.",
      metrics: { sitemapPages: sitemapIds.size, llmsPages: llmsIds.size, inSitemapOnly: inSitemapNotLlms.length, inLlmsOnly: inLlmsNotSitemap.length },
      evidence: [
        ...inSitemapNotLlms.slice(0, 4).map((id) => ({ url: `https://docs.adyen.com${id}`, note: "in sitemap.xml, absent from llms.txt" })),
        ...inLlmsNotSitemap.slice(0, 4).map((id) => ({ url: `https://docs.adyen.com${id}.md`, note: "in llms.txt, absent from sitemap.xml" })),
      ],
      recommendation: "Emit both files from one page manifest in the docs build and add a CI assertion that the two URL sets are equal.",
    });
  }

  // ---------------------------------------------------------------- 3. link liveness
  const bad = records.filter((r) => r.status !== 200);
  const html = records.filter((r) => r.status === 200 && /text\/html/i.test(r.contentType));
  const redirected = records.filter((r) => r.status === 200 && r.finalUrl !== r.url);
  if (bad.length || html.length || redirected.length) {
    findings.push({
      id: "LLMS-DEAD-LINKS",
      title: "llms.txt links that do not return a 200 Markdown document",
      severity: bad.length + html.length > 25 ? "high" : bad.length + html.length > 5 ? "medium" : "low",
      surface: "llms.txt",
      agentImpact: "A link in llms.txt is a promise that the page exists as Markdown. Every broken or HTML-returning link is an agent fetch that fails or feeds HTML into a Markdown parser.",
      metrics: { checked: records.length, non200: bad.length, htmlInsteadOfMarkdown: html.length, redirected: redirected.length, okRate: pct(records.length - bad.length - html.length, records.length) },
      evidence: [
        ...bad.slice(0, MAX_EVIDENCE).map((r) => ({ url: r.url, note: `HTTP ${r.status}${r.error ? ` (${r.error})` : ""}` })),
        ...html.slice(0, 3).map((r) => ({ url: r.url, note: `200 but content-type ${r.contentType}` })),
        ...redirected.slice(0, 3).map((r) => ({ url: r.url, note: `redirects to ${r.finalUrl}` })),
      ],
      recommendation: "Run this link check in the docs CI on every deploy; fail the build on any non-200 or non-Markdown response for a URL that llms.txt advertises.",
    });
  }

  // ---------------------------------------------------------------- 3b. edge challenge / rate limit
  const challengedNow = records.filter((r) => r.cfMitigated === "challenge" || r.status === 429);
  const challengedRuns = input.crawlRuns.filter((r) => r.challengePages > 0);
  if (challengedNow.length || challengedRuns.length) {
    const worst = challengedRuns.sort((a, b) => b.challengePages - a.challengePages)[0];
    const metrics: Record<string, number | string> = { crawlRuns: input.crawlRuns.length, challengedInThisRun: challengedNow.length };
    if (worst) {
      metrics.worstRunConcurrency = worst.concurrency;
      metrics.worstRunOk = worst.statusCounts["200"] ?? 0;
      metrics.worstRunChallenged = worst.challengePages;
      metrics.worstRunElapsedSeconds = worst.elapsedSeconds;
    }
    findings.push({
      id: "EDGE-CHALLENGE",
      title: `docs.adyen.com answers a plain HTTP client with a Cloudflare JavaScript challenge (HTTP 429, cf-mitigated: challenge) after about ${worst ? (worst.statusCounts["200"] ?? 0).toLocaleString() : "1,000"} Markdown fetches`,
      severity: "high",
      surface: "robots",
      agentImpact:
        "robots.txt invites AI agents in and llms.txt hands them 2,500 Markdown URLs, but the edge serves a browser-only challenge page once a client reads the corpus at any speed. An agent cannot execute the challenge, receives an HTML body on a .md URL, and gets no Retry-After to plan around. The tooling says 'crawl me'; the CDN says 'prove you are a browser'.",
      metrics,
      evidence: [
        { url: "https://docs.adyen.com/online-payments/build-your-integration/advanced-flow.md", note: "HTTP 429, content-type text/html, cf-mitigated: challenge, no Retry-After (single request, identifying User-Agent)" },
        ...(worst ? [{ url: "https://docs.adyen.com/llms.txt", note: `run ${worst.run}: ${worst.statusCounts["200"] ?? 0} pages OK then ${worst.challengePages} challenge pages at concurrency ${worst.concurrency} in ${worst.elapsedSeconds}s` }] : []),
        ...challengedNow.slice(0, 3).map((r) => ({ url: r.url, note: `HTTP ${r.status} cf-mitigated=${r.cfMitigated ?? "-"} at ${r.fetchedAt ?? "?"}` })),
      ],
      recommendation: "Exempt `/*.md`, `/llms.txt` and `/llms-full.txt` from managed challenges (or key the rate limit on the identifying User-Agent and return a real 429 with Retry-After), and publish the crawl budget in llms.txt.",
    });
  }

  // ---------------------------------------------------------------- 4. llms-full.txt size
  const fullTokens = Math.round(input.llmsFullBytes / 4);
  findings.push({
    id: "LLMS-FULL-SIZE",
    title: `llms-full.txt is ${(input.llmsFullBytes / 1_048_576).toFixed(1)} MB (about ${(fullTokens / 1e6).toFixed(1)}M tokens), larger than any model context`,
    severity: "high",
    surface: "llms-full.txt",
    agentImpact:
      "llms-full.txt exists so an agent can load the whole corpus in one read. At this size no current model can, so agents that follow the llms.txt pointer either fail the fetch or truncate silently and reason from the first few hundred pages (the Account and Customer Area sections).",
    metrics: { bytes: input.llmsFullBytes, approxTokens: fullTokens, pagesInCorpus: llmsEntries.length },
    evidence: [
      { url: "https://docs.adyen.com/llms-full.txt", note: `Content-Length ${input.llmsFullBytes.toLocaleString()} bytes on ${input.now.toISOString().slice(0, 10)}` },
      { url: "https://docs.adyen.com/llms.txt", note: "line 5 points agents at llms-full.txt as 'the full concatenated Markdown corpus of every page'" },
    ],
    recommendation: "Split llms-full.txt per product section (Online payments, Platforms, Issuing, POS, Risk) and per language track, each under ~2M tokens; keep the aggregate file but add its size to the llms.txt line so agents can plan.",
  });

  // ---------------------------------------------------------------- 5. oversized pages
  const big = sortByCountDesc(analyses, (a) => a.approxTokens).filter((a) => a.approxTokens > 100_000);
  if (big.length) {
    findings.push({
      id: "PAGE-TOO-LARGE",
      title: `${big.length} pages exceed 100k tokens each because every language tab is inlined`,
      severity: "medium",
      surface: "docs.md",
      agentImpact:
        "The .md rendering flattens every code-language tab into one document. An agent asking for the Node.js sessions flow receives Java, Kotlin, Swift, PHP, Go, C#, Ruby and Python as well, and may not fit the page in context at all.",
      metrics: { pagesOver100kTokens: big.length, largestBytes: big[0].bytes, largestApproxTokens: big[0].approxTokens },
      evidence: big.slice(0, MAX_EVIDENCE).map((a) => ({ url: a.url, note: `${(a.bytes / 1024).toFixed(0)} KB, ~${a.approxTokens.toLocaleString()} tokens, ${a.codeBlocks.length} code blocks` })),
      recommendation: "Honour a `?lang=` query (or `Accept-Language`-style header) on .md URLs, or publish one .md per language tab and list them in llms.txt.",
    });
  }

  // ---------------------------------------------------------------- 6. unlabelled / unclosed fences
  const unl = analyses.filter((a) => a.unlabelledFences > 0);
  const unlTotal = unl.reduce((s, a) => s + a.unlabelledFences, 0);
  const allFences = analyses.reduce((s, a) => s + a.codeBlocks.length, 0);
  const unclosed = analyses.filter((a) => a.unclosedFence);
  if (unlTotal || unclosed.length) {
    findings.push({
      id: "FENCE-LANG",
      title: `${unlTotal.toLocaleString()} of ${allFences.toLocaleString()} code fences carry no language tag`,
      severity: "medium",
      surface: "snippets",
      agentImpact:
        "A fence without a language is untyped text to an agent: it cannot tell a JSON request body from a shell command from a webhook payload, cannot lint it, and cannot choose it when the user asked for a specific language.",
      metrics: { fencesTotal: allFences, fencesUnlabelled: unlTotal, pagesAffected: unl.length, pagesWithUnclosedFence: unclosed.length, unlabelledRate: pct(unlTotal, allFences) },
      evidence: [
        ...sortByCountDesc(unl, (a) => a.unlabelledFences).slice(0, MAX_EVIDENCE - 2).map((a) => ({ url: a.url, note: `${a.unlabelledFences} unlabelled of ${a.codeBlocks.length} fences` })),
        ...unclosed.slice(0, 2).map((a) => ({ url: a.url, note: "odd number of ``` fences (block never closes)" })),
      ],
      recommendation: "Add a docs lint rule: every fence has a language; treat `json`, `bash`, and `text` as the fallbacks.",
    });
  }

  // ---------------------------------------------------------------- 7. snippet lint
  const snippetResults = lintSnippets(analyses);
  const byLang = new Map<string, { total: number; failed: SnippetResult[] }>();
  for (const r of snippetResults) {
    const s = byLang.get(r.lang) ?? { total: 0, failed: [] };
    s.total++;
    if (!r.ok) s.failed.push(r);
    byLang.set(r.lang, s);
  }
  const failed = snippetResults.filter((r) => !r.ok);
  const fragments = snippetResults.filter((r) => r.ok && r.fragment);
  if (failed.length) {
    const reasons = new Map<string, number>();
    for (const r of failed) {
      const k = (r.reason ?? "").replace(/\(line \d+\)/, "").replace(/parse error: .*/, "parse error").trim();
      reasons.set(k, (reasons.get(k) ?? 0) + 1);
    }
    const metrics: Record<string, number | string> = {
      snippetsChecked: snippetResults.length,
      snippetsFailing: failed.length,
      failRate: pct(failed.length, snippetResults.length),
      usableOnlyAsFragment: fragments.length,
    };
    for (const [lang, s] of byLang) metrics[`${lang}Checked`] = s.total, (metrics[`${lang}Failing`] = s.failed.length);
    for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) metrics[`reason: ${k}`] = v;
    findings.push({
      id: "SNIPPET-LINT",
      title: `${failed.length.toLocaleString()} of ${snippetResults.length.toLocaleString()} JSON/JS/TS/Python snippets do not parse, even as fragments; ${fragments.length.toLocaleString()} more parse only after dedenting or wrapping`,
      severity: "high",
      surface: "snippets",
      agentImpact:
        "Agents copy snippets verbatim. A JSON example with `...` or a comment fails JSON.parse in the agent's own tool call; a JS block that does not parse is a broken first attempt the agent must debug before it can help the developer.",
      metrics,
      evidence: failed
        .filter((r) => r.lang !== "json" || !/ellipsis/.test(r.reason ?? ""))
        .slice(0, 5)
        .concat(failed.filter((r) => /ellipsis/.test(r.reason ?? "")).slice(0, 3))
        .map((r) => ({ url: `${r.url}#L${r.line}`, note: `${r.lang}: ${r.reason}` })),
      recommendation: "Lint every fenced snippet in CI (JSON.parse, tsc parse diagnostics, python ast). Replace `...` with a complete minimal example or move the elision into a comment outside the fence; strip list indentation from fenced blocks in the Markdown renderer.",
    });
  }

  // ---------------------------------------------------------------- 7b. template markup leaked into pages
  const leaked = analyses.filter((a) => a.templateMarkers > 0);
  const leakedTotal = leaked.reduce((s, a) => s + a.templateMarkers, 0);
  if (leaked.length) {
    const inJson = analyses.reduce((s, a) => s + a.codeBlocks.filter((b) => b.lang === "json" && /\{hint:/.test(b.code)).length, 0);
    findings.push({
      id: "TEMPLATE-LEAK",
      title: `Docs-template markup ({hint:...}{/hint}) leaks into ${leaked.length} Markdown pages, ${inJson} times inside JSON examples`,
      severity: "high",
      surface: "docs.md",
      agentImpact:
        "The HTML renderer turns {hint:...} into a tooltip; the Markdown renderer prints it verbatim, so a JSON example contains \"{hint:This is the card alias}M4695...{/hint}\" where a value should be. An agent that copies it ships the markup, and JSON.parse still succeeds because it sits inside a string, so nothing catches it downstream.",
      metrics: { pagesWithLeakedMarkup: leaked.length, markupOccurrences: leakedTotal, occurrencesInsideJsonBlocks: inJson },
      evidence: sortByCountDesc(leaked, (a) => a.templateMarkers)
        .slice(0, MAX_EVIDENCE)
        .map((a) => ({ url: a.url, note: `${a.templateMarkers} template markers` })),
      recommendation: "Strip or resolve {hint:} in the Markdown export (render the hint as a trailing comment outside the fence) and add a grep for `{hint:` to the docs CI.",
    });
  }

  // ---------------------------------------------------------------- 8. Checkout API version drift inside docs
  const versionPages = analyses.filter((a) => Object.keys(a.checkoutVersions).length > 0);
  const versionTotals = new Map<string, number>();
  const mixed: PageAnalysis[] = [];
  for (const a of versionPages) {
    for (const [v, c] of Object.entries(a.checkoutVersions)) versionTotals.set(v, (versionTotals.get(v) ?? 0) + c);
    if (Object.keys(a.checkoutVersions).length > 1) mixed.push(a);
  }
  const latest = `v${input.checkoutLatestVersion}`;
  const stalePages = versionPages.filter((a) => !(latest in a.checkoutVersions));
  if (versionPages.length) {
    const metrics: Record<string, number | string> = {
      latestCheckoutVersion: latest,
      sdkCheckoutVersion: `v${input.sdkCheckoutVersion}`,
      pagesWithEndpointUrls: versionPages.length,
      pagesMixingVersions: mixed.length,
      pagesWithoutLatestVersion: stalePages.length,
    };
    for (const [v, c] of [...versionTotals.entries()].sort()) metrics[`urls ${v}`] = c;
    findings.push({
      id: "API-VERSION-DRIFT",
      title: `${mixed.length} pages mix Checkout API versions in their own examples; ${stalePages.length} never mention the current ${latest}`,
      severity: "high",
      surface: "openapi",
      agentImpact:
        `The OpenAPI spec and the Node SDK are at Checkout ${latest}. Docs examples still call older versions, sometimes three different ones on the same page. An agent has no way to know which is current and will pin a new integration to whatever it read first.`,
      metrics,
      evidence: sortByCountDesc(mixed, (a) => Object.keys(a.checkoutVersions).length)
        .slice(0, MAX_EVIDENCE)
        .map((a) => ({ url: a.url, note: Object.entries(a.checkoutVersions).map(([v, c]) => `${v}: ${c}`).join(", ") })),
      recommendation: "Template the version into snippets from one constant (`{{checkoutVersion}}`) and bump it in one commit when the spec releases; assert in CI that no page contains more than one version.",
    });
  }

  // ---------------------------------------------------------------- 9. API Explorer links vs spec
  const endpoints = listEndpoints(checkoutSpec);
  const epKey = new Set(endpoints.map((e) => `${e.method} ${e.path}`));
  const explorer = analyses.flatMap((a) => a.apiExplorerLinks.map((l) => ({ url: a.url, link: l })));
  const checkoutExplorer = explorer.map((x) => ({ ...x, ep: explorerLinkToEndpoint(x.link) })).filter((x) => x.ep && x.ep.service === "Checkout");
  const pinnedOld = checkoutExplorer.filter((x) => x.ep!.version !== "latest" && x.ep!.version !== input.checkoutLatestVersion);
  const unknownPath = checkoutExplorer.filter((x) => (x.ep!.version === "latest" || x.ep!.version === input.checkoutLatestVersion) && !epKey.has(`${x.ep!.method} ${x.ep!.path}`));
  const versionsSeen = new Map<string, number>();
  for (const x of checkoutExplorer) versionsSeen.set(x.ep!.version, (versionsSeen.get(x.ep!.version) ?? 0) + 1);
  if (checkoutExplorer.length) {
    const metrics: Record<string, number | string> = { checkoutExplorerLinks: checkoutExplorer.length, pinnedToOlderVersion: pinnedOld.length, pathNotInSpec: unknownPath.length };
    for (const [v, c] of [...versionsSeen.entries()].sort()) metrics[`links ${v}`] = c;
    findings.push({
      id: "EXPLORER-LINKS",
      title: `${pinnedOld.length} API Explorer links pin an older Checkout version; ${unknownPath.length} point at paths absent from the ${latest} spec`,
      severity: unknownPath.length ? "medium" : "low",
      surface: "openapi",
      agentImpact: "API Explorer links are the docs' own pointer into the reference. Links pinned to an older version send an agent to a reference that disagrees with the SDK; links to missing paths send it nowhere.",
      metrics,
      evidence: [
        ...unknownPath.slice(0, 4).map((x) => ({ url: x.url, note: `links ${x.link} but ${x.ep!.method} ${x.ep!.path} is not in CheckoutService-${latest}.json` })),
        ...pinnedOld.slice(0, 4).map((x) => ({ url: x.url, note: `links ${x.link} (Checkout ${x.ep!.version}; current is ${latest})` })),
      ],
      recommendation: "Link to `/api-explorer/Checkout/latest/...` everywhere and validate each explorer link against the published spec in CI.",
    });
  }

  // ---------------------------------------------------------------- 10. JSON request examples vs spec schema
  const exampleChecks: ExampleCheck[] = [];
  for (const a of analyses) {
    // Classic Payments API pages document /pal/servlet endpoints whose examples share field names with Checkout; skip them.
    if (/\/classic-integrations\/|\/classic-platforms\//.test(a.url)) continue;
    for (const b of a.codeBlocks) {
      if (b.lang !== "json") continue;
      if (/pal\/servlet|Payment\/v\d+/.test(b.context)) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(b.code);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
      const rec = obj as Record<string, unknown>;
      // Request bodies carry merchantAccount; responses carry pspReference/resultCode/sessionData/id.
      if (!("merchantAccount" in rec) || "pspReference" in rec || "resultCode" in rec || "sessionData" in rec || "id" in rec) continue;
      const guess = guessEndpointFromContext(b.context);
      if (!guess) continue;
      const ep = endpoints.find((e) => e.method === "POST" && e.path === guess);
      if (!ep) continue;
      const chk = checkExample(checkoutSpec, ep, rec, { url: a.url, line: b.line });
      if (chk) exampleChecks.push(chk);
    }
  }
  const withUnknown = exampleChecks.filter((c) => c.unknownProperties.length > 0);
  const withMissing = exampleChecks.filter((c) => c.missingRequired.length > 0);
  if (exampleChecks.length) {
    const unknownProps = new Map<string, number>();
    for (const c of withUnknown) for (const p of c.unknownProperties) unknownProps.set(p, (unknownProps.get(p) ?? 0) + 1);
    const metrics: Record<string, number | string> = { requestExamplesChecked: exampleChecks.length, examplesWithUnknownFields: withUnknown.length, examplesMissingRequiredFields: withMissing.length };
    for (const [p, c] of [...unknownProps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) metrics[`unknown field: ${p}`] = c;
    findings.push({
      id: "EXAMPLE-SCHEMA-DRIFT",
      title: `${withUnknown.length} of ${exampleChecks.length} JSON request examples use fields the ${latest} spec does not define; ${withMissing.length} omit a required field`,
      severity: withUnknown.length + withMissing.length >= 5 ? "medium" : "low",
      surface: "openapi",
      agentImpact:
        "Agents validate their tool calls against the OpenAPI schema (the official MCP server is generated from it). A docs example with a field the schema lacks either gets rejected client-side or teaches the agent a field that the API ignores. A required field missing from the example is a guaranteed 422 on the first try.",
      metrics,
      evidence: [
        ...withUnknown.slice(0, 5).map((c) => ({ url: `${c.url}#L${c.line}`, note: `${c.endpoint} example has unknown top-level field(s): ${c.unknownProperties.join(", ")}` })),
        ...withMissing.slice(0, 3).map((c) => ({ url: `${c.url}#L${c.line}`, note: `${c.endpoint} example omits required: ${c.missingRequired.join(", ")}` })),
      ],
      recommendation: "Validate every request example against the request schema of the endpoint it sits under (this audit's `checkExample`) as a docs CI step.",
    });
  }

  // ---------------------------------------------------------------- 11. freshness
  const dated = analyses.filter((a) => a.lastModified);
  const ageYears = (iso: string): number => (input.now.getTime() - Date.parse(iso)) / (365.25 * 24 * 3600 * 1000);
  const over3 = dated.filter((a) => ageYears(a.lastModified!) > 3);
  const over5 = dated.filter((a) => ageYears(a.lastModified!) > 5);
  const undated = analyses.length - dated.length;
  const noHeader = records.filter((r) => r.status === 200 && !r.lastModifiedHeader && !r.etag);
  if (over3.length || undated || noHeader.length) {
    findings.push({
      id: "FRESHNESS",
      title: `${over3.length} of ${dated.length} pages declare a last_modified more than 3 years old (${over5.length} more than 5)${undated ? `; ${undated} pages declare no date at all` : ""}`,
      severity: "medium",
      surface: "docs.md",
      agentImpact:
        "The posting's own words: stale content misleads agents as much as people. The .md frontmatter exposes `last_modified`, which is the right signal, but it is either very old or absent on a large share of pages, so an agent cannot down-weight stale guidance.",
      metrics: {
        pagesWithDate: dated.length,
        pagesWithoutDate: undated,
        olderThan3y: over3.length,
        olderThan5y: over5.length,
        olderThan3yWithCodeInIntegrationSections: over3.filter((a) => /\/(online-payments|development-resources|payment-methods)\//.test(a.url) && a.codeBlocks.length > 0).length,
        responsesWithoutLastModifiedOrEtag: noHeader.length,
      },
      evidence: sortByCountDesc(
        over3.filter((a) => /\/(online-payments|development-resources|payment-methods|api-explorer)\//.test(a.url) && a.codeBlocks.length > 0),
        (a) => ageYears(a.lastModified!),
      )
        .slice(0, MAX_EVIDENCE)
        .map((a) => ({ url: a.url, note: `last_modified ${a.lastModified!.slice(0, 10)}, ${a.codeBlocks.length} code blocks` })),
      recommendation: "Set `last_modified` from git history on every page, expose the same value as the HTTP Last-Modified header, and add a `reviewed_on` field so agents can distinguish 'old but verified' from 'old'.",
    });
  }

  // ---------------------------------------------------------------- 12. relative links in .md
  const relPages = analyses.filter((a) => a.relativeLinks.length > 0);
  const relTotal = relPages.reduce((s, a) => s + a.relativeLinks.length, 0);
  const relUnresolvable = new Map<string, string[]>();
  for (const a of relPages) {
    for (const l of a.relativeLinks) {
      if (l.startsWith("/user/") || /\.(svg|png|jpe?g|gif|webp|pdf|zip)(\?|$)/i.test(l)) continue; // images and assets
      const id = pageId(l);
      if (!llmsIds.has(id) && !id.startsWith("/api-explorer")) {
        const arr = relUnresolvable.get(id) ?? [];
        if (arr.length < 3) arr.push(a.url);
        relUnresolvable.set(id, arr);
      }
    }
  }
  if (relTotal) {
    findings.push({
      id: "RELATIVE-LINKS",
      title: `${relTotal.toLocaleString()} links in the .md corpus are site-relative; ${relUnresolvable.size} distinct targets are not in llms.txt`,
      severity: "medium",
      surface: "docs.md",
      agentImpact:
        "A .md page fetched by URL contains links like `/payment-methods`. An agent must guess the host and append `.md` to follow them; when the target is not in llms.txt the guess fails. Absolute `.md` links would let an agent walk the corpus without heuristics.",
      metrics: { relativeLinks: relTotal, pagesWithRelativeLinks: relPages.length, distinctTargetsNotInLlms: relUnresolvable.size },
      evidence: [...relUnresolvable.entries()].slice(0, MAX_EVIDENCE).map(([id, from]) => ({ url: `https://docs.adyen.com${id}`, note: `linked from ${from[0]}${from.length > 1 ? ` and ${from.length - 1} more` : ""}; not in llms.txt` })),
      recommendation: "Rewrite in-site links to absolute `https://docs.adyen.com/...md` URLs in the .md rendering, and include API Explorer reference pages in llms.txt.",
    });
  }

  // ---------------------------------------------------------------- 13. API reference not in llms.txt
  const explorerCount = llmsEntries.filter((e) => e.url.includes("/api-explorer")).length;
  const explorerInSitemap = input.sitemapUrls.filter((u) => u.includes("/api-explorer")).length;
  findings.push({
    id: "REFERENCE-NOT-INDEXED",
    title: `llms.txt lists ${explorerCount} API reference pages; the guides link to the API Explorer ${explorer.length.toLocaleString()} times`,
    severity: "high",
    surface: "llms.txt",
    agentImpact:
      "The guides defer field-level detail to the API Explorer, which is a JavaScript application with no Markdown rendering and no llms.txt entry. An agent reading the corpus can reach the prose but not the schema it is told to consult, so it guesses field names.",
    metrics: { apiExplorerEntriesInLlms: explorerCount, apiExplorerEntriesInSitemap: explorerInSitemap, apiExplorerLinksFromGuides: explorer.length, checkoutEndpointsInSpec: endpoints.length },
    evidence: [
      { url: "https://docs.adyen.com/llms.txt", note: `${llmsEntries.length} entries, ${explorerCount} under /api-explorer` },
      { url: "https://docs.adyen.com/api-explorer/Checkout/latest/post/payments", note: "JS-rendered; the .md variant returns 404" },
      { url: "https://github.com/Adyen/adyen-openapi", note: `CheckoutService-v${input.checkoutLatestVersion}.json has ${endpoints.length} operations, none exposed as Markdown` },
    ],
    recommendation: "Render one Markdown page per operation from the OpenAPI spec (this repo's `data/llms-checkout.txt` is a generated example) and list them in a `## API reference` section of llms.txt.",
  });

  // ---------------------------------------------------------------- 14. official MCP coverage
  const mcpTools = parseOfficialMcpReadme(input.officialMcpReadme);
  const mcpCheckout = mcpTools.filter((t) => t.service === "Checkout");
  const mcpKeys = new Set(mcpCheckout.map((t) => `${t.method} ${t.path}`));
  const uncovered = endpoints.filter((e) => !mcpKeys.has(`${e.method} ${e.path}`));
  const readmePinned = (input.officialMcpReadme.match(/api-explorer\/Checkout\/(\d+)\//g) ?? []).map((s) => s.match(/\/(\d+)\//)![1]);
  const pinnedSet = [...new Set(readmePinned)];
  findings.push({
    id: "MCP-COVERAGE",
    title: `Official @adyen/mcp covers ${mcpCheckout.length} of ${endpoints.length} Checkout operations; POST /payments and /payments/details are not among them`,
    severity: "medium",
    surface: "mcp",
    agentImpact:
      "An agent with the official server can create a session or a payment link but cannot run the Advanced flow (/payments, /payments/details) or check a test card, which is what most integration debugging needs. Its README also pins Checkout " +
      (pinnedSet.length ? pinnedSet.map((v) => `v${v}`).join("/") : "no version") +
      ` while the spec and SDK are at ${latest}.`,
    metrics: { checkoutOperationsInSpec: endpoints.length, coveredByOfficialMcp: mcpCheckout.length, uncovered: uncovered.length, readmeVersionPins: pinnedSet.join(", ") || "none", totalOfficialTools: mcpTools.length },
    evidence: [
      { url: "https://github.com/Adyen/adyen-mcp/blob/main/README.md", note: `tool list parsed on ${input.now.toISOString().slice(0, 10)}: ${mcpTools.length} operations across Checkout and Management` },
      ...uncovered.slice(0, 6).map((e) => ({ url: `https://docs.adyen.com/api-explorer/Checkout/latest/${e.method.toLowerCase()}${e.path.replace(/\{([^}]+)\}/g, "($1)")}`, note: `${e.method} ${e.path}: no official MCP tool` })),
    ],
    recommendation: "Generate the tool list from the OpenAPI spec so coverage and version move together; this repo's MCP adds /payments, /payments/details and a test-card catalogue for the TEST environment.",
  });

  // ---------------------------------------------------------------- 15. robots posture (positive)
  const robots = input.robotsTxt;
  const aiAgents = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "CCBot", "anthropic-ai"].filter((ua) => new RegExp(`User-agent:\\s*${ua}`, "i").test(robots));
  findings.push({
    id: "ROBOTS-POSTURE",
    title: `robots.txt explicitly allows ${aiAgents.length} named AI crawlers and publishes llms.txt: the posture is right, the content is the gap`,
    severity: "info",
    surface: "robots",
    agentImpact: "Agents are welcome at the door. Every finding above is about what they find once inside.",
    metrics: { namedAiAgentsAllowed: aiAgents.length, llmsTxtPresent: 1, llmsFullPresent: 1, markdownPerPage: 1 },
    evidence: [
      { url: "https://docs.adyen.com/robots.txt", note: `Allow: / for ${aiAgents.join(", ")}` },
      { url: "https://docs.adyen.com/llms.txt", note: "present; every page also served as Markdown via `.md`" },
    ],
    recommendation: "Keep it. Add `Sitemap:` and `llms.txt` hints to the HTML `<head>` (`<link rel=\"alternate\" type=\"text/markdown\">`) so agents that land on an HTML page discover the Markdown twin.",
  });

  const totals: Record<string, number | string> = {
    llmsEntries: llmsEntries.length,
    pagesFetched: records.length,
    pages200: records.filter((r) => r.status === 200).length,
    corpusBytes: analyses.reduce((s, a) => s + a.bytes, 0),
    codeBlocks: allFences,
    snippetsLinted: snippetResults.length,
    snippetsFailing: failed.length,
    findings: findings.length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
  };

  return { findings, totals, snippetResults, exampleChecks };
}
