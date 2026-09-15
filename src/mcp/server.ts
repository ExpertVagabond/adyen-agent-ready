#!/usr/bin/env node
/**
 * adyen-agent-ready MCP server (stdio).
 *
 *   ADYEN_API_KEY=... ADYEN_MERCHANT_ACCOUNT=... npx adyen-agent-ready-mcp
 *
 * Tools that call the Adyen TEST API need credentials; the docs, test-card
 * and audit tools work without them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { configFromEnv, createGateway } from "../adyen/gateway.js";
import { USER_AGENT } from "../audit/fetch.js";
import { loadData, toolDescriptions, tools, type ToolContext, type ToolName } from "./tools.js";

export async function buildContext(): Promise<ToolContext> {
  const data = await loadData();
  let gateway: ToolContext["gateway"];
  let gatewayError: string | undefined;
  try {
    gateway = createGateway(configFromEnv());
  } catch (err) {
    gatewayError = err instanceof Error ? err.message : String(err);
  }
  return {
    ...data,
    gateway,
    gatewayError,
    fetchMarkdown: async (url) => {
      const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/markdown, text/plain" } });
      return { status: res.status, body: await res.text() };
    },
  };
}

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "adyen-agent-ready", version: "0.1.0" });
  for (const name of Object.keys(tools) as ToolName[]) {
    const meta = toolDescriptions[name];
    const shape = (meta.schema as z.ZodObject<z.ZodRawShape>).shape;
    server.registerTool(
      name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: shape,
        annotations: { readOnlyHint: meta.readOnly, destructiveHint: false, openWorldHint: !meta.readOnly || name === "adyen_docs_lookup" },
      },
      async (args: Record<string, unknown>) => {
        const parsed = meta.schema.parse(args);
        return tools[name](ctx, parsed as never);
      },
    );
  }
  return server;
}

async function main(): Promise<void> {
  const ctx = await buildContext();
  if (ctx.gatewayError) console.error(`[adyen-agent-ready] API tools disabled: ${ctx.gatewayError}`);
  else console.error(`[adyen-agent-ready] Adyen ${ctx.gateway!.environment} gateway ready for merchant ${ctx.gateway!.merchantAccount}`);
  const server = buildServer(ctx);
  await server.connect(new StdioServerTransport());
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
