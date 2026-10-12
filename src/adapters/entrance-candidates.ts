/**
 * The entrances a plain reading of the tree can detect, per language: the
 * surface the declared entrances are measured against (c-3760638e: a gap
 * count alone rewards declaring fewer, coarser entrances, so Structure says
 * how much of the detected surface the declared entrances cover).
 *
 * A scan, never a parse and never a guess presented as fact: each rule is a
 * shape a framework or a runner fixes, few enough to list, and each detected
 * entrance carries the rule and why it matched. Precision over recall: what
 * the rules cannot see is said in NOT_DETECTED, and a surface a project
 * builds its own way (a hand-written dispatcher, a message consumer) is left
 * to its declared entrances. The rule list (CANDIDATE_RULES and
 * NOT_DETECTED) lives in readings/scope/entrance-coverage.ts, which the
 * browser bundle carries, so the view, the query and the spec print one list.
 *
 * Detection reads the spec for one thing only: the symbols declared
 * entrances name as handlers or guards, the wrappers. An export created by
 * calling one is detected, and every detected entrance records which of them
 * its own statement calls (`through`), which is how a grouped entrance
 * ("server function mutations", handled by mutationRpc) is measured against
 * the functions registered through it. The spec's handlers and guards are
 * part of the structure reading's fingerprint, so a detection kept with a
 * reading is current exactly as long as the reading is.
 */

import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Language } from "./index.ts";
import { isTestPath } from "./adapter.ts";

/** One entrance the reading detected in the tree. */
export interface EntranceCandidate {
  /** The project-relative file where it was detected. */
  file: string;
  /** One-based. */
  line: number;
  /**
   * The name a declared entrance's handler would give it: the exported
   * symbol, the registered handler's name, or "" when the file itself is the
   * entrance (a script, a package bin).
   */
  symbol: string;
  /** The rule that detected it, one of the language's CANDIDATE_RULES (entrance-coverage.ts). */
  rule: string;
  /** Why, in words a reader can check against the file. */
  why: string;
  /** Set when the symbol is registered here and declared elsewhere (a route table, a URL pattern): a handler naming it resolves to another file. */
  registered?: true;
  /** The declared entrances' handlers and guards its own statement calls or is decorated with, when any. */
  through?: string[];
}

export interface DetectOptions {
  language: Language;
  /** The bounded project files to read, project-relative. */
  files: readonly string[];
  /** The symbol names declared entrances give as handlers or guards. */
  wrappers: readonly string[];
  testFolders: readonly string[];
  /** Reads a project file; a test stubs it. */
  read?: (file: string) => string | undefined;
}

const TS_CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const RUNNABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs|py)$/;

/** A name as a regular expression that matches it literally, whatever characters it holds. */
function escape(name: string): string {
  return name.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/** The lines of the statement or definition that starts at `start` (zero-based): until the next line at or left of its indentation that begins something new. */
function spanOf(lines: readonly string[], start: number, language: Language): string {
  const indent = /^\s*/.exec(lines[start] ?? "")![0].length;
  let end = start + 1;
  // A Python definition begins at its decorators; its body is indented past the def.
  let def = start;
  if (language === "python") while (def < lines.length && /^\s*@/.test(lines[def] ?? "")) def += 1;
  end = Math.max(end, def + 1);
  for (; end < lines.length; end++) {
    const text = lines[end] ?? "";
    if (text.trim() === "") continue;
    const at = /^\s*/.exec(text)![0].length;
    if (at > indent) continue;
    if (language === "typescript" && /^\s*[)\]}.]/.test(text)) continue;
    break;
  }
  return lines.slice(start, end).join("\n");
}

/** Whether the file imports or declares the name, so a call to it is a call to that symbol and not a namesake. */
function binds(text: string, name: string, language: Language): boolean {
  const n = escape(name);
  if (language === "python") {
    return new RegExp(`^\\s*from\\s+\\S+\\s+import\\s+[^\\n]*\\b${n}\\b`, "m").test(text) || new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${n}\\b|^${n}\\s*=`, "m").test(text) || new RegExp(`^\\s*from\\s+\\S+\\s+import\\s*\\([^)]*\\b${n}\\b`, "m").test(text);
  }
  for (const m of text.matchAll(/\bimport\s[^"'`;]*?\bfrom\s*["'][^"']+["']/g)) if (new RegExp(`(?<![\\w$])${n}(?![\\w$])`).test(m[0])) return true;
  return new RegExp(`(?:function\\*?|const|let|var|class)\\s+${n}(?![\\w$])`).test(text) || new RegExp(`(?:const|let|var)\\s*\\{[^}]*(?<![\\w$])${n}(?![\\w$])[^}]*\\}\\s*=`).test(text);
}

/** The wrappers a span calls (or, in Python, is decorated with), each bound in its file. */
function throughOf(span: string, text: string, wrappers: readonly string[], language: Language): string[] | undefined {
  const found = wrappers.filter((w) => {
    const n = escape(w);
    const called = new RegExp(`(?<![\\w$])${n}\\s*(?:<[^()<>]*>)?\\s*\\(`).test(span) || (language === "python" && new RegExp(`^\\s*@(?:[\\w.]*\\.)?${n}\\b`, "m").test(span));
    return called && binds(text, w, language);
  });
  return found.length === 0 ? undefined : found;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** The last identifier of a handler expression: cached(serveOutput) is serveOutput, views.detail is detail, Thing.as_view() is Thing. */
function handlerName(expression: string): string {
  const inner = /([A-Za-z_$][\w$]*)\s*\)*\s*$/.exec(expression.replace(/\.as_view(?:\s*\([^)]*\))?\s*$/, "").trim());
  return inner?.[1] ?? "";
}

/* ---------------------------------------------------------------- TypeScript */

/** The text from its first code: leading whitespace and comments skipped by a walk, never a backtracking pattern. */
function leadingCode(text: string): string {
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else return text.slice(i);
  }
}

/** The exports a Next.js route file answers requests by, one per HTTP method. */
export const NEXT_ROUTE_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** The exports a Remix route file runs on the server by. */
export const REMIX_ROUTE_EXPORTS: ReadonlySet<string> = new Set(["loader", "action"]);

function typescriptCandidates(file: string, text: string, wrappers: readonly string[]): EntranceCandidate[] {
  const out: EntranceCandidate[] = [];
  const lines = text.split("\n");
  // The file's own top-level helpers, so a route whose handlers are a local `handle` calling the wrapper is registered through it.
  const helpers = new Map<string, number>();
  lines.forEach((line, i) => {
    const m = /^(?:export\s+)?(?:async\s+)?(?:function\*?\s*|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/.exec(line);
    if (m !== null && !helpers.has(m[1]!)) helpers.set(m[1]!, i);
  });
  const add = (c: Omit<EntranceCandidate, "through">, span: string): void => {
    let through = throughOf(span, text, wrappers, "typescript");
    if (through === undefined) {
      // One level into the file's own helpers the statement names, never further.
      const named = [...helpers].filter(([name, at]) => at !== c.line - 1 && new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`).test(span));
      if (named.length > 0) through = throughOf(named.map(([, at]) => spanOf(lines, at, "typescript")).join("\n"), text, wrappers, "typescript");
    }
    out.push(through === undefined ? c : { ...c, through });
  };
  const wrapperSet = new Set(wrappers);
  const nextRoute = /(^|\/)app\/(.+\/)?route\.(ts|tsx|js|mjs)$/.test(file);
  const pagesApi = /(^|\/)pages\/api\/.+\.(ts|tsx|js|mjs)$/.test(file);
  const remixRoute = /(^|\/)app\/routes\/.+\.(ts|tsx|js|jsx)$/.test(file);
  const useServer = /^["']use server["']/.test(leadingCode(text));
  // Next.js's request proxy (proxy.ts since Next.js 16, middleware.ts before it), at the project root or under src/.
  const proxyFile = /^(?:src\/)?(proxy|middleware)\.(ts|js|mjs)$/.exec(file)?.[1];
  const nextPage = /(^|\/)app\/(.+\/)?page\.(tsx|jsx|ts|js)$/.test(file) && !remixRoute;
  if (nextRoute || proxyFile !== undefined) {
    // What a route or proxy file exports by name without declaring it: an export list, re-exported or local, or a destructuring
    // (export { GET, POST } from "@/app/(auth)/auth", export { auth as proxy }, export const { GET, POST } = handlers).
    const wanted = (name: string): boolean => (nextRoute ? NEXT_ROUTE_METHODS.has(name) : name === proxyFile);
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}|^export\s+(?:const|let|var)\s*\{([^}]*)\}\s*=/gm)) {
      const listed = m[1] !== undefined;
      const reexported = listed && /^\s*from\s*["']/.test(text.slice(m.index + m[0].length));
      for (const item of (m[1] ?? m[2]!).split(",")) {
        const named = listed ? /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(item) : /^\s*(?:[A-Za-z_$][\w$]*\s*:\s*)?([A-Za-z_$][\w$]*)\s*$/.exec(item);
        const name = named === null ? undefined : (named[2] ?? named[1]!);
        if (name === undefined || !wanted(name)) continue;
        const line = lineOf(text, m.index);
        const how = reexported ? "re-exported" : "exported by name";
        const c = nextRoute
          ? { file, line, symbol: name, rule: "route handler", why: `${name} ${how} in a Next.js route file: answers ${name} requests` }
          : { file, line, symbol: name, rule: "request proxy", why: `${name} ${how} in ${file}: Next.js runs it before every request it matches` };
        add(c, spanOf(lines, line - 1, "typescript"));
      }
    }
    if (proxyFile !== undefined) {
      const at = lines.findIndex((l) => /^export\s+default\b/.test(l));
      if (at >= 0) add({ file, line: at + 1, symbol: "", rule: "request proxy", why: `the default export of ${file}: Next.js runs it before every request it matches` }, spanOf(lines, at, "typescript"));
    }
  }
  const at = nextPage ? lines.findIndex((l) => /^export\s+default\b/.test(l)) : -1;
  if (at >= 0) {
    add({ file, line: at + 1, symbol: "", rule: "page route", why: "the default export of a Next.js app/**/page file: renders its route on the server for every visitor" }, spanOf(lines, at, "typescript"));
  }
  lines.forEach((line, i) => {
    const declared = proxyFile === undefined ? null : /^export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/.exec(line);
    if (declared !== null && declared[1] === proxyFile) {
      add({ file, line: i + 1, symbol: proxyFile!, rule: "request proxy", why: `export ${proxyFile} in ${file}: Next.js runs it before every request it matches` }, spanOf(lines, i, "typescript"));
      return;
    }
    const exported = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*\(/.exec(line);
    if (exported !== null) {
      const [, name, callee] = exported as unknown as [string, string, string];
      const span = spanOf(lines, i, "typescript");
      if (callee === "createServerFn") {
        add({ file, line: i + 1, symbol: name, rule: "server function", why: `export const ${name} = createServerFn(...): a TanStack Start server function a browser can call` }, span);
        return;
      }
      if (callee === "createServerFileRoute" || callee === "createAPIFileRoute" || (callee === "createFileRoute" && /\bserver\s*:\s*\{[\s\S]*\bhandlers\b/.test(span))) {
        add({ file, line: i + 1, symbol: name, rule: "server route", why: `export const ${name} = ${callee}(...)${callee === "createFileRoute" ? " with server handlers" : ""}: a route that answers requests on the server` }, span);
        return;
      }
      if (wrapperSet.has(callee)) {
        add({ file, line: i + 1, symbol: name, rule: "wrapped export", why: `export const ${name} = ${callee}(...): created by ${callee}, which a declared entrance names` }, span);
        return;
      }
    }
    const fn = /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\b|\(|function\b)/.exec(line);
    const fnName = fn?.[1] ?? fn?.[2];
    if (fnName !== undefined) {
      const span = spanOf(lines, i, "typescript");
      if (nextRoute && NEXT_ROUTE_METHODS.has(fnName)) add({ file, line: i + 1, symbol: fnName, rule: "route handler", why: `export ${fnName} in a Next.js route file: answers ${fnName} requests` }, span);
      else if (remixRoute && REMIX_ROUTE_EXPORTS.has(fnName)) add({ file, line: i + 1, symbol: fnName, rule: "route handler", why: `export ${fnName} in app/routes: runs on the server for its route` }, span);
      else if (useServer && /^export\s+(?:async\s+function|const\s+\w+\s*(?::[^=]+)?=\s*async\b)/.test(line)) add({ file, line: i + 1, symbol: fnName, rule: "server action", why: `export ${fnName} in a 'use server' file: a server action a browser can call` }, span);
    }
    if (pagesApi && /^export\s+default\b/.test(line)) add({ file, line: i + 1, symbol: "", rule: "route handler", why: "the default export under pages/api: a Next.js API route" }, spanOf(lines, i, "typescript"));
    const table = /\b(?:pattern|path|route)\s*:\s*["'`](\/[^"'`]*)["'`][^\n]*?\bhandler\s*:\s*([A-Za-z_$][\w$.]*(?:\s*\(\s*[A-Za-z_$][\w$.]*\s*\))?)/.exec(line);
    if (table !== null) {
      const symbol = handlerName(table[2]!);
      if (symbol !== "") add({ file, line: i + 1, symbol, rule: "route table", why: `a route table entry: ${table[1]} handled by ${table[2]!.trim()}`, registered: true }, line);
      return;
    }
    // A statement, never text inside a string: the call opens its line, as `app.get(...)`, `await router.post(...)` or a chained `.get(...)`.
    const method = /^\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)?\.(get|post|put|patch|delete|all|head|options)\(\s*["'`](\/[^"'`]*)["'`]\s*,([^\n]*)$/.exec(line);
    if (method !== null) {
      const last = /,?\s*([A-Za-z_$][\w$.]*)\s*\)\s*;?\s*$/.exec(method[3]!);
      const symbol = last === null ? "" : handlerName(last[1]!);
      add({ file, line: i + 1, symbol, rule: "route method", why: `${method[1]!.toUpperCase()} ${method[2]} registered by a .${method[1]}() call${symbol === "" ? " with an inline handler" : ` to ${symbol}`}`, ...(symbol === "" ? {} : { registered: true as const }) }, spanOf(lines, i, "typescript"));
    }
  });
  return out;
}

/* -------------------------------------------------------------------- Python */

function pythonCandidates(file: string, text: string, wrappers: readonly string[]): EntranceCandidate[] {
  const out: EntranceCandidate[] = [];
  const lines = text.split("\n");
  const add = (c: Omit<EntranceCandidate, "through">, span: string): void => {
    const through = throughOf(span, text, wrappers, "python");
    out.push(through === undefined ? c : { ...c, through });
  };
  /** The def or class a decorator at line i decorates: its name, and the line the decorators start on. */
  const decorated = (i: number): { name: string; start: number } | undefined => {
    let start = i;
    while (start > 0 && /^\s*@/.test(lines[start - 1] ?? "")) start -= 1;
    for (let j = i; j < lines.length; j++) {
      const def = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(lines[j] ?? "");
      if (def !== null) return { name: def[1]!, start };
      if (!/^\s*(@|#|$)/.test(lines[j] ?? "") && !/^\s+/.test(lines[j] ?? "")) return undefined;
    }
    return undefined;
  };
  const seen = new Set<number>();
  const urls = /(^|\/)urls\.py$/.test(file);
  const command = /(^|\/)management\/commands\/[^_/][^/]*\.py$/.test(file);
  // A URL pattern and a router registration are read over the whole text, not line by line: a call may break after its open parenthesis, its route and its handler on the lines below, as billing's seats/<id>/reactivate/ route is written.
  const lineAt = (index: number): number => text.slice(0, index).split("\n").length;
  const callText = (index: number, end: number): string => text.slice(index, end);
  if (urls) {
    for (const pattern of text.matchAll(/\b(?:re_path|path|url)\(\s*[rbuf]*["'][^"']*["']\s*,\s*([A-Za-z_][\w.]*(?:\.as_view\s*\([^)]*\))?)/g)) {
      if (/^include\b/.test(pattern[1]!)) continue;
      const symbol = handlerName(pattern[1]!);
      if (symbol !== "") add({ file, line: lineAt(pattern.index), symbol, rule: "url pattern", why: `a URL pattern routed to ${pattern[1]!.trim()}`, registered: true }, callText(pattern.index, pattern.index + pattern[0].length));
    }
  }
  for (const viewset of text.matchAll(/\b\w+\.register\(\s*[rbuf]*["'][^"']*["']\s*,\s*([A-Za-z_][\w.]*)/g)) {
    add({ file, line: lineAt(viewset.index), symbol: handlerName(viewset[1]!), rule: "viewset", why: `a router registration of ${viewset[1]}`, registered: true }, callText(viewset.index, viewset.index + viewset[0].length));
  }
  lines.forEach((line, i) => {
    if (command && /^class\s+Command\b/.test(line)) add({ file, line: i + 1, symbol: "Command", rule: "management command", why: `a Django management command, run as manage.py ${posix.basename(file, ".py")}` }, spanOf(lines, i, "python"));
    const route = /^\s*@[\w.]*\.(get|post|put|patch|delete|route|api_route|websocket)\(\s*[rbuf]*["'](\/[^"']*)["']/.exec(line);
    const task = /^\s*@(shared_task|[\w.]*\.task|(?:activity|workflow)\.defn)\b/.exec(line);
    if (route !== null || task !== null) {
      const target = decorated(i);
      if (target === undefined || seen.has(target.start)) return;
      seen.add(target.start);
      const span = spanOf(lines, target.start, "python");
      if (route !== null) add({ file, line: target.start + 1, symbol: target.name, rule: "route decorator", why: `${target.name} is decorated @…${route[1]}('${route[2]}'): a web route` }, span);
      else add({ file, line: target.start + 1, symbol: target.name, rule: "task", why: `${target.name} is decorated @${task![1]}: ${/defn$/.test(task![1]!) ? "a Temporal worker runs it" : "a Celery worker runs it"}` }, span);
    }
  });
  return out;
}

/* ------------------------------------------------------ runners and scripts */

interface PackageJson {
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
}

const RUNNERS = /^(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+|bunx\s+)?(node|tsx|ts-node|ts-node-esm|bun|deno|vite-node|python3?|uv\s+run)\b/;

/** The project files a script command runs: each segment whose program is a runner, every argument that names a runnable project file. */
function scriptTargets(command: string, exists: (file: string) => boolean): string[] {
  const found: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const trimmed = segment.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "");
    if (!RUNNERS.test(trimmed)) continue;
    for (const token of trimmed.split(/\s+/).slice(1)) {
      const path = token.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
      if (path.startsWith("-") || !RUNNABLE.test(path) || !exists(path)) continue;
      found.push(path);
    }
  }
  return found;
}

/** Candidates the manifests name: package.json's bin and scripts, pyproject's console scripts. */
function manifestCandidates(files: ReadonlySet<string>, language: Language, read: (file: string) => string | undefined, isTest: (file: string) => boolean): EntranceCandidate[] {
  const out: EntranceCandidate[] = [];
  // Only the project's own files inside the bounds: a manifest naming anything else names no entrance here.
  const exists = (file: string): boolean => files.has(posix.normalize(file));
  const pkgText = read("package.json");
  if (pkgText !== undefined) {
    let pkg: PackageJson = {};
    try {
      pkg = JSON.parse(pkgText) as PackageJson;
    } catch {
      pkg = {};
    }
    const bins = typeof pkg.bin === "string" ? { [posix.basename(pkg.bin)]: pkg.bin } : (pkg.bin ?? {});
    for (const [name, target] of Object.entries(bins)) {
      const file = target.replace(/^\.\//, "");
      if (exists(file)) out.push({ file, line: 1, symbol: "", rule: "package bin", why: `package.json's bin "${name}" runs it` });
    }
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      for (const file of scriptTargets(command, exists)) {
        if (isTest(file)) continue;
        out.push({ file, line: 1, symbol: "", rule: "package script", why: `the package script "${name}" runs it` });
      }
    }
  }
  if (language === "python") {
    const pyproject = read("pyproject.toml");
    if (pyproject !== undefined) {
      let section = "";
      for (const raw of pyproject.split("\n")) {
        const header = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
        if (header !== null) {
          section = header[1]!.trim();
          continue;
        }
        if (section !== "project.scripts" && section !== "tool.poetry.scripts") continue;
        const entry = /^\s*["']?([\w.-]+)["']?\s*=\s*["']([\w.]+):([\w]+)["']/.exec(raw);
        if (entry === null) continue;
        const module = entry[2]!.split(".").join("/");
        const file = [`${module}.py`, `${module}/__init__.py`, `src/${module}.py`, `src/${module}/__init__.py`].find(exists);
        if (file !== undefined) out.push({ file, line: 1, symbol: entry[3]!, rule: "console script", why: `pyproject's console script "${entry[1]}" runs ${entry[2]}:${entry[3]}` });
      }
    }
  }
  return out;
}

/** Top-level scripts: directly under scripts/ (or bin/, for TypeScript), run rather than imported. */
function scriptCandidates(files: readonly string[], language: Language, read: (file: string) => string | undefined, imported: ReadonlySet<string>): EntranceCandidate[] {
  const out: EntranceCandidate[] = [];
  for (const file of files) {
    const match = /^(scripts|bin)\/[^/]+$/.exec(file);
    if (match === null) continue;
    if (language === "python") {
      if (match[1] !== "scripts" || !file.endsWith(".py")) continue;
      const text = read(file) ?? "";
      if (/^if\s+__name__\s*==\s*["']__main__["']\s*:/m.test(text)) out.push({ file, line: 1, symbol: "", rule: "script", why: `a script under ${match[1]}/ with an if __name__ == "__main__" block` });
      continue;
    }
    if (!TS_CODE.test(file) || /\.d\.ts$/.test(file) || imported.has(file)) continue;
    out.push({ file, line: 1, symbol: "", rule: "script", why: `a script directly under ${match[1]}/ that no project file imports` });
  }
  return out;
}

const TS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;

/** The project files some other project file imports by a relative path. */
function importedFiles(files: readonly string[], read: (file: string) => string | undefined): Set<string> {
  const all = new Set(files);
  const out = new Set<string>();
  for (const file of files) {
    if (!TS_CODE.test(file)) continue;
    const text = read(file);
    if (text === undefined) continue;
    for (const m of text.matchAll(TS_IMPORT)) {
      const joined = posix.normalize(posix.join(posix.dirname(file), m[1]!));
      const stem = joined.replace(/\.(js|mjs|cjs|jsx)$/, "");
      for (const c of [joined, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].map((e) => stem + e), ...[".ts", ".tsx", ".js"].map((e) => posix.join(joined, "index" + e))]) {
        if (all.has(c) && c !== file) out.add(c);
      }
    }
  }
  return out;
}

/**
 * Every entrance the rules detect in the given files and manifests, sorted by
 * file and line, one per file for file-grain entrances (a script a bin and a
 * package script both run is one entrance, its reasons joined).
 */
export function detectEntranceCandidates(root: string, options: DetectOptions): EntranceCandidate[] {
  const { language, files, testFolders } = options;
  const wrappers = [...new Set(options.wrappers.filter((w) => /^[A-Za-z_$][\w$]*$/.test(w)))].sort();
  const cache = new Map<string, string | undefined>();
  const read = (file: string): string | undefined => {
    if (cache.has(file)) return cache.get(file);
    let text: string | undefined;
    try {
      text = options.read !== undefined ? options.read(file) : readFileSync(join(root, file), "utf8");
    } catch {
      text = undefined;
    }
    cache.set(file, text);
    return text;
  };
  const isTest = (file: string): boolean => isTestPath(file, testFolders);
  const code = files.filter((f) => !isTest(f) && (language === "python" ? f.endsWith(".py") : TS_CODE.test(f) && !/\.d\.ts$/.test(f)));
  const found: EntranceCandidate[] = [];
  for (const file of code) {
    const text = read(file);
    if (text === undefined) continue;
    found.push(...(language === "python" ? pythonCandidates(file, text, wrappers) : typescriptCandidates(file, text, wrappers)));
  }
  const fileGrain = [...manifestCandidates(new Set(files), language, read, isTest), ...scriptCandidates(code, language, read, language === "typescript" ? importedFiles(code, read) : new Set())];
  const byFile = new Map<string, EntranceCandidate>();
  for (const c of fileGrain) {
    if (c.symbol !== "") {
      found.push(c);
      continue;
    }
    const known = byFile.get(c.file);
    if (known === undefined) byFile.set(c.file, c);
    else if (!known.why.includes(c.why)) known.why = `${known.why}; ${c.why}`;
  }
  for (const c of byFile.values()) {
    const text = read(c.file);
    const through = text === undefined ? undefined : throughOf(text, text, wrappers, language);
    found.push(through === undefined ? c : { ...c, through });
  }
  // A symbol a rule detects in a file is one entrance, whichever rules saw it.
  const seen = new Set<string>();
  return found
    .filter((c) => {
      const key = `${c.file}\u0000${c.symbol}\u0000${c.symbol === "" || c.registered ? c.line : ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.symbol.localeCompare(b.symbol));
}
