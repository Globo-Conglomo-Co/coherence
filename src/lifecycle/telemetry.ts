/**
 * Fleet telemetry: opt-in, anonymous, off the tool path (d-c00e7997).
 *
 * Nothing is sent unless the user ran `coherence telemetry on`, which writes
 * a per-user file under the user's config directory ($XDG_CONFIG_HOME, or
 * ~/.config, then coherence/) holding a random installation id. A project's
 * `"telemetry": false`, DO_NOT_TRACK and COHERENCE_TELEMETRY=0 each refuse,
 * whatever the user chose. Two events exist, each checked against a schema of
 * allowed keys and values before it is queued and again before it is sent:
 * a summary of one session's hook cost, and a recorded defect's class,
 * origin and how it was caught, never its text.
 *
 * A hook never waits on any of it. Events go to a queue file beside the
 * settings; a session start or a stop with something to send starts
 * `telemetry flush` detached, which sends the queue in one POST to PostHog's
 * batch endpoint with a timeout and drops what it took, sent or not.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "./work-meter.ts";
import { CAUGHT as JOURNAL_CAUGHT } from "../journal/record.ts";
import { LANGUAGES } from "../adapters/index.ts";
import { effectiveConfig, registryForLeaf } from "../adapters/project-config.ts";
import { projectFiles } from "../adapters/project-files.ts";
import { readEnforcementConfig } from "../enforcement/config.ts";
import { loadSpecModel } from "../spec/model.ts";
import { HOOK_TIMES_DIR, type HookTime } from "./hook-latency.ts";
import { TELEMETRY_TARGET, TELEMETRY_TIMEOUT_MS, type TelemetryTarget } from "./telemetry-config.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export const SESSION_EVENT = "coherence session hooks";
export const DEFECT_EVENT = "coherence defect recorded";

/** The hook events a session summary may name: the host's events, never anything a project says. */
export const SUMMARY_EVENTS = ["SessionStart", "SubagentStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"] as const;
const STATS = ["count", "p50_ms", "p95_ms", "max_ms"] as const;
export const HOSTS = ["claude", "codex", "unknown"] as const;
export const PLATFORMS = ["darwin", "linux", "win32", "other"] as const;
export const FILE_BUCKETS = ["<1k", "1k-10k", "10k-100k", ">100k"] as const;
export const COMPONENT_BUCKETS = ["<10", "10-100", "100-1k", ">1k"] as const;
export const INTRODUCED = ["fix", "pre-existing", "unknown"] as const;
/** What caught a defect, as the journal declares it, and unknown for a value it does not. */
export const CAUGHT = [...JOURNAL_CAUGHT, "unknown"] as const;
/** A defect class is a short slug, a name from the defect classes Coherence keeps, never prose; anything else is sent as "other". */
const CLASS_FORM = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** A session summarized once it has been idle this long: it is over, not paused. */
const IDLE_MS = 30 * 60 * 1000;
/** How far back a collection looks, and how many sessions one collection summarizes at most. */
const COLLECT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const COLLECT_MOST = 20;
/** A batch file a flush left behind this long ago was from a flush that died: dropped, never sent. */
const STALE_SENDING_MS = 10 * 60 * 1000;
const REPORTED_KEPT = 2000;

export interface QueuedEvent {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

export interface TelemetrySettings {
  enabled: boolean;
  id?: string;
  /** When the user opted in: sessions last touched before it are never summarized. */
  since?: string;
}

// ---------------------------------------------------------------- where it lives

/** The user's config directory for Coherence: $XDG_CONFIG_HOME/coherence or ~/.config/coherence; never inside a project. */
export function telemetryDir(env: Env = process.env): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg !== "" ? xdg : join(env["HOME"] ?? homedir(), ".config");
  return join(base, "coherence");
}

export const settingsPath = (env: Env = process.env): string => join(telemetryDir(env), "telemetry.json");
export const queuePath = (env: Env = process.env): string => join(telemetryDir(env), "telemetry-queue.jsonl");
const reportedPath = (env: Env): string => join(telemetryDir(env), "telemetry-reported.json");
const factsPath = (env: Env): string => join(telemetryDir(env), "telemetry-facts.json");

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeJson(path: string, value: unknown, env: Env): void {
  mkdirSync(telemetryDir(env), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function readSettings(env: Env = process.env): TelemetrySettings {
  const value = readJson(settingsPath(env));
  if (typeof value !== "object" || value === null) return { enabled: false };
  const record = value as Record<string, unknown>;
  return {
    enabled: record["enabled"] === true,
    ...(typeof record["id"] === "string" ? { id: record["id"] } : {}),
    ...(typeof record["since"] === "string" ? { since: record["since"] } : {}),
  };
}

// ---------------------------------------------------------------- whether it is on

export interface TelemetryState {
  on: boolean;
  /** Why it is off, or "on". */
  reason: string;
  settings: TelemetrySettings;
}

export const truthy = (value: string | undefined): boolean => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
const refusing = (value: string | undefined): boolean => value !== undefined && ["0", "false", "off", "no"].includes(value.toLowerCase());

/** Whether the project at `root` refuses telemetry: its config, or its registry's, says "telemetry": false; a config that will not parse refuses too. */
export function projectRefuses(root: string): boolean {
  try {
    return effectiveConfig(root)?.record["telemetry"] === false;
  } catch {
    return true;
  }
}

/**
 * Whether anything may be queued or sent, and why not. The environment wins
 * over everything, then a build with no key, then the project, then the
 * user's own choice, which is off until they turn it on.
 */
export function telemetryState(root: string | undefined, env: Env = process.env, target: TelemetryTarget = TELEMETRY_TARGET): TelemetryState {
  const settings = readSettings(env);
  const off = (reason: string): TelemetryState => ({ on: false, reason, settings });
  if (truthy(env["DO_NOT_TRACK"])) return off("DO_NOT_TRACK is set");
  if (refusing(env["COHERENCE_TELEMETRY"])) return off("COHERENCE_TELEMETRY=0 is set");
  if (target.key === "") return off("telemetry is not configured for this build (no PostHog project key)");
  if (root !== undefined && projectRefuses(root)) return off('this project\'s coherence.config.json says "telemetry": false');
  if (!settings.enabled || settings.id === undefined) return off("off (run coherence telemetry on to opt in)");
  return { on: true, reason: "on", settings };
}

// ---------------------------------------------------------------- what is sent

/** The version of Coherence this is, from its own package.json; "0.0.0" when it cannot be read. */
export function coherenceVersion(): string {
  const value = readJson(fileURLToPath(new URL("../../package.json", import.meta.url)));
  const version = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["version"] : undefined;
  return typeof version === "string" && SEMVER.test(version) ? version : "0.0.0";
}
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,32})?$/;

/** The agent host a hook or a command runs under, from what the host leaves in the event and the environment. */
export function hostOf(input: Record<string, unknown>, env: Env = process.env): (typeof HOSTS)[number] {
  const transcript = typeof input["transcript_path"] === "string" ? input["transcript_path"] : "";
  if (transcript.includes("/.codex/") || env["CODEX_THREAD_ID"] !== undefined) return "codex";
  if (transcript.includes("/.claude/") || env["CLAUDECODE"] === "1" || env["CLAUDE_PROJECT_DIR"] !== undefined) return "claude";
  return "unknown";
}

export function platformOf(platform: string = process.platform): (typeof PLATFORMS)[number] {
  return (PLATFORMS as readonly string[]).includes(platform) ? (platform as (typeof PLATFORMS)[number]) : "other";
}

export function fileBucket(n: number): (typeof FILE_BUCKETS)[number] {
  return n < 1_000 ? "<1k" : n < 10_000 ? "1k-10k" : n < 100_000 ? "10k-100k" : ">100k";
}

export function componentBucket(n: number): (typeof COMPONENT_BUCKETS)[number] {
  return n < 10 ? "<10" : n < 100 ? "10-100" : n < 1_000 ? "100-1k" : ">1k";
}

/** The nearest-rank percentile of sorted values, rounded to a whole millisecond. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return Math.round(sorted[rank - 1]!);
}

/** Per hook event: how many calls, and their p50, p95 and max milliseconds, as flat properties. */
export function hookSummary(times: readonly HookTime[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of SUMMARY_EVENTS) {
    const ms = times.filter((t) => t.event === event).map((t) => t.ms).sort((a, b) => a - b);
    if (ms.length === 0) continue;
    out[`${event}_count`] = ms.length;
    out[`${event}_p50_ms`] = percentile(ms, 50);
    out[`${event}_p95_ms`] = percentile(ms, 95);
    out[`${event}_max_ms`] = Math.round(ms[ms.length - 1]!);
  }
  return out;
}

export interface ProjectFacts {
  languages: string[];
  files: (typeof FILE_BUCKETS)[number];
  components: (typeof COMPONENT_BUCKETS)[number];
  registry: boolean;
}

/** The project's languages and size as buckets: counted, never named. */
export function projectFacts(root: string): ProjectFacts {
  let languages: string[] = [];
  try {
    languages = [...readEnforcementConfig(root).languages];
  } catch {
    languages = [];
  }
  let files = 0;
  try {
    files = projectFiles(root).length;
  } catch {
    files = 0;
  }
  let components = 0;
  try {
    components = loadSpecModel(root).components.length;
  } catch {
    components = 0;
  }
  let registry = false;
  try {
    registry = registryForLeaf(root) !== undefined;
  } catch {
    registry = false;
  }
  return { languages, files: fileBucket(files), components: componentBucket(components), registry };
}

const rootKey = (root: string): string => createHash("sha256").update(root).digest("hex").slice(0, 16);

/** The facts the last collection counted for this project, kept locally so a defect's event does not walk the tree; counted now when none were kept. */
function keptFacts(root: string, env: Env): ProjectFacts {
  const kept = readJson(factsPath(env));
  const held = typeof kept === "object" && kept !== null ? (kept as Record<string, ProjectFacts>)[rootKey(root)] : undefined;
  if (held !== undefined) return held;
  const facts = projectFacts(root);
  keepFacts(root, facts, env);
  return facts;
}

function keepFacts(root: string, facts: ProjectFacts, env: Env): void {
  try {
    const kept = readJson(factsPath(env));
    const all = typeof kept === "object" && kept !== null ? (kept as Record<string, ProjectFacts>) : {};
    all[rootKey(root)] = facts;
    writeJson(factsPath(env), all, env);
  } catch {
    // The facts are a convenience; the next event counts again.
  }
}

function common(target: TelemetryTarget, host: string): Record<string, unknown> {
  return {
    $process_person_profile: false,
    team: target.team,
    version: coherenceVersion(),
    host,
    platform: platformOf(),
    node: Number(process.versions.node.split(".")[0]),
  };
}

export function sessionEvent(id: string, at: string, host: (typeof HOSTS)[number], facts: ProjectFacts, times: readonly HookTime[], target: TelemetryTarget = TELEMETRY_TARGET): QueuedEvent {
  return {
    event: SESSION_EVENT,
    distinct_id: id,
    timestamp: at,
    properties: { ...common(target, host), languages: facts.languages, files: facts.files, components: facts.components, registry: facts.registry, ...hookSummary(times) },
  };
}

/** What a defect record says of its class, origin and catch, read loosely: the defect verb's fields, unknown when absent. */
export interface DefectFields {
  class?: unknown;
  introduced?: unknown;
  caught?: unknown;
}

export function defectClass(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "unclassified";
  const slug = value.trim().toLowerCase();
  return CLASS_FORM.test(slug) ? slug : "other";
}

/** Only the kind of origin, never the commit or pull request it names. */
export function introducedKind(value: unknown): (typeof INTRODUCED)[number] {
  if (typeof value !== "string") return "unknown";
  const v = value.trim().toLowerCase();
  if (v === "pre-existing" || v === "preexisting") return "pre-existing";
  if (v.startsWith("fix") || /^[0-9a-f]{7,40}$/.test(v) || /^(#|pr[-:#]?)?\d+$/.test(v)) return "fix";
  return "unknown";
}

export function caughtKind(value: unknown): (typeof CAUGHT)[number] {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (CAUGHT as readonly string[]).includes(v) ? (v as (typeof CAUGHT)[number]) : "unknown";
}

export function defectEvent(id: string, at: string, host: (typeof HOSTS)[number], files: ProjectFacts["files"], fields: DefectFields, target: TelemetryTarget = TELEMETRY_TARGET): QueuedEvent {
  return {
    event: DEFECT_EVENT,
    distinct_id: id,
    timestamp: at,
    properties: { ...common(target, host), class: defectClass(fields.class), introduced: introducedKind(fields.introduced), caught: caughtKind(fields.caught), files },
  };
}

// ---------------------------------------------------------------- the schema

type Check = (value: unknown) => boolean;
const oneOf = (values: readonly string[]): Check => (v) => typeof v === "string" && values.includes(v);
const count: Check = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const COMMON_SCHEMA = (target: TelemetryTarget): Record<string, Check> => ({
  $process_person_profile: (v) => v === false,
  team: (v) => v === target.team,
  version: (v) => typeof v === "string" && SEMVER.test(v),
  host: oneOf(HOSTS),
  platform: oneOf(PLATFORMS),
  node: (v) => count(v) && (v as number) < 1000,
});

/** Every key each event may carry, with the values it may hold: a key outside these is a problem, so a new field fails until it is listed here. */
export function eventSchema(event: string, target: TelemetryTarget = TELEMETRY_TARGET): Record<string, Check> | undefined {
  if (event === SESSION_EVENT) {
    const hooks: Record<string, Check> = {};
    for (const e of SUMMARY_EVENTS) for (const s of STATS) hooks[`${e}_${s}`] = count;
    return {
      ...COMMON_SCHEMA(target),
      languages: (v) => Array.isArray(v) && v.length <= LANGUAGES.length && v.every((l) => (LANGUAGES as readonly string[]).includes(l)),
      files: oneOf(FILE_BUCKETS),
      components: oneOf(COMPONENT_BUCKETS),
      registry: (v) => typeof v === "boolean",
      ...hooks,
    };
  }
  if (event === DEFECT_EVENT) {
    return {
      ...COMMON_SCHEMA(target),
      class: (v) => typeof v === "string" && (CLASS_FORM.test(v) || v === "unclassified" || v === "other"),
      introduced: oneOf(INTRODUCED),
      caught: oneOf(CAUGHT),
      files: oneOf(FILE_BUCKETS),
    };
  }
  return undefined;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOP_KEYS = new Set(["event", "distinct_id", "timestamp", "properties"]);

/** What in an event lies outside the allowed schema; empty when every key and value is one the schema lists. */
export function schemaProblems(value: unknown, target: TelemetryTarget = TELEMETRY_TARGET): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["not an object"];
  const event = value as Record<string, unknown>;
  const problems = Object.keys(event).filter((k) => !TOP_KEYS.has(k)).map((k) => `key ${k} is not allowed`);
  const schema = typeof event["event"] === "string" ? eventSchema(event["event"], target) : undefined;
  if (schema === undefined) return [...problems, `event ${JSON.stringify(event["event"])} is not one Coherence sends`];
  if (typeof event["distinct_id"] !== "string" || !UUID_V4.test(event["distinct_id"])) problems.push("distinct_id is not a random installation id");
  if (typeof event["timestamp"] !== "string" || Number.isNaN(Date.parse(event["timestamp"]))) problems.push("timestamp is not a time");
  const properties = event["properties"];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return [...problems, "properties is not an object"];
  for (const [key, v] of Object.entries(properties)) {
    const check = schema[key];
    if (check === undefined) problems.push(`property ${key} is not allowed`);
    else if (!check(v)) problems.push(`property ${key} holds a value outside its schema`);
  }
  for (const required of ["$process_person_profile", "team", "version", "host"]) if (!(required in properties)) problems.push(`property ${required} is missing`);
  return problems;
}

// ---------------------------------------------------------------- the queue

/** Append one event to the queue: one line, whatever the queue holds; an event outside the schema is never queued. */
export function enqueue(event: QueuedEvent, env: Env = process.env, target: TelemetryTarget = TELEMETRY_TARGET): boolean {
  if (schemaProblems(event, target).length > 0) return false;
  mkdirSync(telemetryDir(env), { recursive: true });
  appendFileSync(queuePath(env), JSON.stringify(event) + "\n");
  return true;
}

function parseQueue(text: string): QueuedEvent[] {
  return text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      return [JSON.parse(line) as QueuedEvent];
    } catch {
      return [];
    }
  });
}

export function readQueue(env: Env = process.env): QueuedEvent[] {
  try {
    return parseQueue(readFileSync(queuePath(env), "utf8"));
  } catch {
    return [];
  }
}

function queueHolds(env: Env): boolean {
  try {
    return statSync(queuePath(env)).size > 0;
  } catch {
    return false;
  }
}

export function clearQueue(env: Env = process.env): void {
  try {
    unlinkSync(queuePath(env));
  } catch {
    // nothing queued
  }
}

/** The request body a flush POSTs to the batch endpoint: what `telemetry show` prints. */
export function batchBody(events: readonly QueuedEvent[], target: TelemetryTarget = TELEMETRY_TARGET): { api_key: string; batch: QueuedEvent[] } {
  return { api_key: target.key, batch: [...events] };
}

// ---------------------------------------------------------------- opting in and out

export function optIn(env: Env = process.env, now: () => Date = () => new Date()): TelemetrySettings {
  const settings: TelemetrySettings = { enabled: true, id: randomUUID(), since: now().toISOString() };
  clearQueue(env);
  writeJson(settingsPath(env), settings, env);
  return settings;
}

/** Off forgets the id and drops the queue: nothing already queued leaves after the user said no. */
export function optOut(env: Env = process.env): void {
  clearQueue(env);
  writeJson(settingsPath(env), { enabled: false }, env);
}

/** A new installation id; what was queued under the old one is dropped, never sent under either. */
export function resetId(env: Env = process.env): TelemetrySettings {
  const settings = readSettings(env);
  const next: TelemetrySettings = { ...settings, id: randomUUID() };
  clearQueue(env);
  writeJson(settingsPath(env), next, env);
  return next;
}

// ---------------------------------------------------------------- collecting sessions

function reported(env: Env): string[] {
  const value = readJson(reportedPath(env));
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const sessionKey = (root: string, file: string): string => createHash("sha256").update(`${root}\0${file}`).digest("hex").slice(0, 24);
const sessionFileName = (session: string): string => `${session.replace(/[^\w.-]/g, "_")}.jsonl`;

/** The hook-time files of sessions in this project that are over, touched since the opt-in, and never summarized. */
export function pendingSessions(root: string, current: string | undefined, env: Env = process.env, now: () => number = Date.now): string[] {
  const state = telemetryState(root, env);
  if (!state.on) return [];
  const dir = join(root, HOOK_TIMES_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const since = Math.max(Date.parse(state.settings.since ?? "") || 0, now() - COLLECT_WINDOW_MS);
  const done = new Set(reported(env));
  const own = current === undefined ? undefined : sessionFileName(current);
  const found: string[] = [];
  for (const name of names) {
    if (name === own || done.has(sessionKey(root, name))) continue;
    try {
      const mtime = statSync(join(dir, name)).mtimeMs;
      if (mtime >= since && mtime < now() - IDLE_MS) found.push(name);
    } catch {
      continue;
    }
  }
  return found.sort().slice(0, COLLECT_MOST);
}

function readTimes(path: string): HookTime[] {
  try {
    return readFileSync(path, "utf8").split("\n").flatMap((line) => {
      try {
        const t = JSON.parse(line) as Partial<HookTime>;
        return typeof t.at === "string" && typeof t.event === "string" && typeof t.ms === "number" ? [t as HookTime] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** Queue one summary for each session that is over; runs in the detached flush, never in a hook. Returns how many were queued. */
export function collectSessions(root: string, current: string | undefined, host: (typeof HOSTS)[number], env: Env = process.env, now: () => number = Date.now): number {
  const state = telemetryState(root, env);
  if (!state.on || state.settings.id === undefined) return 0;
  const names = pendingSessions(root, current, env, now);
  if (names.length === 0) return 0;
  const facts = projectFacts(root);
  keepFacts(root, facts, env);
  const done = reported(env);
  let queued = 0;
  for (const name of names) {
    const times = readTimes(join(root, HOOK_TIMES_DIR, name));
    done.push(sessionKey(root, name));
    if (times.length === 0) continue;
    if (enqueue(sessionEvent(state.settings.id, times[times.length - 1]!.at, host, facts, times), env)) queued++;
  }
  writeJson(reportedPath(env), done.slice(-REPORTED_KEPT), env);
  return queued;
}

/** The defect verb's one call: queue the defect's event when telemetry is on; never throws, never sends. */
export function recordDefectTelemetry(root: string, record: object, env: Env = process.env, now: () => Date = () => new Date()): void {
  try {
    const state = telemetryState(root, env);
    if (!state.on || state.settings.id === undefined) return;
    const fields: DefectFields = record;
    enqueue(defectEvent(state.settings.id, now().toISOString(), hostOf({}, env), keptFacts(root, env).files, fields), env);
  } catch {
    // Telemetry is never part of the record's write.
  }
}

// ---------------------------------------------------------------- flushing

/** Sends one batch; resolves true when PostHog accepted it. Tests pass their own and never reach the network. */
export type Sender = (url: string, body: string, timeoutMs: number) => Promise<boolean>;

export const FETCH_SENDER: Sender = async (url, body, timeoutMs) => {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
};

export interface FlushResult {
  sent: number;
  dropped: number;
  ok: boolean;
}

/**
 * Take the queue and send it in one POST, then drop it whatever the answer:
 * one attempt, no retry. The queue is renamed away first, so an event
 * appended while the batch is in flight waits for the next flush.
 */
export async function flushQueue(env: Env = process.env, send: Sender = FETCH_SENDER, target: TelemetryTarget = TELEMETRY_TARGET, now: () => number = Date.now): Promise<FlushResult> {
  const dir = telemetryDir(env);
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("telemetry-queue.") || !name.endsWith(".sending")) continue;
      const path = join(dir, name);
      if (now() - statSync(path).mtimeMs > STALE_SENDING_MS) unlinkSync(path);
    }
  } catch {
    // no folder, nothing left behind
  }
  const state = telemetryState(undefined, env, target);
  if (!state.on || !queueHolds(env)) return { sent: 0, dropped: 0, ok: true };
  const taken = join(dir, `telemetry-queue.${process.pid}.${now()}.sending`);
  try {
    renameSync(queuePath(env), taken);
  } catch {
    return { sent: 0, dropped: 0, ok: true };
  }
  try {
    const all = parseQueue(readFileSync(taken, "utf8"));
    // An event written under another id (before a reset) or outside the schema is dropped, never sent.
    const events = all.filter((e) => e.distinct_id === state.settings.id && schemaProblems(e, target).length === 0);
    if (events.length === 0) return { sent: 0, dropped: all.length, ok: true };
    const ok = await send(`${target.host.replace(/\/+$/, "")}/batch/`, JSON.stringify(batchBody(events, target)), TELEMETRY_TIMEOUT_MS);
    return { sent: ok ? events.length : 0, dropped: all.length - (ok ? events.length : 0), ok };
  } finally {
    try {
      unlinkSync(taken);
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------- the hook's one call

/** This checkout's cli, which the detached flush runs. */
const OWN_CLI = fileURLToPath(new URL(`../cli${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

export type Spawner = (command: string, args: string[], options: { cwd: string; detached: true; stdio: "ignore" }) => { on(event: "error", listener: () => void): unknown; unref(): void };

/**
 * At a session start or a stop: start the detached flush when telemetry is
 * on and something waits to go, a queued event or (at a start) a session
 * that is over and never summarized. Returns at once, never waits on the
 * child, and never throws into the hook.
 */
export function startTelemetry(root: string, event: string, input: Record<string, unknown>, env: Env = process.env, spawner: Spawner = spawn as unknown as Spawner): boolean {
  try {
    if (event !== "SessionStart" && event !== "Stop") return false;
    if (!telemetryState(root, env).on) return false;
    const session = typeof input["session_id"] === "string" && input["session_id"] !== "" ? input["session_id"] : undefined;
    const collect = event === "SessionStart" && pendingSessions(root, session, env).length > 0;
    if (!collect && !queueHolds(env)) return false;
    const args = ["--disable-warning=ExperimentalWarning", OWN_CLI, "telemetry", "flush", "--root", root, "--host", hostOf(input, env)];
    if (collect) args.push("--collect", ...(session === undefined ? [] : ["--current", session]));
    const child = spawner(process.execPath, args, { cwd: root, detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
