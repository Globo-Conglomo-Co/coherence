/**
 * The journal's command surface: one command per verb plus the reader.
 *
 *   node src/cli.ts decide "<chose>" [--over "<rejected>"]... --because "<why>" [--human "<what the human said>"] [--cite <id>]...
 *   node src/cli.ts retract <id> --because "<what refuted it>"
 *   node src/cli.ts conjecture "<observation>" [--could-be "<candidate>"]... --discriminated-by "<test>" [--cite <id>]...
 *   node src/cli.ts resolved <id> --because "<what the test showed>" [--as "<candidate>"]   (a defect: [--guard <component>/<invariant>] [--decision <id>])
 *   node src/cli.ts classify <defect-id> [--class <name>] [--introduced <origin>] [--caught <how>] --because "<evidence>"
 *   node src/cli.ts dismiss <id> --because "<why nobody will chase it>"
 *   node src/cli.ts defect "<what failed>" --evidence "<reproducer or report>" [--file <path>]...
 *   node src/cli.ts experiment create "<expectation>" [--context <file>]... --action "<step>"... --success "<criterion>"...
 *   node src/cli.ts experiment close <id> --result <stepId>=<result>...   (result: one of STEP_RESULTS)
 *   node src/cli.ts unable "<what you could not do>" --because "<the wall>"
 *   node src/cli.ts escalate "<what a human must see>" --because "<why a human>" [--human "<words>"] [--cite <id>]...
 *   node src/cli.ts acknowledge <id> --because "<what the human decided>" [--human "<words>"]
 *   node src/cli.ts enact "<practice>" --step <n>=<done[:evidence]|deviated:why|skipped:why>... [--trigger "<what fired it>"] [--cite <id>]...
 *   node src/cli.ts journal [--session <id>] [--agent <name>] [--kind <kind>] [--since <cursorOrIso>] [--json]
 *   node src/cli.ts journal --subjects [--since <cursorOrIso>]
 *   node src/cli.ts journal <id>      one record of either store, what it cites and what cites it
 *   node src/cli.ts work create | move | close | owner | inspect   (see WORK_USAGE)
 *
 * decide, conjecture, defect, experiment create, unable and escalate take
 * --cite <id>, repeated, for the earlier records they rest on or are about.
 * Every writing verb takes --session and --agent (required). A write binds
 * to the one active work order its session owns; --work <id> names another.
 * The commands take an `Io` so tests can run them in a temporary directory
 * with a fixed clock and capture what they print.
 */

import { JournalError, parseFlags } from "./args.ts";
import { CAUGHT, KIND_NAMES, STEP_RESULTS, alternation } from "./record.ts";
import { parseCursor, parseKind, renderDamaged, renderJson, renderOne, renderSubjects, renderTimeline, type Filters } from "./read.ts";
import { gitBranch, loadJournal } from "./store.ts";
import { loadWork } from "./work.ts";
import {
  acknowledge,
  classify,
  conjecture,
  decide,
  defect,
  dismiss,
  enact,
  escalate,
  experiment,
  resolved,
  retract,
  unable,
  type Context,
  type Written,
} from "./verbs.ts";
import { WORK_USAGE, work } from "./workVerbs.ts";
import { recordsOnOtherBranches } from "./branches.ts";

export interface Io {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => Date;
  /** What stands against a record before it is written; see Context.vet. */
  vet?: (record: object) => string[];
}

/** A command prints through its Io and returns the exit code. */
export type Command = (argv: string[], io: Io) => number;

function context(io: Io): Context {
  return { cwd: io.cwd, now: io.now ?? (() => new Date()), ...(io.vet === undefined ? {} : { vet: io.vet }) };
}

function guarded(run: (argv: string[], io: Io) => void): Command {
  return (argv, io) => {
    try {
      run(argv, io);
      return 0;
    } catch (error) {
      if (error instanceof JournalError) {
        io.err(`journal: ${error.message}`);
        return 1;
      }
      throw error;
    }
  };
}

function writing(verb: (argv: string[], ctx: Context) => Written): Command {
  return guarded((argv, io) => {
    for (const line of verb(argv, context(io)).lines) io.out(line);
  });
}

const read: Command = guarded((argv, io) => {
  const parsed = parseFlags(argv, {
    session: "one",
    agent: "one",
    kind: "one",
    json: "switch",
    subjects: "switch",
    since: "one",
  });
  const loaded = loadJournal(io.cwd);
  const work = loadWork(io.cwd).records;
  if (parsed.positionals.length > 0) {
    const [id, ...rest] = parsed.positionals;
    if (rest.length > 0) throw new JournalError(`journal takes at most one record id; got "${rest[0]}"`);
    if (parsed.one.size > 0 || parsed.switches.size > 0) throw new JournalError("journal <id> takes no filter; it shows one record and its citations both ways");
    for (const line of renderOne(id!, loaded, work, (ids) => recordsOnOtherBranches(io.cwd, ids))) io.out(line);
    for (const line of renderDamaged(loaded.damaged)) io.err(line);
    return;
  }
  const filters: Filters = {};
  const session = parsed.one.get("session");
  const agent = parsed.one.get("agent");
  const kind = parsed.one.get("kind");
  if (session !== undefined) filters.session = session;
  if (agent !== undefined) filters.agent = agent;
  if (kind !== undefined) filters.kind = parseKind(kind);
  const sinceText = parsed.one.get("since");
  const since = sinceText === undefined ? null : parseCursor(sinceText);
  let lines: string[];
  if (parsed.switches.has("subjects")) {
    lines = renderSubjects(loaded, since, filters);
  } else if (parsed.switches.has("json")) {
    if (since !== null) throw new JournalError("--since goes with the timeline or --subjects, not --json");
    lines = [renderJson(loaded, filters, gitBranch(io.cwd), work)];
  } else {
    lines = renderTimeline(loaded, filters, since, work);
  }
  for (const line of lines) io.out(line);
  for (const line of renderDamaged(loaded.damaged)) io.err(line);
});

const workCommand: Command = guarded((argv, io) => {
  for (const line of work(argv, context(io)).lines) io.out(line);
});

export const journalVerbs: Record<string, Command> = {
  work: workCommand,
  decide: writing(decide),
  retract: writing(retract),
  conjecture: writing(conjecture),
  resolved: writing(resolved),
  classify: writing(classify),
  dismiss: writing(dismiss),
  defect: writing(defect),
  experiment: writing(experiment),
  unable: writing(unable),
  escalate: writing(escalate),
  acknowledge: writing(acknowledge),
  enact: writing(enact),
  journal: read,
};

export const JOURNAL_USAGE = [
  WORK_USAGE,
  "journal verbs (each needs --session <id> --agent <name>; a write binds to the one active order its session owns, or to --work <id>):",
  "  (--cite <id>, repeatable, names an earlier journal or work record this one rests on or is about, here or committed on another branch; an id found nowhere refuses the write)",
  "  (--human records words the agent attributes to a human, apart from its own because; it is not proof a human wrote them)",
  '  decide "<chose>" [--over "<rejected>"]... --because "<why>" [--human "<what the human said>"] [--cite <id>]...',
  '  retract <id> --because "<what refuted it>"',
  '  conjecture "<observation>" [--could-be "<candidate>"]... --discriminated-by "<test>" [--cite <id>]...',
  '  resolved <conjecture-id> --because "<what the test showed>" [--as "<candidate>"]',
  `  resolved <defect-id> --because "<what fixed it>" [--guard <component>/<invariant>] [--decision <id>] [--class <name>] [--introduced <commit|PR #n|pre-existing|unknown>] [--caught <${alternation(CAUGHT)}>]`,
  '      a defect\'s close owes a guard for its class (an invariant whose refutation is witnessed) or a decision saying why the fix suffices; spec --check names a close with neither',
  '  dismiss <id> --because "<why nobody will chase it>"',
  `  defect "<what failed>" --evidence "<reproducer or report>" [--file <path>]... [--class <name>] [--introduced <commit|PR #n|pre-existing|unknown>] [--caught <${alternation(CAUGHT)}>] [--cite <id>]...`,
  '      --class is a kebab-case name declared once as the property "class <name>" of defect in a lexicon; give all three: they are what the convergence reading counts',
  '  classify <defect-id> [--class <name>] [--introduced <...>] [--caught <...>] --because "<the evidence>" [--over "<rejected>"]...   a decision citing the defect; the defect is never edited',
  '  experiment create "<expectation>" [--context <file>]... --action "<step>"... --success "<criterion>"... [--cite <id>]...',
  `  experiment close <id> --result <stepId>=<${alternation(STEP_RESULTS)}>...`,
  '  unable "<what you could not do>" --because "<the wall>" [--cite <id>]...',
  '  escalate "<what a human must see>" --because "<why a human>" [--human "<what the human said>"] [--cite <id>]...',
  '  acknowledge <id> --because "<what the human decided>" [--human "<what the human said>"]',
  '  enact "<practice>" --step <n>=done[:<evidence>] | <n>=deviated:<why> | <n>=skipped:<why>  (one per step) [--trigger "<what fired it>"] [--cite <id>]...',
  `  journal [--session <id>] [--agent <name>] [--kind <${alternation(KIND_NAMES)}>] [--since <cursorOrIso>] [--json]`,
  "  journal --subjects [--since <cursorOrIso>]",
  "  journal <id>      one journal or work record, each record it cites, and each record citing it",
].join("\n");
