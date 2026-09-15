export type Severity = "high" | "medium" | "low" | "info";

export interface Evidence {
  /** Absolute URL the evidence was taken from. */
  url: string;
  /** One-line human-readable observation. */
  note: string;
}

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  /** Which developer surface the finding concerns. */
  surface: "llms.txt" | "llms-full.txt" | "docs.md" | "snippets" | "openapi" | "robots" | "mcp";
  /** Why an agent (not just a human) is misled by this. */
  agentImpact: string;
  /** Numbers that back the finding, e.g. counts. */
  metrics: Record<string, number | string>;
  evidence: Evidence[];
  recommendation: string;
}

export interface LlmsEntry {
  section: string;
  title: string;
  url: string;
  description: string;
  line: number;
}

export interface PageRecord {
  url: string;
  status: number;
  contentType: string;
  finalUrl: string;
  bytes: number;
  lastModifiedHeader?: string;
  etag?: string;
  retryAfter?: string;
  /** Cloudflare's `cf-mitigated` header, e.g. "challenge" when a JS challenge page was served. */
  cfMitigated?: string;
  fetchedAt?: string;
  /** Path of the cached body, or undefined when fetch failed. */
  cachePath?: string;
  error?: string;
}

export interface CodeBlock {
  lang: string;
  code: string;
  /** 1-based line of the opening fence. */
  line: number;
  /** Up to 12 prose lines preceding the fence, used to infer which endpoint the block documents. */
  context: string;
}

export interface PageAnalysis {
  url: string;
  title: string;
  lastModified?: string;
  bytes: number;
  approxTokens: number;
  codeBlocks: CodeBlock[];
  unlabelledFences: number;
  unclosedFence: boolean;
  relativeLinks: string[];
  absoluteDocsLinks: string[];
  externalLinks: string[];
  htmlTags: number;
  templateMarkers: number;
  checkoutVersions: Record<string, number>;
  apiExplorerLinks: string[];
}

export interface AuditReport {
  generatedAt: string;
  source: {
    llmsTxt: string;
    llmsFullTxt: string;
    sitemap: string;
    robots: string;
    openapiRepo: string;
    officialMcpReadme: string;
  };
  totals: Record<string, number | string>;
  findings: Finding[];
}
