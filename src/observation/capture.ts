/**
 * Capture: the observed pass rides the batched totality pass's one runner
 * invocation and collects what executed, per test where the runner can say,
 * per run (and said so) where it cannot.
 *
 *   node:test  per test: preload.ts, loaded into each test child through
 *              NODE_OPTIONS, takes V8 precise coverage around every test
 *   vitest     per run: vitest attributes coverage to no test; with a coverage
 *              provider installed (@vitest/coverage-v8 or -istanbul), its
 *              istanbul JSON is the whole run's region; without one, nothing
 *   pytest     per test: coverage.py with dynamic contexts (test_function)
 *              runs pytest as `python -m coverage run -m pytest ...`; the
 *              JSON export afterwards reads the data file and runs no test
 *
 * Verdicts and failure text come from the same report the batched pass
 * reads. Per-test attribution is never fabricated: a runner that gives only a
 * run's coverage is recorded as one region for the run.
 */

import { spawnSync } from "../lifecycle/work-meter.ts";
import { perProcess } from "../lifecycle/process-caches.ts";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installedPackage, projectFrom } from "../adapters/installed.ts";
import { keepProjectFiles, projectFiles } from "../adapters/project-files.ts";
import type { EnforcementConfig } from "../enforcement/config.ts";
import type { BatchObserver, CommandSpec, JsonReport } from "../enforcement/totality.ts";
import { positionsOf, type ExecutedFile, type Span } from "./map.ts";
import type { ObservedTestLine } from "./preload.ts";

export type Runner = "node:test" | "vitest" | "pytest";
export type Attribution = "per test" | "per run" | "none";
export type TestVerdict = "pass" | "fail" | "skipped" | "unreported";

export interface CapturedTest {
  /** Project-relative test file, where the runner named it. */
  file: string | undefined;
  name: string;
  fullName: string;
  /** The titles above the test, where the report gave them. */
  ancestors?: string[];
  verdict: TestVerdict;
  /** The failure's message and stack, as the runner reported it. */
  failure?: string;
  /** What executed in this test alone; absent when the runner cannot attribute per test. */
  executed?: ExecutedFile[];
}

export interface Capture {
  runner: Runner | undefined;
  attribution: Attribution;
  /** What the runner gave, in one plain sentence. */
  note: string;
  tests: CapturedTest[];
  /** The whole run's region, when coverage is per run. */
  run?: ExecutedFile[];
}

const PRELOAD = fileURLToPath(new URL(`./preload${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

function commandText(config: EnforcementConfig): string {
  return Array.isArray(config.testJson) ? config.testJson.join(" ") : (config.testJson ?? "");
}

/** Which runner the batched command names, read from the command itself. */
export function runnerOf(config: EnforcementConfig): Runner | undefined {
  const text = commandText(config);
  if (/\bvitest\b/.test(text)) return "vitest";
  if (config.testFilterForm === "pytest" || /\bpytest\b/.test(text)) return "pytest";
  if (/(^|[\s/"'])node["']?(\s|$)/.test(text) && /\s--test(\s|=|$)/.test(text)) return "node:test";
  return undefined;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The project's files per real root, enumerated once per process; a path not among them is asked of git once more before it is refused. */
const enumerated = perProcess(new Map<string, ReadonlySet<string>>());
const owned = perProcess(new Map<string, boolean>());

function isOwned(realRoot: string, rel: string): boolean {
  let files = enumerated.get(realRoot);
  if (files === undefined) enumerated.set(realRoot, (files = new Set(projectFiles(realRoot))));
  if (files.has(rel)) return true;
  // A dependency's file is never the project's, and there are thousands: no second question for them.
  if (rel.split("/").includes("node_modules")) return false;
  const key = `${realRoot}\u0000${rel}`;
  let own = owned.get(key);
  // A file created after the enumeration (a test's fixture, a new module) is asked about by itself.
  if (own === undefined) owned.set(key, (own = keepProjectFiles(realRoot, [rel]).has(rel)));
  return own;
}

/**
 * A path the runtime printed, project-relative, or undefined when it is not
 * one of the project's own files: outside the root, ignored, or inside a
 * nested checkout (projectFiles' rule), so what executed in an agent's
 * worktree copy is never observed as this project's code.
 */
export function projectPath(realRoot: string, path: string): string | undefined {
  const absolute = real(isAbsolute(path) ? path : join(realRoot, path));
  const rel = relative(realRoot, absolute).split(sep).join("/");
  if (rel === "" || rel.startsWith("..")) return undefined;
  return isOwned(realRoot, rel) ? rel : undefined;
}

function reportedTests(report: JsonReport | undefined, realRoot: string): CapturedTest[] {
  const out: CapturedTest[] = [];
  for (const file of report?.testResults ?? []) {
    for (const r of file.assertionResults ?? []) {
      const verdict: TestVerdict = r.status === "failed" ? "fail" : r.status === "passed" ? "pass" : "skipped";
      const failure = r.failureMessages?.filter((m) => m.trim() !== "").join("\n");
      out.push({
        file: file.name === undefined ? undefined : projectPath(realRoot, file.name),
        name: r.title ?? r.fullName ?? "",
        fullName: r.fullName ?? r.title ?? "",
        ...(r.ancestorTitles === undefined ? {} : { ancestors: r.ancestorTitles }),
        verdict,
        ...(failure === undefined || failure === "" ? {} : { failure }),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------ node:test */

function readText(realRoot: string, file: string, cache: Map<string, string | undefined>): string | undefined {
  if (!cache.has(file)) {
    try {
      cache.set(file, readFileSync(join(realRoot, file), "utf8"));
    } catch {
      cache.set(file, undefined);
    }
  }
  return cache.get(file);
}

/** One child's per-test line as executed files: V8's offsets turned into positions in the file's own text. */
export function executedFromV8(line: ObservedTestLine, realRoot: string, cache = new Map<string, string | undefined>()): ExecutedFile[] {
  const files: ExecutedFile[] = [];
  for (const script of line.scripts) {
    let path: string;
    try {
      path = fileURLToPath(script.url);
    } catch {
      continue;
    }
    const file = projectPath(realRoot, path);
    if (file === undefined) continue;
    const text = readText(realRoot, file, cache);
    if (text === undefined) continue;
    const at = positionsOf(text);
    const spans: Span[] = script.functions.map(([start, end, count, name]) => ({
      start: at(start),
      end: at(end),
      count,
      kind: start === 0 && name === "" ? "module" : "function",
      ...(name === "" ? {} : { name }),
    }));
    for (const [start, end, count] of script.blocks) spans.push({ start: at(start), end: at(end), count, kind: "block" });
    files.push({ file, spans });
  }
  return files;
}

/** Join what each child observed with the report's verdicts, by test file and full name. */
export function joinNodeTest(lines: readonly ObservedTestLine[], reported: readonly CapturedTest[], realRoot: string): CapturedTest[] {
  const cache = new Map<string, string | undefined>();
  const key = (file: string | undefined, fullName: string): string => `${file ?? ""}\u0000${fullName}`;
  const byKey = new Map(reported.map((t) => [key(t.file, t.fullName), t]));
  const tests: CapturedTest[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const file = projectPath(realRoot, line.file);
    const k = key(file, line.fullName);
    seen.add(k);
    const verdictOf = byKey.get(k);
    tests.push({
      file,
      name: line.name,
      fullName: line.fullName,
      ...(verdictOf?.ancestors === undefined ? {} : { ancestors: verdictOf.ancestors }),
      verdict: verdictOf?.verdict ?? "unreported",
      ...(verdictOf?.failure === undefined ? {} : { failure: verdictOf.failure }),
      executed: executedFromV8(line, realRoot, cache),
    });
  }
  // A failure the report names that no test line carries (a suite, a hook): kept, with no region, unless a test beneath it already failed.
  for (const t of reported) {
    if (t.verdict !== "fail" || seen.has(key(t.file, t.fullName))) continue;
    if (tests.some((x) => x.verdict === "fail" && x.file === t.file && x.fullName.startsWith(`${t.fullName} `))) continue;
    tests.push(t);
  }
  return tests;
}

/* --------------------------------------------------------------- vitest */

interface IstanbulFile {
  path?: string;
  statementMap?: Record<string, { start: { line: number; column: number | null }; end: { line: number; column: number | null } }>;
  s?: Record<string, number>;
  fnMap?: Record<string, { name?: string; loc: { start: { line: number; column: number | null }; end: { line: number; column: number | null } } }>;
  f?: Record<string, number>;
}

/** Istanbul's coverage-final.json (what vitest's providers write) as executed files for the whole run. */
export function executedFromIstanbul(coverage: Record<string, IstanbulFile>, realRoot: string): ExecutedFile[] {
  const pos = (p: { line: number; column: number | null }): { line: number; character: number } => ({ line: p.line - 1, character: p.column ?? 0 });
  const endPos = (p: { line: number; column: number | null }): { line: number; character: number } => ({ line: p.line - 1, character: p.column ?? Number.MAX_SAFE_INTEGER });
  const files: ExecutedFile[] = [];
  for (const [key, entry] of Object.entries(coverage)) {
    const file = projectPath(realRoot, entry.path ?? key);
    if (file === undefined || file.includes("node_modules/")) continue;
    const spans: Span[] = [];
    for (const [id, fn] of Object.entries(entry.fnMap ?? {})) {
      spans.push({ start: pos(fn.loc.start), end: endPos(fn.loc.end), count: entry.f?.[id] ?? 0, kind: "function", ...(fn.name === undefined ? {} : { name: fn.name }) });
    }
    for (const [id, st] of Object.entries(entry.statementMap ?? {})) {
      spans.push({ start: pos(st.start), end: endPos(st.end), count: entry.s?.[id] ?? 0, kind: "block" });
    }
    files.push({ file, spans });
  }
  return files;
}

/** The coverage provider the project has installed, as the package resolver finds it from the project (installed.ts). */
function vitestProvider(root: string): string | undefined {
  for (const name of ["coverage-v8", "coverage-istanbul"]) if (installedPackage(`@vitest/${name}`, projectFrom(root)) !== undefined) return `@vitest/${name}`;
  return undefined;
}

/* --------------------------------------------------------------- pytest */

interface CoverageJson {
  files?: Record<string, { executed_lines?: number[]; contexts?: Record<string, string[]> }>;
}

/**
 * coverage.py's JSON with contexts as executed files per test context. A
 * line's contexts name the tests that ran it (test_function contexts: the
 * test's qualified name); the empty context is import time and belongs to no
 * test.
 */
export function executedFromCoveragePy(json: CoverageJson, realRoot: string): Map<string, ExecutedFile[]> {
  const byContext = new Map<string, Map<string, Span[]>>();
  for (const [key, entry] of Object.entries(json.files ?? {})) {
    const file = projectPath(realRoot, key);
    if (file === undefined) continue;
    for (const [lineText, contexts] of Object.entries(entry.contexts ?? {})) {
      const line = Number(lineText) - 1;
      for (const context of contexts) {
        if (context === "") continue;
        const files = byContext.get(context) ?? new Map<string, Span[]>();
        const spans = files.get(file) ?? [];
        spans.push({ start: { line, character: 0 }, end: { line: line + 1, character: 0 }, count: 1, kind: "line" });
        files.set(file, spans);
        byContext.set(context, files);
      }
    }
  }
  return new Map([...byContext].map(([context, files]) => [context, [...files].map(([file, spans]) => ({ file, spans }))]));
}

/** Whether a coverage.py context names a reported test: its full name, or a dotted suffix of it. */
function contextNames(context: string, test: CapturedTest): boolean {
  const bare = context.split("|")[0]!;
  return test.fullName === bare || test.fullName.endsWith(`.${bare}`) || test.fullName.split("::").join(".").endsWith(`.${bare}`);
}

/* ------------------------------------------------------------- observer */

export interface Observing {
  runner: Runner | undefined;
  /** Undefined when nothing can be observed; the pass runs exactly as it would unobserved. */
  observer: BatchObserver | undefined;
  collect(): Capture;
}

/** The observer for the config's batched command, and how to collect what it captured. */
export function createObserver(root: string, config: EnforcementConfig): Observing {
  const realRoot = real(root);
  const runner = runnerOf(config);
  let report: JsonReport | undefined;
  const hand = (r: JsonReport | undefined): void => {
    report = r;
  };
  const nothing = (note: string): Observing => ({
    runner,
    observer: { wrap: (spec) => spec, report: hand },
    collect: () => ({ runner, attribution: "none", note, tests: reportedTests(report, realRoot) }),
  });
  if (config.testJson === undefined) {
    return { runner, observer: undefined, collect: () => ({ runner, attribution: "none", note: "no testJson command: observation rides only the one batched invocation, and the one-at-a-time pass is not observed", tests: [] }) };
  }
  if (runner === undefined) return nothing(`the batched command names no runner observation knows (node --test, vitest, pytest): ${commandText(config)}`);

  const dir = mkdtempSync(join(tmpdir(), "coherence-observe-"));
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });

  if (runner === "node:test") {
    const importFlag = `--import=${pathToFileURL(PRELOAD).href}`;
    return {
      runner,
      observer: {
        wrap: (spec: CommandSpec): CommandSpec => ({
          ...spec,
          env: {
            ...spec.env,
            NODE_OPTIONS: [process.env["NODE_OPTIONS"], importFlag].filter((v) => v !== undefined && v !== "").join(" "),
            COHERENCE_OBSERVE_DIR: dir,
            COHERENCE_OBSERVE_ROOT: realRoot,
          },
        }),
        report: hand,
      },
      collect: () => {
        try {
          const lines: ObservedTestLine[] = [];
          for (const name of readdirSync(dir)) {
            if (!name.endsWith(".jsonl")) continue;
            for (const text of readFileSync(join(dir, name), "utf8").split("\n")) if (text.trim() !== "") lines.push(JSON.parse(text) as ObservedTestLine);
          }
          const tests = joinNodeTest(lines, reportedTests(report, realRoot), realRoot);
          return { runner, attribution: "per test", note: "node:test: V8 precise coverage taken around each test in its own child", tests };
        } finally {
          cleanup();
        }
      },
    };
  }

  if (runner === "vitest") {
    const provider = vitestProvider(root);
    if (provider === undefined) {
      cleanup();
      return nothing("vitest attributes no coverage to a test, and no coverage provider is installed (@vitest/coverage-v8 or @vitest/coverage-istanbul): nothing observed");
    }
    const flags = ["--coverage.enabled=true", "--coverage.reporter=json", `--coverage.reportsDirectory=${dir}`, "--coverage.clean=true"];
    return {
      runner,
      observer: {
        wrap: (spec) => (spec.shell ? { ...spec, command: `${spec.command} ${flags.map((f) => `'${f}'`).join(" ")}` } : { ...spec, args: [...spec.args, ...flags] }),
        report: hand,
      },
      collect: () => {
        try {
          const path = join(dir, "coverage-final.json");
          const tests = reportedTests(report, realRoot);
          if (!existsSync(path)) return { runner, attribution: "none", note: `vitest with ${provider} wrote no coverage-final.json: nothing observed`, tests };
          const run = executedFromIstanbul(JSON.parse(readFileSync(path, "utf8")) as Record<string, IstanbulFile>, realRoot);
          return { runner, attribution: "per run", note: `vitest with ${provider}: coverage for the whole run; vitest attributes none to a test`, tests, run };
        } finally {
          cleanup();
        }
      },
    };
  }

  // pytest, through coverage.py's own runner around the same pytest invocation.
  const argv = Array.isArray(config.testJson) ? config.testJson : undefined;
  const at = argv === undefined ? -1 : argv.findIndex((arg, i) => arg === "-m" && argv[i + 1] === "pytest");
  if (argv === undefined || at < 1) {
    cleanup();
    return nothing("pytest is observed only when the batched command is an argv array running `<python> -m pytest`, so coverage.py can run the same invocation: nothing observed");
  }
  const python = argv[0]!;
  const probe = spawnSync(python, ["-c", "import coverage"], { encoding: "utf8" });
  if (probe.status !== 0) {
    cleanup();
    return nothing(`coverage.py is not installed in ${python}: nothing observed`);
  }
  const rc = join(dir, "coveragerc");
  writeFileSync(
    rc,
    ["[run]", "dynamic_context = test_function", `data_file = ${join(dir, "coverage.data")}`, `source = ${realRoot}`, "omit =", "    */.venv/*", "    */node_modules/*", "", "[json]", "show_contexts = True", ""].join("\n"),
  );
  return {
    runner,
    observer: {
      // argv positions 1..at-1 are the interpreter's own flags; the pytest argv after `-m pytest` is untouched.
      wrap: (spec) => ({ ...spec, args: [...spec.args.slice(0, at - 1), "-m", "coverage", "run", `--rcfile=${rc}`, ...spec.args.slice(at - 1)] }),
      report: hand,
    },
    collect: () => {
      try {
        const out = join(dir, "coverage.json");
        const exported = spawnSync(python, ["-m", "coverage", "json", `--rcfile=${rc}`, "--show-contexts", "-o", out], { cwd: root, encoding: "utf8" });
        const reported = reportedTests(report, realRoot);
        if (exported.status !== 0 || !existsSync(out)) return { runner, attribution: "none", note: `coverage.py wrote no JSON export (${exported.stderr.trim().split("\n").pop() ?? "no reason given"}): nothing observed`, tests: reported };
        const contexts = executedFromCoveragePy(JSON.parse(readFileSync(out, "utf8")) as CoverageJson, realRoot);
        const tests: CapturedTest[] = reported.map((t) => {
          const executed = [...contexts].filter(([context]) => contextNames(context, t)).flatMap(([, files]) => files);
          return { ...t, executed };
        });
        return { runner, attribution: "per test", note: "pytest: coverage.py dynamic contexts, one per test function", tests };
      } finally {
        cleanup();
      }
    },
  };
}
