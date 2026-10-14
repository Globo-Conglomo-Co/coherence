/**
 * The Practices view's derivations: pure functions from the state the page
 * holds (the practices, the spec, the journal) to the story of what a
 * project practices, how each practice came to be, and how it is holding.
 *
 * The story comes first: which practices exist, what fires each ("when you…
 * → follow…"), where they live, where they came from, and what has no
 * practice yet. Then each practice's health: an adherence strip per step
 * over its latest enactments, the reasons sessions gave for deviating, and
 * what needs attention. Nothing here is stored: every value is derived on
 * each render from the practices and the journal records, so it cannot
 * disagree with them. `query practice` reads the same story.
 */

import { KINDS, WORK_KINDS } from "../../journal/kinds.ts";
import { slug } from "./html.ts";
import { ENACTMENT_WINDOW, citesOf, componentOfFile } from "./derive.ts";
import type { JournalRecord, PracticeTrigger, ScopePractice, ShellState, SpecComponent } from "./model.ts";

/** How many of a practice's latest enactments its strips show. */
export const STRIP_WINDOW = ENACTMENT_WINDOW;

/** Deviations on one step, within the strip, that suggest the step itself should change. */
export const AMENDMENT_SIGNAL = 2;

type Enactment = Extract<JournalRecord, { kind: "enactment" }>;

export function practiceId(id: string): string {
  return `practice-${slug(id)}`;
}

/** Every enactment of a practice, oldest first. */
export function enactmentsOf(records: readonly JournalRecord[], id: string): Enactment[] {
  return records
    .filter((r): r is Enactment => r.kind === "enactment" && r.practice === id)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/* --------------------------------------------------------------- story */

/** A trigger as a reader says it: "When you run `refute`", "When you edit `**\/*.spec.md` adding `refuted:`". */
export function whenText(trigger: PracticeTrigger): string {
  if (trigger.kind === "command") return `When you run \`${trigger.words}\``;
  if (trigger.kind === "edit") return `When you edit \`${trigger.glob}\`${trigger.adding ? ` adding \`${trigger.adding}\`` : ""}`;
  return "On purpose";
}

export interface WhenLine {
  /** The trigger as a reader says it; "On purpose" gathers every explicit practice. */
  when: string;
  kind: PracticeTrigger["kind"];
  practices: string[];
}

/** The project's working rules by what sets them off: commands, then edits, then the practices taken up on purpose. */
export function whenYou(practices: readonly Pick<ScopePractice, "id" | "triggers">[]): WhenLine[] {
  const lines = new Map<string, WhenLine>();
  for (const practice of practices) {
    for (const trigger of practice.triggers) {
      const when = whenText(trigger);
      const line = lines.get(when) ?? { when, kind: trigger.kind, practices: [] };
      if (!line.practices.includes(practice.id)) line.practices.push(practice.id);
      lines.set(when, line);
    }
  }
  const order: Record<PracticeTrigger["kind"], number> = { command: 0, edit: 1, explicit: 2 };
  return [...lines.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.when.localeCompare(b.when));
}

export interface PracticeStory {
  /** The opening paragraph, in words. */
  summary: string;
  when: WhenLine[];
  /** Every component with the practices its file holds; a component with none is listed too. */
  components: { folder: string; name: string; practices: string[] }[];
  kernel: string[];
  /** What has no method yet: components with defects or walls on record and no practice of their own, and defects no pitfall cites. */
  unpracticed: { folder: string; name: string; records: JournalRecord[] }[];
  uncited: JournalRecord[];
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The files a record names: a defect's files, and paths quoted in a record's text. */
function filesOf(record: JournalRecord): string[] {
  if (record.kind === "defect") return record.files;
  return [];
}

export function practiceStory(state: Pick<ShellState, "practices" | "spec" | "journal">): PracticeStory {
  const practices = state.practices.practices;
  const own = practices.filter((p) => !p.kernel);
  const kernel = practices.filter((p) => p.kernel);
  const established = practices.filter((p) => p.state === "established").length;
  const homes = [...new Set(own.map((p) => p.component))];
  const enactments = state.journal.records.filter((r): r is Enactment => r.kind === "enactment");
  const latest = enactments.reduce<Enactment | undefined>((a, b) => (a === undefined || b.at > a.at ? b : a), undefined);
  const latestPractice = latest === undefined ? undefined : practices.find((p) => p.id === latest.practice);
  const parts: string[] = [];
  if (practices.length === 0) {
    parts.push("This project keeps no practices yet: a practice file beside a component's spec holds them.");
  } else {
    const ownText = own.length === 0 ? "none of its own yet" : `${count(own.length, "of its own", "of its own")}, in ${homes.map((h) => `\`${h}\``).join(", ")}`;
    parts.push(`This project keeps ${count(practices.length, "practice", "practices")}: ${ownText}${kernel.length === 0 ? "" : `, and ${count(kernel.length, "kernel practice", "kernel practices")} from Coherence`}.`);
    // In Coherence's own tree its practices are its own; those whose reach is kernel are what every adopter receives.
    const shipped = own.filter((p) => p.reach === "kernel").length;
    if (shipped > 0) parts.push(`${shipped} of them ${shipped === 1 ? "ships" : "ship"} to every adopter as Coherence's kernel; ${own.length - shipped} ${own.length - shipped === 1 ? "stays" : "stay"} internal.`);
    parts.push(`${established} ${established === 1 ? "is" : "are"} established; ${practices.length - established} ${practices.length - established === 1 ? "is a candidate" : "are candidates"} no session has carried out whole yet.`);
    if (latest !== undefined) parts.push(`The latest enactment: ${latestPractice?.name ?? latest.practice}, ${latest.at.slice(0, 10)}, by ${latest.agent}.`);
  }
  const components = state.spec.components.map((c) => ({ folder: c.folder, name: c.name, practices: own.filter((p) => p.component === c.folder).map((p) => p.id) }));
  // What has no method yet: walls and defects on record in a component with no practice of its own.
  const withPractice = new Set(own.map((p) => p.component));
  const lessons = state.journal.records.filter((r) => r.kind === "defect" || r.kind === "unable" || r.kind === "retraction");
  const byComponent = new Map<string, { folder: string; name: string; records: JournalRecord[] }>();
  for (const record of lessons) {
    for (const file of filesOf(record)) {
      const holder: SpecComponent | undefined = componentOfFile(file, state.spec.components);
      if (holder === undefined || withPractice.has(holder.folder)) continue;
      const entry = byComponent.get(holder.folder) ?? { folder: holder.folder, name: holder.name, records: [] };
      if (!entry.records.includes(record)) entry.records.push(record);
      byComponent.set(holder.folder, entry);
    }
  }
  const cited = new Set(practices.flatMap((p) => [...p.pitfalls.flatMap((pf) => pf.cites), ...p.learned]));
  const uncited = state.journal.records.filter((r) => r.kind === "defect" && !cited.has(r.id));
  return {
    summary: parts.join(" "),
    when: whenYou(practices),
    components,
    kernel: kernel.map((p) => p.id),
    unpracticed: [...byComponent.values()].sort((a, b) => b.records.length - a.records.length || a.folder.localeCompare(b.folder)),
    uncited,
  };
}

/* -------------------------------------------------------------- origin */

/** Each record id prefix and the kind it marks, read off the minter's own tables, so a kind added there is named here. */
const KIND_OF_PREFIX: ReadonlyMap<string, string> = new Map([
  ...Object.entries(KINDS).map(([kind, prefix]) => [prefix, kind] as const),
  ...Object.entries(WORK_KINDS).map(([kind, prefix]) => [prefix, `work ${kind}`] as const),
]);

/** What a citation names: a record's kind by its prefix, or a commit. */
export function citationKind(id: string): string {
  const prefix = /^([a-z]+)-[0-9a-f]{8}$/.exec(id)?.[1];
  return prefix === undefined ? "commit" : KIND_OF_PREFIX.get(prefix) ?? "record";
}

export interface PracticeOrigin {
  /** The practice's evidence by kind: "2 defects, 1 decision, 3 commits". */
  learnedFrom: string;
  /** Decisions that cite an enactment of the practice: its amendments, oldest first. */
  amendments: Extract<JournalRecord, { kind: "decision" }>[];
  /** The versions enactments carried out, oldest first, with how many each. */
  versions: { version: string; enactments: number }[];
}

export function practiceOrigin(practice: ScopePractice, records: readonly JournalRecord[]): PracticeOrigin {
  const cites = [...new Set([...practice.pitfalls.flatMap((pf) => pf.cites), ...practice.learned])];
  const kinds = new Map<string, number>();
  for (const id of cites) kinds.set(citationKind(id), (kinds.get(citationKind(id)) ?? 0) + 1);
  const learnedFrom = [...kinds.entries()].map(([kind, n]) => count(n, kind, `${kind}s`)).join(", ");
  const mine = enactmentsOf(records, practice.id);
  const ids = new Set(mine.map((e) => e.id));
  const amendments = records.filter((r): r is Extract<JournalRecord, { kind: "decision" }> => r.kind === "decision" && citesOf(r).some((id) => ids.has(id)));
  const versions: { version: string; enactments: number }[] = [];
  for (const e of mine) {
    const last = versions[versions.length - 1];
    if (last !== undefined && last.version === e.version) last.enactments += 1;
    else versions.push({ version: e.version, enactments: 1 });
  }
  return { learnedFrom, amendments, versions };
}

/* ------------------------------------------------------------ adherence */

/** One cell of a strip: what one enactment did with one step. */
export type Cell = "evidenced" | "claimed" | "done" | "deviated" | "skipped" | "absent";

export interface StepAdherence {
  n: number;
  text: string;
  leaves?: string | undefined;
  /** One cell per enactment in the strip, oldest first. */
  cells: { enactment: string; at: string; cell: Cell; note?: string | undefined }[];
  /** The reasons given for deviating or skipping, grouped by their words, most frequent first. */
  reasons: { text: string; result: "deviated" | "skipped"; count: number }[];
  /** Deviations within the strip that suggest the step itself should change. */
  amendmentSuggested: boolean;
}

/**
 * Each current step against the practice's latest enactments: a step is
 * matched to an enactment's step by its words, so an enactment of an older
 * version that lacked the step shows it absent rather than skipped.
 */
export function adherence(practice: ScopePractice, records: readonly JournalRecord[], window: number = STRIP_WINDOW): StepAdherence[] {
  const strip = enactmentsOf(records, practice.id).slice(-window);
  return practice.steps.map((step) => {
    const cells: StepAdherence["cells"] = [];
    const reasons = new Map<string, { text: string; result: "deviated" | "skipped"; count: number }>();
    let deviations = 0;
    for (const e of strip) {
      const index = e.steps.findIndex((s) => normalize(s.text) === normalize(step.text));
      const outcome = index === -1 ? undefined : e.results[String(index + 1)];
      if (index === -1 || outcome === undefined) {
        cells.push({ enactment: e.id, at: e.at, cell: "absent" });
        continue;
      }
      if (outcome.result === "done") {
        const named = e.steps[index]!.leaves !== undefined;
        const cell: Cell = named ? (outcome.evidence !== undefined && outcome.evidence.trim() !== "" ? "evidenced" : "claimed") : "done";
        cells.push({ enactment: e.id, at: e.at, cell, note: outcome.evidence });
        continue;
      }
      cells.push({ enactment: e.id, at: e.at, cell: outcome.result, note: outcome.because });
      if (outcome.result === "deviated") deviations += 1;
      const key = `${outcome.result}:${normalize(outcome.because).toLowerCase()}`;
      const entry = reasons.get(key) ?? { text: outcome.because, result: outcome.result, count: 0 };
      entry.count += 1;
      reasons.set(key, entry);
    }
    return {
      n: step.n,
      text: step.text,
      ...(step.leaves === undefined ? {} : { leaves: step.leaves }),
      cells,
      reasons: [...reasons.values()].sort((a, b) => b.count - a.count),
      amendmentSuggested: deviations >= AMENDMENT_SIGNAL,
    };
  });
}

/* ------------------------------------------------------------ attention */

export interface AttentionItem {
  practice: string;
  kind: "removed step" | "claimed, not shown" | "amendment suggested" | "never enacted";
  text: string;
}

/** What needs a reader's attention across the practices, most pressing first. */
export function attention(state: Pick<ShellState, "practices" | "spec" | "journal">): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const practice of state.practices.practices) {
    for (const problem of state.spec.problems) {
      if (problem.file === practice.file && problem.message.startsWith(`practice ${practice.name}:`) && /is gone/.test(problem.message)) {
        items.push({ practice: practice.id, kind: "removed step", text: problem.message });
      }
    }
  }
  for (const practice of state.practices.practices) {
    const latest = enactmentsOf(state.journal.records, practice.id).at(-1);
    if (latest === undefined) continue;
    latest.steps.forEach((step, i) => {
      const outcome = latest.results[String(i + 1)];
      if (step.leaves !== undefined && outcome?.result === "done" && (outcome.evidence === undefined || outcome.evidence.trim() === "")) {
        items.push({ practice: practice.id, kind: "claimed, not shown", text: `step ${i + 1} was marked done in ${latest.id} without the evidence it names (${step.leaves})` });
      }
    });
  }
  for (const practice of state.practices.practices) {
    for (const step of adherence(practice, state.journal.records)) {
      if (step.amendmentSuggested) items.push({ practice: practice.id, kind: "amendment suggested", text: `step ${step.n} was deviated from ${step.cells.filter((c) => c.cell === "deviated").length} times in the latest enactments: ${step.text}` });
    }
  }
  for (const practice of state.practices.practices) {
    // A kernel practice is carried out in adopters, so never having been enacted here says nothing about it.
    if (practice.enactments === 0 && !practice.kernel && practice.reach !== "kernel") items.push({ practice: practice.id, kind: "never enacted", text: "a candidate no session has carried out yet" });
  }
  return items;
}

/** A practice matches a query by its name, sentence, steps, pitfalls, triggers, or component. */
export function practiceMatches(practice: ScopePractice, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [practice.id, practice.sentence, practice.component, ...practice.steps.map((s) => s.text), ...practice.pitfalls.map((p) => p.text), ...practice.triggers.map(whenText)].some((f) => f.toLowerCase().includes(q));
}

/**
 * The story as plain text, for the agent query: the opening paragraph, the
 * project's working rules by what fires them, where the practices live, what
 * has no practice yet, and what needs attention, each practice by its id.
 */
export function practiceStoryText(state: Pick<ShellState, "practices" | "spec" | "journal">): string {
  const story = practiceStory(state);
  const name = (id: string): string => id;
  const lines = [story.summary.replace(/`/g, ""), ""];
  if (story.when.length > 0) {
    lines.push("When you… → follow…");
    for (const line of story.when) lines.push(`  ${line.when.replace(/`/g, "")} → ${line.practices.map(name).join(", ")}`);
    lines.push("");
  }
  const homes = story.components.filter((c) => c.practices.length > 0);
  if (homes.length > 0 || story.kernel.length > 0) {
    lines.push("Where they live");
    for (const c of homes) lines.push(`  ${c.folder}: ${c.practices.map((id) => id.slice(id.lastIndexOf("/") + 1)).join(", ")}`);
    if (story.kernel.length > 0) lines.push(`  from Coherence, the kernel: ${story.kernel.map((id) => id.slice(id.lastIndexOf("/") + 1)).join(", ")}`);
    const bare = story.components.filter((c) => c.practices.length === 0);
    if (bare.length > 0) lines.push(`  no practice of their own: ${bare.map((c) => c.folder).join(", ")}`);
    lines.push("");
  }
  if (story.unpracticed.length > 0 || story.uncited.length > 0) {
    lines.push("No practice yet");
    for (const u of story.unpracticed.slice(0, 8)) lines.push(`  ${u.folder}: ${u.records.map((r) => r.id).join(", ")}`);
    if (story.uncited.length > 0) lines.push(`  ${story.uncited.length} defect${story.uncited.length === 1 ? "" : "s"} no pitfall cites: ${story.uncited.slice(-8).map((r) => r.id).join(", ")}${story.uncited.length > 8 ? ", …" : ""}`);
    lines.push("");
  }
  const items = attention(state);
  if (items.length > 0) {
    lines.push(`Needs attention (${items.length})`);
    for (const item of items) lines.push(`  ${item.kind}: ${item.practice}: ${item.text}`);
    lines.push("");
  }
  lines.push("One practice whole: query practice \"<practice>\".");
  return lines.join("\n");
}
