/**
 * OpenAPI helpers: load the Adyen Checkout spec, list endpoints, resolve
 * request schemas, and compare docs examples / API Explorer links / the
 * official MCP tool list against the spec.
 */

export interface Endpoint {
  method: string;
  path: string;
  requestSchema?: string;
}

export interface SchemaShape {
  name: string;
  required: string[];
  properties: string[];
}

export interface OpenApiDoc {
  info: { version: string; title?: string };
  paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> } }>>;
  components?: { schemas?: Record<string, SchemaNode> };
}

interface SchemaNode {
  required?: string[];
  properties?: Record<string, unknown>;
  allOf?: SchemaNode[];
  $ref?: string;
}

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export function listEndpoints(spec: OpenApiDoc): Endpoint[] {
  const out: Endpoint[] = [];
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!METHODS.has(method)) continue;
      const ref = op.requestBody?.content?.["application/json"]?.schema?.$ref;
      out.push({ method: method.toUpperCase(), path, requestSchema: ref ? ref.split("/").pop() : undefined });
    }
  }
  return out;
}

export function resolveSchema(spec: OpenApiDoc, name: string): SchemaShape | undefined {
  const node = spec.components?.schemas?.[name];
  if (!node) return undefined;
  const required = new Set<string>();
  const properties = new Set<string>();
  const visit = (n: SchemaNode | undefined): void => {
    if (!n) return;
    if (n.$ref) visit(spec.components?.schemas?.[n.$ref.split("/").pop() ?? ""]);
    for (const r of n.required ?? []) required.add(r);
    for (const p of Object.keys(n.properties ?? {})) properties.add(p);
    for (const a of n.allOf ?? []) visit(a);
  };
  visit(node);
  return { name, required: [...required], properties: [...properties] };
}

/**
 * Normalise an API Explorer path segment to an OpenAPI path.
 *   post/payments/(paymentPspReference)/refunds  ->  POST /payments/{paymentPspReference}/refunds
 */
export function explorerLinkToEndpoint(link: string): { service: string; version: string; method: string; path: string } | undefined {
  const unescaped = link.replace(/\\([()])/g, "$1");
  const m = /api-explorer\/([A-Za-z]+)\/([a-z0-9]+)\/(get|post|put|patch|delete)\/(.+?)(?:[#?].*)?$/.exec(unescaped);
  if (!m) return undefined;
  const path =
    "/" +
    m[4]
      .replace(/\(([^)]+)\)/g, "{$1}")
      .replace(/(^|\/)_([A-Za-z]+)_(?=\/|$)/g, "$1{$2}")
      .replace(/\/$/, "");
  return { service: m[1], version: m[2], method: m[3].toUpperCase(), path };
}

export interface ExampleCheck {
  url: string;
  line: number;
  endpoint: string;
  missingRequired: string[];
  unknownProperties: string[];
}

/**
 * Validate a docs JSON request example against the spec schema for the
 * endpoint it documents. Only top-level keys are checked; nested objects are
 * out of scope for this pass.
 */
export function checkExample(
  spec: OpenApiDoc,
  endpoint: Endpoint,
  example: Record<string, unknown>,
  where: { url: string; line: number },
): ExampleCheck | undefined {
  if (!endpoint.requestSchema) return undefined;
  const shape = resolveSchema(spec, endpoint.requestSchema);
  if (!shape) return undefined;
  const keys = Object.keys(example);
  const missingRequired = shape.required.filter((r) => !keys.includes(r));
  const known = new Set(shape.properties);
  const unknownProperties = keys.filter((k) => !known.has(k));
  return { url: where.url, line: where.line, endpoint: `${endpoint.method} ${endpoint.path}`, missingRequired, unknownProperties };
}

/** Pull the `METHOD [`/path`]` tool list out of the official adyen-mcp README. */
export function parseOfficialMcpReadme(readme: string): { method: string; path: string; service: string }[] {
  const out: { method: string; path: string; service: string }[] = [];
  const re = /(GET|POST|PATCH|PUT|DELETE)\s+\[`\/?([^`]+)`\]\(https?:\/\/docs\.adyen\.com\/api-explorer\/([A-Za-z]+)\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(readme)) !== null) {
    out.push({ method: m[1], path: "/" + m[2].replace(/^\//, ""), service: m[3] });
  }
  return out;
}

const CHECKOUT_PATHS = new Set([
  "/sessions",
  "/payments",
  "/payments/details",
  "/paymentMethods",
  "/paymentMethods/balance",
  "/paymentLinks",
  "/orders",
  "/orders/cancel",
  "/donations",
  "/storedPaymentMethods",
  "/cardDetails",
  "/payments/{paymentPspReference}/captures",
  "/payments/{paymentPspReference}/refunds",
  "/payments/{paymentPspReference}/cancels",
  "/payments/{paymentPspReference}/reversals",
  "/payments/{paymentPspReference}/amountUpdates",
]);

/**
 * Guess which endpoint a code block documents from the prose that precedes it.
 * Only explicit references count: an API Explorer link or a checkout(-test)
 * endpoint URL. The most recent reference wins; when it points at another
 * service (Recurring, Payment, Management...) the block is not a Checkout
 * example and undefined is returned.
 */
export function guessEndpointFromContext(context: string): string | undefined {
  // A bold label such as **/payments request** or **/capture request** right before the block is authoritative.
  const lastLine = context.trimEnd().split("\n").pop() ?? "";
  const label = /\*\*\s*(\/[A-Za-z/{}()]+)\s+(?:request|response)\s*\*\*/.exec(lastLine);
  if (label) {
    const path = label[1].replace(/\(([^)]+)\)/g, "{$1}");
    return CHECKOUT_PATHS.has(path) ? path : undefined;
  }
  // Links inside table cells describe fields, not the request the block documents.
  context = context
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("|"))
    .join("\n");
  const refs: { idx: number; service: string; path: string }[] = [];
  const explorer = /api-explorer\/([A-Za-z]+)\/[a-z0-9]+\/(?:get|post|put|patch|delete)\/((?:\\[()]|[^)\s#?"'>])+)/g;
  let m: RegExpExecArray | null;
  while ((m = explorer.exec(context)) !== null) {
    refs.push({ idx: m.index, service: m[1], path: "/" + m[2].replace(/\\([()])/g, "$1").replace(/\(([^)]+)\)/g, "{$1}").replace(/\/$/, "") });
  }
  const url = /https?:\/\/(checkout(?:-test)?|pal-test|pal-live|[a-z0-9-]+-live)\.adyen\.com\/(?:[a-z]+\/)?v\d+\/([A-Za-z/{}]+)/g;
  while ((m = url.exec(context)) !== null) {
    refs.push({ idx: m.index, service: m[1].startsWith("checkout") ? "Checkout" : "Other", path: "/" + m[2].replace(/\/$/, "") });
  }
  if (refs.length === 0) return undefined;
  const last = refs.sort((a, b) => a.idx - b.idx)[refs.length - 1];
  return last.service === "Checkout" ? last.path : undefined;
}
