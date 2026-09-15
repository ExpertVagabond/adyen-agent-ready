/**
 * Render an llms.txt-style Markdown reference for the Adyen Checkout API from
 * its OpenAPI document. This is the artifact finding REFERENCE-NOT-INDEXED
 * asks for: one Markdown block per operation, with the request schema's
 * required and optional top-level fields, so an agent can read the reference
 * without executing the API Explorer's JavaScript.
 */
import { listEndpoints, resolveSchema, type OpenApiDoc } from "./openapi.js";

interface PropNode {
  type?: string;
  description?: string;
  $ref?: string;
  items?: { $ref?: string; type?: string };
  enum?: string[];
  maxLength?: number;
}

interface OperationNode {
  summary?: string;
  description?: string;
  operationId?: string;
  "x-methodName"?: string;
  responses?: Record<string, { description?: string }>;
  parameters?: { name: string; in: string; required?: boolean; description?: string }[];
}

function firstSentence(s: string | undefined): string {
  if (!s) return "";
  const cleaned = s.replace(/\s+/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(cleaned);
  return (m ? m[1] : cleaned).slice(0, 220);
}

function typeOf(p: PropNode): string {
  if (p.$ref) return p.$ref.split("/").pop() ?? "object";
  if (p.type === "array") return `${p.items?.$ref ? p.items.$ref.split("/").pop() : p.items?.type ?? "any"}[]`;
  if (p.enum) return `enum(${p.enum.slice(0, 6).join("|")}${p.enum.length > 6 ? "|…" : ""})`;
  return p.type ?? "object";
}

export function renderLlmsCheckout(spec: OpenApiDoc, version: string): string {
  const out: string[] = [];
  out.push(`# Adyen Checkout API v${version}`);
  out.push("");
  out.push(`> Machine-readable reference for the Adyen Checkout API, generated from https://github.com/Adyen/adyen-openapi/blob/main/json/CheckoutService-v${version}.json by adyen-agent-ready. Base URL (test): https://checkout-test.adyen.com/v${version}. Authentication: \`X-API-Key\` header. Every operation below lists the required request fields first.`);
  out.push("");
  out.push("Related guides: https://docs.adyen.com/online-payments/build-your-integration/sessions-flow.md (Sessions flow), https://docs.adyen.com/online-payments/build-your-integration/advanced-flow.md (Advanced flow), https://docs.adyen.com/development-resources/test-cards-and-credentials/test-card-numbers.md (test cards).");
  out.push("");

  const paths = spec.paths as Record<string, Record<string, OperationNode>>;
  for (const ep of listEndpoints(spec)) {
    const op = paths[ep.path]?.[ep.method.toLowerCase()];
    out.push(`## ${ep.method} ${ep.path}`);
    out.push("");
    if (op?.summary) out.push(`${op.summary}. ${firstSentence(op.description)}`.trim());
    const explorerPath = ep.path.replace(/\{([^}]+)\}/g, "($1)");
    out.push("");
    out.push(`- Reference: https://docs.adyen.com/api-explorer/Checkout/${version}/${ep.method.toLowerCase()}${explorerPath}`);
    const pathParams = (op?.parameters ?? []).filter((p) => p.in === "path");
    if (pathParams.length) out.push(`- Path parameters: ${pathParams.map((p) => `\`${p.name}\` (${firstSentence(p.description) || "string"})`).join("; ")}`);
    if (ep.requestSchema) {
      const shape = resolveSchema(spec, ep.requestSchema);
      const schemaNode = spec.components?.schemas?.[ep.requestSchema] as { properties?: Record<string, PropNode> } | undefined;
      const props = schemaNode?.properties ?? {};
      if (shape) {
        out.push(`- Request body: \`${ep.requestSchema}\``);
        if (shape.required.length) {
          out.push(`- Required: ${shape.required.map((r) => `\`${r}\` (${typeOf(props[r] ?? {})})`).join(", ")}`);
        } else {
          out.push("- Required: none");
        }
        const optional = shape.properties.filter((p) => !shape.required.includes(p));
        if (optional.length) {
          out.push(`- Optional (${optional.length}): ${optional.map((p) => `\`${p}\``).join(", ")}`);
        }
        const described = shape.required.map((r) => ({ name: r, node: props[r] })).filter((x) => x.node?.description);
        if (described.length) {
          out.push("- Field notes:");
          for (const { name, node } of described) out.push(`  - \`${name}\`: ${firstSentence(node!.description)}`);
        }
      }
    } else {
      out.push("- Request body: none");
    }
    const responses = Object.entries(op?.responses ?? {})
      .map(([code, r]) => `${code} ${firstSentence(r.description)}`)
      .slice(0, 6);
    if (responses.length) out.push(`- Responses: ${responses.join("; ")}`);
    out.push("");
  }
  return out.join("\n");
}
