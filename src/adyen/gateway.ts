/**
 * Thin wrapper over @adyen/api-library for the Checkout API.
 *
 * Credentials come from the environment only (never from tool arguments):
 *   ADYEN_API_KEY           X-API-Key of a web service user (TEST)
 *   ADYEN_MERCHANT_ACCOUNT  merchant account code
 *   ADYEN_ENVIRONMENT       TEST (default). LIVE is refused unless ADYEN_ALLOW_LIVE=1.
 *   ADYEN_LIVE_PREFIX       live URL prefix (only when LIVE is allowed)
 */
import { Client, CheckoutAPI, EnvironmentEnum, Types } from "@adyen/api-library";
import type { Config } from "@adyen/api-library";
import type { IRequest } from "@adyen/api-library/lib/src/typings/requestOptions.js";

/** Mirror of the SDK's ClientInterface (not exported from the package root). */
export interface HttpClientLike {
  request(endpoint: string, json: string | Buffer, config: Config, isApiKeyRequired: boolean, requestOptions?: IRequest.Options): Promise<string>;
}

export type PaymentMethodsRequest = Types.checkout.PaymentMethodsRequest;
export type PaymentMethodsResponse = Types.checkout.PaymentMethodsResponse;
export type CreateCheckoutSessionRequest = Types.checkout.CreateCheckoutSessionRequest;
export type CreateCheckoutSessionResponse = Types.checkout.CreateCheckoutSessionResponse;
export type PaymentRequest = Types.checkout.PaymentRequest;
export type PaymentResponse = Types.checkout.PaymentResponse;
export type PaymentDetailsRequest = Types.checkout.PaymentDetailsRequest;
export type PaymentDetailsResponse = Types.checkout.PaymentDetailsResponse;

export interface AdyenConfig {
  apiKey: string;
  merchantAccount: string;
  environment: "TEST" | "LIVE";
  livePrefix?: string;
}

export class ConfigError extends Error {}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AdyenConfig {
  const apiKey = env.ADYEN_API_KEY?.trim();
  const merchantAccount = env.ADYEN_MERCHANT_ACCOUNT?.trim();
  const environment = (env.ADYEN_ENVIRONMENT?.trim().toUpperCase() || "TEST") as "TEST" | "LIVE";
  if (!apiKey) throw new ConfigError("ADYEN_API_KEY is not set. Create a TEST web service user in the Customer Area and export its API key.");
  if (!merchantAccount) throw new ConfigError("ADYEN_MERCHANT_ACCOUNT is not set.");
  if (environment !== "TEST" && environment !== "LIVE") throw new ConfigError("ADYEN_ENVIRONMENT must be TEST or LIVE.");
  if (environment === "LIVE" && env.ADYEN_ALLOW_LIVE !== "1") {
    throw new ConfigError("ADYEN_ENVIRONMENT=LIVE refused: this server is built for the TEST environment. Set ADYEN_ALLOW_LIVE=1 to override.");
  }
  if (environment === "LIVE" && !env.ADYEN_LIVE_PREFIX) throw new ConfigError("ADYEN_LIVE_PREFIX is required for LIVE.");
  return { apiKey, merchantAccount, environment, livePrefix: env.ADYEN_LIVE_PREFIX };
}

/** The subset of the Checkout API this server exposes. Mockable in tests. */
export interface CheckoutGateway {
  readonly merchantAccount: string;
  readonly environment: "TEST" | "LIVE";
  paymentMethods(req: PaymentMethodsRequest, idempotencyKey?: string): Promise<PaymentMethodsResponse>;
  sessions(req: CreateCheckoutSessionRequest, idempotencyKey?: string): Promise<CreateCheckoutSessionResponse>;
  getSession(sessionId: string, sessionResult: string): Promise<Types.checkout.SessionResultResponse>;
  payments(req: PaymentRequest, idempotencyKey?: string): Promise<PaymentResponse>;
  paymentsDetails(req: PaymentDetailsRequest, idempotencyKey?: string): Promise<PaymentDetailsResponse>;
}

/**
 * Build a gateway over the real SDK. Pass `httpClient` to route HTTP through a
 * fake (tests) instead of the network.
 */
export function createGateway(config: AdyenConfig, httpClient?: HttpClientLike): CheckoutGateway {
  const client = new Client(
    {
      apiKey: config.apiKey,
      environment: config.environment === "LIVE" ? EnvironmentEnum.LIVE : EnvironmentEnum.TEST,
      liveEndpointUrlPrefix: config.livePrefix,
      applicationName: "adyen-agent-ready",
    },
    httpClient as ConstructorParameters<typeof Client>[1],
  );
  const checkout = new CheckoutAPI(client);
  const opts = (idempotencyKey?: string) => (idempotencyKey ? { idempotencyKey } : undefined);
  return {
    merchantAccount: config.merchantAccount,
    environment: config.environment,
    paymentMethods: (req, k) => checkout.PaymentsApi.paymentMethods(req, opts(k)),
    sessions: (req, k) => checkout.PaymentsApi.sessions(req, opts(k)),
    getSession: (sessionId, sessionResult) => checkout.PaymentsApi.getResultOfPaymentSession(sessionId, sessionResult),
    payments: (req, k) => checkout.PaymentsApi.payments(req, opts(k)),
    paymentsDetails: (req, k) => checkout.PaymentsApi.paymentsDetails(req, opts(k)),
  };
}
