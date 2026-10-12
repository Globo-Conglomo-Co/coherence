/**
 * Read traces: the files a session explicitly read, recorded at tool
 * boundaries, and snapshotted at Stop against the patch and the economy
 * prediction. One JSONL file per session under .coherence/traces, append
 * only; it exists only as calibrate's input.
 *
 *   read      one line per PostToolUse of a reading tool that named a file
 *             under the root
 *   write     one line per PostToolUse that wrote files under the root (an
 *             edit tool, a patch, or a shell command that writes)
 *   snapshot  one line at Stop: the files the session itself wrote that
 *             still exist and the config does not ignore, the distinct files
 *             it read, and the closure predicted for what it wrote
 *
 * The hook calls recordReadTrace on PostToolUse and snapshotTrace on Stop;
 * the two call sites live in the hook, not here. Traces are not committed:
 * git ignores .coherence/* except the listed record folders, and traces are
 * per session and larger than a journal, so they stay on the machine the
 * session ran on.
 */

import { execFileSync } from "../lifecycle/work-meter.ts";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LanguageAdapter } from "../adapters/adapter.ts";
import { configIgnore, keepProjectFiles, projectListing, underIgnored } from "../adapters/project-files.ts";
import type { HookInput } from "../lifecycle/hook.ts";
import { readerNaming } from "../lifecycle/host-tools.ts";
import type { SpecModel } from "../spec/model.ts";
import { predictClosure, type Instrument } from "./closure.ts";
import { toRelative } from "./source.ts";

export const TRACES_DIR = join(".coherence", "traces");


const SESSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ReadLine {
  kind: "read";
  at: string;
  session: string;
  file: string;
}

export interface Snapshot {
  kind: "snapshot";
  at: string;
  session: string;
  commit: string | null;
  /** The patch: the files the session wrote (a snapshot older than write lines holds the working tree against HEAD, plus untracked). */
  changed: string[];
  /** The distinct files the session read before this snapshot. */
  read: string[];
  /** The closure predicted for the changed files. */
  predicted: string[];
  tokens: number;
  instrument: Instrument;
}

/** Files one tool use wrote: the session's own patch, as the hook saw it, never another session's or a person's edits. */
export interface WriteLine {
  kind: "write";
  at: string;
  session: string;
  files: string[];
}

export type TraceLine = ReadLine | WriteLine | Snapshot;

export function tracesDir(root: string): string {
  return join(root, TRACES_DIR);
}

export function traceFile(root: string, session: string): string {
  if (!SESSION_TOKEN.test(session)) throw new Error(`session "${session}" cannot name a file; use letters, digits, dot, dash, or underscore`);
  return join(tracesDir(root), `${session}.jsonl`);
}

function append(root: string, line: TraceLine): string {
  const file = traceFile(root, line.session);
  mkdirSync(tracesDir(root), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  return file;
}

/** The project-relative file a reading tool event read, or undefined when the event read no file under the root. */
export function readFileOf(root: string, input: HookInput): string | undefined {
  // Which tools read, and the field each names its file in, is host-tools.ts's.
  const field = readerNaming(input.tool_name);
  const toolInput = input.tool_input;
  if (field === undefined || typeof toolInput !== "object" || toolInput === null) return undefined;
  const path = (toolInput as Record<string, unknown>)[field];
  if (typeof path !== "string" || path === "") return undefined;
  const rel = toRelative(root, path);
  if (rel === undefined || rel.startsWith(".git/") || rel.startsWith("node_modules/")) return undefined;
  try {
    if (!statSync(resolve(root, rel)).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return rel;
}

export interface TraceOptions {
  now?: (() => Date) | undefined;
}

/**
 * Record one read from a PostToolUse event. Returns the file recorded, or
 * undefined when the event was not a read of a file under the root.
 */
export function recordReadTrace(root: string, session: string, input: HookInput, options: TraceOptions = {}): string | undefined {
  const file = readFileOf(root, input);
  if (file === undefined) return undefined;
  const at = (options.now ?? (() => new Date()))().toISOString();
  append(root, { kind: "read", at, session, file });
  return file;
}

/** Record the files a tool use wrote, when it wrote any; the hook hands in what writtenFiles read from the event. */
export function recordWriteTrace(root: string, session: string, files: readonly string[], options: TraceOptions = {}): void {
  if (files.length === 0 || !SESSION_TOKEN.test(session)) return;
  const at = (options.now ?? (() => new Date()))().toISOString();
  append(root, { kind: "write", at, session, files: [...files] });
}

/** The distinct files a session's trace says it wrote, sorted. */
export function filesWritten(root: string, session: string): string[] {
  const file = traceFile(root, session);
  if (!existsSync(file)) return [];
  const found = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const parsed = parseLine(line);
    if (typeof parsed !== "string" && parsed.kind === "write") for (const f of parsed.files) found.add(f);
  }
  return [...found].sort();
}

/**
 * The session's own patch at a stop: the files its tool uses wrote that are
 * still files, are the project's own, and lie outside every folder the
 * config ignores. Another session's edits and a person's uncommitted work
 * are not this session's change, so they are never predicted for.
 */
export function sessionPatch(root: string, session: string): string[] {
  const written = filesWritten(root, session).filter((f) => {
    try {
      return statSync(resolve(root, f)).isFile();
    } catch {
      return false;
    }
  });
  if (written.length === 0) return [];
  const skip = new Set(configIgnore(root));
  const own = keepProjectFiles(root, written, projectListing(root));
  return written.filter((f) => own.has(f) && !underIgnored(f, skip)).sort();
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Files changed in the working tree at `root`: modified against HEAD plus untracked. Empty outside git. */
export function patchFiles(root: string): string[] {
  const diff = git(root, ["diff", "--name-only", "--relative", "HEAD"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
  if (diff === null && untracked === null) return [];
  const all = [...new Set(`${diff ?? ""}\n${untracked ?? ""}`.split("\n").map((l) => l.trim()).filter((l) => l !== ""))];
  // Only the project's own files (a nested repository lists as one folder entry, never the project's); a deletion stays.
  const own = keepProjectFiles(root, all);
  return all.filter((f) => own.has(f) || !existsSync(join(root, f))).sort();
}

export interface SessionTrace {
  session: string;
  reads: ReadLine[];
  writes: WriteLine[];
  snapshots: Snapshot[];
}

export interface LoadedTraces {
  sessions: SessionTrace[];
  damaged: { file: string; line: number; reason: string }[];
}

export function loadTraces(root: string): LoadedTraces {
  const dir = tracesDir(root);
  const loaded: LoadedTraces = { sessions: [], damaged: [] };
  if (!existsSync(dir)) return loaded;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    const session: SessionTrace = { session: name.slice(0, -".jsonl".length), reads: [], writes: [], snapshots: [] };
    readFileSync(join(dir, name), "utf8").split("\n").forEach((line, index) => {
      if (line.trim() === "") return;
      const parsed = parseLine(line);
      if (typeof parsed === "string") loaded.damaged.push({ file: join(TRACES_DIR, name), line: index + 1, reason: parsed });
      else if (parsed.kind === "read") session.reads.push(parsed);
      else if (parsed.kind === "write") session.writes.push(parsed);
      else session.snapshots.push(parsed);
    });
    loaded.sessions.push(session);
  }
  return loaded;
}

function parseLine(line: string): TraceLine | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return `not JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not a trace line";
  const record = value as Record<string, unknown>;
  for (const field of ["kind", "at", "session"]) if (typeof record[field] !== "string") return `missing ${field}`;
  if (Number.isNaN(Date.parse(record["at"] as string))) return `unreadable time "${String(record["at"])}"`;
  if (record["kind"] === "read") return typeof record["file"] === "string" ? (value as ReadLine) : "read line names no file";
  if (record["kind"] === "write") return Array.isArray(record["files"]) && record["files"].every((f) => typeof f === "string") ? (value as WriteLine) : "write line names no files";
  if (record["kind"] === "snapshot") {
    for (const field of ["changed", "read", "predicted"]) if (!Array.isArray(record[field])) return `snapshot missing ${field}`;
    return value as Snapshot;
  }
  return `unknown kind "${String(record["kind"])}"`;
}

/** The distinct files a session's trace says it read, sorted. */
export function filesRead(root: string, session: string): string[] {
  const file = traceFile(root, session);
  if (!existsSync(file)) return [];
  const found = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const parsed = parseLine(line);
    if (typeof parsed !== "string" && parsed.kind === "read") found.add(parsed.file);
  }
  return [...found].sort();
}

export interface SnapshotOptions extends TraceOptions {
  adapter?: LanguageAdapter | undefined;
  server?: "cold" | "warm" | undefined;
  instrumentReason?: string | undefined;
  model?: SpecModel | undefined;
  /** The patch, when the caller already has it. */
  changed?: readonly string[] | undefined;
}

/**
 * Snapshot a session at Stop: the patch, what was read, and the closure
 * predicted for the patch. Nothing is written when the session neither read
 * nor changed a file; the snapshot is returned otherwise.
 */
export async function snapshotTrace(root: string, session: string, options: SnapshotOptions = {}): Promise<Snapshot | undefined> {
  const changed = [...(options.changed ?? sessionPatch(root, session))].filter((f) => {
    try {
      return statSync(resolve(root, f)).isFile();
    } catch {
      return false;
    }
  });
  const read = filesRead(root, session);
  if (changed.length === 0 && read.length === 0) return undefined;
  let predicted: string[] = [];
  let tokens = 0;
  let instrument: Instrument = { language: "unknown", server: "none", reason: options.instrumentReason ?? "no adapter" };
  if (changed.length > 0) {
    try {
      const closure = await predictClosure(root, changed, { adapter: options.adapter, server: options.server, instrumentReason: options.instrumentReason, model: options.model });
      predicted = closure.entries.map((e) => e.file);
      tokens = closure.tokens;
      instrument = closure.instrument;
    } catch (error) {
      instrument = { language: "unknown", server: "none", reason: `prediction failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const at = (options.now ?? (() => new Date()))().toISOString();
  const snapshot: Snapshot = { kind: "snapshot", at, session, commit: git(root, ["rev-parse", "--short", "HEAD"]), changed, read, predicted, tokens, instrument };
  append(root, snapshot);
  return snapshot;
}
