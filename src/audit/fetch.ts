import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PageRecord } from "./types.js";

export const USER_AGENT =
  "adyen-agent-ready-audit/0.1 (+https://github.com/ExpertVagabond/adyen-agent-ready; agent-legibility audit)";

export interface FetchOptions {
  cacheDir: string;
  concurrency?: number;
  offline?: boolean;
  timeoutMs?: number;
  /** Pause between requests on each worker (politeness). */
  delayMs?: number;
  /** How many times to retry a 429 / 503 with exponential backoff (30s, 60s, 120s). */
  retries?: number;
  onProgress?: (done: number, total: number) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function cacheKey(url: string): string {
  return createHash("sha1").update(url).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch one URL with a timeout, write the body and a small metadata sidecar
 * into the cache directory, and return the record. In offline mode only the
 * cache is consulted.
 */
export async function fetchCached(url: string, opts: FetchOptions): Promise<PageRecord> {
  await mkdir(opts.cacheDir, { recursive: true });
  const key = cacheKey(url);
  const bodyPath = join(opts.cacheDir, `${key}.body`);
  const metaPath = join(opts.cacheDir, `${key}.json`);

  if (await exists(metaPath)) {
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as PageRecord;
    if (opts.offline || meta.status === 200) return meta;
  }
  if (opts.offline) {
    return { url, status: 0, contentType: "", finalUrl: url, bytes: 0, error: "not in cache (offline)" };
  }

  const retries = opts.retries ?? 3;
  let rec: PageRecord | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    rec = await fetchOnce(url, bodyPath, opts.timeoutMs ?? 30_000);
    if (rec.status !== 429 && rec.status !== 503) break;
    if (attempt < retries) await sleep(30_000 * 2 ** attempt);
  }
  await writeFile(metaPath, JSON.stringify(rec));
  if (opts.delayMs) await sleep(opts.delayMs);
  return rec!;
}

async function fetchOnce(url: string, bodyPath: string, timeoutMs: number): Promise<PageRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" },
      redirect: "follow",
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const rec: PageRecord = {
      url,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      finalUrl: res.url || url,
      bytes: buf.byteLength,
      lastModifiedHeader: res.headers.get("last-modified") ?? undefined,
      etag: res.headers.get("etag") ?? undefined,
      retryAfter: res.headers.get("retry-after") ?? undefined,
      cfMitigated: res.headers.get("cf-mitigated") ?? undefined,
      fetchedAt: new Date().toISOString(),
      cachePath: bodyPath,
    };
    await writeFile(bodyPath, buf);
    return rec;
  } catch (err) {
    return {
      url,
      status: 0,
      contentType: "",
      finalUrl: url,
      bytes: 0,
      fetchedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded-concurrency map over URLs. Order of results matches input order. */
export async function fetchAll(urls: string[], opts: FetchOptions): Promise<PageRecord[]> {
  const limit = Math.max(1, opts.concurrency ?? 4);
  const results: PageRecord[] = new Array(urls.length);
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= urls.length) return;
      results[i] = await fetchCached(urls[i], opts);
      done++;
      opts.onProgress?.(done, urls.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, worker));
  return results;
}

export async function readBody(rec: PageRecord): Promise<string> {
  if (!rec.cachePath) return "";
  return readFile(rec.cachePath, "utf8");
}
