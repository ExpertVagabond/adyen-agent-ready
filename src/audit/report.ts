import type { AuditReport, Finding } from "./types.js";

const SEV_ORDER: Record<Finding["severity"], number> = { high: 0, medium: 1, low: 2, info: 3 };

function fmt(v: number | string): string {
  return typeof v === "number" ? v.toLocaleString("en-US") : v;
}

export function renderAuditMarkdown(report: AuditReport): string {
  const findings = [...report.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const out: string[] = [];
  out.push("# Adyen developer surfaces: agent-legibility audit");
  out.push("");
  out.push(`Generated ${report.generatedAt.slice(0, 10)} by [adyen-agent-ready](https://github.com/ExpertVagabond/adyen-agent-ready) (\`npm run audit\`). Every number below was measured against the live surfaces on that date; re-run to refresh.`);
  out.push("");
  out.push("## Scope");
  out.push("");
  out.push("| Surface | Source |");
  out.push("|---|---|");
  out.push(`| Page index | ${report.source.llmsTxt} |`);
  out.push(`| Full corpus | ${report.source.llmsFullTxt} |`);
  out.push(`| Sitemap | ${report.source.sitemap} |`);
  out.push(`| Crawler policy | ${report.source.robots} |`);
  out.push(`| API spec | ${report.source.openapiRepo} |`);
  out.push(`| Official MCP | ${report.source.officialMcpReadme} |`);
  out.push("");
  out.push("## Totals");
  out.push("");
  out.push("| Metric | Value |");
  out.push("|---|---|");
  for (const [k, v] of Object.entries(report.totals)) out.push(`| ${k} | ${fmt(v)} |`);
  out.push("");
  out.push("## Findings");
  out.push("");
  out.push("| # | ID | Severity | Surface | Title |");
  out.push("|---|---|---|---|---|");
  findings.forEach((f, i) => out.push(`| ${i + 1} | ${f.id} | ${f.severity} | ${f.surface} | ${f.title} |`));
  out.push("");
  findings.forEach((f, i) => {
    out.push(`### ${i + 1}. ${f.title}`);
    out.push("");
    out.push(`**ID** ${f.id} · **Severity** ${f.severity} · **Surface** ${f.surface}`);
    out.push("");
    out.push(`**Why it misleads an agent.** ${f.agentImpact}`);
    out.push("");
    out.push("**Measured.**");
    out.push("");
    out.push("| Metric | Value |");
    out.push("|---|---|");
    for (const [k, v] of Object.entries(f.metrics)) out.push(`| ${k} | ${fmt(v)} |`);
    out.push("");
    if (f.evidence.length) {
      out.push("**Evidence.**");
      out.push("");
      for (const e of f.evidence) out.push(`- ${e.url} : ${e.note}`);
      out.push("");
    }
    out.push(`**Fix.** ${f.recommendation}`);
    out.push("");
  });
  out.push("## Method");
  out.push("");
  out.push("1. Parse `llms.txt` into entries; parse `sitemap.xml`; diff the two URL sets.");
  out.push("2. Fetch every `.md` URL that `llms.txt` advertises (bounded concurrency, cached under `.cache/`); record HTTP status, content type, redirects, `Last-Modified`/`ETag`.");
  out.push("3. Parse each page: frontmatter (`last_modified`), fenced code blocks with language tags, links (relative, in-site, external), Checkout endpoint versions in URLs, API Explorer links.");
  out.push("4. Lint snippets: `JSON.parse` for JSON, TypeScript parse diagnostics for JS/TS, `ast.parse` for Python.");
  out.push("5. Load the latest `CheckoutService-v*.json` from `Adyen/adyen-openapi`; resolve API Explorer links to operations; validate JSON request examples against the request schema of the endpoint they document (top-level fields only).");
  out.push("6. Parse the official `Adyen/adyen-mcp` README tool list and diff it against the spec's operations.");
  out.push("7. Read `robots.txt` for named AI user agents.");
  out.push("");
  out.push("Limitations: request-example attribution uses the prose preceding each block, so a small number of examples may be matched to the wrong endpoint; nested schema validation is out of scope; Java/Kotlin/Swift/PHP/Go/C#/Ruby snippets are counted but not compiled.");
  out.push("");
  return out.join("\n");
}
