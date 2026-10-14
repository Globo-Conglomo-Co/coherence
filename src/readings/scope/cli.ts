/**
 * The scope command: open the live reading, or write a snapshot.
 *
 *   coherence scope [--root <project>] [--no-open]
 *       start or attach to the root's warm server, have it answer HTTP, print
 *       the tokened address and open it in the browser (not with --no-open)
 *   coherence scope --snapshot [--out <file>] [--root <project>] [--lexicon <path>] [--domain <path>]
 *                   [--domain-title "<title>"] [--project <name>] [--no-interfaces]
 *                   <the budget flags, BUDGET_FLAGS>
 *       write one self-contained file: the shell with the state inline
 *
 * `--out` alone also writes a snapshot, so `npm run -s scope -- --root <dir>
 * --out <file>` keeps working as it always has.
 */

import { spawn } from "../../lifecycle/work-meter.ts";
import { resolve } from "node:path";
import { withWarmAdapter } from "../../enforcement/run.ts";
import type { Io } from "../../journal/cli.ts";
import { COHERENCE_LEXICON } from "../../lifecycle/project.ts";
import { DEFAULTS, projectNameOf, writeScopePage, type BuildOptions } from "./build.ts";
import { BUDGET_FLAG_NAMES, BUDGET_FLAGS, budgetFlags, readComponentInterfaces } from "./component-interfaces.ts";
import { readAndRecord } from "./gaps.ts";
import { keptLine } from "./kept-answers.ts";

export const SCOPE_USAGE = [
  "  scope [--root <dir>] [--no-open]   open the live Scope reading from the warm server (prints its address)",
  `  scope --snapshot [--out <file>] [--root <dir>] [--lexicon <path>] [--domain <path>] [--domain-title <title>] [--project <name>] [--no-interfaces] ${BUDGET_FLAGS}`,
  "                                     write one self-contained file: the shell with the state inline (--out alone does the same)",
].join("\n");

const VALUED = new Set(["root", "out", "lexicon", "domain", "domain-title", "project", ...BUDGET_FLAG_NAMES]);
const SWITCHES = new Set(["snapshot", "no-open", "no-interfaces"]);

function parse(argv: string[]): { values: Map<string, string>; switches: Set<string> } | string {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) return `unexpected argument "${arg}"`;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (SWITCHES.has(name)) {
      switches.add(name);
      continue;
    }
    if (!VALUED.has(name)) return `unknown flag --${name}`;
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "") return `--${name} needs a value`;
    values.set(name, value);
  }
  return { values, switches };
}

export async function scopeCommand(argv: string[], io: Io): Promise<number> {
  const parsed = parse(argv);
  if (typeof parsed === "string") {
    io.err(`scope: ${parsed}\n${SCOPE_USAGE}`);
    return 64;
  }
  const { values, switches } = parsed;
  const given = values.get("root");
  const root = given === undefined ? resolve(io.cwd) : resolve(io.cwd, given);
  if (switches.has("snapshot") || values.has("out")) return snapshot(root, values, switches, io);
  return openLive(root, !switches.has("no-open"), io);
}

async function snapshot(root: string, values: Map<string, string>, switches: Set<string>, io: Io): Promise<number> {
  // The default is the project's own .coherence folder, resolved against the root the reading is of, not the working folder.
  const out = values.get("out") ?? resolve(root, DEFAULTS.outPath);
  const options: BuildOptions = {
    root,
    // Coherence's own lexicon always comes from this installation, never from the project's folder: an adopter has no docs/lexicon.json of Coherence's.
    lexiconPath: values.get("lexicon") ?? COHERENCE_LEXICON,
    project: values.get("project") ?? projectNameOf(root),
  };
  // Structure reads every component interface through the language adapter; --no-interfaces writes without the instrument.
  if (!switches.has("no-interfaces")) {
    const budget = budgetFlags(values);
    if (typeof budget === "string") {
      io.err(`scope: ${budget}\n${SCOPE_USAGE}`);
      return 64;
    }
    options.componentInterfaces = await readAndRecord(root, () => readComponentInterfaces(root, undefined, { budget }));
    const kept = options.componentInterfaces.kind === "read" ? keptLine(options.componentInterfaces.kept) : undefined;
    if (kept !== undefined) io.err(kept);
  }
  const domain = values.get("domain");
  if (domain !== undefined) options.domainPath = domain;
  const title = values.get("domain-title");
  if (title !== undefined) options.domainTitle = title;
  const { bytes, state } = await writeScopePage(options, resolve(io.cwd, out));
  const first = state.lexicon.layers[0];
  const count = first?.kind === "present" ? first.lexicon.concepts.length : 0;
  const layer = state.lexicon.layers[1]?.kind === "present" ? "with a domain lexicon" : "no domain lexicon";
  const c = state.spec.counts;
  io.out(`Scope: wrote ${out} (${bytes} bytes, ${count} concepts, ${layer}, ${c.components} components, ${c.bullets} bullets, ${state.runs.records.length} runs, ${state.journal.records.length} journal records).`);
  return 0;
}

/** Start or attach to the root's warm server through the one door, ask it to answer HTTP, and open the page. */
async function openLive(root: string, open: boolean, io: Io): Promise<number> {
  return withWarmAdapter(root, async (remote, _server, reason) => {
    if (remote === undefined) {
      io.err(`scope: the warm server did not start (${reason ?? "no reason given"}); \`scope --snapshot\` writes a file instead`);
      return 1;
    }
    let url: string;
    try {
      ({ url } = await remote.openHttp());
    } catch (error) {
      io.err(`scope: the warm server would not answer HTTP (${error instanceof Error ? error.message : String(error)})`);
      return 1;
    }
    io.out(`Scope: ${url}`);
    io.out("The address carries this project's token: anyone who has it can read the reading while the server runs. It updates as the journal, runs, work orders and specs change.");
    if (open) {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.on("error", () => io.err("scope: could not open a browser; open the address above"));
      child.unref();
    }
    return 0;
  });
}
