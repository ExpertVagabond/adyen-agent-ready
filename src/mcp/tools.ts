/**
 * Tool definitions for the adyen-agent-ready MCP server.
 *
 * Every tool is a plain async function over a `ToolContext` so it can be unit
 * tested without an MCP transport. `server.ts` registers them with the SDK.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CheckoutGateway } from "../adyen/gateway.js";
import type { TestCard } from "../audit/test-cards.js";
import type { Finding, LlmsEntry } from "../audit/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ToolContext {
  /** Undefined when credentials are missing; API tools then return a clear error instead of crashing the server. */
  gateway?: CheckoutGateway;
  gatewayError?: string;
  testCards: TestCard[];
  llmsIndex: LlmsEntry[];
  findings: Finding[];
  /** Fetch a docs page as Markdown. Injected so tests never touch the network. */
  fetchMarkdown: (url: string) => Promise<{ status: number; body: string }>;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const amountSchema = z.object({
  currency: z.string().length(3).describe("ISO 4217 code, e.g. EUR or USD"),
  value: z.number().int().nonnegative().describe("Minor units: 1000 = EUR 10.00"),
});

export const schemas = {
  listPaymentMethods: z.object({
    countryCode: z.string().length(2).describe("Shopper country, ISO 3166-1 alpha-2"),
    amount: amountSchema.optional(),
    channel: z.enum(["Web", "iOS", "Android"]).default("Web"),
    shopperLocale: z.string().optional().describe("e.g. en-US"),
  }),
  createSession: z.object({
    amount: amountSchema,
    reference: z.string().min(1).max(80).describe("Your order reference"),
    returnUrl: z.string().url().describe("Where the shopper returns after a redirect payment method"),
    countryCode: z.string().length(2),
    shopperLocale: z.string().optional(),
    shopperReference: z.string().optional(),
    shopperEmail: z.string().email().optional(),
    idempotencyKey: z.string().optional(),
  }),
  getSession: z.object({
    sessionId: z.string().min(1),
    sessionResult: z.string().min(1).describe("The sessionResult returned to the front end after payment"),
  }),
  createPayment: z.object({
    amount: amountSchema,
    reference: z.string().min(1).max(80),
    returnUrl: z.string().url(),
    countryCode: z.string().length(2).optional(),
    card: z
      .object({
        number: z.string().regex(/^\d{12,19}$/).describe("Test PAN without spaces; use adyen_test_cards to pick one"),
        expiryMonth: z.string().regex(/^\d{2}$/),
        expiryYear: z.string().regex(/^\d{4}$/),
        cvc: z.string().regex(/^\d{3,4}$/).optional(),
        holderName: z.string().default("Test Shopper"),
      })
      .describe("Raw card details. TEST only; the web service user needs the 'API PCI Payments role'."),
    shopperReference: z.string().optional(),
    idempotencyKey: z.string().optional(),
  }),
  submitPaymentDetails: z.object({
    paymentData: z.string().optional(),
    details: z.record(z.string()).describe("The `details` object the front end returned, e.g. { redirectResult }"),
  }),
  testCards: z.object({
    brand: z.string().optional().describe("Filter by brand substring, e.g. visa, mastercard, amex"),
    country: z.string().length(2).optional(),
    threeDS2: z.boolean().optional().describe("Only cards that trigger 3D Secure 2"),
    limit: z.number().int().positive().max(100).default(20),
  }),
  docsLookup: z.object({
    query: z.string().min(2).describe("Words to match against page titles, URLs and descriptions in docs.adyen.com/llms.txt"),
    fetch: z.boolean().default(false).describe("Also fetch the best match as Markdown"),
    maxChars: z.number().int().positive().max(200_000).default(12_000).describe("Cap on returned Markdown; large pages are trimmed"),
    limit: z.number().int().positive().max(25).default(8),
  }),
  auditFindings: z.object({
    id: z.string().optional().describe("Finding ID, e.g. EDGE-CHALLENGE; omit for the summary table"),
    severity: z.enum(["high", "medium", "low", "info"]).optional(),
  }),
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fail(message: string, extra?: unknown): ToolResult {
  return { content: [{ type: "text", text: extra ? `${message}\n${JSON.stringify(extra, null, 2)}` : message }], isError: true };
}

function requireGateway(ctx: ToolContext): CheckoutGateway | ToolResult {
  if (ctx.gateway) return ctx.gateway;
  return fail(
    `Adyen credentials are not configured: ${ctx.gatewayError ?? "unknown"}. ` +
      "Set ADYEN_API_KEY and ADYEN_MERCHANT_ACCOUNT for a TEST web service user (free test account: https://www.adyen.com/signup).",
  );
}

/** Errors from the SDK carry the API's JSON body in `responseBody`; surface it for the agent. */
function apiError(err: unknown): ToolResult {
  const e = err as { message?: string; statusCode?: number; responseBody?: string };
  let body: unknown = e.responseBody;
  try {
    body = e.responseBody ? JSON.parse(e.responseBody) : undefined;
  } catch {
    /* keep raw */
  }
  return fail(`Adyen API error${e.statusCode ? ` (HTTP ${e.statusCode})` : ""}: ${e.message ?? String(err)}`, body);
}

export const tools = {
  async adyen_list_payment_methods(ctx: ToolContext, input: z.infer<typeof schemas.listPaymentMethods>): Promise<ToolResult> {
    const gw = requireGateway(ctx);
    if ("content" in gw) return gw;
    try {
      const res = await gw.paymentMethods({
        merchantAccount: gw.merchantAccount,
        countryCode: input.countryCode,
        amount: input.amount,
        channel: input.channel as never,
        shopperLocale: input.shopperLocale,
      });
      return ok({
        environment: gw.environment,
        count: res.paymentMethods?.length ?? 0,
        paymentMethods: (res.paymentMethods ?? []).map((m) => ({ type: m.type, name: m.name, brands: m.brands })),
      });
    } catch (err) {
      return apiError(err);
    }
  },

  async adyen_create_session(ctx: ToolContext, input: z.infer<typeof schemas.createSession>): Promise<ToolResult> {
    const gw = requireGateway(ctx);
    if ("content" in gw) return gw;
    try {
      const res = await gw.sessions(
        {
          merchantAccount: gw.merchantAccount,
          amount: input.amount,
          reference: input.reference,
          returnUrl: input.returnUrl,
          countryCode: input.countryCode,
          shopperLocale: input.shopperLocale,
          shopperReference: input.shopperReference,
          shopperEmail: input.shopperEmail,
        },
        input.idempotencyKey,
      );
      return ok({
        environment: gw.environment,
        id: res.id,
        sessionData: res.sessionData,
        expiresAt: res.expiresAt,
        amount: res.amount,
        reference: res.reference,
        next: "Pass { id, sessionData } to Drop-in/Components on the front end. Docs: https://docs.adyen.com/online-payments/build-your-integration/sessions-flow.md",
      });
    } catch (err) {
      return apiError(err);
    }
  },

  async adyen_get_session(ctx: ToolContext, input: z.infer<typeof schemas.getSession>): Promise<ToolResult> {
    const gw = requireGateway(ctx);
    if ("content" in gw) return gw;
    try {
      return ok(await gw.getSession(input.sessionId, input.sessionResult));
    } catch (err) {
      return apiError(err);
    }
  },

  async adyen_create_payment(ctx: ToolContext, input: z.infer<typeof schemas.createPayment>): Promise<ToolResult> {
    const gw = requireGateway(ctx);
    if ("content" in gw) return gw;
    if (gw.environment !== "TEST") return fail("adyen_create_payment with raw card data is only allowed in the TEST environment.");
    const known = ctx.testCards.some((c) => c.number === input.card.number);
    try {
      const res = await gw.payments(
        {
          merchantAccount: gw.merchantAccount,
          amount: input.amount,
          reference: input.reference,
          returnUrl: input.returnUrl,
          countryCode: input.countryCode,
          shopperReference: input.shopperReference,
          paymentMethod: {
            type: "scheme",
            number: input.card.number,
            expiryMonth: input.card.expiryMonth,
            expiryYear: input.card.expiryYear,
            cvc: input.card.cvc,
            holderName: input.card.holderName,
          } as never,
        },
        input.idempotencyKey,
      );
      return ok({
        environment: gw.environment,
        knownTestCard: known,
        resultCode: res.resultCode,
        pspReference: res.pspReference,
        refusalReason: res.refusalReason,
        action: res.action ? { type: res.action.type } : undefined,
        next: res.action
          ? "The response contains an action (3DS/redirect). Hand it to the front end, then call adyen_submit_payment_details with the returned details."
          : "Terminal result; check resultCode. Result codes: https://docs.adyen.com/online-payments/build-your-integration/payment-result-codes.md",
      });
    } catch (err) {
      return apiError(err);
    }
  },

  async adyen_submit_payment_details(ctx: ToolContext, input: z.infer<typeof schemas.submitPaymentDetails>): Promise<ToolResult> {
    const gw = requireGateway(ctx);
    if ("content" in gw) return gw;
    try {
      const res = await gw.paymentsDetails({ paymentData: input.paymentData, details: input.details as never });
      return ok({ resultCode: res.resultCode, pspReference: res.pspReference, refusalReason: res.refusalReason });
    } catch (err) {
      return apiError(err);
    }
  },

  async adyen_test_cards(ctx: ToolContext, input: z.infer<typeof schemas.testCards>): Promise<ToolResult> {
    let cards = ctx.testCards;
    if (input.brand) {
      const q = input.brand.toLowerCase();
      cards = cards.filter((c) => c.brand.toLowerCase().includes(q) || (c.variant ?? "").toLowerCase().includes(q));
    }
    if (input.country) cards = cards.filter((c) => c.country === input.country!.toUpperCase());
    if (input.threeDS2 !== undefined) cards = cards.filter((c) => c.threeDS2 === input.threeDS2);
    return ok({
      source: "https://docs.adyen.com/development-resources/test-cards-and-credentials/test-card-numbers.md",
      total: cards.length,
      cards: cards.slice(0, input.limit),
      usage: "Pass number/expiry/cvc to adyen_create_payment. Expiry '03/2030' means expiryMonth '03', expiryYear '2030'.",
    });
  },

  async adyen_docs_lookup(ctx: ToolContext, input: z.infer<typeof schemas.docsLookup>): Promise<ToolResult> {
    const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = ctx.llmsIndex
      .map((e) => {
        const hay = `${e.title} ${e.url} ${e.description} ${e.section}`.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (e.title.toLowerCase().includes(t)) score += 3;
          if (e.url.toLowerCase().includes(t)) score += 2;
          if (hay.includes(t)) score += 1;
        }
        return { e, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit);
    if (scored.length === 0) return ok({ query: input.query, matches: [], hint: "No llms.txt entry matched. Try a product name (sessions, drop-in, webhooks, 3d secure)." });
    const matches = scored.map(({ e, score }) => ({ title: e.title, url: e.url, section: e.section, description: e.description, score }));
    if (!input.fetch) return ok({ query: input.query, matches });
    const best = scored[0].e;
    const page = await ctx.fetchMarkdown(best.url);
    if (page.status !== 200) {
      return fail(`Fetching ${best.url} returned HTTP ${page.status}. docs.adyen.com serves a Cloudflare challenge to non-browser clients under load (see audit finding EDGE-CHALLENGE); retry later.`, { matches });
    }
    const trimmed = page.body.length > input.maxChars;
    return ok({
      query: input.query,
      matches,
      page: { url: best.url, chars: page.body.length, trimmed, markdown: trimmed ? page.body.slice(0, input.maxChars) + "\n\n[... trimmed; raise maxChars to read more]" : page.body },
    });
  },

  async adyen_audit_findings(ctx: ToolContext, input: z.infer<typeof schemas.auditFindings>): Promise<ToolResult> {
    if (input.id) {
      const f = ctx.findings.find((x) => x.id.toLowerCase() === input.id!.toLowerCase());
      return f ? ok(f) : fail(`No finding with id ${input.id}. Known: ${ctx.findings.map((x) => x.id).join(", ")}`);
    }
    const list = ctx.findings.filter((f) => !input.severity || f.severity === input.severity);
    return ok({
      report: "https://github.com/ExpertVagabond/adyen-agent-ready/blob/main/AUDIT.md",
      count: list.length,
      findings: list.map((f) => ({ id: f.id, severity: f.severity, surface: f.surface, title: f.title })),
    });
  },
};

export type ToolName = keyof typeof tools;

export const toolDescriptions: Record<ToolName, { title: string; description: string; schema: z.ZodTypeAny; readOnly: boolean }> = {
  adyen_list_payment_methods: {
    title: "List payment methods",
    description: "POST /paymentMethods on the Adyen Checkout API (TEST): which payment methods are available for a country and amount.",
    schema: schemas.listPaymentMethods,
    readOnly: true,
  },
  adyen_create_session: {
    title: "Create a checkout session",
    description: "POST /sessions: start a Sessions-flow payment and return { id, sessionData } for Drop-in or Components.",
    schema: schemas.createSession,
    readOnly: false,
  },
  adyen_get_session: {
    title: "Get session result",
    description: "GET /sessions/{id}: read the outcome of a checkout session using the sessionResult from the front end.",
    schema: schemas.getSession,
    readOnly: true,
  },
  adyen_create_payment: {
    title: "Create a test card payment",
    description: "POST /payments (Advanced flow) with raw test-card data. TEST environment only. Combine with adyen_test_cards.",
    schema: schemas.createPayment,
    readOnly: false,
  },
  adyen_submit_payment_details: {
    title: "Submit payment details",
    description: "POST /payments/details: finish a payment after a redirect or 3D Secure action.",
    schema: schemas.submitPaymentDetails,
    readOnly: false,
  },
  adyen_test_cards: {
    title: "Test card catalogue",
    description: "Look up Adyen test card numbers (parsed from docs.adyen.com) by brand, country or 3DS2 behaviour. No network call.",
    schema: schemas.testCards,
    readOnly: true,
  },
  adyen_docs_lookup: {
    title: "Search Adyen docs",
    description: "Search the docs.adyen.com llms.txt index and optionally fetch the best page as Markdown, trimmed to a token budget.",
    schema: schemas.docsLookup,
    readOnly: true,
  },
  adyen_audit_findings: {
    title: "Agent-legibility audit findings",
    description: "Read the findings of the adyen-agent-ready audit of Adyen's developer surfaces (AUDIT.md).",
    schema: schemas.auditFindings,
    readOnly: true,
  },
};

/** Load the data files shipped with the package. */
export async function loadData(root: string = ROOT): Promise<Pick<ToolContext, "testCards" | "llmsIndex" | "findings">> {
  const readJson = async <T>(rel: string, fallback: T): Promise<T> => {
    try {
      return JSON.parse(await readFile(join(root, rel), "utf8")) as T;
    } catch {
      return fallback;
    }
  };
  const cards = await readJson<{ cards: TestCard[] }>("data/test-cards.json", { cards: [] });
  const index = await readJson<LlmsEntry[]>("data/llms-index.json", []);
  const report = await readJson<{ findings: Finding[] }>("audit/report.json", { findings: [] });
  return { testCards: cards.cards, llmsIndex: index, findings: report.findings };
}
