# Adyen developer surfaces: agent-legibility audit

Generated 2026-09-15 by [adyen-agent-ready](https://github.com/ExpertVagabond/adyen-agent-ready) (`npm run audit`). Every number below was measured against the live surfaces on that date; re-run to refresh.

## Scope

| Surface | Source |
|---|---|
| Page index | https://docs.adyen.com/llms.txt |
| Full corpus | https://docs.adyen.com/llms-full.txt |
| Sitemap | https://docs.adyen.com/sitemap.xml |
| Crawler policy | https://docs.adyen.com/robots.txt |
| API spec | https://github.com/Adyen/adyen-openapi |
| Official MCP | https://raw.githubusercontent.com/Adyen/adyen-mcp/main/README.md |

## Totals

| Metric | Value |
|---|---|
| llmsEntries | 2,524 |
| pagesFetched | 2,524 |
| pages200 | 2,523 |
| corpusBytes | 53,034,923 |
| codeBlocks | 19,084 |
| snippetsLinted | 7,870 |
| snippetsFailing | 847 |
| findings | 17 |
| high | 6 |
| medium | 7 |
| low | 3 |
| elapsedSeconds | 6 |

## Findings

| # | ID | Severity | Surface | Title |
|---|---|---|---|---|
| 1 | EDGE-CHALLENGE | high | robots | docs.adyen.com answers a plain HTTP client with a Cloudflare JavaScript challenge (HTTP 429, cf-mitigated: challenge) after about 1,002 Markdown fetches |
| 2 | LLMS-FULL-SIZE | high | llms-full.txt | llms-full.txt is 51.1 MB (about 13.4M tokens), larger than any model context |
| 3 | SNIPPET-LINT | high | snippets | 847 of 7,870 JSON/JS/TS/Python snippets do not parse, even as fragments; 526 more parse only after dedenting or wrapping |
| 4 | TEMPLATE-LEAK | high | docs.md | Docs-template markup ({hint:...}{/hint}) leaks into 115 Markdown pages, 66 times inside JSON examples |
| 5 | API-VERSION-DRIFT | high | openapi | 245 pages mix Checkout API versions in their own examples; 67 never mention the current v72 |
| 6 | REFERENCE-NOT-INDEXED | high | llms.txt | llms.txt lists 0 API reference pages; the guides link to the API Explorer 11,370 times |
| 7 | LLMS-SITEMAP-DRIFT | medium | llms.txt | llms.txt and sitemap.xml disagree on which pages exist |
| 8 | PAGE-TOO-LARGE | medium | docs.md | 6 pages exceed 100k tokens each because every language tab is inlined |
| 9 | FENCE-LANG | medium | snippets | 270 of 19,084 code fences carry no language tag |
| 10 | EXAMPLE-SCHEMA-DRIFT | medium | openapi | 8 of 40 JSON request examples use fields the v72 spec does not define; 9 omit a required field |
| 11 | FRESHNESS | medium | docs.md | 801 of 2523 pages declare a last_modified more than 3 years old (456 more than 5) |
| 12 | RELATIVE-LINKS | medium | docs.md | 57,539 links in the .md corpus are site-relative; 396 distinct targets are not in llms.txt |
| 13 | MCP-COVERAGE | medium | mcp | Official @adyen/mcp covers 8 of 29 Checkout operations; POST /payments and /payments/details are not among them |
| 14 | LLMS-INDEX | low | llms.txt | llms.txt index hygiene: duplicate URLs and entries without a description |
| 15 | LLMS-DEAD-LINKS | low | llms.txt | llms.txt links that do not return a 200 Markdown document |
| 16 | EXPLORER-LINKS | low | openapi | 120 API Explorer links pin an older Checkout version; 0 point at paths absent from the v72 spec |
| 17 | ROBOTS-POSTURE | info | robots | robots.txt explicitly allows 6 named AI crawlers and publishes llms.txt: the posture is right, the content is the gap |

### 1. docs.adyen.com answers a plain HTTP client with a Cloudflare JavaScript challenge (HTTP 429, cf-mitigated: challenge) after about 1,002 Markdown fetches

**ID** EDGE-CHALLENGE · **Severity** high · **Surface** robots

**Why it misleads an agent.** robots.txt invites AI agents in and llms.txt hands them 2,500 Markdown URLs, but the edge serves a browser-only challenge page once a client reads the corpus at any speed. An agent cannot execute the challenge, receives an HTML body on a .md URL, and gets no Retry-After to plan around. The tooling says 'crawl me'; the CDN says 'prove you are a browser'.

**Measured.**

| Metric | Value |
|---|---|
| crawlRuns | 8 |
| challengedInThisRun | 0 |
| worstRunConcurrency | 12 |
| worstRunOk | 1,002 |
| worstRunChallenged | 1,523 |
| worstRunElapsedSeconds | 22 |

**Evidence.**

- https://docs.adyen.com/online-payments/build-your-integration/advanced-flow.md : HTTP 429, content-type text/html, cf-mitigated: challenge, no Retry-After (single request, identifying User-Agent)
- https://docs.adyen.com/llms.txt : run 1: 1002 pages OK then 1523 challenge pages at concurrency 12 in 22s

**Fix.** Exempt `/*.md`, `/llms.txt` and `/llms-full.txt` from managed challenges (or key the rate limit on the identifying User-Agent and return a real 429 with Retry-After), and publish the crawl budget in llms.txt.

### 2. llms-full.txt is 51.1 MB (about 13.4M tokens), larger than any model context

**ID** LLMS-FULL-SIZE · **Severity** high · **Surface** llms-full.txt

**Why it misleads an agent.** llms-full.txt exists so an agent can load the whole corpus in one read. At this size no current model can, so agents that follow the llms.txt pointer either fail the fetch or truncate silently and reason from the first few hundred pages (the Account and Customer Area sections).

**Measured.**

| Metric | Value |
|---|---|
| bytes | 53,586,145 |
| approxTokens | 13,396,536 |
| pagesInCorpus | 2,524 |

**Evidence.**

- https://docs.adyen.com/llms-full.txt : Content-Length 53,586,145 bytes on 2026-09-15
- https://docs.adyen.com/llms.txt : line 5 points agents at llms-full.txt as 'the full concatenated Markdown corpus of every page'

**Fix.** Split llms-full.txt per product section (Online payments, Platforms, Issuing, POS, Risk) and per language track, each under ~2M tokens; keep the aggregate file but add its size to the llms.txt line so agents can plan.

### 3. 847 of 7,870 JSON/JS/TS/Python snippets do not parse, even as fragments; 526 more parse only after dedenting or wrapping

**ID** SNIPPET-LINT · **Severity** high · **Surface** snippets

**Why it misleads an agent.** Agents copy snippets verbatim. A JSON example with `...` or a comment fails JSON.parse in the agent's own tool call; a JS block that does not parse is a broken first attempt the agent must debug before it can help the developer.

**Measured.**

| Metric | Value |
|---|---|
| snippetsChecked | 7,870 |
| snippetsFailing | 847 |
| failRate | 10.8% |
| usableOnlyAsFragment | 526 |
| jsonChecked | 3,016 |
| jsonFailing | 509 |
| jsChecked | 2,367 |
| jsFailing | 249 |
| tsChecked | 1,133 |
| tsFailing | 23 |
| pyChecked | 1,354 |
| pyFailing | 66 |
| reason: ellipsis placeholder (...) inside JSON | 299 |
| reason: ellipsis placeholder (...) inside code | 99 |
| reason: parse error | 75 |
| reason: trailing comma | 59 |
| reason: not a JSON document (fragment) | 58 |

**Evidence.**

- https://docs.adyen.com/business-accounts/how-sca-works.md#L155 : js: Expression expected. (line 7)
- https://docs.adyen.com/business-accounts/manage-legal-entities.md#L369 : json: comments inside JSON
- https://docs.adyen.com/business-accounts/manage-sca-devices.md#L203 : ts: Expression expected. (line 8)
- https://docs.adyen.com/business-accounts/register-sca-devices.md#L111 : js: Expression expected. (line 7)
- https://docs.adyen.com/business-accounts/sca-for-funds-transfers.md#L109 : js: Expression expected. (line 7)
- https://docs.adyen.com/business-accounts/kyc-verification-codes.md#L81 : json: ellipsis placeholder (...) inside JSON
- https://docs.adyen.com/business-accounts/kyc-verification-codes/general-verification-errors.md#L309 : json: ellipsis placeholder (...) inside JSON
- https://docs.adyen.com/business-accounts/kyc-verification-codes/remediating-actions.md#L298 : json: ellipsis placeholder (...) inside JSON

**Fix.** Lint every fenced snippet in CI (JSON.parse, tsc parse diagnostics, python ast). Replace `...` with a complete minimal example or move the elision into a comment outside the fence; strip list indentation from fenced blocks in the Markdown renderer.

### 4. Docs-template markup ({hint:...}{/hint}) leaks into 115 Markdown pages, 66 times inside JSON examples

**ID** TEMPLATE-LEAK · **Severity** high · **Surface** docs.md

**Why it misleads an agent.** The HTML renderer turns {hint:...} into a tooltip; the Markdown renderer prints it verbatim, so a JSON example contains "{hint:This is the card alias}M4695...{/hint}" where a value should be. An agent that copies it ships the markup, and JSON.parse still succeeds because it sits inside a string, so nothing catches it downstream.

**Measured.**

| Metric | Value |
|---|---|
| pagesWithLeakedMarkup | 115 |
| markupOccurrences | 727 |
| occurrencesInsideJsonBlocks | 66 |

**Evidence.**

- https://docs.adyen.com/online-payments/3d-secure/native-3ds2.md : 68 template markers
- https://docs.adyen.com/online-payments/build-your-integration/advanced-flow.md : 36 template markers
- https://docs.adyen.com/online-payments/online-payouts/instant-payouts.md : 36 template markers
- https://docs.adyen.com/online-payments/tokenization/forward-payment-details.md : 25 template markers
- https://docs.adyen.com/point-of-sale/offline-payment.md : 22 template markers
- https://docs.adyen.com/online-payments/3d-secure/standalone-authentication.md : 20 template markers
- https://docs.adyen.com/point-of-sale/card-acquisition.md : 16 template markers
- https://docs.adyen.com/point-of-sale/shopper-recognition/identification.md : 14 template markers

**Fix.** Strip or resolve {hint:} in the Markdown export (render the hint as a trailing comment outside the fence) and add a grep for `{hint:` to the docs CI.

### 5. 245 pages mix Checkout API versions in their own examples; 67 never mention the current v72

**ID** API-VERSION-DRIFT · **Severity** high · **Surface** openapi

**Why it misleads an agent.** The OpenAPI spec and the Node SDK are at Checkout v72. Docs examples still call older versions, sometimes three different ones on the same page. An agent has no way to know which is current and will pin a new integration to whatever it read first.

**Measured.**

| Metric | Value |
|---|---|
| latestCheckoutVersion | v72 |
| sdkCheckoutVersion | v72 |
| pagesWithEndpointUrls | 513 |
| pagesMixingVersions | 245 |
| pagesWithoutLatestVersion | 67 |
| urls v52 | 1 |
| urls v64 | 1 |
| urls v65 | 7 |
| urls v66 | 2 |
| urls v68 | 178 |
| urls v69 | 31 |
| urls v70 | 25 |
| urls v71 | 201 |
| urls v72 | 927 |

**Evidence.**

- https://docs.adyen.com/online-payments/3d-secure/redirect-3ds2/web-drop-in.md : v72: 1, v68: 1, v66: 1
- https://docs.adyen.com/online-payments/build-your-integration/sessions-flow.md : v71: 6, v70: 12, v72: 2
- https://docs.adyen.com/payment-methods/afterpaytouch/api-only.md : v71: 1, v68: 1, v72: 3
- https://docs.adyen.com/payment-methods/cards/android-component.md : v70: 1, v72: 5, v71: 2
- https://docs.adyen.com/payment-methods/cards/android-drop-in.md : v70: 1, v72: 5, v71: 2
- https://docs.adyen.com/payment-methods/cards/flutter-component.md : v70: 1, v72: 5, v71: 2
- https://docs.adyen.com/payment-methods/cards/flutter-drop-in.md : v70: 1, v72: 5, v71: 2
- https://docs.adyen.com/payment-methods/cards/ios-component.md : v69: 1, v72: 5, v71: 2

**Fix.** Template the version into snippets from one constant (`{{checkoutVersion}}`) and bump it in one commit when the spec releases; assert in CI that no page contains more than one version.

### 6. llms.txt lists 0 API reference pages; the guides link to the API Explorer 11,370 times

**ID** REFERENCE-NOT-INDEXED · **Severity** high · **Surface** llms.txt

**Why it misleads an agent.** The guides defer field-level detail to the API Explorer, which is a JavaScript application with no Markdown rendering and no llms.txt entry. An agent reading the corpus can reach the prose but not the schema it is told to consult, so it guesses field names.

**Measured.**

| Metric | Value |
|---|---|
| apiExplorerEntriesInLlms | 0 |
| apiExplorerEntriesInSitemap | 0 |
| apiExplorerLinksFromGuides | 11,370 |
| checkoutEndpointsInSpec | 29 |

**Evidence.**

- https://docs.adyen.com/llms.txt : 2524 entries, 0 under /api-explorer
- https://docs.adyen.com/api-explorer/Checkout/latest/post/payments : JS-rendered; the .md variant returns 404
- https://github.com/Adyen/adyen-openapi : CheckoutService-v72.json has 29 operations, none exposed as Markdown

**Fix.** Render one Markdown page per operation from the OpenAPI spec (this repo's `data/llms-checkout.txt` is a generated example) and list them in a `## API reference` section of llms.txt.

### 7. llms.txt and sitemap.xml disagree on which pages exist

**ID** LLMS-SITEMAP-DRIFT · **Severity** medium · **Surface** llms.txt

**Why it misleads an agent.** Two machine-readable indexes of the same site disagree. An agent that trusts llms.txt never sees pages only the sitemap lists, and vice versa.

**Measured.**

| Metric | Value |
|---|---|
| sitemapPages | 2,566 |
| llmsPages | 2,524 |
| inSitemapOnly | 42 |
| inLlmsOnly | 0 |

**Evidence.**

- https://docs.adyen.com/adyen-for-platforms-model/marketplaces : in sitemap.xml, absent from llms.txt
- https://docs.adyen.com/adyen-for-platforms-model/platforms : in sitemap.xml, absent from llms.txt
- https://docs.adyen.com/capital/release-notes : in sitemap.xml, absent from llms.txt
- https://docs.adyen.com/classic-platforms/verification-process/required-information : in sitemap.xml, absent from llms.txt

**Fix.** Emit both files from one page manifest in the docs build and add a CI assertion that the two URL sets are equal.

### 8. 6 pages exceed 100k tokens each because every language tab is inlined

**ID** PAGE-TOO-LARGE · **Severity** medium · **Surface** docs.md

**Why it misleads an agent.** The .md rendering flattens every code-language tab into one document. An agent asking for the Node.js sessions flow receives Java, Kotlin, Swift, PHP, Go, C#, Ruby and Python as well, and may not fit the page in context at all.

**Measured.**

| Metric | Value |
|---|---|
| pagesOver100kTokens | 6 |
| largestBytes | 1,081,899 |
| largestApproxTokens | 270,475 |

**Evidence.**

- https://docs.adyen.com/online-payments/build-your-integration/advanced-flow.md : 1057 KB, ~270,475 tokens, 857 code blocks
- https://docs.adyen.com/online-payments/release-notes.md : 784 KB, ~200,791 tokens, 497 code blocks
- https://docs.adyen.com/online-payments/build-your-integration/sessions-flow.md : 610 KB, ~156,215 tokens, 417 code blocks
- https://docs.adyen.com/online-payments/3d-secure/native-3ds2.md : 525 KB, ~134,277 tokens, 197 code blocks
- https://docs.adyen.com/issuing/verification-requirements/required-kyc-information.md : 481 KB, ~123,015 tokens, 0 code blocks
- https://docs.adyen.com/risk-management/understanding-disputes/dispute-reason-codes.md : 394 KB, ~100,847 tokens, 0 code blocks

**Fix.** Honour a `?lang=` query (or `Accept-Language`-style header) on .md URLs, or publish one .md per language tab and list them in llms.txt.

### 9. 270 of 19,084 code fences carry no language tag

**ID** FENCE-LANG · **Severity** medium · **Surface** snippets

**Why it misleads an agent.** A fence without a language is untyped text to an agent: it cannot tell a JSON request body from a shell command from a webhook payload, cannot lint it, and cannot choose it when the user asked for a specific language.

**Measured.**

| Metric | Value |
|---|---|
| fencesTotal | 19,084 |
| fencesUnlabelled | 270 |
| pagesAffected | 9 |
| pagesWithUnclosedFence | 1 |
| unlabelledRate | 1.4% |

**Evidence.**

- https://docs.adyen.com/online-payments/release-notes.md : 245 unlabelled of 497 fences
- https://docs.adyen.com/plugins/adobe-commerce/set-up-the-plugin-in-adobe-commerce.md : 8 unlabelled of 8 fences
- https://docs.adyen.com/online-payments/classic-integrations/classic-api-integration/3d-secure-authentication/native-3ds2/browser-based-integration.md : 6 unlabelled of 60 fences
- https://docs.adyen.com/point-of-sale/firmware-release-notes.md : 6 unlabelled of 10 fences
- https://docs.adyen.com/development-resources/batch-processing/advanced-sftp-batch-files/batch-file-naming-and-structure.md : 1 unlabelled of 3 fences
- https://docs.adyen.com/development-resources/batch-processing/advanced-sftp-batch-files/batch-request-file/authorisation-request-file/authorisation-for-ach-direct-debit.md : 1 unlabelled of 1 fences
- https://docs.adyen.com/reporting/closing-your-fiscal-period/monthly-and-daily-finance-report.md : odd number of ``` fences (block never closes)

**Fix.** Add a docs lint rule: every fence has a language; treat `json`, `bash`, and `text` as the fallbacks.

### 10. 8 of 40 JSON request examples use fields the v72 spec does not define; 9 omit a required field

**ID** EXAMPLE-SCHEMA-DRIFT · **Severity** medium · **Surface** openapi

**Why it misleads an agent.** Agents validate their tool calls against the OpenAPI schema (the official MCP server is generated from it). A docs example with a field the schema lacks either gets rejected client-side or teaches the agent a field that the API ignores. A required field missing from the example is a guaranteed 422 on the first try.

**Measured.**

| Metric | Value |
|---|---|
| requestExamplesChecked | 40 |
| examplesWithUnknownFields | 8 |
| examplesMissingRequiredFields | 9 |
| unknown field: {hint:The shopperReference that you specified when creating the token}shopperReference{/hint} | 7 |
| unknown field: {hint:This is the unique customer reference in your db}shopperReference{/hint} | 1 |

**Evidence.**

- https://docs.adyen.com/payment-methods/klarna/android-component/earlier-versions.md#L1553 : POST /payments example has unknown top-level field(s): {hint:The shopperReference that you specified when creating the token}shopperReference{/hint}
- https://docs.adyen.com/payment-methods/klarna/android-drop-in/earlier-versions.md#L1537 : POST /payments example has unknown top-level field(s): {hint:The shopperReference that you specified when creating the token}shopperReference{/hint}
- https://docs.adyen.com/payment-methods/klarna/api-only.md#L1654 : POST /payments example has unknown top-level field(s): {hint:The shopperReference that you specified when creating the token}shopperReference{/hint}
- https://docs.adyen.com/payment-methods/klarna/ios-component.md#L2177 : POST /payments example has unknown top-level field(s): {hint:The shopperReference that you specified when creating the token}shopperReference{/hint}
- https://docs.adyen.com/payment-methods/klarna/ios-drop-in.md#L2130 : POST /payments example has unknown top-level field(s): {hint:The shopperReference that you specified when creating the token}shopperReference{/hint}
- https://docs.adyen.com/online-payments/instant-card-funding.md#L52 : POST /payments example omits required: returnUrl
- https://docs.adyen.com/online-payments/instant-card-funding.md#L105 : POST /payments example omits required: returnUrl
- https://docs.adyen.com/online-payments/tokenization/managing-tokens.md#L122 : POST /payments example omits required: returnUrl

**Fix.** Validate every request example against the request schema of the endpoint it sits under (this audit's `checkExample`) as a docs CI step.

### 11. 801 of 2523 pages declare a last_modified more than 3 years old (456 more than 5)

**ID** FRESHNESS · **Severity** medium · **Surface** docs.md

**Why it misleads an agent.** The posting's own words: stale content misleads agents as much as people. The .md frontmatter exposes `last_modified`, which is the right signal, but it is either very old or absent on a large share of pages, so an agent cannot down-weight stale guidance.

**Measured.**

| Metric | Value |
|---|---|
| pagesWithDate | 2,523 |
| pagesWithoutDate | 0 |
| olderThan3y | 801 |
| olderThan5y | 456 |
| olderThan3yWithCodeInIntegrationSections | 172 |
| responsesWithoutLastModifiedOrEtag | 0 |

**Evidence.**

- https://docs.adyen.com/online-payments/classic-integrations/classic-api-integration/client-side-encryption/hosting-the-cse-library.md : last_modified 2019-04-22, 7 code blocks
- https://docs.adyen.com/development-resources/batch-processing/advanced-sftp-batch-files/batch-acknowledgement-file.md : last_modified 2019-04-29, 2 code blocks
- https://docs.adyen.com/development-resources/batch-processing/advanced-sftp-batch-files/batch-request-file/authorisation-request-file/authorisation-for-a-card-payment.md : last_modified 2019-04-29, 4 code blocks
- https://docs.adyen.com/development-resources/batch-processing/advanced-sftp-batch-files/batch-request-file/authorisation-request-file/authorisation-for-ach-direct-debit.md : last_modified 2019-04-30, 1 code blocks
- https://docs.adyen.com/development-resources/batch-processing/advanced-sftp-batch-files/batch-request-file/modification-request-file/cancelorrefund-request.md : last_modified 2019-04-30, 1 code blocks
- https://docs.adyen.com/development-resources/batch-processing/advanced-sftp-batch-files/batch-request-file/payout-request-file/payout-request.md : last_modified 2019-04-30, 3 code blocks
- https://docs.adyen.com/development-resources/batch-processing/advanced-sftp-batch-files/batch-request-file/authorisation-request-file/authorisation-for-an-iban-payment.md : last_modified 2019-04-30, 3 code blocks
- https://docs.adyen.com/development-resources/batch-processing/advanced-sftp-batch-files/batch-request-file/modification-request-file/authorisationreferral-request.md : last_modified 2019-04-30, 1 code blocks

**Fix.** Set `last_modified` from git history on every page, expose the same value as the HTTP Last-Modified header, and add a `reviewed_on` field so agents can distinguish 'old but verified' from 'old'.

### 12. 57,539 links in the .md corpus are site-relative; 396 distinct targets are not in llms.txt

**ID** RELATIVE-LINKS · **Severity** medium · **Surface** docs.md

**Why it misleads an agent.** A .md page fetched by URL contains links like `/payment-methods`. An agent must guess the host and append `.md` to follow them; when the target is not in llms.txt the guess fails. Absolute `.md` links would let an agent walk the corpus without heuristics.

**Measured.**

| Metric | Value |
|---|---|
| relativeLinks | 57,539 |
| pagesWithRelativeLinks | 2,480 |
| distinctTargetsNotInLlms | 396 |

**Evidence.**

- https://docs.adyen.com/reporting/downloading-reports : linked from https://docs.adyen.com/account.md and 2 more; not in llms.txt
- https://docs.adyen.com/account/view-your-balances-pilot : linked from https://docs.adyen.com/account/balances.md and 2 more; not in llms.txt
- https://docs.adyen.com/account/manage-your-balances-pilot : linked from https://docs.adyen.com/account/balances.md and 2 more; not in llms.txt
- https://docs.adyen.com/account/balances-pilot/next-payout : linked from https://docs.adyen.com/account/balances.md; not in llms.txt
- https://docs.adyen.com/account/balances-pilot/reserve : linked from https://docs.adyen.com/account/balances.md and 2 more; not in llms.txt
- https://docs.adyen.com/account/balances-pilot/deposit : linked from https://docs.adyen.com/account/balances.md and 2 more; not in llms.txt
- https://docs.adyen.com/get-started-with-adyen/adyen-glossary : linked from https://docs.adyen.com/account/balances/deposit.md and 2 more; not in llms.txt
- https://docs.adyen.com/reporting/monthly-and-daily-finance-report : linked from https://docs.adyen.com/account/balances/next-payout.md and 1 more; not in llms.txt

**Fix.** Rewrite in-site links to absolute `https://docs.adyen.com/...md` URLs in the .md rendering, and include API Explorer reference pages in llms.txt.

### 13. Official @adyen/mcp covers 8 of 29 Checkout operations; POST /payments and /payments/details are not among them

**ID** MCP-COVERAGE · **Severity** medium · **Surface** mcp

**Why it misleads an agent.** An agent with the official server can create a session or a payment link but cannot run the Advanced flow (/payments, /payments/details) or check a test card, which is what most integration debugging needs. Its README also pins Checkout v71 while the spec and SDK are at v72.

**Measured.**

| Metric | Value |
|---|---|
| checkoutOperationsInSpec | 29 |
| coveredByOfficialMcp | 8 |
| uncovered | 21 |
| readmeVersionPins | 71 |
| totalOfficialTools | 40 |

**Evidence.**

- https://github.com/Adyen/adyen-mcp/blob/main/README.md : tool list parsed on 2026-09-15: 40 operations across Checkout and Management
- https://docs.adyen.com/api-explorer/Checkout/latest/post/applePay/sessions : POST /applePay/sessions: no official MCP tool
- https://docs.adyen.com/api-explorer/Checkout/latest/post/cancels : POST /cancels: no official MCP tool
- https://docs.adyen.com/api-explorer/Checkout/latest/post/cardDetails : POST /cardDetails: no official MCP tool
- https://docs.adyen.com/api-explorer/Checkout/latest/post/donationCampaigns : POST /donationCampaigns: no official MCP tool
- https://docs.adyen.com/api-explorer/Checkout/latest/post/donations : POST /donations: no official MCP tool
- https://docs.adyen.com/api-explorer/Checkout/latest/post/forward : POST /forward: no official MCP tool

**Fix.** Generate the tool list from the OpenAPI spec so coverage and version move together; this repo's MCP adds /payments, /payments/details and a test-card catalogue for the TEST environment.

### 14. llms.txt index hygiene: duplicate URLs and entries without a description

**ID** LLMS-INDEX · **Severity** low · **Surface** llms.txt

**Why it misleads an agent.** An agent picking pages from llms.txt uses the one-line description to decide what to fetch. Entries without one are opaque; duplicates waste retrieval budget.

**Measured.**

| Metric | Value |
|---|---|
| entries | 2,524 |
| duplicateUrls | 0 |
| entriesWithoutDescription | 165 |
| entriesNotMarkdown | 0 |

**Evidence.**

- https://docs.adyen.com/.md : line 9: no description ("Home")
- https://docs.adyen.com/business-accounts/kyc-verification-codes/general-verification-errors.md : line 94: no description ("General error codes")
- https://docs.adyen.com/business-accounts/kyc-verification-codes/remediating-actions.md : line 95: no description ("Remediating action codes")
- https://docs.adyen.com/business-accounts/kyc-verification-codes/sub-errors.md : line 96: no description ("Suberror codes")
- https://docs.adyen.com/classic-platforms/kyc-action-required-snapshot-report.md : line 196: no description ("KYC action required snapshot report")

**Fix.** Generate llms.txt from the same source of truth as the page frontmatter so every entry carries `description`, and dedupe on canonical URL.

### 15. llms.txt links that do not return a 200 Markdown document

**ID** LLMS-DEAD-LINKS · **Severity** low · **Surface** llms.txt

**Why it misleads an agent.** A link in llms.txt is a promise that the page exists as Markdown. Every broken or HTML-returning link is an agent fetch that fails or feeds HTML into a Markdown parser.

**Measured.**

| Metric | Value |
|---|---|
| checked | 2,524 |
| non200 | 1 |
| htmlInsteadOfMarkdown | 0 |
| redirected | 0 |
| okRate | 100.0% |

**Evidence.**

- https://docs.adyen.com/scripts/docs-mirror.md : HTTP 404

**Fix.** Run this link check in the docs CI on every deploy; fail the build on any non-200 or non-Markdown response for a URL that llms.txt advertises.

### 16. 120 API Explorer links pin an older Checkout version; 0 point at paths absent from the v72 spec

**ID** EXPLORER-LINKS · **Severity** low · **Surface** openapi

**Why it misleads an agent.** API Explorer links are the docs' own pointer into the reference. Links pinned to an older version send an agent to a reference that disagrees with the SDK; links to missing paths send it nowhere.

**Measured.**

| Metric | Value |
|---|---|
| checkoutExplorerLinks | 5,274 |
| pinnedToOlderVersion | 120 |
| pathNotInSpec | 0 |
| links 40 | 4 |
| links 41 | 2 |
| links 49 | 5 |
| links 50 | 1 |
| links 52 | 2 |
| links 53 | 3 |
| links 64 | 10 |
| links 65 | 7 |
| links 66 | 16 |
| links 67 | 14 |
| links 68 | 16 |
| links 69 | 7 |
| links 70 | 21 |
| links 71 | 11 |
| links 72 | 1 |
| links later | 1 |
| links latest | 5,153 |

**Evidence.**

- https://docs.adyen.com/marketplaces/prepare-reports.md : links https://docs.adyen.com/api-explorer/Checkout/70/post/payments/_paymentPspReference_/captures (Checkout 70; current is v72)
- https://docs.adyen.com/marketplaces/prepare-reports.md : links https://docs.adyen.com/api-explorer/Checkout/70/post/payments/_paymentPspReference_/refunds (Checkout 70; current is v72)
- https://docs.adyen.com/online-payments/3d-secure/native-3ds2.md : links https://docs.adyen.com/api-explorer/Checkout/67/post/payments (Checkout 67; current is v72)
- https://docs.adyen.com/online-payments/3d-secure/native-3ds2.md : links https://docs.adyen.com/api-explorer/Checkout/66/post/payments (Checkout 66; current is v72)

**Fix.** Link to `/api-explorer/Checkout/latest/...` everywhere and validate each explorer link against the published spec in CI.

### 17. robots.txt explicitly allows 6 named AI crawlers and publishes llms.txt: the posture is right, the content is the gap

**ID** ROBOTS-POSTURE · **Severity** info · **Surface** robots

**Why it misleads an agent.** Agents are welcome at the door. Every finding above is about what they find once inside.

**Measured.**

| Metric | Value |
|---|---|
| namedAiAgentsAllowed | 6 |
| llmsTxtPresent | 1 |
| llmsFullPresent | 1 |
| markdownPerPage | 1 |

**Evidence.**

- https://docs.adyen.com/robots.txt : Allow: / for GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, anthropic-ai
- https://docs.adyen.com/llms.txt : present; every page also served as Markdown via `.md`

**Fix.** Keep it. Add `Sitemap:` and `llms.txt` hints to the HTML `<head>` (`<link rel="alternate" type="text/markdown">`) so agents that land on an HTML page discover the Markdown twin.

## Method

1. Parse `llms.txt` into entries; parse `sitemap.xml`; diff the two URL sets.
2. Fetch every `.md` URL that `llms.txt` advertises (bounded concurrency, cached under `.cache/`); record HTTP status, content type, redirects, `Last-Modified`/`ETag`.
3. Parse each page: frontmatter (`last_modified`), fenced code blocks with language tags, links (relative, in-site, external), Checkout endpoint versions in URLs, API Explorer links.
4. Lint snippets: `JSON.parse` for JSON, TypeScript parse diagnostics for JS/TS, `ast.parse` for Python.
5. Load the latest `CheckoutService-v*.json` from `Adyen/adyen-openapi`; resolve API Explorer links to operations; validate JSON request examples against the request schema of the endpoint they document (top-level fields only).
6. Parse the official `Adyen/adyen-mcp` README tool list and diff it against the spec's operations.
7. Read `robots.txt` for named AI user agents.

Limitations: request-example attribution uses the prose preceding each block, so a small number of examples may be matched to the wrong endpoint; nested schema validation is out of scope; Java/Kotlin/Swift/PHP/Go/C#/Ruby snippets are counted but not compiled.
