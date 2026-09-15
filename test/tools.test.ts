import { describe, expect, it } from "vitest";
import { schemas, tools, type ToolContext } from "../src/mcp/tools.js";
import type { CheckoutGateway } from "../src/adyen/gateway.js";
import type { Finding } from "../src/audit/types.js";

const findings: Finding[] = [
  { id: "EDGE-CHALLENGE", title: "edge", severity: "high", surface: "robots", agentImpact: "", metrics: {}, evidence: [], recommendation: "" },
  { id: "LLMS-INDEX", title: "index", severity: "low", surface: "llms.txt", agentImpact: "", metrics: {}, evidence: [], recommendation: "" },
];

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    testCards: [
      { brand: "Visa", number: "4111111111111111", variant: "Consumer", country: "NL", expiry: "03/2030", cvc: "737", threeDS2: false },
      { brand: "Mastercard", number: "5555555555554444", variant: "Credit", country: "GB", expiry: "03/2030", cvc: "737", threeDS2: false },
      { brand: "3D Secure 2", number: "4917610000000000", variant: "Visa", expiry: "03/2030", cvc: "737", threeDS2: true },
    ],
    llmsIndex: [
      { section: "Online payments", title: "Sessions flow integration guide", url: "https://docs.adyen.com/online-payments/build-your-integration/sessions-flow.md", description: "Start accepting payments.", line: 1 },
      { section: "Online payments", title: "Webhooks", url: "https://docs.adyen.com/development-resources/webhooks.md", description: "Receive notifications.", line: 2 },
    ],
    findings,
    fetchMarkdown: async () => ({ status: 200, body: "# Sessions flow\n\n" + "x".repeat(50_000) }),
    ...overrides,
  };
}

function fakeGateway(): CheckoutGateway & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    merchantAccount: "TestMerchant",
    environment: "TEST",
    async paymentMethods() {
      calls.push("paymentMethods");
      return { paymentMethods: [{ type: "scheme", name: "Cards" }] } as never;
    },
    async sessions(req) {
      calls.push("sessions");
      return { id: "CS1", sessionData: "data", amount: req.amount, reference: req.reference } as never;
    },
    async getSession() {
      calls.push("getSession");
      return { id: "CS1", status: "completed" } as never;
    },
    async payments(req) {
      calls.push("payments");
      return { resultCode: "Authorised", pspReference: "PSP1", amount: req.amount } as never;
    },
    async paymentsDetails() {
      calls.push("paymentsDetails");
      return { resultCode: "Authorised", pspReference: "PSP2" } as never;
    },
  };
}

describe("tools without credentials", () => {
  it("API tools return a clear isError result instead of throwing", async () => {
    const r = await tools.adyen_list_payment_methods(ctx({ gatewayError: "ADYEN_API_KEY is not set." }), schemas.listPaymentMethods.parse({ countryCode: "NL" }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/ADYEN_API_KEY/);
    expect(r.content[0].text).toMatch(/adyen\.com\/signup/);
  });

  it("test-card catalogue filters by brand, country and 3DS2", async () => {
    const visa = await tools.adyen_test_cards(ctx(), schemas.testCards.parse({ brand: "visa" }));
    expect(JSON.parse(visa.content[0].text).total).toBe(2);
    const gb = await tools.adyen_test_cards(ctx(), schemas.testCards.parse({ country: "gb" }));
    expect(JSON.parse(gb.content[0].text).cards[0].number).toBe("5555555555554444");
    const tds = await tools.adyen_test_cards(ctx(), schemas.testCards.parse({ threeDS2: true }));
    expect(JSON.parse(tds.content[0].text).cards).toHaveLength(1);
  });

  it("docs lookup ranks title matches first and trims fetched pages", async () => {
    const r = await tools.adyen_docs_lookup(ctx(), schemas.docsLookup.parse({ query: "sessions flow", fetch: true, maxChars: 500 }));
    const body = JSON.parse(r.content[0].text);
    expect(body.matches[0].url).toMatch(/sessions-flow\.md$/);
    expect(body.page.trimmed).toBe(true);
    expect(body.page.markdown.length).toBeLessThan(600);
  });

  it("docs lookup explains a Cloudflare challenge instead of returning HTML", async () => {
    const r = await tools.adyen_docs_lookup(ctx({ fetchMarkdown: async () => ({ status: 429, body: "<html>Just a moment" }) }), schemas.docsLookup.parse({ query: "webhooks", fetch: true }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/EDGE-CHALLENGE/);
  });

  it("audit findings summary and by id", async () => {
    const all = await tools.adyen_audit_findings(ctx(), schemas.auditFindings.parse({}));
    expect(JSON.parse(all.content[0].text).count).toBe(2);
    const high = await tools.adyen_audit_findings(ctx(), schemas.auditFindings.parse({ severity: "high" }));
    expect(JSON.parse(high.content[0].text).findings[0].id).toBe("EDGE-CHALLENGE");
    const one = await tools.adyen_audit_findings(ctx(), schemas.auditFindings.parse({ id: "llms-index" }));
    expect(JSON.parse(one.content[0].text).id).toBe("LLMS-INDEX");
    const missing = await tools.adyen_audit_findings(ctx(), schemas.auditFindings.parse({ id: "NOPE" }));
    expect(missing.isError).toBe(true);
  });
});

describe("tools with a gateway", () => {
  it("create_session injects the merchant account and returns Drop-in inputs", async () => {
    const gw = fakeGateway();
    const r = await tools.adyen_create_session(
      ctx({ gateway: gw }),
      schemas.createSession.parse({ amount: { currency: "EUR", value: 1000 }, reference: "ORDER-1", returnUrl: "https://example.com/r", countryCode: "NL" }),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.id).toBe("CS1");
    expect(body.sessionData).toBe("data");
    expect(gw.calls).toEqual(["sessions"]);
  });

  it("create_payment flags whether the PAN is a known test card", async () => {
    const gw = fakeGateway();
    const input = schemas.createPayment.parse({
      amount: { currency: "EUR", value: 1000 },
      reference: "ORDER-2",
      returnUrl: "https://example.com/r",
      card: { number: "4111111111111111", expiryMonth: "03", expiryYear: "2030", cvc: "737" },
    });
    const r = await tools.adyen_create_payment(ctx({ gateway: gw }), input);
    const body = JSON.parse(r.content[0].text);
    expect(body.resultCode).toBe("Authorised");
    expect(body.knownTestCard).toBe(true);
    const unknown = await tools.adyen_create_payment(ctx({ gateway: gw }), { ...input, card: { ...input.card, number: "4000000000000002" } });
    expect(JSON.parse(unknown.content[0].text).knownTestCard).toBe(false);
  });

  it("create_payment refuses raw card data outside TEST", async () => {
    const gw = { ...fakeGateway(), environment: "LIVE" as const };
    const r = await tools.adyen_create_payment(
      ctx({ gateway: gw }),
      schemas.createPayment.parse({ amount: { currency: "EUR", value: 1 }, reference: "x", returnUrl: "https://e.com", card: { number: "4111111111111111", expiryMonth: "03", expiryYear: "2030" } }),
    );
    expect(r.isError).toBe(true);
  });

  it("API errors are returned with the Adyen error body", async () => {
    const gw = fakeGateway();
    gw.paymentMethods = async () => {
      const err = new Error("HTTP Exception: 403") as Error & { statusCode: number; responseBody: string };
      err.statusCode = 403;
      err.responseBody = JSON.stringify({ errorCode: "901", message: "Invalid Merchant Account" });
      throw err;
    };
    const r = await tools.adyen_list_payment_methods(ctx({ gateway: gw }), schemas.listPaymentMethods.parse({ countryCode: "NL" }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/HTTP 403/);
    expect(r.content[0].text).toMatch(/Invalid Merchant Account/);
  });

  it("input schemas reject malformed arguments", () => {
    expect(() => schemas.createSession.parse({ amount: { currency: "EURO", value: 1 }, reference: "r", returnUrl: "nope", countryCode: "NL" })).toThrow();
    expect(() => schemas.createPayment.parse({ amount: { currency: "EUR", value: 1 }, reference: "r", returnUrl: "https://e.com", card: { number: "4111 1111", expiryMonth: "3", expiryYear: "30" } })).toThrow();
  });
});
