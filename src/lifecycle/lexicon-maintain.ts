/** Preview first, apply atomically, then record the actual effect. An interrupted journal write is recoverable. */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { decide } from "../journal/verbs.ts";
import { loadJournal, sessionFile } from "../journal/store.ts";
import { workBinding } from "../journal/work.ts";
import { DISPOSITIONS, digest, isSettled, lexiconCoverage } from "./lexicon-coverage.ts";
import { aliasNames, parseLexicon, rejectedNames } from "./lexicon.ts";
import { projectName } from "../adapters/project-config.ts";
import { normalizeTerm, runCheck } from "./check.ts";
import {
  isCoherenceItself,
  loadProjectLexicons,
  projectLexiconPath,
} from "./project.ts";
import { parseLexicon as parseScopeLexicon } from "../readings/scope/model.ts";

export interface Who {
  session: string;
  agent: string;
  work?: string;
  /** Earlier records the ruling rests on, passed through to the decision as --cite. */
  cite?: string[];
}
/** What a lexicon proposal may do to a concept. */
export const CHANGE_ACTIONS = ["declare", "define", "alias", "reject", "lift", "rename", "retire"] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

export interface Change {
  action: ChangeAction;
  name: string;
  value?: string;
  definition?: string;
  entry?: Record<string, unknown>;
  /** rename only: the old name keeps other senses (a keyword, another layer's term), so it is not rejected. */
  qualify?: boolean;
  /** define only: the properties.<key> and detail.<key> to remove. Nothing else is ever dropped (DROPPABLE). */
  drop?: string[];
  /**
   * Filled by propose, never given: the text each removed key or lifted
   * rejection carried. It rides in the change, so the applying decision keeps
   * what the lexicon no longer holds.
   */
  removed?: Record<string, unknown>;
  because: string;
}
/** A dropped property key that the unknown-noun check would no longer accept: the uses that would become findings. */
export interface DropFindings {
  drop: string;
  uses: number;
  terms: string[];
}
export interface Proposal {
  id: string;
  target: string;
  before: string;
  after: string;
  change: Change;
  humanRequired: boolean;
  /** define with a properties drop only: what the drop would turn into unknown-noun findings, counted before apply. */
  findings?: DropFindings[];
}
/**
 * The change rule for each field of a concept. definition: replaced by
 * define. properties, detail: merged; a key leaves only by an explicit drop.
 * aliases, instances: added freely; one leaves only by reject, with a human.
 * rejected: append-only; one leaves only by lift, with a human and a cite of
 * the decision that rejected it. provenance: append-only; never dropped, never
 * rewritten. name: rename or retire, with a human.
 */
const DROPPABLE = ["properties", "detail"] as const;
interface Transaction {
  proposal: Proposal;
  who: Who;
  because: string;
  over: string[];
  human?: string;
}
const STATE = ".coherence/lexicon";
/**
 * The shape of an applied-proposal decision: the vocabulary verb, "apply",
 * the proposal id. The verb is matched by shape, not by name, so a record
 * written before the concept was renamed (under the name it now rejects)
 * still counts as applied: the journal is append-only and is read as written.
 */
const APPLIED = /^[a-z]+ apply [a-z]p-[a-f0-9]{24} /;

/** Confine even through existing symlinked parents; a configured lexicon cannot write outside its project. */
export function confined(root: string, name: string, what = "lexicon path"): string {
  const path = resolve(root, name);
  const rel = relative(resolve(root), path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
    throw new Error(`${what} is outside the project root`);
  let existing = path;
  while (!existsSync(existing)) existing = dirname(existing);
  const actual = relative(realpathSync(root), realpathSync(existing));
  if (isAbsolute(actual) || actual === ".." || actual.startsWith("../"))
    throw new Error(`${what} follows a link outside the project root`);
  return path;
}
function atomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
function body(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
function validate(value: Record<string, unknown>, path: string): void {
  const parsed = parseLexicon(value, path);
  // Scope reads the same file strictly; a change it would refuse never reaches disk.
  parseScopeLexicon(value, path);
  const names = new Set<string>();
  for (const entry of value["concepts"] as Record<string, unknown>[]) {
    for (const key of [
      "aliases",
      "instances",
      "related",
      "not_to_be_confused_with",
    ])
      if (
        entry[key] !== undefined &&
        (!Array.isArray(entry[key]) ||
          (entry[key] as unknown[]).some((v) => typeof v !== "string"))
      )
        throw new Error(`${key} must be a list of strings`);
    if (
      entry["properties"] !== undefined &&
      (!entry["properties"] ||
        typeof entry["properties"] !== "object" ||
        Array.isArray(entry["properties"]))
    )
      throw new Error("properties must be an object");
  }
  for (const c of parsed.concepts) {
    if (!c.definition.trim())
      throw new Error(`a settled concept needs a definition: ${c.name}`);
    for (const n of [c.name, ...c.aliases, ...(c.instances ?? [])]) {
      const key = n.toLowerCase().trim();
      if (names.has(key))
        throw new Error(`ambiguous or duplicate lexicon name: ${n}`);
      names.add(key);
    }
  }
  for (const rejected of rejectedNames(parsed))
    if (names.has(rejected.name.toLowerCase().trim()))
      throw new Error(
        `a name cannot be both accepted and rejected: ${rejected.name}`,
      );
}
export async function lexiconTarget(root: string): Promise<string> {
  return confined(
    root,
    (await projectLexiconPath(root)) ??
      ((await isCoherenceItself(root))
        ? "docs/lexicon.json"
        : "lexicon.json"),
  );
}
/**
 * A property key is accepted vocabulary (d-3283157b), so dropping one can turn
 * its current uses into unknown-noun findings. The check runs twice, over the
 * lexicon as it stands and as the proposal leaves it; each new finding is
 * charged to the dropped key it spells.
 */
async function dropFindings(
  root: string,
  target: string,
  after: Record<string, unknown>,
  drops: string[],
): Promise<DropFindings[]> {
  const { coherence, project } = await loadProjectLexicons(root);
  const changed = parseLexicon(after, target);
  const ownLayer = resolve(target) === resolve(coherence.path);
  if (ownLayer) changed.project ??= "coherence";
  else changed.project = projectName(root, changed.project);
  const coherenceItself = await isCoherenceItself(root);
  const before = await runCheck({ root, coherence, project, coherenceItself });
  const afterReport = await runCheck({
    root,
    coherence: ownLayer ? changed : coherence,
    project: ownLayer ? project : changed,
    coherenceItself,
  });
  const held = new Set(
    before.unknown.filter((f) => f.baselined !== true).map((f) => f.term),
  );
  const fresh = afterReport.unknown.filter(
    (f) => f.baselined !== true && !held.has(f.term),
  );
  return drops
    .filter((d) => d.startsWith("properties."))
    .map((drop) => {
      const names = aliasNames(drop.slice("properties.".length)).map(normalizeTerm);
      const mine = fresh.filter((f) =>
        names.some((n) => f.term === n || f.term === n + "s" || f.term === n + "es"),
      );
      return {
        drop,
        uses: mine.reduce((n, f) => n + f.count, 0),
        terms: mine.map((f) => f.term),
      };
    });
}
export async function propose(root: string, change: Change): Promise<Proposal> {
  if (!change.name.trim() || !change.because.trim())
    throw new Error("a proposal needs a name and because");
  if (change.entry) {
    if (Array.isArray(change.entry) || typeof change.entry !== "object")
      throw new Error("entry must be an object");
    if (
      change.entry["name"] !== undefined &&
      change.entry["name"] !== change.name
    )
      throw new Error(
        "use an explicit rename proposal to change a concept's name",
      );
    if (
      [
        "uses",
        "contexts",
        "where",
        "file",
        "files",
        "code_addresses",
        "defined_in",
        "implementation_paths",
      ].some((k) => k in change.entry!)
    )
      throw new Error(
        "live usage/code addresses belong to the reading, not a lexicon entry",
      );
  }
  const target = await lexiconTarget(root);
  const raw = body(target);
  // A new lexicon stores no project: the project's name is the config's (projectName), never a copy here to drift.
  const value = (
    raw ? JSON.parse(raw) : { version: 1, concepts: [] }
  ) as Record<string, unknown>;
  if (!Array.isArray(value["concepts"]))
    throw new Error("lexicon concepts must be a list");
  const concepts = value["concepts"] as Record<string, unknown>[];
  const existing = concepts.find(
    (c) => String(c["name"]).toLowerCase() === change.name.toLowerCase(),
  );
  if (change.action !== "declare" && !existing)
    throw new Error(`no concept named ${change.name}`);
  if (change.drop?.length && change.action !== "define")
    throw new Error("--drop applies only to define");
  let acceptedRemoval = false;
  const removed: Record<string, unknown> = {};
  if (change.action === "declare") {
    if (existing) throw new Error(`concept already exists: ${change.name}`);
    concepts.push({
      ...change.entry,
      name: change.name,
      definition: change.definition ?? change.entry?.["definition"] ?? "",
    });
  } else if (change.action === "define") {
    const entry = change.entry ?? {};
    const merged: Record<string, unknown> = {
      ...existing,
      ...entry,
      name: change.name,
      definition:
        change.definition ?? entry["definition"] ?? existing!["definition"],
    };
    for (const key of ["detail", "provenance", "properties"])
      if (entry[key] !== undefined) {
        if (
          !entry[key] ||
          typeof entry[key] !== "object" ||
          Array.isArray(entry[key])
        )
          throw new Error(`${key} must be an object`);
        const prior = (existing![key] as Record<string, unknown>) ?? {};
        // Provenance is append-only: a key it already holds keeps its text.
        if (key === "provenance")
          for (const [k, v] of Object.entries(entry[key] as Record<string, unknown>))
            if (k in prior && JSON.stringify(prior[k]) !== JSON.stringify(v))
              throw new Error(
                `provenance is append-only: ${change.name} already records provenance.${k}; add a new key instead`,
              );
        merged[key] = {
          ...prior,
          ...(entry[key] as Record<string, unknown>),
        };
      }
    for (const key of ["aliases", "instances", "rejected"])
      if (entry[key] !== undefined) {
        if (!Array.isArray(entry[key]))
          throw new Error(`${key} must be a list`);
        merged[key] = [
          ...new Map(
            [...((existing![key] as unknown[]) ?? []), ...entry[key]].map(
              (v) => [JSON.stringify(v), v],
            ),
          ).values(),
        ];
      }
    for (const path of change.drop ?? []) {
      const dot = path.indexOf(".");
      const field = dot === -1 ? path : path.slice(0, dot);
      const key = dot === -1 ? "" : path.slice(dot + 1);
      if (field === "provenance")
        throw new Error(
          `provenance is append-only: ${path} cannot be dropped`,
        );
      if (!(DROPPABLE as readonly string[]).includes(field) || !key)
        throw new Error(
          `--drop takes properties.<key> or detail.<key>, not ${path}; an alias or instance leaves by reject, a rejected name by lift, a concept by rename or retire`,
        );
      if (
        entry[field] !== undefined &&
        key in (entry[field] as Record<string, unknown>)
      )
        throw new Error(`${path} is both set and dropped`);
      const current = merged[field] as Record<string, unknown> | undefined;
      if (!current || !(key in current))
        throw new Error(`${change.name} has no ${path} to drop`);
      removed[path] = current[key];
      const { [key]: _gone, ...rest } = current;
      if (Object.keys(rest).length > 0) merged[field] = rest;
      else delete merged[field];
    }
    // Replaced, not assigned over: a dropped key must leave the entry.
    concepts[concepts.indexOf(existing!)] = merged;
  } else if (change.action === "lift") {
    if (!change.value?.trim())
      throw new Error("a lift needs the rejected name to lift");
    const rejected = (existing!["rejected"] as Record<string, unknown>[]) ?? [];
    const lifted = rejected.find(
      (r) =>
        String(r["alternative"]).toLowerCase() === change.value!.toLowerCase(),
    );
    if (!lifted)
      throw new Error(`${change.name} rejects no name ${change.value}`);
    removed[`rejected.${lifted["alternative"]}`] = lifted;
    existing!["rejected"] = rejected.filter((r) => r !== lifted);
    if ((existing!["rejected"] as unknown[]).length === 0)
      delete existing!["rejected"];
  } else if (change.action === "alias") {
    if (!change.value?.trim()) throw new Error("an alias needs a value");
    existing!["aliases"] = [
      ...((existing!["aliases"] as string[]) ?? []),
      change.value,
    ];
  } else if (change.action === "reject") {
    if (!change.value?.trim()) throw new Error("a rejected name needs a value");
    const owner = concepts.find((c) =>
      [
        c["name"],
        ...((c["aliases"] as string[]) ?? []),
        ...((c["instances"] as string[]) ?? []),
      ].some((n) => String(n).toLowerCase() === change.value!.toLowerCase()),
    );
    if (
      owner &&
      (owner !== existing ||
        String(owner["name"]).toLowerCase() === change.value.toLowerCase())
    )
      throw new Error(
        "use rename/retire for a concept, or reject the alias under its own concept",
      );
    if (owner) {
      acceptedRemoval = true;
      for (const key of ["aliases", "instances"])
        if (Array.isArray(existing![key]))
          existing![key] = existing![key].filter(
            (n) => String(n).toLowerCase() !== change.value!.toLowerCase(),
          );
    }
    existing!["rejected"] = [
      ...((existing!["rejected"] as unknown[]) ?? []),
      { alternative: change.value, because: change.because },
    ];
  } else if (change.action === "rename") {
    if (!change.value?.trim()) throw new Error("a rename needs a new name");
    existing!["name"] = change.value;
    if (!change.qualify)
      existing!["rejected"] = [
        ...((existing!["rejected"] as unknown[]) ?? []),
        { alternative: change.name, because: change.because },
      ];
    for (const c of concepts)
      if (Array.isArray(c["related"]))
        c["related"] = c["related"].map((n) =>
          n === change.name ? change.value : n,
        );
  } else if (change.action === "retire") {
    concepts.splice(concepts.indexOf(existing!), 1);
    value["retired"] = [
      ...((value["retired"] as unknown[]) ?? []),
      { ...existing, because: change.because },
    ];
    value["rejected"] = [
      ...((value["rejected"] as unknown[]) ?? []),
      { concept: change.name, because: change.because },
    ];
  }
  // Human-only actions are flagged at proposal time, not guessed from a success message after a write.
  const humanRequired =
    acceptedRemoval || ["lift", "rename", "retire"].includes(change.action);
  validate(value, target);
  const findings = Object.keys(removed).some((k) => k.startsWith("properties."))
    ? await dropFindings(root, target, value, Object.keys(removed))
    : undefined;
  const draft = {
    target: relative(root, target),
    before: digest(raw),
    after: JSON.stringify(value, null, 2) + "\n",
    change: Object.keys(removed).length > 0 ? { ...change, removed } : change,
    humanRequired,
    ...(findings ? { findings } : {}),
  };
  const proposal: Proposal = {
    id: "lp-" + digest(draft).slice(0, 24),
    ...draft,
  };
  const path = confined(root, `${STATE}/proposals/${proposal.id}.json`);
  atomic(path, JSON.stringify(proposal, null, 2) + "\n");
  return proposal;
}
function readProposal(root: string, id: string): Proposal {
  if (!/^lp-[a-f0-9]{24}$/.test(id))
    throw new Error("invalid lexicon proposal id");
  const p = JSON.parse(
    readFileSync(confined(root, `${STATE}/proposals/${id}.json`), "utf8"),
  ) as Proposal;
  const { id: stored, ...draft } = p;
  if (stored !== id || "lp-" + digest(draft).slice(0, 24) !== id)
    throw new Error("proposal content was changed; prepare a new preview");
  return p;
}
function writingFlags(who: Who): string[] {
  if (!who.session || !who.agent)
    throw new Error("every lexicon ruling needs --session and --agent");
  return [
    "--session",
    who.session,
    "--agent",
    who.agent,
    ...(who.work ? ["--work", who.work] : []),
    ...(who.cite ?? []).flatMap((id) => ["--cite", id]),
  ];
}
function appliedDecision(root: string, id: string): string | undefined {
  return loadJournal(root).records.find(
    (r) => r.kind === "decision" && APPLIED.test(r.chose) && r.chose.includes(` apply ${id} `),
  )?.id;
}
/**
 * The applied decisions that put a name into a concept's rejected list: a
 * reject of that name, or a rename away from it that did not qualify. A
 * rejection older than the journal has none, and its lift carries the lifted
 * entry, reason and all, in its own decision.
 */
function rejectingDecisions(root: string, concept: string, name: string): string[] {
  const same = (a: unknown, b: string): boolean =>
    String(a).toLowerCase() === b.toLowerCase();
  return loadJournal(root).records.flatMap((r) => {
    if (r.kind !== "decision" || !APPLIED.test(r.chose)) return [];
    let change: Change;
    try {
      change = (JSON.parse(r.chose.replace(APPLIED, "")) as { change: Change }).change;
    } catch {
      return [];
    }
    const rejected =
      (change.action === "reject" && same(change.name, concept) && same(change.value, name)) ||
      (change.action === "rename" && !change.qualify && same(change.name, name) && same(change.value, concept));
    return rejected ? [r.id] : [];
  });
}
/** The same path finishes a fresh application and an interrupted one; it never overwrites concurrent edits. */
function finish(root: string, tx: Transaction): string {
  const target = confined(root, tx.proposal.target);
  const current = body(target);
  if (current !== tx.proposal.after) {
    if (digest(current) !== tx.proposal.before)
      throw new Error(
        "lexicon changed since preview; pending application cannot overwrite it",
      );
    atomic(target, tx.proposal.after);
  }
  const existing = appliedDecision(root, tx.proposal.id);
  const id =
    existing ??
    decide(
      [
        `lexicon apply ${tx.proposal.id} ${JSON.stringify({ change: tx.proposal.change, human: tx.human ?? null })}`,
        "--because",
        tx.because,
        ...tx.over.flatMap((s) => ["--over", s]),
        ...writingFlags(tx.who),
      ],
      { cwd: root, now: () => new Date() },
    ).record.id;
  unlinkSync(confined(root, `${STATE}/pending.json`));
  return id;
}
function locked<T>(root: string, run: () => T): T {
  const path = confined(root, `${STATE}/apply.lock`);
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch {
    throw new Error(
      "another lexicon apply/recover holds the lock; inspect it before removing a stale lock",
    );
  }
  try {
    return run();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}
export function applyProposal(
  root: string,
  id: string,
  who: Who,
  because: string,
  over: string[],
  human?: string,
): string {
  writingFlags(who);
  confined(root, sessionFile(root, who.session));
  workBinding(root, who.session, who.work);
  if (!because.trim() || !over.length || over.some((s) => !s.trim()))
    throw new Error(
      "a ruling needs --because and --over (use none when nothing was rejected)",
    );
  return locked(root, () => {
    const p = readProposal(root, id);
    if (p.humanRequired && !human?.trim())
      throw new Error(
        `${p.change.action === "reject" ? "removing an accepted name" : p.change.action} needs an explicit --human acknowledgement; no change applied`,
      );
    if (p.change.action === "lift") {
      const originals = rejectingDecisions(root, p.change.name, p.change.value ?? "");
      if (
        originals.length > 0 &&
        !originals.some((id) => (who.cite ?? []).includes(id))
      )
        throw new Error(
          `lifting a rejection cites the decision that made it: --cite ${originals.join(" or --cite ")}; no change applied`,
        );
    }
    if (existsSync(confined(root, `${STATE}/pending.json`)))
      throw new Error(
        "an application is pending: run lexicon recover before another apply",
      );
    if (appliedDecision(root, id))
      throw new Error(
        "proposal already applied; prepare a new preview for further changes",
      );
    if (digest(body(confined(root, p.target))) !== p.before)
      throw new Error("lexicon changed since preview; prepare a new proposal");
    const tx: Transaction = {
      proposal: p,
      who,
      because,
      over,
      ...(human ? { human } : {}),
    };
    atomic(confined(root, `${STATE}/pending.json`), JSON.stringify(tx));
    return finish(root, tx);
  });
}
export function recoverLexicon(root: string): string {
  return locked(root, () => {
    const path = confined(root, `${STATE}/pending.json`);
    if (!existsSync(path)) return "no pending lexicon application";
    const tx = JSON.parse(readFileSync(path, "utf8")) as Transaction;
    const p = readProposal(root, tx.proposal.id);
    if (digest(p) !== digest(tx.proposal))
      throw new Error("pending proposal does not match its preview");
    writingFlags(tx.who);
    confined(root, sessionFile(root, tx.who.session));
    workBinding(root, tx.who.session, tx.who.work);
    return finish(root, tx);
  });
}
export async function reviewLexicon(
  root: string,
  term: string,
  component: string,
  evidence: string,
  disposition: string,
  who: Who,
  because: string,
  over: string[],
  human?: string,
): Promise<string> {
  writingFlags(who);
  confined(root, sessionFile(root, who.session));
  if (!(DISPOSITIONS as readonly string[]).includes(disposition))
    throw new Error(
      `disposition must be ${DISPOSITIONS.slice(0, -1).join(", ")}, or ${DISPOSITIONS.at(-1)}`,
    );
  if (isSettled(disposition) && !human?.trim())
    throw new Error(
      "a settled sense review needs --human acknowledgement; use deferred or defect without a ruling",
    );
  const report = await lexiconCoverage(root);
  const found = report.terms.find(
    (t) => t.term.toLowerCase() === term.toLowerCase(),
  );
  if (
    disposition === "confirmed" &&
    (found?.state === "unresolved" || found?.state === "rejected")
  )
    throw new Error(
      "declare/map/fix this name before confirming its defined sense; a review is not a declaration",
    );
  const context = found?.contexts.find((c) => c.component === component);
  if (!context || context.fingerprint !== evidence)
    throw new Error(
      "stale or absent review evidence; read lexicon review again",
    );
  if (!because.trim() || !over.length)
    throw new Error("a review needs --because and --over");
  return decide(
    [
      "lexicon review " +
        JSON.stringify({
          term,
          component,
          evidence,
          disposition,
          human: human ?? null,
        }),
      "--because",
      because,
      ...over.flatMap((s) => ["--over", s]),
      ...writingFlags(who),
    ],
    { cwd: root, now: () => new Date() },
  ).record.id;
}
