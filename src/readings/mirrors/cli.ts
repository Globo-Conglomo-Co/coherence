/**
 * query mirrors: the mirror reading on request.
 *
 *   query mirrors [--all] [--limit <n>] [--rev <rev>] [--no-history] [--json | --proposals] [--refresh]
 *
 * By default the groups the threshold policy surfaces, at HEAD; --all every
 * group; --json the whole reading with the alarms and the proposals;
 * --proposals only the proposed declarations, as JSON. A reading of HEAD with
 * the default options (history read, loose pairs left out) is kept for the
 * hooks (recorded.ts). --refresh is what a hook starts in the background: it
 * reads and keeps only when the kept reading is of another commit, and prints
 * nothing.
 */

import { execFileSync } from "../../lifecycle/work-meter.ts";
import type { Io } from "../../journal/cli.ts";
import { MirrorUnable, readMirrors } from "./mirrors.ts";
import { alarmsOf, MIRRORS_USAGE, proposalsOf, readingText, surfaced } from "./policy.ts";
import { lastMirrors, recordMirrors } from "./recorded.ts";

interface Parsed {
  all: boolean;
  json: boolean;
  proposals: boolean;
  history: boolean;
  refresh: boolean;
  rev: string | undefined;
  limit: number | undefined;
}

function parse(argv: readonly string[]): Parsed | string {
  const parsed: Parsed = { all: false, json: false, proposals: false, history: true, refresh: false, rev: undefined, limit: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--all") parsed.all = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--proposals") parsed.proposals = true;
    else if (arg === "--no-history") parsed.history = false;
    else if (arg === "--refresh") parsed.refresh = true;
    else if (arg === "--rev" || arg === "--limit") {
      const value = argv[++i];
      if (value === undefined || value === "") return `${arg} needs a value`;
      if (arg === "--rev") parsed.rev = value;
      else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) return "--limit needs a whole number of 1 or more";
        parsed.limit = n;
      }
    } else return `unknown argument ${arg}`;
  }
  if (parsed.json && parsed.proposals) return "--json and --proposals are two answers; ask for one";
  return parsed;
}

function headCommit(root: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export async function mirrorsCommand(root: string, argv: readonly string[], io: Pick<Io, "out" | "err">): Promise<number> {
  const parsed = parse(argv);
  if (typeof parsed === "string") {
    io.err(`query mirrors: ${parsed}\n${MIRRORS_USAGE}`);
    return 64;
  }
  if (parsed.refresh) {
    const head = headCommit(root);
    if (head === undefined || lastMirrors(root)?.commit === head) return 0;
  }
  // Only HEAD with the default options is what orient may stand on.
  const keep = parsed.rev === undefined && parsed.history && !parsed.all;
  let reading;
  try {
    reading = await readMirrors(root, { ...(parsed.rev === undefined ? {} : { rev: parsed.rev }), history: parsed.history, all: parsed.all });
  } catch (error) {
    if (!(error instanceof MirrorUnable)) throw error;
    io.err(`query mirrors: ${error.message}`);
    return 1;
  }
  if (keep) {
    try {
      recordMirrors(root, reading);
    } catch {
      // A reading that cannot be kept only means orient reads the last one.
    }
  }
  if (parsed.refresh) return 0;
  if (parsed.proposals) io.out(JSON.stringify(proposalsOf(reading.groups), null, 2));
  else if (parsed.json) io.out(JSON.stringify({ ...reading, surfaced: reading.groups.filter(surfaced).map((g) => g.rank), alarms: alarmsOf(reading.groups), proposals: proposalsOf(reading.groups) }, null, 2));
  else io.out(readingText(reading, { all: parsed.all, ...(parsed.limit === undefined ? {} : { limit: parsed.limit }) }));
  return 0;
}
