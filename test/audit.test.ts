import { describe, expect, it } from "vitest";
import { analysePage, extractCodeBlocks, pageId, parseFrontmatter, parseLlmsTxt, parseSitemap } from "../src/audit/parse.js";
import { lintJs, lintJson, lintTs, lintPythonBatch } from "../src/audit/snippets.js";
import { checkExample, explorerLinkToEndpoint, guessEndpointFromContext, listEndpoints, parseOfficialMcpReadme, resolveSchema, type OpenApiDoc } from "../src/audit/openapi.js";
import { parseTestCards } from "../src/audit/test-cards.js";
import { renderLlmsCheckout } from "../src/audit/llms-checkout.js";
import { buildFindings } from "../src/audit/checks.js";
import { renderAuditMarkdown } from "../src/audit/report.js";

const LLMS = `# Adyen Docs

> Developer docs.

## Account
Learn things.

- [Account](https://docs.adyen.com/account.md): Manage your account.
- [Balances](https://docs.adyen.com/account/balances.md)

## Online payments

- [Sessions flow](https://docs.adyen.com/online-payments/build-your-integration/sessions-flow.md): Start accepting payments.
- [Sessions flow](https://docs.adyen.com/online-payments/build-your-integration/sessions-flow.md): duplicate
`;

const PAGE = `---
title: "Sessions flow integration guide"
description: "Start accepting payments."
url: "https://docs.adyen.com/online-payments/build-your-integration/sessions-flow"
last_modified: "2019-03-10T14:38:00+01:00"
---

# Sessions flow

Make a POST [/sessions](https://docs.adyen.com/api-explorer/Checkout/latest/post/sessions) request. See [payment methods](/payment-methods) and [old](/gone-page).

\`\`\`bash
curl https://checkout-test.adyen.com/v70/sessions
\`\`\`

\`\`\`json
{
  "merchantAccount": "YOUR_MERCHANT_ACCOUNT",
  "amount": { "currency": "EUR", "value": 1000 },
  "reference": "ORDER-1",
  "returnUrl": "https://example.com",
  "bogusField": true
}
\`\`\`

\`\`\`
{ "unlabelled": true }
\`\`\`

\`\`\`js
const x = ;
\`\`\`

Then call [/payments/details](https://docs.adyen.com/api-explorer/Checkout/71/post/payments/details) at https://checkout-test.adyen.com/v72/payments/details.
`;

const SPEC: OpenApiDoc = {
  info: { version: "72" },
  paths: {
    "/sessions": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/CreateCheckoutSessionRequest" } } } } } },
    "/payments": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/PaymentRequest" } } } } } },
    "/payments/details": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/PaymentDetailsRequest" } } } } } },
    "/sessions/{sessionId}": { get: {} },
  },
  components: {
    schemas: {
      CreateCheckoutSessionRequest: { required: ["amount", "merchantAccount", "reference", "returnUrl"], properties: { amount: {}, merchantAccount: {}, reference: {}, returnUrl: {}, countryCode: {} } },
      PaymentRequest: { required: ["amount", "merchantAccount", "paymentMethod", "reference", "returnUrl"], properties: { amount: {}, merchantAccount: {}, paymentMethod: {}, reference: {}, returnUrl: {} } },
      PaymentDetailsRequest: { required: ["details"], properties: { details: {}, paymentData: {} } },
    },
  },
};

describe("parse", () => {
  it("parses llms.txt entries with sections and optional descriptions", () => {
    const e = parseLlmsTxt(LLMS);
    expect(e).toHaveLength(4);
    expect(e[0]).toMatchObject({ section: "Account", title: "Account", description: "Manage your account." });
    expect(e[1].description).toBe("");
    expect(e[2].section).toBe("Online payments");
  });
  it("parses sitemap locs and canonical page ids", () => {
    expect(parseSitemap("<urlset><url><loc>https://docs.adyen.com/account</loc></url><url><loc> https://docs.adyen.com/x/ </loc></url></urlset>")).toEqual(["https://docs.adyen.com/account", "https://docs.adyen.com/x/"]);
    expect(pageId("https://docs.adyen.com/account/balances.md")).toBe("/account/balances");
    expect(pageId("/account/balances/#anchor")).toBe("/account/balances");
    expect(pageId("https://docs.adyen.com/.md")).toBe("/");
  });
  it("reads frontmatter and code blocks with context", () => {
    expect(parseFrontmatter(PAGE).last_modified).toBe("2019-03-10T14:38:00+01:00");
    const { blocks, unlabelled, unclosed } = extractCodeBlocks(PAGE);
    expect(blocks.map((b) => b.lang)).toEqual(["bash", "json", "", "js"]);
    expect(unlabelled).toBe(1);
    expect(unclosed).toBe(false);
    expect(blocks[1].context).toMatch(/\/sessions/);
    expect(extractCodeBlocks("```json\n{}").unclosed).toBe(true);
  });
  it("analyses links, versions and explorer references", () => {
    const a = analysePage("https://docs.adyen.com/x.md", PAGE);
    expect(a.relativeLinks).toEqual(["/payment-methods", "/gone-page"]);
    expect(a.checkoutVersions).toEqual({ v70: 1, v72: 1 });
    expect(a.apiExplorerLinks).toHaveLength(2);
    expect(a.unlabelledFences).toBe(1);
  });
});

describe("snippet lint", () => {
  it("classifies JSON failures", () => {
    expect(lintJson('{"a": 1}').ok).toBe(true);
    expect(lintJson('{"a": 1, ...}').reason).toMatch(/ellipsis/);
    expect(lintJson('{\n  // note\n  "a": 1\n}').reason).toMatch(/comments/);
    expect(lintJson('{"a": 1,}').reason).toMatch(/trailing comma/);
    expect(lintJson('"a": 1').reason).toMatch(/fragment/);
  });
  it("parses JS and TS with the TypeScript parser", () => {
    expect(lintJs("const a = 1;\nconsole.log(a)").ok).toBe(true);
    expect(lintJs("const a = ;").ok).toBe(false);
    expect(lintTs("const a: number = 1;").ok).toBe(true);
    expect(lintTs("function f(: string) {}").ok).toBe(false);
  });
  it("parses Python via python3 when available", () => {
    const r = lintPythonBatch(["x = 1", "def f(:\n  pass"]);
    if (r[0] === undefined) return; // python3 absent on this machine
    expect(r[0]!.ok).toBe(true);
    expect(r[1]!.ok).toBe(false);
  });
});

describe("openapi", () => {
  it("lists endpoints and resolves schemas", () => {
    const eps = listEndpoints(SPEC);
    expect(eps.map((e) => `${e.method} ${e.path}`)).toContain("GET /sessions/{sessionId}");
    expect(resolveSchema(SPEC, "PaymentRequest")?.required).toContain("paymentMethod");
  });
  it("maps API Explorer links to operations", () => {
    expect(explorerLinkToEndpoint("https://docs.adyen.com/api-explorer/Checkout/71/post/payments/(paymentPspReference)/refunds")).toEqual({ service: "Checkout", version: "71", method: "POST", path: "/payments/{paymentPspReference}/refunds" });
    expect(explorerLinkToEndpoint("https://docs.adyen.com/api-explorer/Checkout/latest/get/sessions/(sessionId)#query-sessionResult")?.path).toBe("/sessions/{sessionId}");
  });
  it("validates examples against the request schema", () => {
    const ep = listEndpoints(SPEC).find((e) => e.path === "/sessions")!;
    const chk = checkExample(SPEC, ep, { merchantAccount: "x", amount: {}, bogus: 1 }, { url: "u", line: 1 })!;
    expect(chk.missingRequired).toEqual(["reference", "returnUrl"]);
    expect(chk.unknownProperties).toEqual(["bogus"]);
  });
  it("guesses the endpoint from preceding prose and parses the official README", () => {
    expect(guessEndpointFromContext("Make a [/paymentMethods](https://docs.adyen.com/api-explorer/Checkout/latest/post/paymentMethods) request, then a [/payments](https://docs.adyen.com/api-explorer/Checkout/71/post/payments) request")).toBe("/payments");
    expect(guessEndpointFromContext("curl https://checkout-test.adyen.com/v72/payments/details")).toBe("/payments/details");
    expect(guessEndpointFromContext("[/payments](https://docs.adyen.com/api-explorer/Checkout/latest/post/payments) then [/disable](https://docs.adyen.com/api-explorer/Recurring/latest/post/disable)")).toBeUndefined();
    expect(guessEndpointFromContext("plain prose mentioning /payments")).toBeUndefined();
    expect(guessEndpointFromContext("[/payments/(paymentPspReference)/captures](https://docs.adyen.com/api-explorer/Checkout/latest/post/payments/\\(paymentPspReference\\)/captures)\n**/capture request**")).toBeUndefined();
    expect(guessEndpointFromContext("see the link\n**/payments request**")).toBe("/payments");
    const readme = "- Creates a /sessions payment request - POST [`/sessions`](https://docs.adyen.com/api-explorer/Checkout/71/post/sessions)\n- GET [`/merchants`](https://docs.adyen.com/api-explorer/Management/latest/get/merchants)";
    expect(parseOfficialMcpReadme(readme)).toEqual([
      { method: "POST", path: "/sessions", service: "Checkout" },
      { method: "GET", path: "/merchants", service: "Management" },
    ]);
  });
  it("renders a Markdown reference with required fields first", () => {
    const md = renderLlmsCheckout(SPEC, "72");
    expect(md).toMatch(/## POST \/payments\n/);
    expect(md).toMatch(/Required: `amount` \(object\), `merchantAccount`/);
    expect(md).toMatch(/api-explorer\/Checkout\/72\/get\/sessions\/\(sessionId\)/);
  });
});

describe("test cards", () => {
  it("parses brand tables and the 3DS2 table", () => {
    const md = `## Visa\n\n| Card number | Type | Country | Expiry | CVC |\n|---|---|---|---|---|\n| 4111 1111 1111 1111 | Consumer | NL | 03/2030 | 737 |\n| 4111 1111 4555 1142 Security code optional | Classic | NL | 03/2030 | 737 |\n\n## 3D Secure 2\n\n| Brand | Number | Expiry | CVC |\n|---|---|---|---|\n| Visa | 4917 6100 0000 0000 | 03/2030 | 737 |\n`;
    const cards = parseTestCards(md);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({ brand: "Visa", number: "4111111111111111", variant: "Consumer", country: "NL", expiry: "03/2030", cvc: "737", threeDS2: false });
    expect(cards[1].note).toBe("Security code optional");
    expect(cards[2]).toMatchObject({ number: "4917610000000000", variant: "Visa", threeDS2: true });
  });
});

describe("findings end to end on a fixture corpus", () => {
  it("produces the expected finding ids and a Markdown report", () => {
    const entries = parseLlmsTxt(LLMS);
    const url = entries[2].url;
    const records = entries.map((e) => ({ url: e.url, status: e.url.endsWith("balances.md") ? 404 : 200, contentType: "text/plain", finalUrl: e.url, bytes: 100, lastModifiedHeader: "x" }));
    const analyses = [analysePage(url, PAGE)];
    const { findings, totals } = buildFindings({
      llmsEntries: entries,
      llmsFullBytes: 53_000_000,
      sitemapUrls: ["https://docs.adyen.com/account", "https://docs.adyen.com/only-in-sitemap"],
      robotsTxt: "User-agent: GPTBot\nUser-agent: ClaudeBot\nAllow: /\n",
      records,
      analyses,
      checkoutSpec: SPEC,
      checkoutLatestVersion: "72",
      officialMcpReadme: "- POST [`/sessions`](https://docs.adyen.com/api-explorer/Checkout/71/post/sessions)",
      sdkCheckoutVersion: "72",
      crawlRuns: [{ run: 1, startedAt: "2026-09-14T23:50:00Z", concurrency: 12, delayMs: 0, retries: 0, elapsedSeconds: 22, statusCounts: { "200": 1002, "429": 1523 }, challengePages: 1523 }],
      now: new Date("2026-09-14T00:00:00Z"),
    });
    const ids = findings.map((f) => f.id);
    for (const id of ["LLMS-INDEX", "LLMS-SITEMAP-DRIFT", "LLMS-DEAD-LINKS", "EDGE-CHALLENGE", "LLMS-FULL-SIZE", "FENCE-LANG", "SNIPPET-LINT", "API-VERSION-DRIFT", "EXPLORER-LINKS", "EXAMPLE-SCHEMA-DRIFT", "FRESHNESS", "RELATIVE-LINKS", "REFERENCE-NOT-INDEXED", "MCP-COVERAGE", "ROBOTS-POSTURE"]) {
      expect(ids).toContain(id);
    }
    const drift = findings.find((f) => f.id === "EXAMPLE-SCHEMA-DRIFT")!;
    expect(drift.metrics.examplesWithUnknownFields).toBe(1);
    expect(drift.evidence[0].note).toMatch(/bogusField/);
    const dead = findings.find((f) => f.id === "LLMS-DEAD-LINKS")!;
    expect(dead.metrics.non200).toBe(1);
    const rel = findings.find((f) => f.id === "RELATIVE-LINKS")!;
    expect(rel.metrics.distinctTargetsNotInLlms).toBe(2);
    expect(totals.findings).toBe(findings.length);
    const md = renderAuditMarkdown({ generatedAt: "2026-09-14T00:00:00Z", source: { llmsTxt: "a", llmsFullTxt: "b", sitemap: "c", robots: "d", openapiRepo: "e", officialMcpReadme: "f" }, totals, findings });
    expect(md).toMatch(/^# Adyen developer surfaces: agent-legibility audit/);
    expect(md).toMatch(/### 1\. /);
    expect(md.split("\n").filter((l) => l.startsWith("### ")).length).toBe(findings.length);
  });
});
