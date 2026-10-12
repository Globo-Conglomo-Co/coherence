/** Fixed lexicon workflows: observe, propose, record a ruling, and read the changed evidence back. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative } from "node:path";
import { parseFlags, type Parsed } from "../journal/args.ts";
import type { Io } from "../journal/cli.ts";
import { isCoherenceItself, loadProjectLexicons } from "./project.ts";
import { runCheck } from "./check.ts";
import { recordBaseline } from "./lexicon-baseline.ts";
import {
  attention,
  coverageText,
  DISPOSITIONS,
  digest,
  isSettled,
  lexiconCoverage,
  liveUses,
  readingPaths,
  readLine,
  type Coverage,
} from "./lexicon-coverage.ts";
import {
  CHANGE_ACTIONS,
  applyProposal,
  confined,
  lexiconTarget,
  propose,
  recoverLexicon,
  reviewLexicon,
  type Change,
  type Proposal,
  type Who,
} from "./lexicon-maintain.ts";

export const LEXICON_WORK_USAGE = `  lexicon coverage [--json] [<path>...]   recurring terms without a definition and senses at risk, ranked; --json: every observed use and population fact
                                          <path>: read only the project's files under these folders or files, relative to the root or absolute inside it
  lexicon review <term> [--json]          definition, live contexts, evidence keys and prior rulings
  lexicon review <term> --component <folder> --evidence <key> --disposition ${DISPOSITIONS.join("|")} --because <reason> --over <alternative> --session <id> --agent <name> [--human <acknowledgement>] [--cite <id>]
  lexicon propose ${CHANGE_ACTIONS.join("|")} <concept> [value] [--definition <text>] [--entry <file.json>] [--drop <field.key>]... [--qualify] --because <reason>
                                          define --drop properties.<key>|detail.<key>: remove that key; the removed text goes into the applying decision
                                          lift <concept> <name>: take a rejected name back; apply needs --human and --cite of the decision that rejected it
                                          rename --qualify: the old name keeps its other senses and is not rejected
  lexicon apply <proposal-id> --because <reason> --over <alternative> --session <id> --agent <name> [--human <acknowledgement>] [--work <id>] [--cite <id>]
  lexicon recover                        finish an interrupted application without overwriting intervening edits
  lexicon draft [--out <file>] [<path>...] unsettled candidates, collisions and review questions; never overwrites
                                          <path>: draft only from the project's files under these folders or files (src/billing, docs)
  lexicon baseline --session <id> --agent <name> [--because <reason>] [--cite <id>]
                                          remember what is here now: this session's observed uses (no meaning is marked covered) and, in an adopter,
                                          the lexicon check's findings as a journal record the check then fails only beyond; that record only shrinks
  lexicon changes [--session <id>] [--json] new undefined terms and senses at risk relative to that session's baseline
  lexicon ready --terms <a,b,...> [--json] explicit vocabulary prerequisites for a named slice; not host-delivery proof
  lexicon similar <text> [--json]         optional offline suggestions; model absence leaves exact checks available
  lexicon model --download                 explicitly download and verify the pinned 37 MB model
  lexicon model --file <local.gguf> --sha256 <hash>  explicitly configure a local model`;
const WORKFLOWS = ["coverage", "review", "propose", "apply", "recover", "draft", "baseline", "changes", "ready", "similar", "model"] as const;

export function lexiconHelp(verb?: string): string {
  if (verb === undefined || verb === "help") return `usage:
${LEXICON_WORK_USAGE}`;
  // A usage line's deeper-indented continuation lines belong to it.
  let current = false;
  const lines = LEXICON_WORK_USAGE.split("\n").filter((line) => {
    if (!line.startsWith("   ")) current = line.trimStart().startsWith(`lexicon ${verb}`);
    return current;
  });
  return lines.length > 0
    ? `usage:
${lines.join("\n")}

Run lexicon help for every workflow.`
    : `unknown lexicon workflow: ${verb}; run lexicon help`;
}

const get = (p: Parsed, name: string): string | undefined => p.one.get(name);
/**
 * A proposal as a reader needs it: its id first, what it changes, the entry
 * as it would stand, and the apply command to run. The whole lexicon after
 * the change is the proposal file's, printed only with --json.
 */
export function proposalSummary(proposal: Proposal): string[] {
  const { change } = proposal;
  const target = change.action === "rename" && change.value ? change.value : change.name;
  const after = JSON.parse(proposal.after) as { concepts?: { name?: string }[] };
  const entry = after.concepts?.find((c) => c.name === target);
  const what = `${change.action} ${JSON.stringify(change.name)}${change.value ? ` -> ${JSON.stringify(change.value)}` : ""}`;
  return [
    `${proposal.id}  proposes ${what} in ${proposal.target}`,
    ...(entry === undefined ? [`  the concept leaves the lexicon`] : [`  entry after: ${JSON.stringify(entry)}`]),
    `  apply: lexicon apply ${proposal.id} --because "<why>" --over "<the alternative>" --session <id> --agent <name>${proposal.humanRequired ? ' --human "<what the human said>"' : ""}`,
    ...Object.entries(change.removed ?? {}).map(
      ([path, text]) => `  removes ${path}: ${JSON.stringify(text)} (kept in the applying decision)`,
    ),
    ...(proposal.findings ?? []).map(
      (f) =>
        `  dropping ${f.drop}: ${f.uses} current ${f.uses === 1 ? "use" : "uses"} would become unknown-noun findings${f.terms.length ? ` (${f.terms.join(", ")})` : ""}`,
    ),
    ...(proposal.humanRequired ? ["  a human must acknowledge it: apply refuses without --human"] : []),
  ];
}

function need(p: Parsed, name: string): string {
  const s = get(p, name);
  if (!s?.trim()) throw new Error(`missing --${name}`);
  return s;
}
function who(p: Parsed): Who {
  return {
    session: need(p, "session"),
    agent: need(p, "agent"),
    ...(get(p, "work") ? { work: get(p, "work")! } : {}),
    ...(p.many.get("cite")?.length ? { cite: p.many.get("cite")! } : {}),
  };
}
function cleanWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  renameSync(temp, path);
}
export function baselinePath(root: string, session: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session))
    throw new Error("invalid session token");
  return confined(root, `.coherence/lexicon/sessions/${session}.json`);
}
/** The baseline key that remembers a candidate: never a term's own key, which always holds a component after the newline. */
const CANDIDATE = "?candidate\n";

/**
 * What changed since a session's baseline that a reader can act on: a term
 * that now recurs without a definition and was not a candidate before, and a
 * use whose sense is at risk in a context that is new or changed. A known word
 * in an ordinary new line is not a change worth a word.
 */
export function coverageChanges(
  report: Coverage,
  prior: Record<string, string> = {},
): {
  term: string;
  component: string;
  evidence: string;
  state: string;
  reason: string;
}[] {
  const { undefinedTerms, senses } = attention(report);
  return [
    ...undefinedTerms
      .filter((t) => prior[CANDIDATE + t.term] === undefined)
      .map((t) => ({
        term: t.term,
        component: t.first,
        evidence: t.fingerprint,
        state: "unresolved",
        reason: `recurs without a definition (${t.prose} prose lines, ${t.components} components)`,
      })),
    ...senses
      .filter((s) => prior[s.term + "\n" + s.component] !== s.evidence)
      .map((s) => ({
        term: s.term,
        component: s.component,
        evidence: s.evidence,
        state: s.state,
        reason: `sense at risk: ${s.reason}`,
      })),
  ];
}

/**
 * The candidates this session introduced and still leaves without a
 * definition: recurring now, and either marked introduced in the baseline or
 * not in it at all. A candidate the session found at its start is not its debt.
 */
export function introducedCandidates(report: Coverage, prior: Record<string, string>): string[] {
  return attention(report)
    .undefinedTerms.map((t) => t.term)
    .filter((term) => prior[CANDIDATE + term] !== "start");
}

/**
 * Where an edit's held terms wait for the stop: the terms this session made
 * recur without a definition that no stop or prompt has named yet. Apart from
 * the baseline, so a prompt reads a few names, never the session's whole reading.
 */
export function pendingPath(root: string, session: string): string {
  return baselinePath(root, session).replace(/\.json$/, ".pending.json");
}
export function saveBaseline(
  root: string,
  session: string,
  report: Coverage,
): void {
  const path = baselinePath(root, session);
  const previous = existsSync(path) ? priorBaseline(root, session) : undefined;
  cleanWrite(
    path,
    Object.fromEntries([
      ...report.terms.flatMap((t) =>
        t.contexts.map((c) => [t.term + "\n" + c.component, c.fingerprint]),
      ),
      // A candidate present when the session's baseline was first taken is the session's inheritance; one that appears later is its own.
      ...attention(report).undefinedTerms.map((t) => [
        CANDIDATE + t.term,
        previous?.[CANDIDATE + t.term] ?? (previous === undefined ? "start" : "introduced"),
      ]),
    ]),
  );
}
/** The terms a baseline already holds as candidates: an edit never finds them again. */
export function heldCandidates(prior: Record<string, string>): Set<string> {
  return new Set(Object.keys(prior).filter((key) => key.startsWith(CANDIDATE)).map((key) => key.slice(CANDIDATE.length)));
}
/** The terms edits held that no stop or prompt has named yet, or why they could not be read. */
export function pendingCandidates(root: string, session: string): { terms: string[]; unreadable?: string } {
  const path = pendingPath(root, session);
  if (!existsSync(path)) return { terms: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) return { terms: [], unreadable: "it is not a list of terms" };
    return { terms: parsed };
  } catch (error) {
    return { terms: [], unreadable: error instanceof Error ? error.message : String(error) };
  }
}
/**
 * Hold terms an edit found recurring without a definition: the baseline
 * marks each as this session's own candidate, so no later edit finds it
 * again, and the pending list keeps it until a stop or a prompt names it.
 */
export function holdCandidates(root: string, session: string, terms: readonly string[]): void {
  if (terms.length === 0) return;
  const path = baselinePath(root, session);
  const previous = existsSync(path) ? priorBaseline(root, session) : {};
  cleanWrite(path, { ...previous, ...Object.fromEntries(terms.map((term) => [CANDIDATE + term, previous[CANDIDATE + term] ?? "introduced"])) });
  cleanWrite(pendingPath(root, session), [...new Set([...pendingCandidates(root, session).terms, ...terms])]);
}
/** These terms were named to the session: none of them is pending any more. */
export function deliverCandidates(root: string, session: string, terms: readonly string[]): void {
  const path = pendingPath(root, session);
  if (terms.length === 0 || !existsSync(path)) return;
  const named = new Set(terms);
  const rest = pendingCandidates(root, session).terms.filter((term) => !named.has(term));
  if (rest.length === 0) rmSync(path, { force: true });
  else cleanWrite(path, rest);
}
export function priorBaseline(
  root: string,
  session: string,
): Record<string, string> {
  const path = baselinePath(root, session);
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== "string")
  )
    throw new Error("lexicon baseline is unreadable; recreate it explicitly");
  return value as Record<string, string>;
}
export async function lexiconWorkCommand(
  argv: string[],
  io: Io,
): Promise<number> {
  try {
    const [verb, ...rest] = argv;
    const p = parseFlags(rest, {
      json: "switch",
      out: "one",
      definition: "one",
      entry: "one",
      drop: "many",
      because: "one",
      over: "many",
      human: "one",
      session: "one",
      agent: "one",
      work: "one",
      cite: "many",
      component: "one",
      evidence: "one",
      disposition: "one",
      terms: "one",
      file: "one",
      sha256: "one",
      download: "switch",
      qualify: "switch",
      help: "switch",
    });
    if (p.switches.has("help")) {
      io.out(lexiconHelp(verb));
      return WORKFLOWS.includes(verb as (typeof WORKFLOWS)[number]) ||
          verb === "help"
        ? 0
        : 1;
    }
    if (
      verb !== "propose" &&
      verb !== "coverage" &&
      verb !== "draft" &&
      p.positionals.length >
        (["review", "apply", "similar"].includes(verb ?? "") ? 1 : 0)
    )
      throw new Error("unexpected positional argument; run lexicon help");
    const term = p.positionals[0];
    const json = p.switches.has("json");
    const print = (x: unknown) => io.out(JSON.stringify(x, null, 2));
    if (verb === "propose") {
      const [action, name, value, ...extra] = p.positionals;
      if (
        extra.length ||
        !action ||
        !name ||
        !(CHANGE_ACTIONS as readonly string[]).includes(action)
      )
        throw new Error(
          "propose needs an action and concept; see lexicon help",
        );
      const entryPath = get(p, "entry");
      const entry = entryPath
        ? (JSON.parse(
            readFileSync(confined(io.cwd, entryPath, `entry file ${entryPath}`), "utf8"),
          ) as Record<string, unknown>)
        : undefined;
      const proposal = await propose(io.cwd, {
        action: action as Change["action"],
        name,
        ...(value ? { value } : {}),
        ...(get(p, "definition") !== undefined
          ? { definition: get(p, "definition")! }
          : {}),
        ...(entry ? { entry } : {}),
        ...(p.many.get("drop")?.length ? { drop: p.many.get("drop")! } : {}),
        ...(p.switches.has("qualify") ? { qualify: true } : {}),
        because: need(p, "because"),
      });
      // The whole proposal carries the whole lexicon after the change; only --json prints it.
      if (json) print(proposal);
      else for (const line of proposalSummary(proposal)) io.out(line);
      return 0;
    }
    if (verb === "apply") {
      if (!term) throw new Error("apply needs a proposal id");
      io.out(
        applyProposal(
          io.cwd,
          term,
          who(p),
          need(p, "because"),
          p.many.get("over") ?? [],
          get(p, "human"),
        ),
      );
      return 0;
    }
    if (verb === "recover") {
      io.out(recoverLexicon(io.cwd));
      return 0;
    }
    if (verb === "help") {
      io.out(lexiconHelp());
      return 0;
    }
    if (verb === "model" || verb === "similar") {
      const { configureModel, downloadModel, similarTerms } = await import(
        "./lexicon-similarity.ts"
      );
      if (verb === "model") {
        print(
          p.switches.has("download")
            ? await downloadModel(io.cwd)
            : await configureModel(io.cwd, need(p, "file"), need(p, "sha256")),
        );
        return 0;
      }
      if (!term) throw new Error("similar needs a term or context");
      const result = await similarTerms(io.cwd, term);
      if (json) print(result);
      else io.out(JSON.stringify(result, null, 2));
      return 0;
    }
    if (
      !["coverage", "review", "draft", "baseline", "changes", "ready"].includes(
        verb ?? "",
      )
    )
      throw new Error(`unknown lexicon workflow: ${verb}; run lexicon help`);
    // coverage and draft read only under the paths they are given; with none, the whole project.
    const paths =
      (verb === "coverage" || verb === "draft") && p.positionals.length > 0
        ? readingPaths(io.cwd, p.positionals)
        : undefined;
    const report = await lexiconCoverage(io.cwd, undefined, paths);
    if (verb === "review" && get(p, "disposition")) {
      if (!term) throw new Error("review needs a term");
      io.out(
        await reviewLexicon(
          io.cwd,
          term,
          need(p, "component"),
          need(p, "evidence"),
          need(p, "disposition"),
          who(p),
          need(p, "because"),
          p.many.get("over") ?? [],
          get(p, "human"),
        ),
      );
      return 0;
    }
    if (verb === "draft") {
      const { coherence, project } = await loadProjectLexicons(io.cwd);
      const draft = {
        status: "proposed; nothing here is a settled definition",
        source: report.fingerprint,
        ...(paths ? { read: { paths: report.population.paths, files: report.population.files.length } } : {}),
        existing:
          (
            project ??
            (report.projectLexicon === coherence.path ? coherence : undefined)
          )?.concepts ?? [],
        candidates: report.terms
          .filter((t) => t.state === "unresolved")
          .map((t) => ({
            name: t.term,
            definition: null,
            status: "needs ruling",
            uses: t.uses,
            contexts: t.contexts,
          })),
        candidate_overloads: report.terms
          .filter((t) => t.contexts.length > 1)
          .sort(
            (a, b) =>
              b.contexts.length - a.contexts.length ||
              b.count - a.count ||
              a.term.localeCompare(b.term),
          )
          .map((t) => ({
            term: t.term,
            contexts: t.contexts,
            senses: "not inferred; compare these uses",
          })),
        limits: report.population.limits,
      };
      const out = get(p, "out");
      if (out) {
        const path = confined(io.cwd, out);
        if (path === (await lexiconTarget(io.cwd)))
          throw new Error(
            "an unsettled draft cannot be written as the canonical lexicon",
          );
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(draft, null, 2) + "\n", {
          flag: "wx",
        });
        if (paths) io.out(readLine(report));
        io.out(
          `Wrote unsettled draft ${relative(io.cwd, path)}; use propose/apply for actual changes.`,
        );
      } else print(draft);
      return 0;
    }
    if (verb === "baseline") {
      const writer = who(p);
      saveBaseline(io.cwd, writer.session, report);
      io.out(
        `Baseline saved for ${writer.session}; no sense ruling was created.`,
      );
      if (await isCoherenceItself(io.cwd)) {
        io.out("Coherence's own text is enforced whole: the lexicon check keeps no baseline here.");
        return 0;
      }
      const { coherence, project } = await loadProjectLexicons(io.cwd);
      const check = await runCheck({ root: io.cwd, coherence, project, coherenceItself: false });
      const files = new Map<string, string[]>();
      const lineOf = (file: string, line: number): string => {
        let lines = files.get(file);
        if (lines === undefined) {
          lines = readFileSync(confined(io.cwd, file), "utf8").split(/\r?\n/);
          files.set(file, lines);
        }
        return lines[line - 1] ?? "";
      };
      io.out(recordBaseline(io.cwd, check, lineOf, writer, get(p, "because")));
      return 0;
    }
    if (verb === "changes") {
      const changes = coverageChanges(
        report,
        get(p, "session") ? priorBaseline(io.cwd, get(p, "session")!) : {},
      );
      if (json) print({ changes, population: report.totals });
      else
        io.out(
          changes.length === 0
            ? "Nothing new: no term newly recurs without a definition, and no new use puts a sense at risk."
            : changes
                .slice(0, 30)
                .map((c) => `${c.term} in ${c.component}: ${c.reason}`)
                .join("\n") +
                (changes.length > 30
                  ? "\nUse --json for every change."
                  : ""),
        );
      return 0;
    }
    if (verb === "ready") {
      const terms = need(p, "terms")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (!terms.length) throw new Error("name the slice's terms");
      const pending = terms.flatMap((name) => {
        const found = report.terms.find((t) => t.term === name);
        return !found
          ? [
              {
                term: name,
                reason: "no observed use in the declared population",
              },
            ]
          : found.contexts
              .filter((c) => !isSettled(c.disposition))
              .map((c) => ({
                term: name,
                reason: `${c.component}: ${c.disposition}`,
              }));
      });
      const ready =
        pending.length === 0 && report.population.unreadable.length === 0;
      const result = {
        vocabularyReady: ready,
        pending,
        unreadable: report.population.unreadable,
        limits: [
          "This only checks the named terms and current review evidence, not all project semantics.",
          "Fresh host delivery and the remaining work-order success criteria require separate observation.",
        ],
      };
      print(result);
      return ready ? 0 : 1;
    }
    if (verb === "review" && !term) throw new Error("review needs a term");
    if (verb === "review") {
      const entries = report.terms.filter(
        (t) =>
          t.term === term?.toLowerCase() ||
          t.concept?.toLowerCase() === term?.toLowerCase(),
      );
      // A term below the candidate threshold still has live uses to read before it is named.
      const live =
        entries.length === 0
          ? await liveUses(io.cwd, term!, json ? 1000 : 40)
          : undefined;
      if (json)
        print({
          term,
          entries,
          ...(live ? { liveUses: live.uses, liveUseCount: live.total } : {}),
          limits: report.population.limits,
        });
      else io.out(coverageText(report, term, live));
    } else if (json) print(report);
    else io.out(coverageText(report));
    return 0;
  } catch (e) {
    io.err(`lexicon: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
