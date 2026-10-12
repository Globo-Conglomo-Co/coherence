/**
 * The upgrade test over the network: `npm run test:upgrade`. It installs the
 * previous published release of Coherence into a small adopter project, uses
 * it the way an adopter does (hooks, spec --check, run, refute, enact of every
 * kernel practice and of its own, decide, every hook event), then upgrades the
 * project to this checkout through `npm pack`, the way the adopter's next
 * `npm install` would, and asserts that nothing the adopter already did is
 * turned against it.
 *
 * It needs the npm registry to fetch the previous release, so neither
 * `npm test` nor the totality oracle pass runs it; the Upgrade workflow
 * (.github/workflows/upgrade.yml) does, from the newest release and from the
 * oldest still supported. The offline half, every kernel practice of every
 * tagged release read from git history, is upgrade.test.ts.
 *
 *   COHERENCE_UPGRADE_FROM  the previous release: a published version or a .tgz
 *                           (default: the newest published version not above
 *                           package.json's)
 *   COHERENCE_UPGRADE_TO    the release under test: a checkout to pack, or a .tgz
 *                           (default: this checkout)
 *   COHERENCE_UPGRADE_KEEP  set to keep the fixture folder for inspection
 *
 * The motivating defect: 1.5.0 amended a kernel practice in Coherence's own
 * tree, and every adopter that had enacted the earlier version was refused
 * at enact until it recorded an amend decision for a change it never made
 * (df-36efa8f2).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EARLIER_SEARCH, earlierMatcher, searchesCheckoutFirst } from "./version.ts";
import { writersUnmatched } from "./host-tools.ts";
import { RECORD_STORES } from "./project.ts";
import { ATTRIBUTES_FILE, ATTRIBUTES_TEXT } from "./state-files.ts";

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE = "@posthog/coherence";
const KERNEL_PREFIX = "coherence:";
const OWN_PRACTICE = "src/tokens/rotate a token";
const INVARIANT = "sealed display";
const AGENT = "upgrade-test";

interface Ran {
  label: string;
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything the test ran, in order, printed whole when an assertion fails. */
const transcript: Ran[] = [];

function sh(label: string, command: string, args: string[], cwd: string, input?: string, env: NodeJS.ProcessEnv = {}): Ran {
  // NODE_TEST_CONTEXT would make the fixture's own node --test think it runs inside this one, and skip its files.
  const inherited = { ...process.env };
  delete inherited["NODE_TEST_CONTEXT"];
  delete inherited["COHERENCE_HOME"];
  // No hook or command of the fixture starts a warm instrument in the background: what it starts in the foreground is stopped before the folder goes.
  const result = spawnSync(command, args, { cwd, input, encoding: "utf8", env: { ...inherited, ...env, COHERENCE_NO_WARM_UP: "1" }, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  const ran: Ran = { label, code: result.status ?? (result.error ? 127 : 1), stdout: result.stdout ?? "", stderr: (result.stderr ?? "") + (result.error ? `\n${result.error.message}` : "") };
  transcript.push(ran);
  return ran;
}

function shown(ran: Ran): string {
  return `$ ${ran.label}\n  exit ${ran.code}\n  stdout:\n${indent(ran.stdout)}\n  stderr:\n${indent(ran.stderr)}`;
}

function indent(text: string): string {
  const lines = text.trimEnd().split("\n");
  const kept = lines.length > 120 ? [...lines.slice(0, 60), `... ${lines.length - 120} lines ...`, ...lines.slice(-60)] : lines;
  return kept.map((l) => `    ${l}`).join("\n");
}

function newer(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** The previous release: the env's choice, else the newest published version not above package.json's. */
function previousRelease(): string {
  const chosen = process.env["COHERENCE_UPGRADE_FROM"];
  if (chosen !== undefined && chosen !== "") return chosen.endsWith(".tgz") ? resolve(chosen) : `${PACKAGE}@${chosen}`;
  const own = (JSON.parse(readFileSync(join(CHECKOUT, "package.json"), "utf8")) as { version: string }).version;
  const listed = sh(`npm view ${PACKAGE} versions --json`, "npm", ["view", PACKAGE, "versions", "--json"], CHECKOUT);
  assert.equal(listed.code, 0, shown(listed));
  const versions = (JSON.parse(listed.stdout) as string[]).filter((v) => !v.includes("-") && newer(v, own) <= 0).sort(newer);
  const latest = versions.at(-1);
  assert.ok(latest !== undefined, `no published ${PACKAGE} at or below ${own}`);
  return `${PACKAGE}@${latest}`;
}

/**
 * The previous release's optional dependencies, each pinned to the lowest
 * version its range admits. A published package carries no lockfile, so this
 * is what holds the language server and the compiler still from one run to
 * the next; a range with no plain floor is left to npm.
 */
function pinnedOptionals(previous: string, cwd: string): string[] {
  const viewed = sh(`npm view ${previous} optionalDependencies --json`, "npm", ["view", previous, "optionalDependencies", "--json"], cwd);
  if (viewed.code !== 0 || viewed.stdout.trim() === "") return [];
  const ranges = JSON.parse(viewed.stdout) as Record<string, string>;
  return Object.entries(ranges).flatMap(([name, range]) => {
    const floor = /^[\^~]?(\d+\.\d+\.\d+)$/.exec(range.trim())?.[1];
    return floor === undefined ? [] : [`${name}@${floor}`];
  });
}

/** The release under test as a tarball: built, then packed from a checkout as npm publishes it, or the env's .tgz. */
function currentTarball(scratch: string): { tarball: string; version: string } {
  const chosen = process.env["COHERENCE_UPGRADE_TO"];
  if (chosen !== undefined && chosen.endsWith(".tgz")) {
    const listed = sh(`tar -xOzf ${chosen} package/package.json`, "tar", ["-xOzf", resolve(chosen), "package/package.json"], scratch);
    assert.equal(listed.code, 0, shown(listed));
    return { tarball: resolve(chosen), version: (JSON.parse(listed.stdout) as { version: string }).version };
  }
  const from = chosen !== undefined && chosen !== "" ? resolve(chosen) : CHECKOUT;
  const out = join(scratch, "pack");
  mkdirSync(out, { recursive: true });
  // The build first, so the pack runs no script and its stdout is npm's JSON alone.
  const built = sh(`npm run build (${from})`, "npm", ["run", "build"], from);
  assert.equal(built.code, 0, shown(built));
  const packed = sh(`npm pack ${from}`, "npm", ["pack", from, "--ignore-scripts", "--pack-destination", out, "--json"], from);
  assert.equal(packed.code, 0, shown(packed));
  const report = JSON.parse(packed.stdout) as { filename: string; version: string }[];
  assert.equal(report.length, 1, `npm pack reported ${report.length} packages\n${shown(packed)}`);
  const tarballs = readdirSync(out).filter((f) => f.endsWith(".tgz"));
  assert.deepEqual(tarballs, [report[0]!.filename.replace(/^@/, "").replace("/", "-")], `npm pack named ${report[0]!.filename}, the folder holds ${tarballs.join(", ")}`);
  return { tarball: join(out, tarballs[0]!), version: report[0]!.version };
}

const TSCONFIG = JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true, types: ["node"] }, include: ["src/**/*.ts"] }, null, 2);

const STORE = `/** Every token the project holds, by name. */
export const TOKENS: Record<string, string> = { alpha: "tok-alpha-1", beta: "tok-beta-1" };

/** The one way a token leaves the store: its length, never its text. */
export function seal(name: string): string {
  const token = TOKENS[name];
  return token === undefined ? "" : \`sealed:\${token.length}\`;
}
`;

const BROKEN_STORE = STORE.replace("`sealed:${token.length}`", "token");

const PAGE = `import { seal } from "./store.ts";

export function show(name: string): string {
  return \`<p>\${name}: \${seal(name)}</p>\`;
}
`;

const STORE_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { show } from "./page.ts";
import { TOKENS } from "./store.ts";

test("every token is sealed before display", () => {
  for (const [name, token] of Object.entries(TOKENS)) assert.ok(!show(name).includes(token), name);
});
`;

const ENTRY_SPEC = `# Widgets

A store of tokens that pages show only sealed.

## trust levels
- storage: the rows beneath everything
- display: what a page shows
`;

const COMPONENT_SPEC = `# Tokens

The token store and the page that shows a token.

## invariants
- ${INVARIANT}: A token leaves the store only through seal, and every token a page shows is sealed.
  protects: TOKENS
  chokepoint: seal
  over: every token in TOKENS
  via: every token is sealed before display
  because: a page that shows a raw token leaks a credential
  crossing: storage -> display
  kinds: none
`;

function practiceText(cite: string): string {
  return `- rotate a token: A token is rotated by replacing it in the store, never by writing it into a page.
  when: edit src/tokens/store.ts adding tok- | explicit
  step: replace the token in TOKENS
  step: run the tests
    leaves: npm test passes
  pitfall: a token written into a page reached the display (${cite})
  invariants: ${INVARIANT}
  because: the store is the one place a token lives
`;
}

/**
 * The ignore list adopters write: build output and environments git ignores
 * and a fresh checkout lacks, at the root and inside a package only, and a
 * generated changelog by its path (an adopter's own). A check added later
 * that flags any of them flags a config adopters already have, and the
 * no-new-problem rule below fails the upgrade (df-384acb1e).
 */
const IGNORE = ["dist", "build", "coverage", ".venv", "packages/web/dist", "CHANGELOG.md"];

const CONFIG = JSON.stringify({ name: "widgets", language: "typescript", test: "node --test --test-name-pattern={filter} 'src/**/*.test.ts'", testMatch: "# pass [1-9][0-9]*", ignore: IGNORE }, null, 2);

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function git(root: string, ...args: string[]): Ran {
  return sh(`git ${args.join(" ")}`, "git", ["-c", "user.name=Upgrade Test", "-c", "user.email=upgrade@coherence.invalid", "-c", "commit.gpgsign=false", ...args], root);
}

/** The adopter's CLI: whatever version node_modules holds, as an adopter runs it. */
function coherence(root: string, ...args: string[]): Ran {
  return sh(`npx --no -- coherence ${args.join(" ")}`, "npx", ["--no", "--", "coherence", ...args], root);
}

function installedVersion(root: string): string {
  return (JSON.parse(readFileSync(join(root, "node_modules", "@posthog", "coherence", "package.json"), "utf8")) as { version: string }).version;
}

interface Problem {
  file?: string;
  message: string;
}

interface Model {
  problems: Problem[];
  components: { folder: string; invariants: { name: string; state: string }[] }[];
  runs?: { count: number };
}

function specModel(root: string, phase: string): Model {
  const ran = coherence(root, "spec", "--json");
  assert.doesNotThrow(() => JSON.parse(ran.stdout), `${phase}: spec --json printed no model\n${shown(ran)}`);
  return JSON.parse(ran.stdout) as Model;
}

function problemKey(p: Problem): string {
  return `${p.file ?? ""}: ${p.message}`;
}

/** The kernel practices a release lists, by id, from its query practice. */
function kernelIds(listing: string): string[] {
  return [...new Set([...listing.matchAll(/coherence:src\/[a-z]+\/[^,\n]+/g)].map((m) => m[0].trim()))].sort();
}

/** Whether a text names one of Coherence's kernel practices: by its prefixed id, or by its bare name. */
function namesKernel(text: string, kernels: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return text.includes(KERNEL_PREFIX) || /\bkernel\b/i.test(text) || kernels.some((id) => lower.includes(id.slice(id.lastIndexOf("/") + 1).toLowerCase()));
}

/** Every step of a practice, numbered as query practice prints it. */
function stepsOf(root: string, practice: string): number[] {
  const ran = coherence(root, "query", "practice", practice);
  assert.equal(ran.code, 0, shown(ran));
  const body = ran.stdout.split(/\n\s*Pitfalls/)[0]!;
  const steps = [...body.matchAll(/^\s+(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.ok(steps.length > 0, `query practice "${practice}" listed no steps\n${shown(ran)}`);
  return steps;
}

/** Enact a practice with every step done, as a session that carried it out whole records it. */
function enact(root: string, practice: string, session: string): Ran {
  const steps = stepsOf(root, practice).flatMap((n) => ["--step", `${n}=done:carried out in the upgrade fixture`]);
  return coherence(root, "enact", practice, ...steps, "--session", session, "--agent", AGENT);
}

/** The installed hook command for an event, as the host would run it. */
function hookCommand(root: string, event: string): string {
  const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")) as { hooks?: Record<string, { hooks: { command: string }[] }[]> };
  const commands = (settings.hooks?.[event] ?? []).flatMap((entry) => entry.hooks.map((h) => h.command)).filter((c) => /coherence/.test(c));
  assert.equal(commands.length, 1, `.claude/settings.json holds one Coherence hook for ${event}: ${JSON.stringify(commands)}`);
  return commands[0]!;
}

/** The matcher of the PreToolUse entry of ours in .claude/settings.json. */
function preToolUseMatcher(root: string): unknown {
  const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")) as { hooks?: Record<string, { matcher?: unknown; hooks: { command: string }[] }[]> };
  return (settings.hooks?.["PreToolUse"] ?? []).find((entry) => entry.hooks.some((h) => /coherence/.test(h.command)))?.matcher;
}

interface HookCall {
  event: string;
  what: string;
  ran: Ran;
}

/** One session's worth of hook events: start, a prompt, an edit and a command each before and after, and the stop. */
function driveHooks(root: string, session: string, edit: { from: string; to: string }): HookCall[] {
  const base = { session_id: session, cwd: root, transcript_path: join(root, ".no-transcript.jsonl"), permission_mode: "default" };
  const file = join(root, "src", "tokens", "store.ts");
  const editInput = { file_path: file, old_string: edit.from, new_string: edit.to };
  const bashInput = { command: "npm test", description: "Run the tests" };
  const calls: HookCall[] = [];
  const fire = (event: string, what: string, payload: Record<string, unknown>): void => {
    const command = hookCommand(root, event);
    const ran = sh(`${what}: ${command}`, "sh", ["-c", command], root, JSON.stringify({ ...base, hook_event_name: event, ...payload }), { CLAUDE_PROJECT_DIR: root });
    calls.push({ event, what, ran });
  };
  fire("SessionStart", "SessionStart", { source: "startup" });
  fire("UserPromptSubmit", "UserPromptSubmit", { prompt: "Rotate the alpha token." });
  fire("PreToolUse", "PreToolUse Edit", { tool_name: "Edit", tool_input: editInput });
  writeFileSync(file, readFileSync(file, "utf8").replace(edit.from, edit.to));
  fire("PostToolUse", "PostToolUse Edit", { tool_name: "Edit", tool_input: editInput, tool_response: { filePath: file, success: true } });
  fire("PreToolUse", "PreToolUse Bash", { tool_name: "Bash", tool_input: bashInput });
  const tests = sh("npm test", "npm", ["test"], root);
  fire("PostToolUse", "PostToolUse Bash", { tool_name: "Bash", tool_input: bashInput, tool_response: { stdout: tests.stdout, stderr: tests.stderr, interrupted: false } });
  fire("Stop", "Stop", { stop_hook_active: false });
  return calls;
}

/** What a hook said, as the host shows it: the text inside its JSON answer, or the plain text. */
function hookText(output: string): string {
  const said: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") said.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  for (const line of output.split("\n")) {
    try {
      walk(JSON.parse(line));
    } catch {
      said.push(line);
    }
  }
  return said.join("\n");
}

/** Each line of hook output that asks the adopter to decide, amend or acknowledge something about a kernel practice or Coherence's lexicon. */
function asksAboutCoherence(text: string, kernels: readonly string[]): string[] {
  return hookText(text)
    .split("\n")
    .filter((line) => /\b(decide|decision|amend|amendment|acknowledge)\b/i.test(line) && (namesKernel(line, kernels) || /Coherence.s (own )?(lexicon|vocabulary|practice)/i.test(line) || /docs\/lexicon\.json/.test(line)));
}

function recordIds(text: string): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") {
      const id = (value as { id?: unknown }).id;
      if (typeof id === "string") ids.add(id);
      for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(walk);
    }
  };
  const trimmed = text.trim();
  try {
    walk(JSON.parse(trimmed));
  } catch {
    for (const line of trimmed.split("\n")) {
      try {
        walk(JSON.parse(line));
      } catch {
        // not a record line
      }
    }
  }
  return [...ids];
}

function stateOf(model: Model): string | undefined {
  return model.components.flatMap((c) => c.invariants).find((i) => i.name === INVARIANT)?.state;
}

/** The processes whose command line names the fixture folder, as ps shows them: pid, process group and command. */
function fixtureProcesses(scratch: string): { pid: number; pgid: number; command: string }[] {
  const listed = spawnSync("ps", ["-axww", "-o", "pid=,pgid=,command="], { encoding: "utf8" });
  return (listed.stdout ?? "").split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null || Number(match[1]) === process.pid || !match[3]!.includes(scratch)) return [];
    return [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3]! }];
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stop everything the fixture started before its folder goes: each warm
 * server its pointer and lock files name, with its whole process group (the
 * language server it spawned), then anything else whose command line names
 * the folder. Asked with SIGTERM, which the server answers by stopping, then
 * SIGKILL. What is still alive afterwards is returned.
 */
function stopFixture(root: string, scratch: string): string[] {
  const pids = new Set<number>();
  const run = join(root, ".coherence", "run");
  if (existsSync(run)) {
    for (const name of readdirSync(run).filter((f) => /^server.*\.(json|lock)$/.test(f))) {
      try {
        const pid = (JSON.parse(readFileSync(join(run, name), "utf8")) as { pid?: unknown }).pid;
        if (typeof pid === "number") pids.add(pid);
      } catch {
        // a torn pointer names no one
      }
    }
  }
  for (const p of fixtureProcesses(scratch)) pids.add(p.pid);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const pid of pids) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, signal);
        } catch {
          // gone, or not a group leader
        }
      }
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && [...pids].some(alive)) pause(100);
    if (![...pids].some(alive)) break;
  }
  return [...[...pids].filter(alive).map((pid) => `pid ${pid}`), ...fixtureProcesses(scratch).map((p) => `pid ${p.pid}: ${p.command}`)];
}

function removeWithRetries(path: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      if (!existsSync(path)) return;
    } catch (error) {
      if (attempt >= 5) throw error;
    }
    if (attempt >= 5) throw new Error(`${path} is still there after ${attempt} removals`);
    pause(500);
  }
}

test("an adopter of the previous release upgrades to this one with nothing it did turned against it", { timeout: 1_800_000 }, () => {
  // The real path: on macOS the temporary folder is a link (/var -> /private/var), and the fixture must not lean on how Coherence spells it.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "coherence-upgrade-")));
  const root = join(scratch, "widgets");
  const failures: string[] = [];
  const fail = (what: string, ...ran: Ran[]): void => {
    failures.push([what, ...ran.map(shown)].join("\n"));
  };
  let thrown: unknown;
  try {
    const previous = previousRelease();
    const current = currentTarball(scratch);

    // The adopter: a TypeScript project with a spec, an invariant, a test and a practice of its own.
    mkdirSync(root, { recursive: true });
    write(root, "package.json", JSON.stringify({ name: "widgets", private: true, type: "module", scripts: { test: "node --test 'src/**/*.test.ts'" } }, null, 2));
    write(root, "tsconfig.json", TSCONFIG);
    write(root, "coherence.config.json", CONFIG);
    write(root, "Widgets.spec.md", ENTRY_SPEC);
    write(root, "src/tokens/Tokens.spec.md", COMPONENT_SPEC);
    write(root, "src/tokens/store.ts", STORE);
    write(root, "src/tokens/page.ts", PAGE);
    write(root, "src/tokens/store.test.ts", STORE_TEST);
    write(root, ".gitignore", "node_modules\ndist\nbuild\ncoverage\n.venv\n");
    write(root, "packages/web/.gitignore", "dist\n");
    write(root, "packages/web/index.ts", "export const web = 1;\n");
    write(root, "CHANGELOG.md", "# Changelog\n\nGenerated by changesets.\n");
    // A project lexicon as lexicon apply wrote it before #67: the folder's name stored as its project, unlike the config's (df-be527a7b).
    write(root, "lexicon.json", JSON.stringify({ version: 1, project: "widgets-app", concepts: [] }, null, 2) + "\n");
    assert.equal(git(root, "init", "-q").code, 0);
    assert.equal(git(root, "add", "-A").code, 0);
    assert.equal(git(root, "commit", "-q", "-m", "widgets").code, 0);

    // Under the previous release, its optional dependencies pinned, so the language server is the fixture's own.
    const pins = pinnedOptionals(previous, root);
    const installed = sh(`npm install --save-dev ${previous} ${pins.join(" ")}`, "npm", ["install", "--save-dev", "--save-exact", "--no-audit", "--no-fund", previous, ...pins], root);
    assert.equal(installed.code, 0, shown(installed));
    assert.ok(existsSync(join(root, "node_modules", ".bin", "typescript-language-server")), `the fixture installed no typescript-language-server of its own (pins: ${pins.join(", ") || "none"})\n${shown(installed)}`);
    const version = installedVersion(root);
    const hooks = coherence(root, "hooks", "install", "--host", "claude");
    assert.equal(hooks.code, 0, shown(hooks));
    const before = "upgrade-before";
    const decided = coherence(root, "decide", "a token lives only in the store", "--over", "a token written into a page", "--because", "a page that held a token showed it", "--session", before, "--agent", AGENT);
    assert.equal(decided.code, 0, shown(decided));
    const cite = /\bd-[0-9a-f]{8}\b/.exec(decided.stdout)?.[0];
    assert.ok(cite !== undefined, `decide printed no decision id\n${shown(decided)}`);
    write(root, "src/tokens/Tokens.practice.md", practiceText(cite));

    // A run, a refutation of the totality oracle with the break staged, and a run that sees it green again.
    const firstRun = coherence(root, "run", "--session", before, "--agent", AGENT);
    write(root, "src/tokens/store.ts", BROKEN_STORE);
    const refuted = coherence(root, "refute", `src/tokens/${INVARIANT}`, "--broke", "made seal return the raw token", "--session", before, "--agent", AGENT);
    write(root, "src/tokens/store.ts", STORE);
    const secondRun = coherence(root, "run", "--session", before, "--agent", AGENT);
    if (firstRun.code !== 0 || secondRun.code !== 0 || refuted.code !== 0) fail("the previous release could not run and refute the fixture's invariant (the fixture, not the upgrade)", firstRun, refuted, secondRun);

    // Every kernel practice the previous release lists, and the project's own, enacted with every step done.
    const listed = coherence(root, "query", "practice");
    const kernels = kernelIds(listed.stdout);
    assert.ok(kernels.length > 0, `the previous release lists no kernel practice\n${shown(listed)}`);
    assert.ok(listed.stdout.includes(OWN_PRACTICE), `the previous release does not list the project's own practice\n${shown(listed)}`);
    for (const practice of [...kernels, OWN_PRACTICE]) {
      const ran = enact(root, practice, before);
      if (ran.code !== 0) fail(`the previous release refused enact of ${practice} (the fixture, not the upgrade)`, ran);
    }
    const established = coherence(root, "query", "practice");
    if (!/\b[1-9]\d* (?:are|is) established\b/.test(established.stdout)) fail("no practice reached the established state under the previous release, so the floor had nothing to read (the fixture, not the upgrade)", established);
    const hooksBefore = driveHooks(root, before, { from: "tok-alpha-1", to: "tok-alpha-2" });
    const checkBefore = coherence(root, "spec", "--check");
    const modelBefore = specModel(root, "before");
    const journalBefore = coherence(root, "journal", "--json");
    const idsBefore = recordIds(journalBefore.stdout);
    assert.ok(idsBefore.includes(cite), `the previous release's journal --json does not list ${cite}\n${shown(journalBefore)}`);
    assert.equal(git(root, "add", "-A").code, 0);
    assert.equal(git(root, "commit", "-q", "-m", "adopt Coherence").code, 0);
    const stoppedBefore = stopFixture(root, scratch);
    if (stoppedBefore.length > 0) fail(`processes the previous release started outlived it:\n${stoppedBefore.join("\n")}`);

    // The upgrade, as the adopter's next npm install, and the installed package is the packed one.
    const upgraded = sh(`npm install --save-dev ${current.tarball}`, "npm", ["install", "--save-dev", "--no-audit", "--no-fund", current.tarball], root);
    assert.equal(upgraded.code, 0, shown(upgraded));
    const versionAfter = installedVersion(root);
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages?: Record<string, { version?: string; resolved?: string }> };
    const locked = lock.packages?.["node_modules/@posthog/coherence"];
    if (versionAfter !== current.version || locked?.resolved === undefined || !locked.resolved.startsWith("file:") || !locked.resolved.endsWith(current.tarball.split("/").pop()!)) {
      fail(`the upgrade installed ${versionAfter} from ${locked?.resolved ?? "nowhere"}, not the packed ${current.version} at ${current.tarball}`, upgraded);
    }
    const after = "upgrade-after";

    // hooks --check passes as it stands, or, for hooks an earlier release wrote that look beside the project before the
    // installed package or whose PreToolUse matcher leaves out a tool that writes, names that plainly, as the session
    // start does, and passes once they are reinstalled.
    const check = coherence(root, "hooks", "--check", "--host", "claude");
    if (check.code !== 0) {
      const narrow = writersUnmatched(preToolUseMatcher(root));
      if (!searchesCheckoutFirst(hookCommand(root, "SessionStart")) && narrow.length === 0) fail("hooks --check fails after the upgrade", check);
      if (searchesCheckoutFirst(hookCommand(root, "SessionStart")) && !check.stdout.includes(EARLIER_SEARCH)) fail("hooks --check fails over hooks an earlier release wrote without saying why", check);
      if (narrow.length > 0 && !check.stdout.includes(earlierMatcher(narrow))) fail(`hooks --check fails over a PreToolUse matcher that leaves out ${narrow.join(", ")} without saying so`, check);
      const start = sh("SessionStart under the earlier hooks", "sh", ["-c", hookCommand(root, "SessionStart")], root, JSON.stringify({ session_id: "upgrade-reinstall", cwd: root, hook_event_name: "SessionStart", source: "startup" }), { CLAUDE_PROJECT_DIR: root });
      if (!hookText(start.stdout).includes("Reinstall them: npx --no -- coherence hooks install --host claude")) fail("the session start under hooks an earlier release wrote does not name the reinstall", start);
      const reinstalled = coherence(root, "hooks", "install", "--host", "claude");
      assert.equal(reinstalled.code, 0, shown(reinstalled));
      const again = coherence(root, "hooks", "--check", "--host", "claude");
      if (again.code !== 0) fail("hooks --check fails after the reinstall", again);
    }

    // spec --check: no problem the adopter did not cause.
    const checkAfter = coherence(root, "spec", "--check");
    const modelAfter = specModel(root, "after");
    const known = new Set(modelBefore.problems.map(problemKey));
    const fresh = modelAfter.problems.filter((p) => !known.has(problemKey(p)));
    if (fresh.length > 0) fail(`spec --check names ${fresh.length} problem(s) the previous release did not, though the adopter changed nothing:\n${fresh.map((p) => `  - ${problemKey(p)}`).join("\n")}`, checkBefore, checkAfter);
    const coherences = modelAfter.problems.filter((p) => namesKernel(p.message, kernels) || /node_modules\/@posthog\/coherence/.test(problemKey(p)));
    if (coherences.length > 0) fail(`spec --check names problem(s) about Coherence's own practices, which are not the adopter's to fix:\n${coherences.map((p) => `  - ${problemKey(p)}`).join("\n")}`, checkAfter);
    if (checkAfter.code !== 0 && checkBefore.code === 0) fail("spec --check passed before the upgrade and fails after it", checkBefore, checkAfter);

    // Every kernel practice the previous release listed that this one still ships, and the project's own, enact again.
    const listedAfter = coherence(root, "query", "practice");
    const kernelsAfter = new Set(kernelIds(listedAfter.stdout));
    for (const practice of [...kernels.filter((k) => kernelsAfter.has(k)), OWN_PRACTICE]) {
      const ran = enact(root, practice, after);
      if (ran.code !== 0) fail(`enact of ${practice} is refused after the upgrade`, ran);
    }

    // Every hook event exits 0, the tool hooks engage, and none asks anything about Coherence's own practices or lexicon.
    const hooksAfter = driveHooks(root, after, { from: "tok-beta-1", to: "tok-beta-2" });
    for (const { what, ran } of hooksAfter) {
      if (ran.code !== 0) fail(`${what} exits ${ran.code} after the upgrade; the fixture earns no refusal`, ran);
      const asked = asksAboutCoherence(ran.stdout + "\n" + ran.stderr, kernels);
      if (asked.length > 0) fail(`${what} asks the adopter to decide, amend or acknowledge something about Coherence's own practices or lexicon:\n${asked.map((l) => `  > ${l}`).join("\n")}`, ran);
    }
    for (const [phase, calls] of [["under the previous release", hooksBefore], ["after the upgrade", hooksAfter]] as const) {
      const edit = calls.find((c) => c.what === "PreToolUse Edit")!.ran;
      if (!hookText(edit.stdout).includes("rotate a token")) fail(`PreToolUse for an edit of src/tokens/store.ts adding a token delivered no practice ${phase}: the tool hooks did not engage with the project`, edit);
    }
    for (const { what, ran } of hooksBefore) if (ran.code !== 0) fail(`${what} exited ${ran.code} under the previous release (the fixture, not the upgrade)`, ran);

    // The first session after the upgrade leaves the records merging by union, with no step of the adopter's, and git commits the file that says so.
    const attributes = join(root, ATTRIBUTES_FILE);
    if (!existsSync(attributes) || readFileSync(attributes, "utf8") !== ATTRIBUTES_TEXT) fail(`the first session after the upgrade left ${ATTRIBUTES_FILE} ${existsSync(attributes) ? "with other text" : "absent"}`);
    for (const store of RECORD_STORES) {
      const attr = git(root, "check-attr", "merge", "--", `.coherence/${store}/${after}.jsonl`);
      if (!attr.stdout.includes("merge: union")) fail(`${store}'s session files do not merge by union after the upgrade`, attr);
    }
    const ignored = git(root, "check-ignore", "-q", ATTRIBUTES_FILE);
    if (ignored.code !== 1) fail(`git ignores ${ATTRIBUTES_FILE} after the upgrade, so a teammate never receives it`, ignored);

    // The journal, the runs and the config are still read.
    const journalAfter = coherence(root, "journal", "--json");
    const lost = idsBefore.filter((id) => !recordIds(journalAfter.stdout).includes(id));
    if (journalAfter.code !== 0 || lost.length > 0) fail(`the journal no longer loads ${lost.length} record(s) the previous release wrote: ${lost.join(", ")}`, journalBefore, journalAfter);
    const decision = coherence(root, "journal", cite);
    if (decision.code !== 0 || !decision.stdout.includes("a token lives only in the store")) fail(`journal ${cite} does not read the decision the previous release recorded`, decision);
    if ((modelAfter.runs?.count ?? 0) < (modelBefore.runs?.count ?? 0) || modelBefore.runs === undefined) fail(`the runs the previous release recorded no longer count: ${modelBefore.runs?.count ?? "none"} before, ${modelAfter.runs?.count ?? "none"} after`, checkBefore, checkAfter);
    if (stateOf(modelAfter) !== stateOf(modelBefore)) fail(`"${INVARIANT}" was ${stateOf(modelBefore)} before the upgrade and is ${stateOf(modelAfter)} after it, with no run since`, checkBefore, checkAfter);
    const status = coherence(root, "run", "--status");
    if (status.code !== 0 || !status.stdout.includes(INVARIANT)) fail("run --status does not report the verdicts the previous release recorded", status);
    if (!modelAfter.components.some((c) => c.folder === "src/tokens")) fail("spec --json no longer reads the adopter's component", checkAfter);
    const rerun = coherence(root, "run", "--session", after, "--agent", AGENT);
    if (rerun.code !== 0) fail("run fails after the upgrade, where it passed before it, with the config unchanged", secondRun, rerun);

    process.stdout.write(`# upgrade ${version} -> ${versionAfter}; enacted ${kernels.length} kernel practices and ${OWN_PRACTICE}; ${idsBefore.length} journal records; "${INVARIANT}" ${stateOf(modelAfter)}\n`);
  } catch (error) {
    thrown = error;
  } finally {
    const outlived = stopFixture(root, scratch);
    if (outlived.length > 0) failures.push(`processes the fixture started are still alive after it was stopped:\n${outlived.join("\n")}`);
    if (process.env["COHERENCE_UPGRADE_KEEP"] === undefined) removeWithRetries(scratch);
    else process.stdout.write(`# fixture kept at ${root}\n`);
  }
  if (thrown !== undefined || failures.length > 0) process.stderr.write(`\nEverything the upgrade test ran, in order:\n\n${transcript.map(shown).join("\n\n")}\n`);
  if (thrown !== undefined) throw thrown;
  assert.deepEqual(failures, [], `the upgrade turned the adopter's own state against it:\n\n${failures.join("\n\n")}`);
});
