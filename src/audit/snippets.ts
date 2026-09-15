import { spawnSync } from "node:child_process";
import ts from "typescript";
import type { CodeBlock } from "./types.js";

export interface SnippetResult {
  url: string;
  line: number;
  lang: string;
  ok: boolean;
  /** ok only as a fragment: an expression that needs wrapping, or Python that parses after dedent. */
  fragment?: boolean;
  reason?: string;
}

const JSON_LANGS = new Set(["json", "json5", "jsonc"]);
const JS_LANGS = new Set(["js", "javascript", "node", "nodejs"]);
const TS_LANGS = new Set(["ts", "typescript"]);
const PY_LANGS = new Set(["py", "python", "python3"]);

/** Placeholder forms that Adyen docs use inside JSON examples. */
const ELLIPSIS = /(^|[\s,{[])\.{3}($|[\s,}\]])/;

export function lintJson(code: string): { ok: boolean; reason?: string } {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, reason: "empty block" };
  try {
    JSON.parse(trimmed);
    return { ok: true };
  } catch (err) {
    if (ELLIPSIS.test(trimmed)) return { ok: false, reason: "ellipsis placeholder (...) inside JSON" };
    if (/(^|\n)\s*\/\//.test(trimmed) || /\/\*[\s\S]*?\*\//.test(trimmed)) return { ok: false, reason: "comments inside JSON" };
    if (/,\s*[}\]]/.test(trimmed)) return { ok: false, reason: "trailing comma" };
    if (/^\s*[{[]/.test(trimmed) === false) return { ok: false, reason: "not a JSON document (fragment)" };
    return { ok: false, reason: `parse error: ${(err as Error).message.slice(0, 60)}` };
  }
}

function firstSyntaxError(code: string, kind: ts.ScriptKind): string | undefined {
  const sf = ts.createSourceFile("snippet.tsx", code, ts.ScriptTarget.Latest, true, kind);
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diags.length === 0) return undefined;
  const d = diags[0];
  const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
  const pos = d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start) : undefined;
  return pos ? `${msg} (line ${pos.line + 1})` : msg;
}

/**
 * A block that fails as a program but parses as a bare expression (an object
 * literal, an array, a config fragment) is reported as ok with `fragment: true`
 * so that only blocks an agent could not use in any form count as failures.
 */
function lintScript(code: string, kind: ts.ScriptKind): { ok: boolean; reason?: string; fragment?: boolean } {
  if (!code.trim()) return { ok: false, reason: "empty block" };
  if (ELLIPSIS.test(code)) return { ok: false, reason: "ellipsis placeholder (...) inside code" };
  const err = firstSyntaxError(code, kind);
  if (!err) return { ok: true };
  if (!firstSyntaxError(`(${code.trim()});`, kind)) return { ok: true, fragment: true };
  return { ok: false, reason: err };
}

export function lintJs(code: string): { ok: boolean; reason?: string; fragment?: boolean } {
  return lintScript(code, ts.ScriptKind.JS);
}

export function lintTs(code: string): { ok: boolean; reason?: string; fragment?: boolean } {
  return lintScript(code, ts.ScriptKind.TS);
}

/** Batch-parse Python snippets with the system python3 (ast.parse). Returns undefined when python3 is absent. */
export function lintPythonBatch(codes: string[]): ({ ok: boolean; reason?: string; fragment?: boolean } | undefined)[] {
  if (codes.length === 0) return [];
  const script = [
    "import ast, json, sys, textwrap",
    "codes = json.load(sys.stdin)",
    "out = []",
    "for c in codes:",
    "    try:",
    "        ast.parse(c)",
    "        out.append({'ok': True})",
    "        continue",
    "    except SyntaxError as e:",
    "        first = f'{e.msg} (line {e.lineno})'",
    "    try:",
    "        ast.parse(textwrap.dedent(c))",
    "        out.append({'ok': True, 'fragment': True, 'reason': 'parses only after dedent (fence is indented)'})",
    "    except SyntaxError as e:",
    "        out.append({'ok': False, 'reason': f'{e.msg} (line {e.lineno})'})",
    "json.dump(out, sys.stdout)",
  ].join("\n");
  const r = spawnSync("python3", ["-c", script], { input: JSON.stringify(codes), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return codes.map(() => undefined);
  return JSON.parse(r.stdout) as { ok: boolean; reason?: string; fragment?: boolean }[];
}

export function lintSnippets(pages: { url: string; codeBlocks: CodeBlock[] }[]): SnippetResult[] {
  const results: SnippetResult[] = [];
  const py: { url: string; block: CodeBlock }[] = [];
  for (const p of pages) {
    for (const b of p.codeBlocks) {
      if (JSON_LANGS.has(b.lang)) {
        results.push({ url: p.url, line: b.line, lang: "json", ...lintJson(b.code) });
      } else if (JS_LANGS.has(b.lang)) {
        results.push({ url: p.url, line: b.line, lang: "js", ...lintJs(b.code) });
      } else if (TS_LANGS.has(b.lang)) {
        results.push({ url: p.url, line: b.line, lang: "ts", ...lintTs(b.code) });
      } else if (PY_LANGS.has(b.lang)) {
        py.push({ url: p.url, block: b });
      }
    }
  }
  const pyRes = lintPythonBatch(py.map((x) => x.block.code));
  py.forEach((x, i) => {
    const r = pyRes[i];
    if (r) results.push({ url: x.url, line: x.block.line, lang: "py", ...r });
  });
  return results;
}
