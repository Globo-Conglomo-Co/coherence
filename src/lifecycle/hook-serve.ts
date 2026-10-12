/**
 * The warm hook process: `coherence hook-serve`, one long-lived process per
 * agent-host session that answers hook events with the same runHook that
 * `coherence hook <event>` runs, so a session pays for loading Coherence's
 * code once instead of once per event.
 *
 * Requests and answers are JSON, one per line, on stdin and stdout; with
 * `--socket` the same requests are also taken as HTTP POSTs over a Unix socket
 * in a private folder of its own (mode 0700), whose path is the first line it
 * prints. Claude Code's mods reach a child only that way: `$.process.spawn`
 * writes a child's stdin once and closes it.
 *
 *   {"id":1,"op":"hook","event":"PostToolUse","input":{...}}
 *   {"id":1,"stdout":"...","stderr":"","exit":0,"ms":12}
 *
 * An answer is the one the per-event hook prints: the same stdout, stderr and
 * exit code, and the same records (hook times, firings, journal), committed
 * once the answer was written, as the command line commits once its stdout
 * was accepted. An edit's check also says its verdict as data (`verdict`), for
 * a host that marks the tool call's row where the user alone reads it.
 *
 * One event at a time: runHook keeps one event's spec model and work scope in
 * module state, so two at once would share them. Code that changed on disk
 * since the process loaded answers `stale` and the process exits, so a client
 * never hears from old code: it runs that event through the command line and
 * starts a fresh process.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { codeFingerprint } from "../enforcement/code-fingerprint.ts";
import { withWarmAdapter } from "../enforcement/run.ts";
import { isHookEvent, runHook, type EditVerdict, type HookInput, type HookOptions } from "./hook.ts";
import { coherenceVersion } from "./hook-latency.ts";
import { readStatus, statusText } from "./statusline.ts";

export interface ServeRequest {
  id?: unknown;
  /** `hook` (the default), `status`, `scope` or `ping`. */
  op?: unknown;
  event?: unknown;
  input?: unknown;
}

export type ServeAnswer = { id: unknown } & (
  | { stdout: string; stderr: string; exit: number; ms: number; verdict?: EditVerdict }
  | { status: string }
  | { url: string }
  | { pong: { pid: number; version: string | null; code: string } }
  | { stale: string }
  | { error: string }
);

export interface ServeOptions {
  /** What runHook is given besides `startedAt`, which is each request's arrival: the command line's refresh, warm-up, telemetry and update check. */
  hook?: Omit<HookOptions, "startedAt" | "onEditCheck">;
  /** The identity of the code on disk; codeFingerprint by default (a test stands in its own). */
  fingerprint?: () => string;
  /** Start or attach the root's warm server and answer its live Scope address; the enforcement door's by default. */
  scope?: (root: string) => Promise<string>;
}

export interface HookServer {
  /**
   * Answer one request: the answer is handed to `write`, and only once
   * `write` resolved are the event's records committed. Requests run one at a
   * time in arrival order. Resolves whether the process should now exit.
   */
  serve(request: ServeRequest, write: (answer: ServeAnswer) => Promise<void>): Promise<{ exit: boolean }>;
}

/** The live Scope address through enforcement's one door, as `coherence scope` opens it. */
async function scopeUrl(root: string): Promise<string> {
  return withWarmAdapter(root, async (remote, _server, reason) => {
    if (remote === undefined) throw new Error(`the warm server did not start (${reason ?? "no reason given"})`);
    return (await remote.openHttp()).url;
  });
}

export function hookServer(root: string, options: ServeOptions = {}): HookServer {
  const fingerprint = options.fingerprint ?? codeFingerprint;
  const loaded = fingerprint();
  let queue: Promise<unknown> = Promise.resolve();

  async function one(request: ServeRequest, write: (answer: ServeAnswer) => Promise<void>): Promise<{ exit: boolean }> {
    const arrived = Date.now();
    const id = request.id ?? null;
    const op = request.op ?? "hook";
    const now = fingerprint();
    if (now !== loaded) {
      await write({ id, stale: `Coherence's code changed on disk since this process loaded it (${loaded} → ${now}); run this event through \`coherence hook\` and start a fresh process` });
      return { exit: true };
    }
    if (op === "ping") {
      await write({ id, pong: { pid: process.pid, version: coherenceVersion(), code: loaded } });
      return { exit: false };
    }
    const input = (typeof request.input === "object" && request.input !== null && !Array.isArray(request.input) ? request.input : {}) as HookInput;
    if (op === "status") {
      await write({ id, status: statusText(readStatus(input), false, false) });
      return { exit: false };
    }
    if (op === "scope") {
      try {
        await write({ id, url: await (options.scope ?? scopeUrl)(root) });
      } catch (error) {
        await write({ id, error: `scope: ${error instanceof Error ? error.message : String(error)}` });
      }
      return { exit: false };
    }
    if (op !== "hook" || typeof request.event !== "string" || !isHookEvent(request.event)) {
      await write({ id, error: `expected op hook, status, scope or ping, and for a hook one of its events; got op ${JSON.stringify(op)}, event ${JSON.stringify(request.event)}` });
      return { exit: false };
    }
    let verdict: EditVerdict | undefined;
    const result = await runHook(request.event, input, root, { ...options.hook, startedAt: arrived, onEditCheck: (v) => (verdict = v) });
    // Committed only once the answer was written, as the command line commits once its stdout was accepted: an unwritten feed is shown again.
    await write({ id, stdout: result.stdout, stderr: result.stderr, exit: result.exit, ms: Date.now() - arrived, ...(verdict === undefined ? {} : { verdict }) });
    result.commit?.();
    return { exit: false };
  }

  return {
    serve(request, write) {
      const answered = queue.then(() => one(request, write));
      queue = answered.catch(() => undefined);
      return answered;
    },
  };
}

/** Parse one request line; a line that is not a JSON object is answered with an error, never dropped. */
export function parseRequest(text: string): ServeRequest | { error: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as ServeRequest;
    return { error: "a request is one JSON object" };
  } catch (error) {
    return { error: `a request is one JSON object (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** How often the process looks for its parent: one whose parent is gone (reparented to init) exits. */
const ORPHAN_CHECK_MS = 5_000;

/**
 * Run the process: answer lines on stdin until it closes and, with a socket,
 * HTTP requests until the parent is gone. Resolves the exit code.
 */
export async function runHookServe(root: string, options: ServeOptions & { socket: boolean }): Promise<number> {
  const server = hookServer(root, options);
  const writeLine = (text: string): Promise<void> =>
    new Promise((resolve, reject) => process.stdout.write(`${text}\n`, (error) => (error ? reject(error) : resolve())));
  let http: Server | undefined;
  let folder: string | undefined;
  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => (finish = resolve));
  const end = (code: number): void => {
    http?.close();
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
    finish(code);
  };
  const parent = process.ppid;
  const orphan = setInterval(() => {
    if (process.ppid !== parent) end(0);
  }, ORPHAN_CHECK_MS);
  orphan.unref();
  // The host ends the process with a signal as its session ends: the socket's folder goes with it.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => end(0));

  if (options.socket) {
    folder = mkdtempSync(join(tmpdir(), "coh-"));
    const socket = join(folder, "hook.sock");
    http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const parsed = parseRequest(Buffer.concat(chunks).toString("utf8"));
        const write = (answer: ServeAnswer): Promise<void> =>
          new Promise((resolve, reject) => {
            res.once("error", reject);
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer), () => resolve());
          });
        if ("error" in parsed && typeof parsed.error === "string") {
          void write({ id: null, error: parsed.error });
          return;
        }
        server.serve(parsed as ServeRequest, write).then(
          ({ exit }) => exit && end(0),
          (error: unknown) => {
            if (!res.headersSent) void write({ id: (parsed as ServeRequest).id ?? null, error: error instanceof Error ? error.message : String(error) });
          },
        );
      });
    });
    await new Promise<void>((resolve) => http!.listen(socket, resolve));
    await writeLine(JSON.stringify({ ready: { socket, pid: process.pid, version: coherenceVersion() } }));
  }

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    const parsed = parseRequest(line);
    if ("error" in parsed && typeof parsed.error === "string") {
      void writeLine(JSON.stringify({ id: null, error: parsed.error }));
      return;
    }
    const request = parsed as ServeRequest;
    server.serve(request, (answer) => writeLine(JSON.stringify(answer))).then(
      ({ exit }) => exit && end(0),
      (error: unknown) => void writeLine(JSON.stringify({ id: request.id ?? null, error: error instanceof Error ? error.message : String(error) })),
    );
  });
  // Without a socket stdin is the only way in: once it closes and the last answer is out, the process is done.
  lines.on("close", () => {
    if (!options.socket) void server.serve({ op: "ping" }, async () => {}).then(() => end(0));
  });
  return finished;
}
