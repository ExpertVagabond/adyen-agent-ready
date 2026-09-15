import { describe, expect, it } from "vitest";
import { configFromEnv, ConfigError, createGateway, type HttpClientLike } from "../src/adyen/gateway.js";

/** Records every request the SDK makes and answers from a canned map. */
function fakeHttp(answers: Record<string, unknown>): HttpClientLike & { calls: { endpoint: string; body: unknown; apiKey?: string; idem?: string }[] } {
  const calls: { endpoint: string; body: unknown; apiKey?: string; idem?: string }[] = [];
  return {
    calls,
    async request(endpoint, json, config, _isApiKeyRequired, requestOptions) {
      calls.push({ endpoint, body: json ? JSON.parse(json.toString()) : undefined, apiKey: config.apiKey, idem: requestOptions?.idempotencyKey });
      const key = Object.keys(answers).find((k) => endpoint.endsWith(k));
      if (!key) throw new Error(`unexpected endpoint ${endpoint}`);
      return JSON.stringify(answers[key]);
    },
  };
}

const env = { ADYEN_API_KEY: "test_key", ADYEN_MERCHANT_ACCOUNT: "TestMerchant" };

describe("configFromEnv", () => {
  it("defaults to TEST and reads the two required variables", () => {
    const c = configFromEnv(env);
    expect(c.environment).toBe("TEST");
    expect(c.apiKey).toBe("test_key");
    expect(c.merchantAccount).toBe("TestMerchant");
  });
  it("refuses to start without an API key", () => {
    expect(() => configFromEnv({ ADYEN_MERCHANT_ACCOUNT: "x" })).toThrow(ConfigError);
  });
  it("refuses LIVE unless explicitly allowed", () => {
    expect(() => configFromEnv({ ...env, ADYEN_ENVIRONMENT: "LIVE" })).toThrow(/refused/);
    expect(() => configFromEnv({ ...env, ADYEN_ENVIRONMENT: "LIVE", ADYEN_ALLOW_LIVE: "1" })).toThrow(/ADYEN_LIVE_PREFIX/);
    expect(configFromEnv({ ...env, ADYEN_ENVIRONMENT: "LIVE", ADYEN_ALLOW_LIVE: "1", ADYEN_LIVE_PREFIX: "abc-Company" }).environment).toBe("LIVE");
  });
});

describe("createGateway over the SDK with mocked HTTP", () => {
  it("POST /paymentMethods hits the v72 TEST endpoint with the API key", async () => {
    const http = fakeHttp({ "/paymentMethods": { paymentMethods: [{ type: "scheme", name: "Cards", brands: ["visa", "mc"] }] } });
    const gw = createGateway(configFromEnv(env), http);
    const res = await gw.paymentMethods({ merchantAccount: gw.merchantAccount, countryCode: "NL" });
    expect(res.paymentMethods?.[0].type).toBe("scheme");
    expect(http.calls[0].endpoint).toBe("https://checkout-test.adyen.com/v72/paymentMethods");
    expect(http.calls[0].apiKey).toBe("test_key");
    expect(http.calls[0].body).toMatchObject({ merchantAccount: "TestMerchant", countryCode: "NL" });
  });

  it("POST /sessions forwards the idempotency key and returns id + sessionData", async () => {
    const http = fakeHttp({ "/sessions": { id: "CS123", sessionData: "Ab02b4c..", expiresAt: "2030-01-01T00:00:00Z" } });
    const gw = createGateway(configFromEnv(env), http);
    const res = await gw.sessions(
      { merchantAccount: "TestMerchant", amount: { currency: "EUR", value: 1000 }, reference: "ORDER-1", returnUrl: "https://example.com/return" },
      "idem-1",
    );
    expect(res.id).toBe("CS123");
    expect(http.calls[0].idem).toBe("idem-1");
    expect(http.calls[0].endpoint).toMatch(/\/v72\/sessions$/);
  });

  it("POST /payments sends scheme card data and surfaces the resultCode", async () => {
    const http = fakeHttp({ "/payments": { resultCode: "Authorised", pspReference: "8815" } });
    const gw = createGateway(configFromEnv(env), http);
    const res = await gw.payments({
      merchantAccount: "TestMerchant",
      amount: { currency: "EUR", value: 1000 },
      reference: "ORDER-2",
      returnUrl: "https://example.com/return",
      paymentMethod: { type: "scheme", number: "4111111111111111", expiryMonth: "03", expiryYear: "2030", cvc: "737" } as never,
    });
    expect(res.resultCode).toBe("Authorised");
    expect((http.calls[0].body as { paymentMethod: { number: string } }).paymentMethod.number).toBe("4111111111111111");
  });

  it("propagates API errors from the HTTP layer", async () => {
    const http: HttpClientLike = {
      async request() {
        const err = new Error("HTTP Exception: 422. Unprocessable Entity") as Error & { statusCode: number; responseBody: string };
        err.statusCode = 422;
        err.responseBody = JSON.stringify({ status: 422, errorCode: "130", message: "Required field 'reference' is not provided." });
        throw err;
      },
    };
    const gw = createGateway(configFromEnv(env), http);
    await expect(gw.paymentMethods({ merchantAccount: "TestMerchant" })).rejects.toMatchObject({ statusCode: 422 });
  });
});
