#!/usr/bin/env node
/**
 * Smoke test against the real Adyen TEST environment.
 *
 *   ADYEN_API_KEY=... ADYEN_MERCHANT_ACCOUNT=... npm run smoke
 *
 * 1. POST /paymentMethods for NL
 * 2. POST /sessions for EUR 10.00
 * 3. POST /payments with the Visa 4111 1111 1111 1111 test card (needs the
 *    "API PCI Payments role" on the web service user; step 3 is reported as
 *    SKIPPED, not failed, when the API refuses raw card data)
 *
 * Exit code 0 only when steps 1 and 2 succeed. No credentials are printed.
 */
import { configFromEnv, createGateway } from "../src/adyen/gateway.js";
import { schemas, tools, type ToolContext } from "../src/mcp/tools.js";
import { loadData } from "../src/mcp/tools.js";

async function main(): Promise<void> {
  const config = configFromEnv();
  const gateway = createGateway(config);
  const data = await loadData();
  const ctx: ToolContext = { ...data, gateway, fetchMarkdown: async () => ({ status: 0, body: "" }) };
  const ref = `smoke-${Date.now()}`;
  let failures = 0;

  const step = async (name: string, fn: () => Promise<{ isError?: boolean; content: { text: string }[] }>, optional = false): Promise<void> => {
    const r = await fn();
    const text = r.content[0].text;
    if (r.isError) {
      if (optional && /PCI|not allowed|917|Merchant Account.*not allowed/i.test(text)) {
        console.log(`SKIPPED ${name}: ${text.split("\n")[0]}`);
        return;
      }
      failures++;
      console.log(`FAIL    ${name}: ${text.split("\n")[0]}`);
      return;
    }
    console.log(`OK      ${name}: ${text.split("\n").slice(0, 4).join(" ").slice(0, 160)}`);
  };

  console.log(`Environment ${config.environment}, merchant ${config.merchantAccount}, reference ${ref}`);
  await step("POST /paymentMethods", () => tools.adyen_list_payment_methods(ctx, schemas.listPaymentMethods.parse({ countryCode: "NL", amount: { currency: "EUR", value: 1000 } })));
  await step("POST /sessions", () =>
    tools.adyen_create_session(ctx, schemas.createSession.parse({ amount: { currency: "EUR", value: 1000 }, reference: ref, returnUrl: "https://example.com/return", countryCode: "NL" })),
  );
  await step(
    "POST /payments (Visa test card)",
    () =>
      tools.adyen_create_payment(
        ctx,
        schemas.createPayment.parse({
          amount: { currency: "EUR", value: 1000 },
          reference: `${ref}-card`,
          returnUrl: "https://example.com/return",
          countryCode: "NL",
          card: { number: "4111111111111111", expiryMonth: "03", expiryYear: "2030", cvc: "737", holderName: "Smoke Test" },
        }),
      ),
    true,
  );
  console.log(failures ? `${failures} step(s) failed` : "smoke passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
