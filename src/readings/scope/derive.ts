/**
 * Derivations the views share: everything computed from the state on every
 * render and stored nowhere. The latest verdict per enforcement, which
 * enforcements a run kept from an earlier one, reliance, open escalations,
 * the statuses later journal records confer, card ids, and how a hash finds
 * its view.
 */

import { slug } from "./html.ts";
import type {
  WorkOrder,
  Grade,
  JournalKind,
  JournalRecord,
  LatestEntry,
  PageEntry,
  RunEntry,
  RunRecord,
  ShellState,
  RecordedSite,
  SiteTally,
  SpecComponent,
  SpecInvariant,
  StructurePreview,
  TrustLevel,
} from "./model.ts";

export type { StructurePreview } from "./model.ts";

/* ------------------------------------------------------------- matching */

/** Whether the lower-cased query appears in any of the fields. */
export function textMatches(query: string, ...fields: (string | number | string[] | undefined | null)[]): boolean {
  if (query === "") return true;
  return fields
    .flat()
    .filter((f): f is string | number => f !== undefined && f !== null)
    .map(String)
    .join("\n")
    .toLowerCase()
    .includes(query);
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A date and minute from an ISO time, for a margin. */
export function stamp(at: string): string {
  return `${at.slice(0, 10)} ${at.slice(11, 16)}`;
}

/** The first eight characters of a session id, enough to tell sessions apart on a page. */
export function shortSession(session: string): string {
  return session.length > 8 ? session.slice(0, 8) : session;
}

/* ------------------------------------------------------------------ ids */

export function componentId(folder: string): string {
  return `component-${folder === "." ? "root" : slug(folder)}`;
}

export function invariantId(component: string, name: string): string {
  return `invariant-${component === "." ? "root" : slug(component)}-${slug(name)}`;
}

export function relianceId(component: string, name: string): string {
  return `reliance-${component === "." ? "root" : slug(component)}-${slug(name)}`;
}

/** The id shared by a drawn crossing and its expandable Structure reading. */
export function structureId(component: string, name: string): string {
  return `structure-${component === "." ? "root" : slug(component)}-${slug(name)}`;
}

/** The Structure selection of an invariant's chokepoint: every component interface it stands on, and its reliance. */
export function flowChokepointId(component: string, name: string): string {
  return `structure--chokepoint-${component === "." ? "root" : slug(component)}--${slug(name)}`;
}

/** The Structure selection of a trust level: the interfaces whose crossings carry that class of data. */
export function flowLevelId(level: string): string {
  return `structure--level-${slug(level)}`;
}

export function runId(record: RunRecord): string {
  return `run-${slug(record.at)}-${slug(shortSession(record.session))}`;
}

export function journalId(record: JournalRecord): string {
  return `journal-${slug(record.id)}`;
}

export function workId(id: string): string {
  return `work-${slug(id)}`;
}

/** The prefixes each view's card ids carry; a hash resolves to its view by them. */
const ID_PREFIXES: [string, string][] = [
  ["structure-", "structure"],
  ["component-", "components"],
  ["invariant-", "invariants"],
  ["practice-", "practices"],
  ["run-", "runs"],
  ["journal-", "journal"],
  ["work-", "journal"],
  ["coherence-", "lexicon"],
  ["domain-", "lexicon"],
  ["layer-", "lexicon"],
];

export interface HashTarget {
  view: string;
  /** The element to scroll to, or undefined when the hash names a view alone. */
  id: string | undefined;
}

/** Which view a hash lands in, and which element within it. Undefined for a hash no view claims. */
export function resolveHash(state: ShellState, hash: string): HashTarget | undefined {
  const text = hash.startsWith("#") ? hash.slice(1) : hash;
  if (text === "") return undefined;
  if (state.views.some((v) => v.id === text)) return { view: text, id: undefined };
  const redirected = retiredStructureLink(state, text);
  if (redirected !== undefined) return redirected;
  for (const [prefix, view] of ID_PREFIXES) {
    if (text.startsWith(prefix)) return { view, id: text };
  }
  return undefined;
}

/**
 * Links into the retired Reliance view and the retired security-spine section
 * land on the one map's selection that replaced them: a reliance card, or a
 * spine crossing of an invariant with a chokepoint, selects that chokepoint;
 * a spine crossing with no chokepoint selects the trust level it leaves.
 */
function retiredStructureLink(state: ShellState, text: string): HashTarget | undefined {
  if (text === "reliance") return { view: "structure", id: undefined };
  const spine = text.startsWith("structure-") && !text.startsWith("structure--");
  if (!text.startsWith("reliance-") && !spine) return undefined;
  for (const component of state.spec.components) {
    for (const invariant of component.invariants) {
      if (text !== relianceId(invariant.component, invariant.name) && text !== structureId(invariant.component, invariant.name)) continue;
      if (invariant.enforcements.some((e) => e.form === "chokepoint")) return { view: "structure", id: flowChokepointId(invariant.component, invariant.name) };
      if (invariant.crossing !== undefined) return { view: "structure", id: flowLevelId(invariant.crossing.from) };
      return { view: "invariants", id: invariantId(invariant.component, invariant.name) };
    }
  }
  return text.startsWith("reliance-") ? { view: "structure", id: undefined } : undefined;
}

/** The component a hash names, when it names one. */
export function componentOfHash(state: ShellState, id: string): SpecComponent | undefined {
  return state.spec.components.find((c) => componentId(c.folder) === id);
}

/* ---------------------------------------------------------------- runs */

export function entryKey(component: string, name: string, form: string): string {
  return `${component} ${name} ${form}`;
}

/** The latest entry per enforcement across every run, oldest record first so the last write wins. */
export function latestByEnforcement(records: readonly RunRecord[]): Map<string, LatestEntry> {
  const latest = new Map<string, LatestEntry>();
  for (const record of records) {
    for (const entry of record.invariants) {
      latest.set(entryKey(entry.component, entry.name, entry.form), { ...entry, at: record.at, commit: record.commit, session: record.session });
    }
  }
  return latest;
}

export function latestRun(records: readonly RunRecord[]): RunRecord | undefined {
  return records[records.length - 1];
}

/** Enforcements whose latest verdict the latest run did not produce: kept, dated, from an earlier run. */
export function keptFromEarlier(records: readonly RunRecord[]): LatestEntry[] {
  const last = latestRun(records);
  if (last === undefined) return [];
  const inLatest = new Set(last.invariants.map((e) => entryKey(e.component, e.name, e.form)));
  return [...latestByEnforcement(records).entries()].filter(([key]) => !inLatest.has(key)).map(([, entry]) => entry);
}

/** Whether a verdict shown for an invariant came from a run before the latest. */
export function isKept(entry: LatestEntry, records: readonly RunRecord[]): boolean {
  const last = latestRun(records);
  return last !== undefined && entry.at !== last.at;
}

export interface VerdictCounts {
  pass: number;
  fail: number;
  notRun: number;
}

export function verdictCounts(record: RunRecord): VerdictCounts {
  const counts: VerdictCounts = { pass: 0, fail: 0, notRun: 0 };
  for (const entry of record.invariants) {
    if (entry.verdict === "pass") counts.pass += 1;
    else if (entry.verdict === "fail") counts.fail += 1;
    else counts.notRun += 1;
  }
  return counts;
}

/* ------------------------------------------------------- latest verdicts */

/**
 * The latest run entry per enforcement of one bullet, derived from the run
 * records the state already holds. The rule is the run's own: the last run
 * that checked an enforcement owns its verdict, so an enforcement a later run
 * skipped keeps the one it was given, dated. Nothing is stored: a copy beside
 * the records would be a second truth that could disagree with them.
 */
export function latestOf(invariant: SpecInvariant, runs: readonly RunRecord[]): LatestEntry[] {
  const byForm = new Map<string, LatestEntry>();
  for (const run of runs) {
    for (const entry of run.invariants) {
      if (entry.component !== invariant.component || entry.name !== invariant.name) continue;
      byForm.set(entry.form, { ...entry, at: run.at, commit: run.commit, session: run.session });
    }
  }
  return [...byForm.values()].sort((a, b) => a.form.localeCompare(b.form));
}

/** The enforcements the latest run found passing. */
export function verifiedOf(invariant: SpecInvariant, runs: readonly RunRecord[]): LatestEntry[] {
  return latestOf(invariant, runs).filter((e) => e.verdict === "pass");
}

/** The enforcements the latest run found failing: the structural defects. */
export function defectsOf(invariant: SpecInvariant, runs: readonly RunRecord[]): LatestEntry[] {
  return latestOf(invariant, runs).filter((e) => e.verdict === "fail");
}

/**
 * One verdict per invariant, the one Structure shows everywhere: broken when
 * the bullet is a structural defect or its latest check of a form it still
 * declares failed (a requirement whose chokepoint check found bypasses is
 * broken too, and says so); else verified when the bullet is an invariant;
 * else a requirement. Dated by the latest run that checked it. The
 * per-enforcement verdicts it resolves stay one fold away, never beside it.
 */
export interface InvariantVerdict {
  state: "verified" | "requirement" | "broken";
  /** A requirement whose latest chokepoint check found bypasses: broken, though never an invariant. */
  bypassed: boolean;
  /** The latest run that checked any enforcement it declares, as YYYY-MM-DD. */
  at: string | undefined;
  /** The verdict in words, with its date: "verified 2026-09-22", "requirement", "structural defect 2026-09-22". */
  label: string;
}

export function invariantVerdict(invariant: SpecInvariant, runs: readonly RunRecord[]): InvariantVerdict {
  const forms = new Set(invariant.enforcements.map((e) => e.form));
  const latest = latestOf(invariant, runs).filter((entry) => forms.has(entry.form));
  const failing = latest.some((entry) => entry.verdict === "fail");
  const at = latest.map((entry) => entry.at).sort().pop()?.slice(0, 10);
  const dated = (words: string): string => (at === undefined ? words : `${words} ${at}`);
  if (invariant.state === "structural defect") return { state: "broken", bypassed: false, at, label: dated("structural defect") };
  if (failing) return invariant.state === "invariant" ? { state: "broken", bypassed: false, at, label: dated("structural defect") } : { state: "broken", bypassed: true, at, label: dated("requirement, bypassed") };
  if (invariant.state === "invariant") return { state: "verified", bypassed: false, at, label: dated("verified") };
  // A requirement is not a control: its label says so first, so "checked" never reads as a pass.
  return { state: "requirement", bypassed: false, at, label: at === undefined ? "not enforced · requirement" : `not enforced · requirement, checked ${at}` };
}

/* ------------------------------------------------------------ reliance */

/** One declared chokepoint on a crossing-bearing invariant. */
export interface StructureChokepoint {
  chokepoint: string;
  protects: string;
}

/** One classified reference to either endpoint of a chokepoint claim. */
export interface RelianceSite {
  file: string;
  line: number;
  symbol: string;
  target: RecordedSite["of"];
  siteClass: RecordedSite["class"];
  form: RecordedSite["form"] | undefined;
  /** The component containing the site, or undefined when no declared component contains it. */
  component: SpecComponent | undefined;
  /** Whether the site belongs to the component that owns the invariant. */
  owner: boolean;
  test: boolean;
}

/** Complete means both endpoint queries completed; unknown never means empty. `left` counts the sites the page's window does not carry (0 when it carries them all). */
export type RelianceEvidence =
  | { status: "complete"; sites: RelianceSite[]; left: number }
  | { status: "unknown"; reason: string };

/** The component whose folder is the longest prefix of the file, or undefined when no component holds it. */
export function componentOfFile(file: string, components: readonly SpecComponent[]): SpecComponent | undefined {
  let best: SpecComponent | undefined;
  for (const component of components) {
    if (component.folder === ".") {
      best ??= component;
      continue;
    }
    if (file === component.folder || file.startsWith(`${component.folder}/`)) {
      if (best === undefined || best.folder === "." || component.folder.length > best.folder.length) best = component;
    }
  }
  return best;
}

export function isTestFile(file: string): boolean {
  const parts = file.split("/");
  if (parts.some((part) => part === "__tests__" || part === "test" || part === "tests")) return true;
  return /\.(test|spec)\.[a-z]+$/.test(parts[parts.length - 1] ?? "");
}

function relianceEvidenceOf(
  invariant: SpecInvariant,
  components: readonly SpecComponent[],
  entry: LatestEntry | undefined,
): RelianceEvidence {
  if (entry === undefined) return { status: "unknown", reason: "reliance unknown: no run has checked this chokepoint" };
  // A reference to sites no record holds is unknown evidence, said as such: never an empty set, never legacy.
  if (entry.sitesUnresolved !== undefined) return { status: "unknown", reason: `reliance unknown: ${entry.sitesUnresolved}` };
  if (entry.sites === undefined) {
    return { status: "unknown", reason: "reliance unknown: run carries no sites; evidence is incomplete (legacy or unavailable)" };
  }
  const sites = entry.sites
    .map((site): RelianceSite => {
      const component = componentOfFile(site.file, components);
      return {
        file: site.file,
        line: site.line,
        symbol: site.symbol,
        target: site.of,
        siteClass: site.class,
        form: site.form,
        component,
        owner: component?.folder === invariant.component,
        test: site.test,
      };
    })
    .sort(
      (a, b) =>
        Number(b.owner) - Number(a.owner) ||
        (a.component?.folder ?? "~").localeCompare(b.component?.folder ?? "~") ||
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.target.localeCompare(b.target) ||
        a.siteClass.localeCompare(b.siteClass) ||
        a.symbol.localeCompare(b.symbol),
    );
  return { status: "complete", sites, left: sitesLeftCount(entry) };
}

export interface RelianceEntry {
  component: SpecComponent | undefined;
  owner: boolean;
  sites: RelianceSite[];
}

export interface Reliance {
  invariant: SpecInvariant;
  chokepoint: string;
  protects: string;
  /** The latest chokepoint entry, when one exists. */
  entry: LatestEntry | undefined;
  evidence: RelianceEvidence;
  /** Complete sites grouped owner first, then by component folder. Empty while evidence is unknown. */
  entries: RelianceEntry[];
}

/**
 * Every chokepoint invariant with actual classified references to both the
 * chokepoint and protected thing. Site absence is incomplete evidence; a
 * present empty array alone confirms zero references.
 */
export function relianceOf(invariant: SpecInvariant, components: readonly SpecComponent[], runs: readonly RunRecord[]): Reliance[] {
  const entry = latestOf(invariant, runs).find((candidate) => candidate.form === "chokepoint");
  return invariant.enforcements.flatMap((enforcement) => {
    if (enforcement.form !== "chokepoint") return [];
    const evidence = relianceEvidenceOf(invariant, components, entry);
    const byFolder = new Map<string, RelianceEntry>();
    if (evidence.status === "complete") {
      for (const site of evidence.sites) {
        const key = site.component?.folder ?? "";
        const existing = byFolder.get(key);
        if (existing === undefined) byFolder.set(key, { component: site.component, owner: site.owner, sites: [site] });
        else existing.sites.push(site);
      }
    }
    const entries = [...byFolder.values()].sort(
      (a, b) => Number(b.owner) - Number(a.owner) || (a.component?.folder ?? "~").localeCompare(b.component?.folder ?? "~"),
    );
    return [{ invariant, chokepoint: enforcement.chokepoint, protects: enforcement.protects, entry, evidence, entries }];
  });
}

export function allReliance(components: readonly SpecComponent[], runs: readonly RunRecord[]): Reliance[] {
  return components.flatMap((component) => component.invariants.flatMap((invariant) => relianceOf(invariant, components, runs)));
}

/* ------------------------------------------------------------ structure */

/** One crossing-bearing invariant, ready for a renderer or the text query. */
export interface StructureEdge {
  id: string;
  component: string;
  name: string;
  from: string;
  to: string;
  chokepoints: StructureChokepoint[];
  grade: Grade | undefined;
  enforcer: string | undefined;
  verdict: "pass" | "fail" | "not run" | "unverified";
  state: SpecInvariant["state"];
  bypassCount: number;
  proposed: boolean;
  reliance: RelianceEvidence;
}

/** The complete pure input to the Structure render. No coordinates live here. */
export interface StructureModel {
  /** Declaration order from the entry spec; the order carries no semantic rank. */
  levels: TrustLevel[];
  /** Component order, then invariant declaration order; proposed edges follow in caller order. */
  edges: StructureEdge[];
  /** Existing project invariants omitted because they declare no crossing. */
  invariantsWithoutCrossing: number;
}

/** The enforcer name at the start of a ladder rung's longer explanatory sentence. */
function structureEnforcerName(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.split(/[,:;]/, 1)[0]?.trim();
}

function structureEdgeOf(state: ShellState, invariant: SpecInvariant): StructureEdge | undefined {
  if (invariant.crossing === undefined) return undefined;
  const latest = latestOf(invariant, state.runs.records).find((entry) => entry.form === "chokepoint");
  const rung = latest?.grade === undefined ? undefined : state.spec.ladder.rungs.find((candidate) => candidate.grade === latest.grade);
  const hasChokepoint = invariant.enforcements.some((enforcement) => enforcement.form === "chokepoint");
  return {
    id: structureId(invariant.component, invariant.name),
    component: invariant.component,
    name: invariant.name,
    from: invariant.crossing.from,
    to: invariant.crossing.to,
    chokepoints: invariant.enforcements.flatMap((enforcement) =>
      enforcement.form === "chokepoint" ? [{ chokepoint: enforcement.chokepoint, protects: enforcement.protects }] : [],
    ),
    grade: latest?.grade,
    enforcer: latest?.enforcer ?? structureEnforcerName(rung?.enforcedBy),
    verdict: latest?.verdict ?? "unverified",
    state: invariant.state,
    bypassCount: latest?.bypasses.length ?? 0,
    proposed: false,
    reliance: hasChokepoint
      ? relianceEvidenceOf(invariant, state.spec.components, latest)
      : { status: "unknown", reason: "reliance unknown: invariant declares no chokepoint" },
  };
}

/**
 * Derive the security spine from crossings alone. Existing edges retain the
 * spec model's stable component/declaration order. Preview invariants are
 * ephemeral additions in caller order, with no invented verdict or reliance.
 */
export function structureOf(state: ShellState, preview: readonly StructurePreview[] = state.structure.preview): StructureModel {
  const invariants = allInvariants(state.spec.components);
  const edges = invariants.flatMap((invariant) => {
    const edge = structureEdgeOf(state, invariant);
    return edge === undefined ? [] : [edge];
  });
  for (const proposal of preview) {
    edges.push({
      id: structureId(proposal.component, proposal.name),
      component: proposal.component,
      name: proposal.name,
      from: proposal.crossing.from,
      to: proposal.crossing.to,
      chokepoints: proposal.chokepoints === undefined ? [] : [...proposal.chokepoints],
      grade: undefined,
      enforcer: undefined,
      verdict: "unverified",
      state: "requirement",
      bypassCount: 0,
      proposed: true,
      reliance: { status: "unknown", reason: "reliance unknown: proposed preview has no run evidence" },
    });
  }
  return {
    levels: state.spec.trustLevels,
    edges,
    invariantsWithoutCrossing: invariants.filter((invariant) => invariant.crossing === undefined).length,
  };
}

/* -------------------------------------------------------------- window */

/** How many of the latest run records a page embeds, beyond those that hold a latest entry. */
export const RUN_WINDOW = 12;
/** How many of the latest journal records a page embeds, beyond open escalations and what they point at. */
export const JOURNAL_WINDOW = 150;
/**
 * How many older records a page embeds because a kept record or a work order
 * cites them. Citations are followed one hop, latest citer first, and stop
 * at this cap, so a journal dense with citations cannot pull the whole store
 * back into the page; a citation past the cap renders as an id with the
 * command that shows it.
 */
export const CITED_WINDOW = 60;
/**
 * How many of each practice's latest enactments a page embeds beyond the
 * latest records: what the Practices view's strips read (STRIP_WINDOW). An
 * enactment past it is counted with the journal's other omitted records,
 * and the view says how many of a practice's enactments it holds.
 */
export const ENACTMENT_WINDOW = 12;

/**
 * How many reference sites a page carries across every latest chokepoint
 * entry. Bypass sites are always carried and count against it; the rest is
 * shared evenly (an entry that needs less gives the rest back), so neither a
 * growing codebase nor another chokepoint grows the page; every site left
 * out is counted on its entry (`sitesLeft`).
 */
export const SITE_WINDOW = 500;

/** How many of an entry's sites the page counts and does not carry: the sum of its tally. */
export function sitesLeftCount(entry: PageEntry | LatestEntry): number {
  return (entry.sitesLeft ?? []).reduce((sum, tally) => sum + tally.count, 0);
}

/** Even shares of `budget` over `needs`, the smallest needs served first, so no share is larger than its need and none is left unused while a need is unmet. */
function evenShares(needs: readonly number[], budget: number): number[] {
  const order = needs.map((_, i) => i).sort((a, b) => needs[a]! - needs[b]! || a - b);
  const shares = needs.map(() => 0);
  let left = budget;
  order.forEach((i, k) => {
    shares[i] = Math.min(needs[i]!, Math.floor(left / (order.length - k)));
    left -= shares[i]!;
  });
  return shares;
}

/**
 * One latest chokepoint entry's sites within its share: every bypass site,
 * then sites from outside the owner component, then the owner's, tests
 * last, each by file and line; the carried ones keep the run's order, and
 * the rest are counted by component, endpoint, class and test mark.
 */
function shareSites(entry: RunEntry, share: number, components: readonly SpecComponent[]): PageEntry {
  const sites = entry.sites!;
  const folder = (site: RecordedSite): string | null => componentOfFile(site.file, components)?.folder ?? null;
  const rank = (site: RecordedSite): number => (site.class === "bypass" ? 0 : site.test ? 3 : folder(site) === entry.component ? 2 : 1);
  const order = sites
    .map((site, index) => ({ site, index }))
    .filter(({ site }) => site.class !== "bypass")
    .sort((a, b) => rank(a.site) - rank(b.site) || a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line || a.index - b.index);
  if (order.length <= share) return entry;
  const left = new Set(order.slice(share).map(({ index }) => index));
  const tally = new Map<string, SiteTally>();
  sites.forEach((site, index) => {
    if (!left.has(index)) return;
    const component = folder(site);
    const key = `${component ?? ""}\u0000${site.of}\u0000${site.class}\u0000${site.test}`;
    const known = tally.get(key);
    if (known === undefined) tally.set(key, { component, of: site.of, class: site.class, test: site.test, count: 1 });
    else known.count += 1;
  });
  const sitesLeft = [...tally.values()].sort(
    (a, b) => (a.component ?? "~").localeCompare(b.component ?? "~") || a.of.localeCompare(b.of) || a.class.localeCompare(b.class) || Number(a.test) - Number(b.test),
  );
  return { ...entry, sites: sites.filter((_, index) => !left.has(index)), sitesLeft };
}

/**
 * The run records a page embeds: the latest `keep` whole, and every older run
 * that holds the latest entry of some enforcement, in their original order.
 * Every derivation over runs (the latest verdict, what the latest run kept
 * from an earlier one, reliance from its reference sites) reads the last
 * entry per enforcement, so it is the same over the window as over every
 * record. An older run kept only for what it holds carries just those
 * entries, and the verdicts of the rest as counts (`superseded`, by run id),
 * so a full run of hundreds of entries that still holds two latest verdicts
 * costs the page two entries, not hundreds. Superseded entries in the latest
 * `keep` carry no sites: a full run's sites are most of its bytes. The
 * latest entries share `sites` reference sites between them (SITE_WINDOW),
 * each counting what it leaves out by the components it reads them against.
 */
export function windowRuns(
  records: readonly RunRecord[],
  keep: number = RUN_WINDOW,
  components: readonly SpecComponent[] = [],
  sites: number = SITE_WINDOW,
): { records: RunRecord[]; omitted: number; superseded: Record<string, VerdictCounts> } {
  const holders = new Map<string, number>();
  records.forEach((record, index) => {
    for (const entry of record.invariants) holders.set(entryKey(entry.component, entry.name, entry.form), index);
  });
  const kept = new Set(holders.values());
  const recent = Math.max(0, records.length - keep);
  for (let index = recent; index < records.length; index++) kept.add(index);
  const holds = (entry: RunEntry, index: number): boolean => holders.get(entryKey(entry.component, entry.name, entry.form)) === index;
  // The latest entries with sites, and the share of the site window each carries: bypass sites first, never cut.
  const latest = records.flatMap((record, index) => (kept.has(index) ? record.invariants.filter((entry) => entry.sites !== undefined && holds(entry, index)) : []));
  const bypassSites = latest.reduce((sum, entry) => sum + entry.sites!.filter((site) => site.class === "bypass").length, 0);
  const share = evenShares(latest.map((entry) => entry.sites!.length - entry.sites!.filter((site) => site.class === "bypass").length), Math.max(0, sites - bypassSites));
  const shares = new Map(latest.map((entry, i) => [entry, share[i]!]));
  const carry = (entry: RunEntry): RunEntry => (shares.has(entry) ? shareSites(entry, shares.get(entry)!, components) : entry);
  const superseded: Record<string, VerdictCounts> = {};
  const window = records.flatMap((record, index) => {
    if (!kept.has(index)) return [];
    if (index < recent) {
      const held = record.invariants.filter((entry) => holds(entry, index));
      if (held.length < record.invariants.length) superseded[runId(record)] = verdictCounts({ ...record, invariants: record.invariants.filter((entry) => !holds(entry, index)) });
      const invariants = held.map(carry);
      return [held.length === record.invariants.length && invariants.every((entry, i) => entry === held[i]) ? record : { ...record, invariants }];
    }
    const invariants = record.invariants.map((entry) => (entry.sites === undefined ? entry : holds(entry, index) ? carry(entry) : (({ sites: _sites, ...rest }) => rest)(entry)));
    return [invariants.every((entry, i) => entry === record.invariants[i]) ? record : { ...record, invariants }];
  });
  return { records: window, omitted: records.length - window.length, superseded };
}

/**
 * The journal records a page embeds: the latest `keep`, every open
 * escalation, up to `cap` older records that a kept record or a work order
 * cites (so a citation lands on a card; the latest citers are served first),
 * and every record one of those points at (so a retraction or a close can
 * name what it answers), in their original order. `orders` supplies the
 * work orders' own citations. Of the enactments it keeps each practice's
 * latest `enactmentWindow`, every amendment and what an amendment cites.
 */
export function windowJournal(
  records: readonly JournalRecord[],
  keep: number = JOURNAL_WINDOW,
  orders: readonly WorkOrder[] = [],
  cap: number = CITED_WINDOW,
  pinned: ReadonlySet<string> = new Set(),
  enactmentWindow: number = ENACTMENT_WINDOW,
): { records: JournalRecord[]; omitted: number } {
  const kept = new Set<string>(records.slice(Math.max(0, records.length - keep)).map((record) => record.id));
  // Records a reading must be able to land on whatever their age: what the practices cite (their pitfalls and what they were learned from).
  for (const record of records) if (pinned.has(record.id)) kept.add(record.id);
  for (const escalation of openEscalations(records)) kept.add(escalation.id);
  // The Practices view's strips read each practice's latest ENACTMENT_WINDOW enactments, so the window keeps those; every decision
  // that cites an enactment (an amendment), and the enactments it cites, are kept whatever their age: they are few.
  const enactments = records.filter((record): record is Extract<JournalRecord, { kind: "enactment" }> => record.kind === "enactment");
  const byPractice = new Map<string, JournalRecord[]>();
  for (const enactment of [...enactments].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) byPractice.set(enactment.practice, [...(byPractice.get(enactment.practice) ?? []), enactment]);
  for (const mine of byPractice.values()) for (const enactment of mine.slice(-enactmentWindow)) kept.add(enactment.id);
  const enacted = new Set(enactments.map((record) => record.id));
  for (const record of records) {
    const amends = record.kind === "decision" ? citesOf(record).filter((id) => enacted.has(id)) : [];
    if (amends.length === 0) continue;
    kept.add(record.id);
    for (const id of amends) kept.add(id);
  }
  const present = new Set(records.map((record) => record.id));
  const citing = [...records.filter((record) => kept.has(record.id)).reverse().map(citesOf), ...[...orders].reverse().map(workCites)];
  let pulled = 0;
  for (const ids of citing) {
    for (const id of ids) {
      if (pulled >= cap) break;
      if (!present.has(id) || kept.has(id)) continue;
      kept.add(id);
      pulled += 1;
    }
  }
  for (const record of records) {
    const of = kept.has(record.id) ? pointsAt(record) : null;
    if (of !== null) kept.add(of);
  }
  const window = records.filter((record) => kept.has(record.id));
  return { records: window, omitted: records.length - window.length };
}

/* ------------------------------------------------------------- journal */

export const GLYPH: Record<JournalKind, string> = {
  decision: "◆",
  retraction: "↺",
  conjecture: "?",
  resolution: "✓",
  dismissal: "−",
  defect: "!",
  experiment: "▷",
  close: "▶",
  unable: "⊘",
  escalation: "▲",
  acknowledgement: "△",
  enactment: "◇",
};

export const JOURNAL_KINDS: readonly JournalKind[] = Object.keys(GLYPH) as JournalKind[];

/** Records that point at an earlier record carry its id in `of`. */
export function pointsAt(record: JournalRecord): string | null {
  switch (record.kind) {
    case "retraction":
    case "resolution":
    case "dismissal":
    case "close":
    case "acknowledgement":
      return record.of;
    default:
      return null;
  }
}

/** The ids a record cites; empty for a record that cites nothing or was written before citations. */
export function citesOf(record: { cites?: string[] | undefined }): readonly string[] {
  return Array.isArray(record.cites) ? record.cites : [];
}

/** Every id a work order's own records cite: the order record, then its moves and close, in time order. */
export function workCites(order: WorkOrder): string[] {
  return [...(order.cites ?? []), ...order.history.flatMap((event) => citesOf(event as { cites?: string[] }))];
}

/** One record that cites another: its id, and the work order it belongs to when it is a work record. */
export interface Citer {
  id: string;
  order?: string;
}

/**
 * The citations the page can draw, both ways, derived at render: what cites
 * each id (journal records and work records alike, in time order within
 * each store), and which order each work record belongs to, so a citation
 * of an order's move lands on the order's card.
 */
export interface Citations {
  citedBy: Map<string, Citer[]>;
  orderOf: Map<string, WorkOrder>;
}

export function citations(records: readonly JournalRecord[], orders: readonly WorkOrder[]): Citations {
  const edges: { target: string; citer: Citer; at: string }[] = [];
  for (const record of records) for (const id of citesOf(record)) edges.push({ target: id, citer: { id: record.id }, at: record.at });
  const orderOf = new Map<string, WorkOrder>();
  for (const order of orders) {
    orderOf.set(order.id, order);
    for (const id of order.cites ?? []) edges.push({ target: id, citer: { id: order.id, order: order.id }, at: order.at });
    for (const event of order.history) {
      orderOf.set(event.id, order);
      for (const id of citesOf(event as { cites?: string[] })) edges.push({ target: id, citer: { id: event.id, order: order.id }, at: event.at });
    }
  }
  // Oldest citer first across both stores, so the order on the page is the order the citations were written.
  edges.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.citer.id < b.citer.id ? -1 : a.citer.id > b.citer.id ? 1 : 0));
  const citedBy = new Map<string, Citer[]>();
  for (const { target, citer } of edges) {
    const list = citedBy.get(target) ?? [];
    if (!list.some((c) => c.id === citer.id)) list.push(citer);
    citedBy.set(target, list);
  }
  return { citedBy, orderOf };
}

/** Escalations with no acknowledgement pointing at them, oldest first. */
export function openEscalations(records: readonly JournalRecord[]): (JournalRecord & { kind: "escalation" })[] {
  const acknowledged = new Set(records.filter((r) => r.kind === "acknowledgement").map((r) => pointsAt(r)));
  return records.filter((r): r is JournalRecord & { kind: "escalation" } => r.kind === "escalation" && !acknowledged.has(r.id));
}

/** The status each record has acquired from later records that point at it, as "resolved by rs-…". */
export function journalStatuses(records: readonly JournalRecord[]): Map<string, string> {
  const status = new Map<string, string>();
  for (const record of records) {
    const of = pointsAt(record);
    if (of === null) continue;
    const label =
      record.kind === "close"
        ? `closed by ${record.id}: ${record.outcome}`
        : record.kind === "retraction"
          ? `retracted by ${record.id}`
          : record.kind === "resolution"
            ? `resolved by ${record.id}`
            : record.kind === "dismissal"
              ? `dismissed by ${record.id}`
              : `acknowledged by ${record.id}`;
    status.set(of, label);
  }
  return status;
}

/** The one line that stands for a record. */
export function subjectOf(record: JournalRecord): string {
  switch (record.kind) {
    case "decision":
      return record.chose;
    case "conjecture":
      return record.observation;
    case "defect":
    case "unable":
    case "escalation":
      return record.what;
    case "experiment":
      return record.expectation;
    case "retraction":
      return `retracted ${record.of}`;
    case "resolution":
      return `resolved ${record.of}`;
    case "dismissal":
      return `dismissed ${record.of}`;
    case "close":
      return `closed ${record.of}: ${record.outcome}`;
    case "acknowledgement":
      return `acknowledged ${record.of}`;
    case "enactment":
      return `enacted ${record.practice}`;
  }
}

/** Every text a record carries, for search. */
export function journalText(record: JournalRecord): string[] {
  const head = [record.id, record.kind, record.agent, record.session, record.commit ?? "", ...citesOf(record), record.human ?? ""];
  switch (record.kind) {
    case "decision":
      return [...head, record.chose, record.because, ...(record.over === "none" ? [] : record.over)];
    case "conjecture":
      return [...head, record.observation, record.discriminatedBy, ...record.couldBe];
    case "defect":
      return [...head, record.what, record.evidence, ...record.files];
    case "experiment":
      return [...head, record.expectation, ...record.context, ...record.actions.map((s) => s.text), ...record.criteria.map((s) => s.text)];
    case "close":
      return [...head, record.of, record.outcome];
    case "resolution":
      return [...head, record.of, record.because, record.as ?? ""];
    case "unable":
    case "escalation":
      return [...head, record.what, record.because];
    case "retraction":
    case "dismissal":
    case "acknowledgement":
      return [...head, record.of, record.because];
    case "enactment":
      return [...head, record.practice, record.trigger, ...record.steps.map((s) => s.text), ...Object.values(record.results).map((o) => (o.result === "done" ? o.evidence ?? "" : o.because))];
  }
}

/** Distinct values of a field across records, in first-seen order. */
export function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/* -------------------------------------------------------------- model */

/** Every invariant in the model, in component order. */
export function allInvariants(components: readonly SpecComponent[]): SpecInvariant[] {
  return components.flatMap((c) => c.invariants);
}

export function componentByFolder(components: readonly SpecComponent[], folder: string): SpecComponent | undefined {
  return components.find((c) => c.folder === folder);
}

/** The components as a tree: each with its depth, parents before children, siblings in folder order. */
export function componentTree(components: readonly SpecComponent[]): { component: SpecComponent; depth: number }[] {
  const byFolder = new Map(components.map((c) => [c.folder, c]));
  const out: { component: SpecComponent; depth: number }[] = [];
  const visit = (component: SpecComponent, depth: number): void => {
    out.push({ component, depth });
    for (const child of [...component.children].sort()) {
      const c = byFolder.get(child);
      if (c !== undefined) visit(c, depth + 1);
    }
  };
  for (const component of components) if (component.parent === undefined) visit(component, 0);
  return out;
}

/** A chokepoint enforcement's names, for matching a query against a chokepoint. */
export function chokepointNames(invariant: SpecInvariant): { chokepoint: string; protects: string }[] {
  return invariant.enforcements.flatMap((e) => (e.form === "chokepoint" ? [{ chokepoint: e.chokepoint, protects: e.protects }] : []));
}
