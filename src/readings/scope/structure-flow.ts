/**
 * The Structure map: what a system is made of and how work flows through
 * it, derived from the state on every render and stored nowhere. It is drawn
 * the way transit maps and process drawings are: journeys, not connections.
 *
 * Nodes are the components visible at the current zoom: one level of the
 * component tree at a time, a component opened in place showing its children
 * beside its own code. Edges are component interfaces, from caller to
 * callee: for each ordered pair of visible components, the symbols the
 * caller's non-test code references in the callee, as the language adapter
 * resolved them (the state's `componentInterfaces` reading, aggregated up to
 * the visible components). Without that reading only the references the
 * latest runs recorded (to chokepoints and protected things) are known, and
 * the model says so. Every component interface is in the model; none is
 * implied away.
 *
 * Structural routes. Each entrance's route is the path its handler takes
 * (ROUTE_RULE): the component that declares it, the component holding its
 * handler, then, with the handler's static reach read, from each stop the
 * heaviest component interface that reach uses through a symbol only that
 * stop's component calls (never a type, never a utility another component
 * also calls), never into a core dependency and never to a column left of
 * the last: it stops where the reach goes no further. Without a reach, the
 * heaviest interface onward, which is reference weight, not flow, and says
 * so. Entrances share one line only when they share its stops and its trust
 * (the trust level each declares it carries in, else, derived, the entering
 * side of the crossings whose chokepoint is its handler: d-ba18b0fd), and
 * what they declare of their control, a guard: line or control: none
 * (d-a1095ef2); the line is named for them, at most four names on its
 * token. An entrance that declares control: none, with its reason, is never
 * marked no traced control: its route says no control needed. A project
 * that declares no entrance has its routes derived from the root
 * component's component interfaces, one per callee, each named "via" the
 * first component it reaches and marked reference weight.
 *
 * Core dependencies. A component that more than half of the other visible
 * components call, with at least three callers and at least three quarters
 * of its component interfaces incoming, is a utility: drawn as a rail its
 * callers attach to by a stub, never as a route stop or an arrow.
 *
 * Interface identifiers. Every chokepoint gets a short identifier from its
 * place in the chokepoint list (C for a chokepoint, X for one whose
 * invariant carries a crossing), drawn on each component interface it
 * stands on, and once on a rail for the stubs into a core dependency.
 *
 * An interface is annotated from the invariants, never authored: the
 * chokepoint that stands on it (a chokepoint symbol among its symbols), the
 * crossing of that invariant when trust changes there, and the classes of
 * data that pass (the trust levels of those crossings). A bypass the latest
 * run classified on the pair marks it broken.
 *
 * Placement. A component's column is its true distance from where work
 * enters, uncapped: the fewest component interfaces from a component that
 * declares an entrance (the root when none does), never through a core
 * dependency; what no entrance reaches is measured from a component nothing
 * but a core dependency calls, which stands where work enters, undeclared. Within a column
 * components keep folder order, and each sits in the row that keeps the
 * routes reaching it from the column before as straight as that order
 * allows. Stability is stable relative order: adding one component
 * interface moves out of its column only what the interface reaches (its
 * callee and what the callee reaches, or everything its caller reaches when
 * the interface stops the caller being a core dependency), and never
 * reorders, within a column, components that keep their columns.
 * Everything is a pure function of entrances and component interfaces, ties
 * broken by name; no position is stored.
 *
 * The comparison seam: `compareFlows` takes two models (two states, two
 * commits) and names what changed with the five measures Structure's diff
 * will show.
 */

import { allInvariants, componentOfFile, flowChokepointId, flowLevelId, invariantVerdict, latestOf, openEscalations, plural, subjectOf, type InvariantVerdict, type RelianceSite } from "./derive.ts";
import { coverageOf, type EntranceCoverage } from "./entrance-coverage.ts";
import { creditedByCrossingAlone, crossingChecksTrust, namesEntrance } from "../../spec/covers.ts";
import { slug } from "./html.ts";
import { languagesReadLine, type LanguagesRead } from "./languages-read.ts";
import type { EntranceGuard, InterfacePartial, InterfaceReading, InterfaceSymbol, ReachReference, RecordedSite, ShellState, SpecComponent, SpecInvariant } from "./model.ts";

type ReadInterfaces = Extract<InterfaceReading, { kind: "read" }>;
type InterfaceBounds = NonNullable<ReadInterfaces["bounds"]>;
type InterfaceOutside = NonNullable<ReadInterfaces["outside"]>;

/** How many terminus name lines one row holds: a component whose routes start with more spans more rows. */
export const FLOW_ROW_LINES = 5;

/** The most entrance names one origin token shows; the rest are counted on one more line and listed when the route is selected. */
export const FLOW_TOKEN_NAMES = 4;

/** The lines of a route's origin token, top to bottom: at most four entrance names and a count of the rest, or "via" and the words reference weight. */
export function originLines(route: Pick<FlowRoute, "names" | "derived">): string[] {
  if (route.derived) return [...route.names, "reference weight"];
  if (route.names.length <= FLOW_TOKEN_NAMES) return route.names;
  return [...route.names.slice(0, FLOW_TOKEN_NAMES), `+${route.names.length - FLOW_TOKEN_NAMES} more`];
}

/** The rule a route is followed by, as the map's key and the query state it. */
export const ROUTE_RULE = "a route starts where its entrance is declared and handled, then follows the handler's static reach: from each stop, the heaviest component interface that reach uses through a symbol only that stop's component calls, never a type, never a utility another component also calls, never into a core dependency, never back to a column it has left; it stops where the reach goes no further";

/** The rule the map opens by, as the key and the query state it. */
export const DEFAULT_RULE = "nothing selected, every route drawn and the whole system in view; when something is broken, the component with the most broken chokepoints, then the first in folder order, is selected";

/** The rule that makes a component a core dependency, as the map and the query state it. */
export const CORE_RULE = "called by more than half of the other visible components, by at least three, with at least three quarters of its component interfaces incoming";

/* ------------------------------------------------------------------ ids */

/** Map ids start with "structure--": a slug never begins with a hyphen, so no other id can collide. */
function flowSlug(folder: string): string {
  return folder === "." ? "root" : slug(folder);
}

export function flowNodeId(folder: string): string {
  return `structure--node-${flowSlug(folder)}`;
}

export function flowEdgeId(from: string, to: string): string {
  return `structure--interface-${flowSlug(from)}--${flowSlug(to)}`;
}

export function flowEntranceId(component: string, name: string): string {
  return `structure--entrance-${flowSlug(component)}--${slug(name)}`;
}

/** A route's id: from the first entrance it starts from, or, for a derived route, from the first component it reaches. */
export function flowRouteId(origin: { entrance: string } | { via: string }): string {
  return "entrance" in origin ? origin.entrance.replace(/^structure--entrance-/, "structure--route-") : `structure--route-via-${flowSlug(origin.via)}`;
}

/** The one selection that asks what a change touches and what it weakened: the diff's place on the map. */
export const FLOW_CHANGE_ID = "structure--change";

/** The selection a reader makes by clearing: nothing lit, every route muted. An absent selection is the default story. */
export const FLOW_NONE_ID = "structure--none";

export function isFlowId(id: string): boolean {
  return id.startsWith("structure--");
}

/* ---------------------------------------------------------------- types */

/** Where the symbols of the component interfaces came from. */
export type FlowEvidence = "language adapter" | "run sites only";

export interface FlowInvariantRef {
  component: string;
  name: string;
  state: SpecInvariant["state"];
  /** Its one verdict: verified, requirement, or broken, dated (see invariantVerdict). */
  verdict: InvariantVerdict;
}

/** The states the map draws on an identifier, a component, and a boundary mark. */
export type FlowState = InvariantVerdict["state"];

/** The worst of several states: broken, then requirement, then verified. */
export function worstState(states: readonly FlowState[]): FlowState | undefined {
  return states.includes("broken") ? "broken" : states.includes("requirement") ? "requirement" : states.includes("verified") ? "verified" : undefined;
}

export interface FlowChokepoint extends FlowInvariantRef {
  id: string;
  chokepoint: string;
  protects: string;
}

export interface FlowCrossing extends FlowInvariantRef {
  from: string;
  to: string;
}

/** One component interface: every symbol `from` references in `to`, and what the invariants reveal about it. */
export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  /** Most-referenced first, then by name. */
  symbols: Omit<InterfaceSymbol, "from" | "to">[];
  sites: number;
  chokepoints: FlowChokepoint[];
  crossings: FlowCrossing[];
  /** The classes of data that pass: the trust levels of its crossings, in declaration order. */
  levels: string[];
  /** Bypass sites in `from` of a protected thing whose invariant `to` owns, from the latest run. */
  bypasses: (RelianceSite & { invariant: string })[];
  /** Load-bearing: a chokepoint or a crossing stands on it. */
  loadBearing: boolean;
  /** The structural routes that run along it, by id. */
  routes: string[];
  /** Whether its callee is a core dependency: drawn as a stub, never as a line. */
  stub: boolean;
  /** The interface identifiers standing on it, in chokepoint order. */
  identifiers: string[];
}

/** One structural route: the stops one or more entrances' work takes, in order, drawn as one line of its own color. */
export interface FlowRoute {
  id: string;
  /**
   * Its named origin, one name per line at its terminus, never truncated:
   * the names of the entrances it starts from, in declaration order, or,
   * for a derived route, "via" the first component it reaches.
   */
  names: string[];
  /** Whether no declared entrance starts it: derived from the root's component interface, and marked so. */
  derived: boolean;
  /** The color slot, 0 to 7; undefined past the eighth route, which is drawn neutral and still named. */
  slot: number | undefined;
  /** Entrance ids that take this route; empty when the route is derived from the root's interfaces. */
  entrances: string[];
  /** Component folders in the order work reaches them. */
  stops: string[];
  /** Component interface ids between consecutive stops. */
  edges: string[];
  /** The core dependency the route ends into, when its next stop would be one. */
  rail: string | undefined;
  /** The trust its entrances carry in: the level they declare, else the entering levels of the crossings whose chokepoint is their handler; empty when neither is known. */
  trust: string[];
  /** Whether its entrances declare that trust or it is derived from the crossings on their handler (d-ba18b0fd). */
  trustSource: TrustSource;
  /** Interface identifiers standing where work enters: a chokepoint that is its entrances' handler, drawn on the line from its origin. */
  entry: string[];
  /** Reference sites along its interfaces: what makes one route busier than another. */
  sites: number;
  /**
   * The interface identifiers standing on it: where work enters, on each
   * interface it takes, and on the stub to the rail it ends in.
   */
  controls: string[];
  /**
   * Every control traced on it (d-127ab8e4), in CONTROL_KINDS order: the
   * identifiers standing on its lines, and the verified chokepoints and
   * totality oracles the reading traced beyond them (see FlowControl).
   */
  traced: FlowControl[];
  /** Controls beyond its lines that only some of its entrances pass, with how many: listed, never counted. */
  partial: (FlowControl & { entrances: number })[];
  /**
   * Whether it is untrusted and no control is traced on it: an entrance route
   * with nothing in `traced` whose trust is unknown or a level from outside the
   * system's control (d-ba18b0fd). Not a demonstrated bypass: only that the
   * map traced nothing. A trusted route with no control is not marked.
   */
  noTracedControl: boolean;
  /**
   * Whether its entrances declare they need no control (control: none, with a
   * reason each): never marked no traced control, and tagged no control needed.
   * Entrances share a route only when they agree on it.
   */
  noControl: boolean;
  /** How its stops were followed: the handler's static reach, or, without one, the heaviest interface (reference weight, not flow). */
  followed: "reach" | "weight";
}

/**
 * How a control on a route was traced (d-127ab8e4), in the order the
 * inspector lists them:
 *
 *   interface  an interface identifier stands on its lines: where work
 *              enters, on an interface it takes, or on the stub to its rail
 *              (any verdict; the identifier wears it)
 *   wrapper    the entrances' handler is registered through a verified
 *              chokepoint: its own declaration references the chokepoint and
 *              its reach reaches the protected thing, or its guard: line names
 *              the chokepoint and a registration of the handler spells it
 *   inside     a verified chokepoint whose invariant a component on the route
 *              owns, whose protected thing the handler's reach reaches: it
 *              stands inside that component, on no line of the map
 *   totality   a verified invariant enforced only by a totality oracle whose
 *              entrances: line names the entrance: test-backed, not
 *              structural, and never credited by its crossing alone
 *
 * Every kind but the wrapper counts only when its invariant's crossing
 * checks what the route's trust sends: it enters from a level the route
 * carries in, or enters one (c-9941b95e). A chokepoint guarding another
 * boundary, or declaring none, is no check on this caller however far the
 * handler's reach runs; a wrapper's handler is registered through it.
 */
export const CONTROL_KINDS = ["interface", "wrapper", "inside", "totality"] as const;
export type FlowControlKind = (typeof CONTROL_KINDS)[number];

/** One control traced on a route: which invariant, how it was traced, and, on a line, its identifier. */
export interface FlowControl {
  kind: FlowControlKind;
  component: string;
  name: string;
  /** The interface identifier, for a control standing on the route's lines. */
  identifier: string | undefined;
  /** For a wrapper: whether an entrance's guard: line declared it (confirmed by the reading) or the reading detected it. */
  declared: boolean;
  verdict: InvariantVerdict;
}

/** A core dependency: a component most others call, drawn as a rail. */
export interface FlowCore {
  folder: string;
  /** Visible components calling it, in folder order. */
  callers: string[];
  /** Interface ids from its callers: each is a stub. */
  stubs: string[];
}

/** An interface identifier: the short tag a chokepoint wears where it stands. */
export interface FlowIdentifier {
  /** The tag itself: C or X and the chokepoint's place in the list, as C3 or X7. */
  text: string;
  /** The chokepoint's id. */
  chokepoint: string;
  component: string;
  name: string;
  /** The crossing of its invariant, when trust changes there: a trust boundary on the map. */
  crossing: { from: string; to: string } | undefined;
  /** Component interface ids it stands on. */
  edges: string[];
  /** Routes on whose entrance line it stands: the chokepoint is their entrances' handler. */
  routes: string[];
  /** Its invariant's one verdict, drawn on the identifier. */
  verdict: InvariantVerdict;
}

export interface FlowEntrance {
  id: string;
  name: string;
  meaning: string;
  /** The component whose spec declares it. */
  declaredBy: string;
  /** The components that own it, unfolded by zoom: the one whose spec declares it and the one holding its resolved handler. */
  owners: string[];
  handler: string | undefined;
  /** The visible component holding the resolved handler, where its flow starts. */
  start: string | undefined;
  resolved: boolean;
  reachable: boolean;
  /** Why it is unresolved or unreachable. */
  reason: string | undefined;
  /** The trust work carries in by it: the level it declares, else the entering side of every crossing whose chokepoint is its handler, in level order. */
  trust: string[];
  /** Whether its spec declares that trust (a trust: line) or it is derived from the crossings on its handler. */
  trustSource: TrustSource;
  /** The component interfaces its handler's static reach uses, when the adapter read them. */
  reach: ReachReference[] | undefined;
  /** The components its work passes, unrepresented: where it is declared and handled, and every component its handler's reach enters. */
  passes: string[];
  /** Whether its handler is a module file, whose top-level script receives the work. */
  module: boolean;
  /** The chokepoint its guard: line declares, when it declares one. */
  guard: string | undefined;
  /** The chokepoints the reading traced its handler passing, in any verdict; absent when the reading did not trace them. */
  guards: EntranceGuard[] | undefined;
  /** Why its declared guard does not count, when the reading could not confirm it. */
  guardUnconfirmed: string | undefined;
  /** Why it needs no control, when its spec says so (control: none — <reason>). */
  noControl: string | undefined;
  /** The invariants whose entrances: line names it, in declaration order: the only ones a test-backed control is credited from (covers.ts). */
  coveredBy: { component: string; name: string }[];
  /**
   * Verified invariants that covered it by their crossing alone before
   * entrances: (PR #4) and cover it no longer, until they name it: said
   * where the agent reads its gap, never dropped in silence.
   */
  unnamed: { component: string; name: string }[];
}

export interface FlowNode {
  id: string;
  folder: string;
  name: string;
  intent: string;
  /** Its first row: rows keep routes straight and, within a column, follow folder order (see the file comment). */
  row: number;
  /** Rows it spans: one, or more when the names at its termini need them. */
  span: number;
  /** True distance from where work enters, uncapped (see the file comment); 0 for a core dependency, which stands on a rail. */
  column: number;
  /** Distinct visible components it calls, and that call it. */
  out: number;
  in: number;
  /** Whether work enters here: its spec declares an entrance, or none does and it is the root. */
  declaresEntrance: boolean;
  /** Whether it is a core dependency, drawn as a rail. */
  core: boolean;
  /** Whether no component interface touches it. */
  unconnected: boolean;
  /** Entrances whose flow starts here. */
  entrances: string[];
  /** Components nested beneath it, and whether they are shown. */
  children: number;
  expanded: boolean;
  /** Broken chokepoints of its invariants: every bypass site, and how many are inside it, where no edge can show them. */
  defects: { name: string; state: SpecInvariant["state"]; chokepoint: string; bypasses: number; internal: number; sites: { file: string; line: number; symbol: string; inside: boolean }[] }[];
  /** Its own invariants (and its hidden children's), each with its one verdict, broken first. */
  invariants: FlowInvariantRef[];
  /** The worst verdict among its invariants; undefined when it declares none. */
  state: FlowState | undefined;
  /** Crossings standing inside it, on no drawn component interface or entrance line: its boundary mark. */
  boundary: FlowCrossing[];
  /**
   * Whether an enforcement covers it: a chokepoint (in any state) stands on a
   * component interface it exposes or on an entrance line into it, or one of
   * its own invariants is verified by a totality oracle (decision d-a02f255c).
   */
  covered: boolean;
}

/** Where an entrance's trust comes from: its spec's trust: line, or the crossings on its handler. */
export type TrustSource = "declared" | "derived";

export interface FlowLevel {
  id: string;
  name: string;
  meaning: string;
  /** Whether it comes from outside the system's control: an entrance carrying it with no control traced on its route is marked no traced control. */
  outside: boolean;
  /** Interfaces whose crossings carry this class of data. */
  edges: string[];
  /** Routes whose entrance line carries a crossing of this class of data. */
  routes: string[];
  /** Components whose boundary mark carries a crossing of this class of data. */
  components: string[];
  /** Crossing-bearing invariants naming this level that the map places nowhere: none, when every crossing is drawn. */
  unplaced: FlowCrossing[];
}

/** Where one crossing is drawn: on the interfaces its chokepoint stands on, on an entrance line, or on its component's boundary mark. */
export interface FlowCrossingPlace extends FlowCrossing {
  edges: string[];
  routes: string[];
  /** The visible component whose boundary mark carries it, when neither an interface nor an entrance line does. */
  component: string;
  on: "interface" | "entrance" | "component";
}

/** The health strip: every invariant by its one verdict, and the escalations a human has not acknowledged. */
export interface FlowHealth {
  /** Enforced and verified: the spec model's invariants. */
  verified: FlowInvariantRef[];
  /** Declared, not yet invariants: the spec model's requirements. */
  requirements: FlowInvariantRef[];
  /** The spec model's structural defects. */
  defects: FlowInvariantRef[];
  /** Requirements whose latest chokepoint check found bypasses: broken, though never enforced. */
  bypassed: FlowInvariantRef[];
  escalations: { id: string; what: string }[];
  /** Components no enforcement covers (FlowNode.covered), in folder order. */
  uncovered: string[];
}

/** The strip's counts, and "broken": the structural defects and the bypassed requirements together, the set the verdict names. */
export const FLOW_HEALTH_KINDS = ["verified", "requirements", "defects", "bypassed", "broken", "uncovered", "escalations"] as const;
export type FlowHealthKind = (typeof FLOW_HEALTH_KINDS)[number];

export function flowHealthId(kind: FlowHealthKind): string {
  return `structure--health-${kind}`;
}

/** A component's broken mark: selects its broken chokepoints and their bypass sites. */
export function flowBrokenId(folder: string): string {
  return `structure--broken-${flowSlug(folder)}`;
}

/** A component's boundary mark: selects the crossings standing inside it. */
export function flowBoundaryId(folder: string): string {
  return `structure--boundary-${flowSlug(folder)}`;
}

/** A multi-language project's languages as the reading read them, as a clause: each one read and each one not, with why; empty for one language. */
export function unreadLanguagesText(model: Pick<FlowModel, "languages">): string {
  const line = languagesReadLine(model.languages);
  return line === undefined ? "" : ` (${line})`;
}

export interface FlowModel {
  evidence: FlowEvidence;
  /** The language the adapter read, when it read. */
  language: string | undefined;
  /** Which of the project's languages the reading read, and each one it did not with why; absent when the adapter did not read. */
  languages?: LanguagesRead | undefined;
  /** Why the adapter's reading is absent, when it is. */
  unread: string | undefined;
  /** Drawn from run sites only: each latest chokepoint entry whose sites a reference named and its run file did not hold, as "component/name: why". Never drawn as no references. */
  sitesUnknown: string[];
  /** Visible components in folder order (their column order). */
  nodes: FlowNode[];
  /** Every component interface between visible components, in folder order of caller then callee. */
  edges: FlowEdge[];
  entrances: FlowEntrance[];
  levels: FlowLevel[];
  chokepoints: FlowChokepoint[];
  /** Structural routes in route order. */
  routes: FlowRoute[];
  /** Where the routes come from: declared entrances, or the root's interfaces when no entrance is declared. */
  routesFrom: "entrances" | "root interfaces" | "none";
  coreDependencies: FlowCore[];
  identifiers: FlowIdentifier[];
  /** Source under no component's folder, when the adapter read the tree. */
  unowned: { files: number; lines: number } | undefined;
  /** What the adapter's reading was bounded to, when it read and said so. */
  bounds: InterfaceBounds | undefined;
  /** Reference sites the adapter's reading found outside every declared component, counted and never drawn. */
  outside: InterfaceOutside | undefined;
  /** Present when a budget stopped the adapter's reading: the map is partial. */
  partial: InterfacePartial | undefined;
  /** Every crossing, and where the map draws it. */
  crossings: FlowCrossingPlace[];
  health: FlowHealth;
  /** How much of the surface the reading detected the declared entrances cover; absent when the reading detected nothing (unread, or taken before detection). */
  coverage: EntranceCoverage | undefined;
}

/* ------------------------------------------------------ interface symbols */

const FLOW_NAME = /^([A-Za-z_$][\w$]*)(?:\s+in\s+(\S+))?$/;

/** A spec value as a symbol and optional file, or a module path; undefined for prose. */
function flowNamed(value: string): { symbol?: string; file?: string } | undefined {
  const named = FLOW_NAME.exec(value.trim());
  if (named !== null) return named[2] === undefined ? { symbol: named[1]! } : { symbol: named[1]!, file: named[2]! };
  if (/^[A-Za-z0-9_./@-]+\.[A-Za-z]+$/.test(value.trim())) return { file: value.trim() };
  return undefined;
}

/** Whether trust carried in is untrusted: unknown, a level no entry spec declares, or one from outside the system's control. */
export function flowUntrusted(trust: readonly string[], declared: ReadonlyMap<string, unknown>, outside: ReadonlySet<string>): boolean {
  return trust.length === 0 || trust.some((level) => !declared.has(level) || outside.has(level));
}

/** Whether an interface symbol is the named thing: the same symbol (in the named file, when one is named), or any symbol of a named module. */
function flowIs(symbol: Omit<InterfaceSymbol, "from" | "to">, named: { symbol?: string; file?: string }): boolean {
  const inFile = named.file === undefined || symbol.file === "" || symbol.file === named.file || symbol.file.endsWith(`/${named.file}`);
  return named.symbol === undefined ? inFile && symbol.file !== "" : symbol.symbol === named.symbol && inFile;
}

/** The latest chokepoint entries whose sites a reference named and no record of its file held: said, never read as no references. */
function flowSitesUnknown(state: ShellState): string[] {
  return allInvariants(state.spec.components).flatMap((invariant) => {
    const entry = latestOf(invariant, state.runs.records).find((candidate) => candidate.form === "chokepoint");
    return entry?.sitesUnresolved === undefined ? [] : [`${invariant.component}/${invariant.name}: ${entry.sitesUnresolved}`];
  });
}

/** The symbols the latest runs recorded as referenced across components: the fallback when the adapter was not asked. */
function flowRunSymbols(state: ShellState): InterfaceSymbol[] {
  const components = state.spec.components;
  const tally = new Map<string, InterfaceSymbol>();
  for (const invariant of allInvariants(components)) {
    const entry = latestOf(invariant, state.runs.records).find((candidate) => candidate.form === "chokepoint");
    // An entry whose sites are unknown is named in the model's sitesUnknown, never drawn as an entry with none.
    if (entry?.sites === undefined) continue;
    // The sites a page carries, and those its window counted by component instead: the same tally either way.
    const counted = [
      ...entry.sites.map((site) => ({ from: componentOfFile(site.file, components)?.folder ?? null, of: site.of, class: site.class, test: site.test, count: 1 })),
      ...(entry.sitesLeft ?? []).map((left) => ({ ...left, from: left.component })),
    ];
    for (const enforcement of invariant.enforcements) {
      if (enforcement.form !== "chokepoint") continue;
      for (const site of counted) {
        if (site.test || site.class === "test" || site.class === "inside") continue;
        const from = site.from;
        if (from === null || from === invariant.component) continue;
        const value = site.of === "chokepoint" ? enforcement.chokepoint : enforcement.protects;
        const named = flowNamed(value);
        const symbol = named?.symbol ?? value;
        const key = `${from}\u0000${invariant.component}\u0000${symbol}`;
        const known = tally.get(key);
        if (known === undefined) tally.set(key, { from, to: invariant.component, symbol, file: named?.file ?? "", sites: site.count });
        else known.sites += site.count;
      }
    }
  }
  return [...tally.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.symbol.localeCompare(b.symbol));
}

function flowBypasses(state: ShellState, invariant: SpecInvariant): RecordedSite[] {
  // A chokepoint entry kept from before the bullet dropped its chokepoint form is history, not evidence.
  if (!invariant.enforcements.some((e) => e.form === "chokepoint")) return [];
  const entry = latestOf(invariant, state.runs.records).find((candidate) => candidate.form === "chokepoint");
  if (entry === undefined) return [];
  if (entry.sites !== undefined) return entry.sites.filter((site) => site.class === "bypass" && !site.test);
  return entry.bypasses.map((b): RecordedSite => ({ file: b.file, line: b.line, symbol: b.symbol, class: "bypass", of: "protected", test: false }));
}

/* --------------------------------------------------------------- zoom */

/** The folders open in place: as the state says, else every top-level component. */
export function flowExpanded(state: ShellState): Set<string> {
  if (state.structure.expanded !== undefined) return new Set(state.structure.expanded);
  return new Set(state.spec.components.filter((component) => component.parent === undefined).map((component) => component.folder));
}

/** The visible component that stands for a folder at the current zoom: itself when every ancestor is open, else the nearest closed ancestor. */
function flowRepresentative(components: Map<string, SpecComponent>, expanded: Set<string>, folder: string): string {
  const chain: string[] = [];
  for (let at: string | undefined = folder; at !== undefined; at = components.get(at)?.parent) chain.unshift(at);
  for (let index = 0; index < chain.length - 1; index++) if (!expanded.has(chain[index]!)) return chain[index]!;
  return folder;
}

/** The visible component that stands for each folder at the state's zoom, as flowOf folds them. */
export function flowRepresentOf(state: ShellState): (folder: string) => string {
  const byFolder = new Map(state.spec.components.map((component) => [component.folder, component]));
  const expanded = flowExpanded(state);
  return (folder) => flowRepresentative(byFolder, expanded, folder);
}

/* ---------------------------------------------------------- the model */

/**
 * Derive the Structure map from the state: the one pure function the view
 * and `query structure` both read.
 */
export function flowOf(state: ShellState): FlowModel {
  const components = state.spec.components;
  const byFolder = new Map(components.map((component) => [component.folder, component]));
  const expanded = flowExpanded(state);
  const represent = (folder: string): string => flowRepresentative(byFolder, expanded, folder);
  const visible = components.filter((component) => represent(component.folder) === component.folder);
  const order = new Map(visible.map((component, index) => [component.folder, index]));
  const invariants = allInvariants(components);
  const verdicts = new Map(invariants.map((invariant) => [`${invariant.component}\u0000${invariant.name}`, invariantVerdict(invariant, state.runs.records)]));
  const verdictOf = (component: string, name: string): InvariantVerdict => verdicts.get(`${component}\u0000${name}`) ?? { state: "requirement", bypassed: false, at: undefined, label: "not enforced · requirement" };
  const refOf = (invariant: SpecInvariant): FlowInvariantRef => ({ component: invariant.component, name: invariant.name, state: invariant.state, verdict: verdictOf(invariant.component, invariant.name) });
  const levelOrder = new Map(state.spec.trustLevels.map((level, index) => [level.name, index]));
  const reading = state.componentInterfaces;
  const symbols = reading.kind === "read" ? reading.symbols : flowRunSymbols(state);

  const pairs = new Map<string, Map<string, Omit<InterfaceSymbol, "from" | "to">>>();
  for (const symbol of symbols) {
    if (!byFolder.has(symbol.from) || !byFolder.has(symbol.to)) continue;
    const from = represent(symbol.from);
    const to = represent(symbol.to);
    if (from === to) continue;
    const key = `${from}\u0000${to}`;
    const carried = pairs.get(key) ?? new Map<string, Omit<InterfaceSymbol, "from" | "to">>();
    pairs.set(key, carried);
    const known = carried.get(`${symbol.symbol}\u0000${symbol.file}`);
    if (known === undefined) carried.set(`${symbol.symbol}\u0000${symbol.file}`, { symbol: symbol.symbol, file: symbol.file, sites: symbol.sites });
    else known.sites += symbol.sites;
  }

  const chokepoints: FlowChokepoint[] = invariants.flatMap((invariant) =>
    invariant.enforcements.flatMap((enforcement): FlowChokepoint[] =>
      enforcement.form === "chokepoint"
        ? [{ id: flowChokepointId(invariant.component, invariant.name), ...refOf(invariant), chokepoint: enforcement.chokepoint, protects: enforcement.protects }]
        : [],
    ),
  );

  const edges: FlowEdge[] = [...pairs.entries()]
    .sort(([a], [b]) => {
      const [af, at] = a.split("\u0000") as [string, string];
      const [bf, bt] = b.split("\u0000") as [string, string];
      return order.get(af)! - order.get(bf)! || order.get(at)! - order.get(bt)!;
    })
    .map(([key, carried]) => {
      const [from, to] = key.split("\u0000") as [string, string];
      const list = [...carried.values()].sort((a, b) => b.sites - a.sites || a.symbol.localeCompare(b.symbol) || a.file.localeCompare(b.file));
      const standing = chokepoints.filter((c) => represent(c.component) === to && list.some((symbol) => { const named = flowNamed(c.chokepoint); return named !== undefined && flowIs(symbol, named); }));
      const crossings: FlowCrossing[] = standing.flatMap((c) => {
        const crossing = invariants.find((invariant) => invariant.component === c.component && invariant.name === c.name)?.crossing;
        return crossing === undefined ? [] : [{ component: c.component, name: c.name, state: c.state, verdict: c.verdict, from: crossing.from, to: crossing.to }];
      });
      const bypasses: FlowEdge["bypasses"] = [];
      for (const invariant of invariants) {
        if (represent(invariant.component) !== to) continue;
        for (const site of flowBypasses(state, invariant)) {
          const component = componentOfFile(site.file, components);
          if (component === undefined || represent(component.folder) !== from) continue;
          bypasses.push({ file: site.file, line: site.line, symbol: site.symbol, target: site.of, siteClass: site.class, form: site.form, component, owner: false, test: false, invariant: invariant.name });
        }
      }
      const levels = [...new Set(crossings.flatMap((c) => [c.from, c.to]))].sort((a, b) => (levelOrder.get(a) ?? 99) - (levelOrder.get(b) ?? 99) || a.localeCompare(b));
      return {
        id: flowEdgeId(from, to),
        from,
        to,
        symbols: list,
        sites: list.reduce((sum, symbol) => sum + symbol.sites, 0),
        chokepoints: standing,
        crossings,
        levels,
        bypasses: bypasses.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
        loadBearing: standing.length > 0 || crossings.length > 0,
        routes: [] as string[],
        stub: false,
        identifiers: [] as string[],
      };
    });

  // Entrances: resolved by the adapter when it was asked, else by the spec model's own check.
  const resolutions = reading.kind === "read" ? reading.entrances : undefined;
  const entrances: FlowEntrance[] = components.flatMap((component) =>
    (component.entrances ?? []).map((entrance): FlowEntrance => {
      const resolution = resolutions?.find((r) => r.component === component.folder && r.name === entrance.name);
      const file = resolutions === undefined ? entrance.file : resolution?.file;
      const holder = file === undefined ? undefined : componentOfFile(file, components)?.folder;
      const start = holder === undefined ? undefined : represent(holder);
      const declaredBy = represent(component.folder);
      const module = entrance.handler !== undefined && flowNamed(entrance.handler)?.symbol === undefined && flowNamed(entrance.handler)?.file !== undefined;
      const handlerName = module ? undefined : entrance.handler?.split(/\s+in\s+/)[0];
      const dispatch = edges.find((edge) => edge.from === declaredBy && edge.to === start);
      // A module handler's script is run where it lies: reached when declared there, or when the declaring component references its module.
      const reachable = start !== undefined && (start === declaredBy || (dispatch?.symbols.some((symbol) => (module ? symbol.file === file : symbol.symbol === handlerName)) ?? false));
      const reason =
        start === undefined
          ? (resolution?.reason ?? "the handler did not resolve")
          : reachable
            ? undefined
            : module
              ? `the module ${file} lies in ${start}, and no component interface from ${declaredBy} carries it`
              : `the handler resolves in ${start}, and no component interface from ${declaredBy} carries ${handlerName ?? "it"}`;
      // Its trust: the level it declares; else, derived, the entering side of each crossing whose chokepoint is its handler,
      // in the handler's component (d-ba18b0fd). The spec check refuses a declaration that contradicts such a crossing.
      const trustSource: TrustSource = entrance.trust === undefined ? "derived" : "declared";
      const trust = entrance.trust !== undefined
        ? [entrance.trust]
        : start === undefined || handlerName === undefined
        ? []
        : [...new Set(invariants.filter((invariant) => invariant.crossing !== undefined && represent(invariant.component) === start && invariant.enforcements.some((e) => e.form === "chokepoint" && flowNamed(e.chokepoint)?.symbol === handlerName)).map((invariant) => invariant.crossing!.from))]
          .sort((a, b) => (levelOrder.get(a) ?? 99) - (levelOrder.get(b) ?? 99) || a.localeCompare(b));
      const passes = [...new Set([component.folder, ...(holder === undefined ? [] : [holder]), ...(resolution?.reach ?? []).flatMap((r) => [r.from, r.to])])].sort();
      const owners = [...new Set([component.folder, ...(holder === undefined ? [] : [holder])])];
      // Which invariants name it as covered; and which covered it by their crossing alone, the rule before (PR #4), and no longer do.
      const named = { component: component.folder, name: entrance.name };
      const coveredBy = invariants.filter((invariant) => namesEntrance(invariant, named, components)).map((invariant) => ({ component: invariant.component, name: invariant.name }));
      // Said only where the loss can leave a gap: work carried in from outside the system's control, needing a control.
      const fromOutside = state.spec.trustLevels.some((level) => level.outside === true && trust.includes(level.name));
      const unnamed = entrance.noControl !== undefined || !fromOutside ? [] : invariants.filter((invariant) => creditedByCrossingAlone(invariant, owners, trust) && verdictOf(invariant.component, invariant.name).state === "verified").map((invariant) => ({ component: invariant.component, name: invariant.name }));
      return { id: flowEntranceId(component.folder, entrance.name), name: entrance.name, meaning: entrance.meaning, declaredBy, owners, handler: entrance.handler, start, resolved: start !== undefined, reachable, reason, trust, trustSource, reach: resolution?.reach, passes, module, guard: entrance.guard, guards: resolution?.guards, guardUnconfirmed: resolution?.guardUnconfirmed, noControl: entrance.noControl, coveredBy, unnamed };
    }),
  );

  // Who calls whom among the visible components: every placement fact below is read from the component interfaces.
  const callersOf = new Map<string, string[]>(visible.map((component) => [component.folder, edges.filter((edge) => edge.to === component.folder).map((edge) => edge.from)]));
  const calleesOf = new Map<string, string[]>(visible.map((component) => [component.folder, edges.filter((edge) => edge.from === component.folder).map((edge) => edge.to)]));
  const anyEntrance = components.some((component) => (component.entrances ?? []).length > 0);
  const entersHere = (folder: string): boolean =>
    anyEntrance
      ? components.some((c) => represent(c.folder) === folder && (c.entrances ?? []).length > 0)
      : folder === ".";
  const others = visible.length - 1;
  const isCore = (folder: string): boolean => {
    const callers = callersOf.get(folder)!.length;
    const callees = calleesOf.get(folder)!.length;
    return callers >= 3 && callers * 2 > others && callers * 4 >= 3 * (callers + callees);
  };
  const core = new Set(visible.map((component) => component.folder).filter(isCore));

  // Columns: true distance from where work enters, never through a core dependency.
  const placed = visible.map((component) => component.folder).filter((folder) => !core.has(folder));
  const column = new Map<string, number>();
  const spread = (sources: string[]): void => {
    const queue = sources.filter((folder) => !column.has(folder));
    for (const folder of queue) column.set(folder, 0);
    while (queue.length > 0) {
      const at = queue.shift()!;
      for (const next of calleesOf.get(at)!) {
        if (core.has(next) || column.has(next)) continue;
        column.set(next, column.get(at)! + 1);
        queue.push(next);
      }
    }
  };
  spread(placed.filter(entersHere));
  // What no entrance reaches is measured from where it is entered undeclared: a component nothing but a core dependency calls.
  spread(placed.filter((folder) => !column.has(folder) && callersOf.get(folder)!.every((caller) => core.has(caller))));
  // A cycle nothing outside it reaches: its first component in folder order stands where work enters.
  for (let rest = placed.filter((folder) => !column.has(folder)); rest.length > 0; rest = placed.filter((folder) => !column.has(folder))) spread([rest[0]!]);

  // Structural routes. With the handler's static reach read, a route follows the handler: from each stop, the heaviest
  // component interface the reach uses through a symbol only that stop's component calls (never a type, which the reach
  // never follows, and never a utility another component also calls), never into a core dependency, never to a column
  // left of the last; it stops where the reach goes no further. Without a reach, the heaviest interface onward:
  // reference weight, not flow.
  const byPair = new Map(edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge]));
  const onward = (stops: string[]): { stops: string[]; rail: string | undefined } => {
    const route = [...stops];
    for (;;) {
      const at = route[route.length - 1]!;
      const next = edges
        .filter((edge) => edge.from === at && !route.includes(edge.to) && !core.has(edge.to) && column.get(edge.to)! >= column.get(at)!)
        .sort((a, b) => b.sites - a.sites || a.to.localeCompare(b.to))[0];
      if (next === undefined) return { stops: route, rail: undefined };
      route.push(next.to);
    }
  };
  // Which visible components reference each symbol: one referenced by more than one is a utility, never a route's step.
  const callersOfSymbol = new Map<string, Set<string>>();
  for (const symbol of symbols) {
    if (!byFolder.has(symbol.from) || !byFolder.has(symbol.to)) continue;
    const key = `${represent(symbol.to)}\u0000${symbol.symbol}\u0000${symbol.file}`;
    const set = callersOfSymbol.get(key) ?? new Set<string>();
    set.add(represent(symbol.from));
    callersOfSymbol.set(key, set);
  }
  const follows = (from: string, to: string, reference: ReachReference): boolean =>
    byPair.has(`${from}\u0000${to}`) && (callersOfSymbol.get(`${to}\u0000${reference.symbol}\u0000${reference.file}`)?.size ?? 1) <= 1;
  const alongReach = (stops: string[], reach: readonly ReachReference[]): { stops: string[]; rail: string | undefined } => {
    const route = [...stops];
    for (;;) {
      const at = route[route.length - 1]!;
      const weight = new Map<string, number>();
      for (const reference of reach) {
        if (!byFolder.has(reference.from) || !byFolder.has(reference.to)) continue;
        const from = represent(reference.from);
        const to = represent(reference.to);
        if (from !== at || to === at || route.includes(to) || core.has(to) || column.get(to)! < column.get(at)! || !follows(from, to, reference)) continue;
        weight.set(to, (weight.get(to) ?? 0) + reference.sites);
      }
      const next = [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (next === undefined) return { stops: route, rail: undefined };
      route.push(next[0]);
    }
  };
  const drafts: { stops: string[]; rail: string | undefined; entrance: string | undefined; trust: string[]; trustSource: TrustSource; followed: FlowRoute["followed"]; declares: string }[] = [];
  const routesFrom: FlowModel["routesFrom"] = anyEntrance ? "entrances" : byFolder.has(".") && order.has(".") && !core.has(".") ? "root interfaces" : "none";
  if (routesFrom === "entrances") {
    for (const entrance of entrances) {
      if (!entrance.reachable || entrance.start === undefined || core.has(entrance.declaredBy)) continue;
      const first = entrance.declaredBy === entrance.start ? [entrance.start] : [entrance.declaredBy, entrance.start];
      const followed: FlowRoute["followed"] = entrance.reach === undefined ? "weight" : "reach";
      const { trust, trustSource } = entrance;
      // What the entrance declares of its control: a guard: line, control: none, or the invariants that name it as covered.
      // Entrances that declare differently never share a line, so a control named for some counts for those it names.
      const declares = [entrance.noControl !== undefined ? "none" : entrance.guard === undefined ? "" : `guard ${entrance.guard}`, ...entrance.coveredBy.map((c) => `covered ${c.component}\u0001${c.name}`)].join("\u0000");
      if (core.has(entrance.start)) drafts.push({ stops: [entrance.declaredBy], rail: entrance.start, entrance: entrance.id, trust, trustSource, followed, declares });
      else drafts.push({ ...(entrance.reach === undefined ? onward(first) : alongReach(first, entrance.reach)), entrance: entrance.id, trust, trustSource, followed, declares });
    }
  } else if (routesFrom === "root interfaces") {
    const fromRoot = edges.filter((edge) => edge.from === "." && !core.has(edge.to)).sort((a, b) => b.sites - a.sites || a.to.localeCompare(b.to));
    for (const edge of fromRoot) drafts.push({ ...onward([".", edge.to]), entrance: undefined, trust: [], trustSource: "derived", followed: "weight", declares: "" });
  }
  const nameOf = (folder: string): string => byFolder.get(folder)!.name;
  const routes: FlowRoute[] = [];
  // Entrances share a route only when they share its stops, its rail, the trust they carry in, declared or derived alike,
  // and what they declare of their control (a guard: line, or control: none).
  const declaresOf = new Map<string, string>();
  for (const draft of drafts) {
    const known = routes.find((route) => route.stops.join("\u0000") === draft.stops.join("\u0000") && route.rail === draft.rail && route.trust.join("\u0000") === draft.trust.join("\u0000") && route.trustSource === draft.trustSource && declaresOf.get(route.id) === draft.declares);
    if (known !== undefined) {
      if (draft.entrance !== undefined) {
        known.entrances.push(draft.entrance);
        known.names.push(entrances.find((e) => e.id === draft.entrance)!.name);
      }
      continue;
    }
    const routeEdges = draft.stops.slice(1).map((to, index) => byPair.get(`${draft.stops[index]}\u0000${to}`)!.id);
    const via = draft.stops[1] ?? draft.rail ?? draft.stops[0]!;
    routes.push({
      id: draft.entrance === undefined ? flowRouteId({ via }) : flowRouteId({ entrance: draft.entrance }),
      names: draft.entrance === undefined ? [`via ${nameOf(via)}`] : [entrances.find((e) => e.id === draft.entrance)!.name],
      derived: draft.entrance === undefined,
      slot: undefined,
      entrances: draft.entrance === undefined ? [] : [draft.entrance],
      stops: draft.stops,
      edges: routeEdges,
      rail: draft.rail,
      trust: draft.trust,
      trustSource: draft.trustSource,
      entry: [],
      sites: draft.stops.slice(1).reduce((sum, to, index) => sum + byPair.get(`${draft.stops[index]}\u0000${to}`)!.sites, 0),
      followed: draft.followed,
      controls: [],
      traced: [],
      partial: [],
      noTracedControl: false,
      noControl: draft.declares.split("\u0000")[0] === "none",
    });
    declaresOf.set(routes[routes.length - 1]!.id, draft.declares);
  }
  // Eight colors: the routes most entrances take wear them, in route order; the rest are drawn neutral and still named.
  const ranked = routes.map((route, index) => ({ route, index })).sort((a, b) => b.route.entrances.length - a.route.entrances.length || b.route.sites - a.route.sites || a.index - b.index);
  const colored = new Set(ranked.slice(0, 8).map((r) => r.route.id));
  let slot = 0;
  for (const route of routes) if (colored.has(route.id)) route.slot = slot++;
  for (const route of routes) for (const id of route.edges) edges.find((edge) => edge.id === id)!.routes.push(route.id);

  // Rows. A component spans the rows its termini's names need. Within a column components keep folder order; each asks for
  // the row that keeps the routes reaching it from the column before straight, the median of where those routes come from,
  // and takes it when the component above leaves room, else the next free row. Components where work enters then ask for
  // the rows their routes go on to, and the columns after them are placed again.
  const span = new Map(placed.map((folder) => {
    const starting = routes.filter((route) => route.stops[0] === folder);
    const lines = starting.reduce((sum, route) => sum + originLines(route).length, 0);
    return [folder, Math.max(1, Math.ceil(lines / FLOW_ROW_LINES))] as const;
  }));
  const row = new Map<string, number>();
  const center = (folder: string): number => row.get(folder)! + span.get(folder)! / 2;
  const hops = routes.flatMap((route) => route.stops.slice(1).map((to, i) => ({ from: route.stops[i]!, to })));
  const lastColumn = Math.max(0, ...placed.map((folder) => column.get(folder)!));
  const stack = (c: number, want: (folder: string) => number | undefined): void => {
    let free = 0;
    for (const folder of placed.filter((f) => column.get(f) === c)) {
      const wanted = want(folder);
      const top = Math.max(free, wanted === undefined ? free : Math.round(wanted - span.get(folder)! / 2));
      row.set(folder, top);
      free = top + span.get(folder)!;
    }
  };
  const median = (values: number[]): number | undefined => {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  };
  const fromBefore = (folder: string): number | undefined => median(hops.filter((hop) => hop.to === folder && column.get(hop.from) === column.get(folder)! - 1).map((hop) => center(hop.from)));
  stack(0, () => undefined);
  for (let c = 1; c <= lastColumn; c++) stack(c, fromBefore);
  stack(0, (folder) => median(hops.filter((hop) => hop.from === folder && column.get(hop.to) === 1).map((hop) => center(hop.to))));
  for (let c = 1; c <= lastColumn; c++) stack(c, fromBefore);
  // The map starts at its first row: rows asked for from the other side leave no empty band above everything.
  const first = Math.min(...[...row.values()]);
  if (Number.isFinite(first) && first > 0) for (const [folder, at] of row) row.set(folder, at - first);

  const nodes: FlowNode[] = visible.map((component) => {
    const callers = callersOf.get(component.folder)!;
    const out = calleesOf.get(component.folder)!.length;
    const into = callers.length;
    const own = invariants.filter((invariant) => represent(invariant.component) === component.folder);
    const defects = own
      .filter((invariant) => invariant.enforcements.some((e) => e.form === "chokepoint"))
      .flatMap((invariant) => {
        const entry = latestOf(invariant, state.runs.records).find((candidate) => candidate.form === "chokepoint");
        if (entry?.verdict !== "fail") return [];
        const sites = flowBypasses(state, invariant).map((b) => {
          const at = componentOfFile(b.file, components);
          return { file: b.file, line: b.line, symbol: b.symbol, inside: at !== undefined && represent(at.folder) === component.folder };
        });
        return [{ name: invariant.name, state: invariant.state, chokepoint: flowChokepointId(invariant.component, invariant.name), bypasses: sites.length, internal: sites.filter((s) => s.inside).length, sites }];
      });
    const rank = { broken: 0, requirement: 1, verified: 2 } as const;
    const mine = own.map(refOf).sort((a, b) => rank[a.verdict.state] - rank[b.verdict.state] || a.name.localeCompare(b.name));
    return {
      id: flowNodeId(component.folder),
      folder: component.folder,
      name: component.name,
      intent: component.intent,
      row: row.get(component.folder) ?? 0,
      span: span.get(component.folder) ?? 1,
      column: column.get(component.folder) ?? 0,
      out,
      in: into,
      declaresEntrance: entersHere(component.folder),
      core: core.has(component.folder),
      unconnected: out + into === 0,
      entrances: entrances.filter((entrance) => entrance.start === component.folder).map((entrance) => entrance.id),
      children: components.filter((candidate) => candidate.parent === component.folder).length,
      expanded: expanded.has(component.folder),
      defects,
      invariants: mine,
      state: worstState(mine.map((ref) => ref.verdict.state)),
      boundary: [],
      covered: false,
    };
  });

  // Core dependencies, and the stubs their callers attach by.
  const coreDependencies: FlowCore[] = nodes.filter((node) => node.core).map((node) => {
    const stubs = edges.filter((edge) => edge.to === node.folder);
    for (const edge of stubs) edge.stub = true;
    return { folder: node.folder, callers: stubs.map((edge) => edge.from), stubs: stubs.map((edge) => edge.id) };
  });

  // Where work enters through a chokepoint: one that is the handler of a route's entrances, in the component that handles them.
  const entryOf = (chokepoint: FlowChokepoint): string[] =>
    routes.filter((route) => route.entrances.some((id) => {
      const entrance = entrances.find((e) => e.id === id)!;
      return entrance.declaredBy === entrance.start && entrance.start === represent(chokepoint.component) && entrance.handler !== undefined && flowNamed(chokepoint.chokepoint)?.symbol === entrance.handler.split(/\s+in\s+/)[0];
    })).map((route) => route.id);

  // Interface identifiers: each chokepoint's place in the list, on every interface it stands on and every entrance line it guards.
  const identifiers: FlowIdentifier[] = chokepoints.flatMap((chokepoint, index) => {
    const on = edges.filter((edge) => edge.chokepoints.some((c) => c.id === chokepoint.id));
    const at = entryOf(chokepoint);
    if (on.length === 0 && at.length === 0) return [];
    const crossing = invariants.find((invariant) => invariant.component === chokepoint.component && invariant.name === chokepoint.name)?.crossing;
    const text = `${crossing === undefined ? "C" : "X"}${index + 1}`;
    for (const edge of on) edge.identifiers.push(text);
    for (const route of routes) if (at.includes(route.id)) route.entry.push(text);
    return [{ text, chokepoint: chokepoint.id, component: chokepoint.component, name: chokepoint.name, crossing: crossing === undefined ? undefined : { from: crossing.from, to: crossing.to }, edges: on.map((edge) => edge.id), routes: at, verdict: chokepoint.verdict }];
  });

  // What controls each route: every identifier where work enters, on an interface it takes, or on the stub to its rail;
  // then what the reading traced beyond the lines (d-127ab8e4), verified only: a chokepoint its handler is registered
  // through, a chokepoint inside a component its work passes whose protected thing the reach reaches, and a totality oracle there;
  // each but the wrapper only when its crossing enters from the trust it carries in or enters it. No traced control marks only an untrusted route with none
  // (d-ba18b0fd): its trust unknown (treated as untrusted, d-6df8d09a), a level the entry spec does not declare, or a
  // level from outside the system's control.
  const outsideLevels = new Set(state.spec.trustLevels.filter((level) => level.outside === true).map((level) => level.name));
  const verified = (component: string, name: string): boolean => verdictOf(component, name).state === "verified";
  // A control stands for a route only when it checks what crosses from the route's trust: its crossing enters from a
  // level the route carries in, or enters one, turning an outside caller into it. A chokepoint guarding some other
  // boundary (a data-write log, a migration registry, an egress filter for another reader) is no check on this caller,
  // however far the handler's reach runs (c-9941b95e). A wrapper is exempt: its handler is registered through it.
  const crossesTrust = (component: string, name: string, trust: readonly string[]): boolean =>
    crossingChecksTrust(invariants.find((invariant) => invariant.component === component && invariant.name === name)?.crossing, trust);
  for (const route of routes) {
    const railStub = route.rail === undefined ? undefined : edges.find((edge) => edge.from === route.stops[route.stops.length - 1] && edge.to === route.rail);
    route.controls = [...new Set([...route.entry, ...route.edges.flatMap((id) => edges.find((edge) => edge.id === id)!.identifiers), ...(railStub?.identifiers ?? [])])];
    const traced: FlowControl[] = [];
    const add = (control: Omit<FlowControl, "verdict">): void => {
      if (traced.some((c) => c.component === control.component && c.name === control.name)) return;
      traced.push({ ...control, verdict: verdictOf(control.component, control.name) });
    };
    for (const text of route.controls) {
      const identifier = identifiers.find((i) => i.text === text)!;
      if (!crossesTrust(identifier.component, identifier.name, route.trust)) continue;
      add({ kind: "interface", component: identifier.component, name: identifier.name, identifier: text, declared: false });
    }
    // Beyond the lines, a control is each entrance's own: it counts on the route only when every entrance on it passes it,
    // and one only some pass is listed apart, never counted. The components an entrance's work passes are the same at every
    // zoom: the route's drawn stops and rail, and, unrepresented, where the entrance is declared and handled and every
    // component its handler's reach enters. A child folded into a stop is not on it.
    const drawn = [...route.stops, ...(route.rail === undefined ? [] : [route.rail])];
    const perEntrance = route.entrances.map((id): Omit<FlowControl, "verdict">[] => {
      const entrance = entrances.find((e) => e.id === id);
      const on = new Set([...drawn, ...(entrance?.passes ?? [])]);
      const found: Omit<FlowControl, "verdict">[] = [];
      for (const guard of entrance?.guards ?? []) {
        if (!verified(guard.component, guard.name)) continue;
        if (guard.how === "wrapper" || guard.how === "declared") found.push({ kind: "wrapper", component: guard.component, name: guard.name, identifier: undefined, declared: guard.how === "declared" });
        else if (on.has(guard.component) && crossesTrust(guard.component, guard.name, route.trust)) found.push({ kind: "inside", component: guard.component, name: guard.name, identifier: undefined, declared: false });
      }
      // A test-backed control is the entrance's own: an invariant whose entrances: line names it, never one whose crossing
      // merely matches its trust. Owning the component that declares or handles it was not enough (d-127ab8e4 narrowed it
      // to the owner; covers.ts to the named): a signature check in a routes folder is no check on its crawler file, and
      // a server function sharing a folder shares no test.
      const covering = new Set((entrance?.coveredBy ?? []).map((c) => `${c.component}\u0000${c.name}`));
      for (const invariant of invariants) {
        if (!covering.has(`${invariant.component}\u0000${invariant.name}`) || !crossesTrust(invariant.component, invariant.name, route.trust)) continue;
        // An invariant with a chokepoint is traced by its chokepoint; only one enforced by a totality oracle alone is test-backed here.
        if (invariant.enforcements.some((e) => e.form === "chokepoint") || !invariant.enforcements.some((e) => e.form === "totality oracle")) continue;
        if (verified(invariant.component, invariant.name)) found.push({ kind: "totality", component: invariant.component, name: invariant.name, identifier: undefined, declared: false });
      }
      return found;
    });
    const key = (c: Pick<FlowControl, "kind" | "component" | "name">): string => `${c.kind}\u0000${c.component}\u0000${c.name}`;
    const tally = new Map<string, { control: Omit<FlowControl, "verdict">; entrances: number }>();
    for (const found of perEntrance) {
      for (const control of found.filter((c, i) => found.findIndex((o) => key(o) === key(c)) === i)) {
        const known = tally.get(key(control));
        if (known === undefined) tally.set(key(control), { control, entrances: 1 });
        else {
          known.entrances += 1;
          known.control = { ...known.control, declared: known.control.declared || control.declared };
        }
      }
    }
    const total = Math.max(1, route.entrances.length);
    for (const { control, entrances: count } of tally.values()) if (count === total) add(control);
    route.partial = [...tally.values()]
      .filter(({ control, entrances: count }) => count < total && !traced.some((c) => c.component === control.component && c.name === control.name))
      .map(({ control, entrances: count }) => ({ ...control, verdict: verdictOf(control.component, control.name), entrances: count }))
      .sort((a, b) => CONTROL_KINDS.indexOf(a.kind) - CONTROL_KINDS.indexOf(b.kind) || b.entrances - a.entrances);
    route.traced = traced.sort((a, b) => CONTROL_KINDS.indexOf(a.kind) - CONTROL_KINDS.indexOf(b.kind));
    // An entrance that declares it needs no control, with its reason, is never marked: the claim is shown, and challengeable.
    route.noTracedControl = !route.derived && !route.noControl && route.traced.length === 0 && flowUntrusted(route.trust, levelOrder, outsideLevels);
  }

  // Coverage: a chokepoint on a surface the component exposes or on an entrance line into it, or a verified totality oracle of its own.
  for (const node of nodes) {
    const exposed = edges.some((edge) => edge.to === node.folder && edge.chokepoints.length > 0);
    const entered = identifiers.some((identifier) => identifier.routes.length > 0 && represent(identifier.component) === node.folder);
    const verifiedTotality = invariants.some((invariant) => represent(invariant.component) === node.folder && invariant.enforcements.some((e) => e.form === "totality oracle") && verdictOf(invariant.component, invariant.name).state === "verified");
    node.covered = exposed || entered || verifiedTotality;
  }

  // Every crossing is drawn: on the interfaces its chokepoint stands on, on the entrance line it guards, else on its component's boundary mark.
  const crossings: FlowCrossingPlace[] = invariants.flatMap((invariant): FlowCrossingPlace[] => {
    if (invariant.crossing === undefined) return [];
    const id = flowChokepointId(invariant.component, invariant.name);
    const identifier = identifiers.find((i) => i.chokepoint === id);
    const on = edges.filter((edge) => edge.crossings.some((c) => c.component === invariant.component && c.name === invariant.name)).map((edge) => edge.id);
    const at = identifier?.routes ?? [];
    const home = represent(invariant.component);
    const place = { ...refOf(invariant), from: invariant.crossing.from, to: invariant.crossing.to, edges: on, routes: at, component: home };
    if (on.length > 0) return [{ ...place, on: "interface" }];
    if (at.length > 0) return [{ ...place, on: "entrance" }];
    nodes.find((node) => node.folder === home)?.boundary.push({ component: invariant.component, name: invariant.name, state: invariant.state, verdict: place.verdict, from: place.from, to: place.to });
    return [{ ...place, on: "component" }];
  });

  const touches = (c: { from: string; to: string }, level: string): boolean => c.from === level || c.to === level;
  const levels = state.spec.trustLevels.map((level): FlowLevel => {
    const carrying = edges.filter((edge) => edge.levels.includes(level.name));
    const named = crossings.filter((c) => touches(c, level.name));
    return {
      id: flowLevelId(level.name),
      name: level.name,
      meaning: level.meaning,
      outside: level.outside === true,
      edges: carrying.map((edge) => edge.id),
      routes: [...new Set(named.flatMap((c) => c.routes))],
      components: [...new Set(named.filter((c) => c.on === "component").map((c) => c.component))],
      unplaced: named.filter((c) => !nodes.some((node) => node.folder === c.component)).map(({ component, name, state: s, verdict, from, to }) => ({ component, name, state: s, verdict, from, to })),
    };
  });

  const health: FlowHealth = {
    verified: invariants.filter((i) => i.state === "invariant").map(refOf),
    requirements: invariants.filter((i) => i.state === "requirement").map(refOf),
    defects: invariants.filter((i) => i.state === "structural defect").map(refOf),
    bypassed: invariants.filter((i) => verdictOf(i.component, i.name).bypassed).map(refOf),
    escalations: openEscalations(state.journal.records).map((record) => ({ id: record.id, what: subjectOf(record) })),
    uncovered: nodes.filter((node) => !node.covered).map((node) => node.folder),
  };

  return {
    evidence: reading.kind === "read" ? "language adapter" : "run sites only",
    language: reading.kind === "read" ? reading.language : undefined,
    ...(reading.kind === "read" && reading.languages !== undefined ? { languages: reading.languages } : {}),
    unread: reading.kind === "read" ? undefined : reading.because,
    sitesUnknown: reading.kind === "read" ? [] : flowSitesUnknown(state),
    nodes,
    edges,
    entrances,
    levels,
    chokepoints,
    routes,
    routesFrom,
    coreDependencies,
    identifiers,
    unowned: reading.kind === "read" ? reading.unowned : undefined,
    bounds: reading.kind === "read" ? reading.bounds : undefined,
    outside: reading.kind === "read" ? reading.outside : undefined,
    partial: reading.kind === "read" ? reading.partial : undefined,
    crossings,
    health,
    coverage: reading.kind === "read" ? coverageOf(state.spec.components, reading.candidates) : undefined,
  };
}

/**
 * What the adapter's reading was bounded to, in one clause, the same words
 * on the map's evidence line and in query structure; undefined when the
 * reading does not say (the run-sites fallback, or a reading from before it
 * was bounded).
 */
export function flowBoundsText(model: Pick<FlowModel, "bounds" | "outside">): string | undefined {
  if (model.bounds === undefined) return undefined;
  const b = model.bounds;
  const outside = model.outside;
  const into = outside === undefined || outside.sites === 0 ? "" : `: ${outside.into.map((o) => `${o.sites} into ${o.component}`).join(", ")}`;
  return (
    `read only within the ${plural(b.components, "declared component", "declared components")} (${plural(b.files, "file", "files")} of component code; ` +
    `${plural(b.candidates, "declaration", "declarations")} another component's text names, ${b.asked} asked with the handlers' reach); ` +
    `${plural(outside?.sites ?? 0, "reference site", "reference sites")} from ${plural(outside?.files ?? 0, "file", "files")} in no declared component counted, not drawn${into}; ` +
    `a declaration only such code names is not asked, and code past the config's bounds is not read`
  );
}

/** Why the map is partial, in one sentence, or undefined when the reading finished. */
export function flowPartialText(model: Pick<FlowModel, "partial">): string | undefined {
  const p = model.partial;
  if (p === undefined) return undefined;
  const spent = p.limit === "time" ? `its time budget (${p.budget})` : `its memory budget (${p.budget}; the language server held ${p.observed ?? "more"})`;
  return `partial map: the interface reading stopped at ${spent} after ${p.seconds} s, so the declarations of ${p.unread.length === 0 ? "no component" : p.unread.join(", ")} were not all read and interfaces may be missing; raise ${"interfaceBudget"} in the config or pass --interface-seconds / --interface-memory`;
}

/* ---------------------------------------------------------- selection */

export interface FlowSelection {
  kind: "none" | "entrance" | "route" | "level" | "component" | "edge" | "chokepoint" | "change" | "health" | "broken" | "boundary";
  id: string | undefined;
  /** Component folders on the story; every other component dims. */
  nodes: Set<string>;
  /** Interface ids on the story; every other interface dims. */
  edges: Set<string>;
  /** Routes on the story; every other route dims. */
  routes: Set<string>;
  /** Chokepoint ids whose interface identifiers light; every other identifier dims. */
  chokepoints: Set<string>;
  /** Component folders whose broken or boundary mark lights. */
  marks: Set<string>;
  /** For a component: the interfaces into it, whose callers depend on it (work travels in). */
  into: Set<string>;
  /** For a component: the interfaces out of it, to what it uses (work travels out). */
  outOf: Set<string>;
}

function flowRouteLight(model: FlowModel, route: FlowRoute): Omit<FlowSelection, "kind" | "id"> {
  const railStub = route.rail === undefined ? undefined : model.edges.find((edge) => edge.from === route.stops[route.stops.length - 1] && edge.to === route.rail);
  const edges = new Set([...route.edges, ...(railStub === undefined ? [] : [railStub.id])]);
  return {
    nodes: new Set([...route.stops, ...(route.rail === undefined ? [] : [route.rail])]),
    edges,
    routes: new Set([route.id]),
    chokepoints: new Set(model.identifiers.filter((i) => i.routes.includes(route.id) || i.edges.some((id) => edges.has(id))).map((i) => i.chokepoint)),
    marks: new Set(),
    into: new Set(),
    outOf: new Set(),
  };
}

/** The members of one health count: the invariants it counts; "broken" is the structural defects and the bypassed requirements together. */
export function flowHealthMembers(model: FlowModel, kind: FlowHealthKind): FlowInvariantRef[] {
  if (kind === "broken") {
    const seen = new Set<string>();
    return [...model.health.defects, ...model.health.bypassed].filter((ref) => {
      const key = `${ref.component}\u0000${ref.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return kind === "verified" ? model.health.verified : kind === "requirements" ? model.health.requirements : kind === "defects" ? model.health.defects : kind === "bypassed" ? model.health.bypassed : [];
}

/**
 * The one line the page leads with: the project's health as a verdict, and
 * the count it links to. Broken first; then nothing enforced; then all
 * verified, or verified beside what is not yet enforced.
 */
export function flowVerdict(model: FlowModel): { kind: "broken" | "nothing" | "verified" | "partial" | "empty"; text: string; select: string } {
  const broken = flowHealthMembers(model, "broken").length;
  const verified = model.health.verified.length;
  const requirements = model.health.requirements.length;
  if (broken > 0) {
    const holders = model.nodes.filter((node) => node.defects.length > 0);
    return { kind: "broken", text: `${broken} broken`, select: holders.length === 1 ? flowBrokenId(holders[0]!.folder) : flowHealthId("broken") };
  }
  if (verified === 0 && requirements > 0) return { kind: "nothing", text: "Nothing is enforced yet", select: flowHealthId("requirements") };
  if (verified > 0 && requirements === 0) return { kind: "verified", text: `All ${verified} ${verified === 1 ? "invariant" : "invariants"} verified`, select: flowHealthId("verified") };
  if (verified > 0) return { kind: "partial", text: `${verified} ${verified === 1 ? "invariant" : "invariants"} verified, ${requirements} not enforced yet`, select: flowHealthId("requirements") };
  return { kind: "empty", text: "No invariant is declared", select: flowHealthId("verified") };
}

/**
 * What a selection lights. An entrance lights its structural route; a route
 * lights itself; a trust level lights every crossing that carries that class
 * of data, wherever it is drawn (its interfaces, an entrance line, a
 * component's boundary mark), and only those identifiers; a chokepoint lights
 * every interface it stands on (reliance); a component lights its direct
 * component interfaces and the components at their other ends, and keeps
 * the routes through it undimmed, never everything it transitively
 * reaches; an interface lights itself; a health count lights the components
 * and identifiers of the invariants it counts; a broken or boundary mark
 * lights its component. The change selection lights nothing until two
 * states are compared. An id that names nothing selects nothing.
 */
export function flowSelection(model: FlowModel, selected: string | undefined): FlowSelection {
  const none: FlowSelection = { kind: "none", id: undefined, nodes: new Set(), edges: new Set(), routes: new Set(), chokepoints: new Set(), marks: new Set(), into: new Set(), outOf: new Set() };
  if (selected === undefined) return none;
  if (selected === FLOW_CHANGE_ID) return { ...none, kind: "change", id: selected };
  const identifiersOn = (edges: Set<string>): Set<string> => new Set(model.identifiers.filter((i) => i.edges.some((id) => edges.has(id))).map((i) => i.chokepoint));
  const entrance = model.entrances.find((candidate) => candidate.id === selected);
  if (entrance !== undefined) {
    const route = model.routes.find((candidate) => candidate.entrances.includes(entrance.id));
    if (route === undefined) return { ...none, kind: "entrance", id: selected, nodes: new Set([entrance.declaredBy]) };
    return { kind: "entrance", id: selected, ...flowRouteLight(model, route) };
  }
  const route = model.routes.find((candidate) => candidate.id === selected);
  if (route !== undefined) return { kind: "route", id: selected, ...flowRouteLight(model, route) };
  const level = model.levels.find((candidate) => candidate.id === selected);
  if (level !== undefined) {
    const lit = model.edges.filter((edge) => level.edges.includes(edge.id));
    const routes = model.routes.filter((r) => level.routes.includes(r.id));
    const chokepoints = new Set(model.identifiers.filter((i) => i.crossing !== undefined && (i.crossing.from === level.name || i.crossing.to === level.name)).map((i) => i.chokepoint));
    return {
      ...none,
      kind: "level",
      id: selected,
      nodes: new Set([...lit.flatMap((edge) => [edge.from, edge.to]), ...routes.map((r) => r.stops[0]!), ...level.components]),
      edges: new Set(lit.map((edge) => edge.id)),
      routes: new Set(routes.map((r) => r.id)),
      chokepoints,
      marks: new Set(level.components),
    };
  }
  const chokepoint = model.chokepoints.find((candidate) => candidate.id === selected);
  if (chokepoint !== undefined) {
    const lit = model.edges.filter((edge) => edge.chokepoints.some((c) => c.id === chokepoint.id));
    const entry = model.identifiers.find((i) => i.chokepoint === chokepoint.id)?.routes ?? [];
    return { ...none, kind: "chokepoint", id: selected, nodes: new Set([chokepoint.component, ...lit.flatMap((edge) => [edge.from, edge.to])]), edges: new Set(lit.map((edge) => edge.id)), routes: new Set([...lit.flatMap((edge) => edge.routes), ...entry]), chokepoints: new Set([chokepoint.id]) };
  }
  const node = model.nodes.find((candidate) => candidate.id === selected);
  if (node !== undefined) {
    const direct = model.edges.filter((edge) => edge.from === node.folder || edge.to === node.folder);
    const edges = new Set(direct.map((edge) => edge.id));
    return {
      kind: "component",
      id: selected,
      nodes: new Set([node.folder, ...direct.flatMap((edge) => [edge.from, edge.to])]),
      edges,
      routes: new Set(model.routes.filter((r) => r.stops.includes(node.folder) || r.rail === node.folder).map((r) => r.id)),
      chokepoints: identifiersOn(edges),
      marks: new Set([node.folder]),
      into: new Set(direct.filter((edge) => edge.to === node.folder).map((edge) => edge.id)),
      outOf: new Set(direct.filter((edge) => edge.from === node.folder).map((edge) => edge.id)),
    };
  }
  const edge = model.edges.find((candidate) => candidate.id === selected);
  if (edge !== undefined) return { ...none, kind: "edge", id: selected, nodes: new Set([edge.from, edge.to]), edges: new Set([edge.id]), routes: new Set(edge.routes), chokepoints: identifiersOn(new Set([edge.id])) };
  const health = FLOW_HEALTH_KINDS.find((kind) => flowHealthId(kind) === selected);
  if (health === "uncovered") {
    const folders = new Set(model.health.uncovered);
    return { ...none, kind: "health", id: selected, nodes: folders, marks: folders };
  }
  if (health !== undefined) {
    const members = new Set(flowHealthMembers(model, health).map((m) => `${m.component}\u0000${m.name}`));
    const holders = model.nodes.filter((n) => n.invariants.some((i) => members.has(`${i.component}\u0000${i.name}`)));
    const chokepoints = new Set(model.identifiers.filter((i) => members.has(`${i.component}\u0000${i.name}`)).map((i) => i.chokepoint));
    return { ...none, kind: "health", id: selected, nodes: new Set(holders.map((n) => n.folder)), chokepoints, marks: new Set(holders.filter((n) => n.boundary.some((c) => members.has(`${c.component}\u0000${c.name}`)) || (health !== "verified" && health !== "requirements" && n.defects.length > 0)).map((n) => n.folder)) };
  }
  const brokenAt = model.nodes.find((n) => flowBrokenId(n.folder) === selected && n.defects.length > 0);
  if (brokenAt !== undefined) {
    const edges = new Set(model.edges.filter((e) => e.to === brokenAt.folder && e.bypasses.length > 0).map((e) => e.id));
    return { ...none, kind: "broken", id: selected, nodes: new Set([brokenAt.folder, ...model.edges.filter((e) => edges.has(e.id)).map((e) => e.from)]), edges, chokepoints: new Set(brokenAt.defects.map((d) => d.chokepoint)), marks: new Set([brokenAt.folder]) };
  }
  const boundaryAt = model.nodes.find((n) => flowBoundaryId(n.folder) === selected && n.boundary.length > 0);
  if (boundaryAt !== undefined) return { ...none, kind: "boundary", id: selected, nodes: new Set([boundaryAt.folder]), marks: new Set([boundaryAt.folder]) };
  return none;
}

/** What the map opens on when the reader has selected nothing (DEFAULT_RULE): nothing, the whole system, unless something is broken. */
export function flowDefaultSelection(model: FlowModel): string | undefined {
  const broken = model.nodes.filter((node) => node.defects.length > 0);
  return [...broken].sort((a, b) => b.defects.length - a.defects.length || model.nodes.indexOf(a) - model.nodes.indexOf(b))[0]?.id;
}

/** What is selected: the reader's selection, else the default story; the cleared selection selects nothing. */
export function flowSelected(model: FlowModel, selected: string | undefined): string | undefined {
  if (selected === FLOW_NONE_ID) return undefined;
  return selected ?? flowDefaultSelection(model);
}

/** What a key does on the map: the page calls this, so what each key does is a pure function. */
export function flowKeyAction(event: { key: string; select: string | undefined; button: boolean }): { select: string } | undefined {
  if (event.key === "Escape") return { select: FLOW_NONE_ID };
  // A real button activates itself on Enter and Space; every other select target is activated here.
  if ((event.key === "Enter" || event.key === " ") && event.select !== undefined && !event.button) return { select: event.select };
  return undefined;
}

/** One line of the label a component interface wears. */
export interface FlowLabelLine {
  text: string;
  kind: "chokepoint" | "crossing" | "data" | "symbols" | "count" | "defect";
}


/**
 * The label a component interface wears: what the invariants reveal, in
 * order (the chokepoint that stands there, the crossing, the classes of data
 * when more than one crossing passes), else the symbols referenced most, and
 * its bypasses when broken. Never a verb.
 */
export function flowLabelLines(edge: FlowEdge): FlowLabelLine[] {
  const lines: FlowLabelLine[] = [];
  if (edge.chokepoints.length > 0) {
    const names = [...new Set(edge.chokepoints.map((c) => c.chokepoint.split(/\s+in\s+/)[0]!))];
    lines.push({ text: `chokepoint ${names.join(", ")}`, kind: "chokepoint" });
  }
  const crossings = [...new Set(edge.crossings.map((c) => `${c.from} → ${c.to}`))];
  for (const crossing of crossings.slice(0, 2)) lines.push({ text: crossing, kind: "crossing" });
  if (crossings.length > 2) lines.push({ text: `+${crossings.length - 2} crossings`, kind: "count" });
  if (crossings.length > 1) lines.push({ text: `data ${edge.levels.join(", ")}`, kind: "data" });
  if (lines.length === 0) {
    const top = edge.symbols.slice(0, 3).map((s) => s.symbol);
    lines.push({ text: top.join(", "), kind: "symbols" });
    if (edge.symbols.length > top.length) lines.push({ text: `+${edge.symbols.length - top.length} more`, kind: "count" });
  }
  if (edge.bypasses.length > 0) lines.push({ text: `broken: ${edge.bypasses.length} ${edge.bypasses.length === 1 ? "bypass" : "bypasses"}`, kind: "defect" });
  return lines;
}

/** A route's name in prose: its entrances, or via its first component, marked derived. */
export function routeName(route: FlowRoute): string {
  return route.derived ? `${route.names.join(", ")} (derived)` : route.names.join(", ");
}

/**
 * The trust a route's entrances carry in, in words, labeled as the ruling
 * d-ba18b0fd asks: a declared level alone, a derived one marked derived, and
 * unknown when neither is known.
 */
export function trustInWords(route: Pick<FlowRoute, "trust" | "trustSource">): string {
  if (route.trust.length === 0) return "unknown";
  return route.trustSource === "derived" ? `${route.trust.join(", ")} (derived)` : route.trust.join(", ");
}

/** The words a route untrusted and with no control traced on it carries (d-127ab8e4): not a demonstrated bypass, only that none was traced. */
export const NO_TRACED_CONTROL = "no traced control";

/** The words a route whose entrances declare control: none carries (d-a1095ef2): a stated claim, neutral, with each reason beside it. */
export const NO_CONTROL_NEEDED = "no control needed";

/** How each kind of control was traced, in the inspector's words. */
export const CONTROL_WORDS: Record<FlowControlKind, string> = {
  interface: "structural chokepoint on its line",
  wrapper: "structural chokepoint wrapping its handler",
  inside: "structural chokepoint inside a component on it",
  totality: "test-backed totality oracle",
};

/** One traced control in words: its identifier or kind, and the invariant behind it (the query and the tooltip say it this way). */
export function controlInWords(control: FlowControl): string {
  const how = control.kind === "wrapper" ? `${CONTROL_WORDS.wrapper}${control.declared ? " (declared by guard:)" : ""}` : CONTROL_WORDS[control.kind];
  return `${control.identifier === undefined ? "" : `${control.identifier} `}${how}: ${control.name} (${control.component === "." ? "the root" : control.component})`;
}

/** The name a component shows on the map: the root is named for what it is. */
export function flowName(node: Pick<FlowNode, "folder" | "name">): string {
  return node.folder === "." ? `${node.name} (root)` : node.name;
}

/* --------------------------------------------------------- comparison */

/** One of the five measures of what a change did to the map, for one interface or entrance. */
export type FlowChange =
  | { kind: "entrance added" | "entrance removed"; entrance: string }
  | { kind: "interface added" | "interface removed"; edge: string }
  | { kind: "interface widened"; edge: string; symbols: string[] }
  | { kind: "chokepoint gained a bypass"; edge: string; bypasses: number }
  | { kind: "crossing added" | "crossing removed"; edge: string; crossing: string }
  | { kind: "data path branched"; edge: string; levels: string[] };

/**
 * The seam for Structure's diff: two models (the previous commit's state, or
 * a commit the agent names, and this one), and what changed, measured the
 * five ways the owner named. Pure; the diff view is the next slice.
 */
export function compareFlows(before: FlowModel, after: FlowModel): FlowChange[] {
  const changes: FlowChange[] = [];
  const hadEntrance = new Set(before.entrances.map((e) => e.id));
  const hasEntrance = new Set(after.entrances.map((e) => e.id));
  for (const e of after.entrances) if (!hadEntrance.has(e.id)) changes.push({ kind: "entrance added", entrance: e.id });
  for (const e of before.entrances) if (!hasEntrance.has(e.id)) changes.push({ kind: "entrance removed", entrance: e.id });
  const earlier = new Map(before.edges.map((edge) => [edge.id, edge]));
  const later = new Map(after.edges.map((edge) => [edge.id, edge]));
  for (const edge of after.edges) {
    const was = earlier.get(edge.id);
    const crossingNames = (e: FlowEdge | undefined): Set<string> => new Set((e?.crossings ?? []).map((c) => `${c.component}/${c.name}`));
    if (was === undefined) changes.push({ kind: "interface added", edge: edge.id });
    else {
      const had = new Set(was.symbols.map((s) => s.symbol));
      const gained = [...new Set(edge.symbols.map((s) => s.symbol))].filter((s) => !had.has(s)).sort();
      if (gained.length > 0) changes.push({ kind: "interface widened", edge: edge.id, symbols: gained });
      if (edge.bypasses.length > was.bypasses.length) changes.push({ kind: "chokepoint gained a bypass", edge: edge.id, bypasses: edge.bypasses.length - was.bypasses.length });
    }
    const had = crossingNames(was);
    const has = crossingNames(edge);
    for (const name of has) if (!had.has(name)) changes.push({ kind: "crossing added", edge: edge.id, crossing: name });
    for (const name of had) if (!has.has(name)) changes.push({ kind: "crossing removed", edge: edge.id, crossing: name });
    const levels = edge.levels.filter((level) => !(was?.levels ?? []).includes(level));
    if (levels.length > 0) changes.push({ kind: "data path branched", edge: edge.id, levels });
  }
  for (const edge of before.edges) {
    if (later.has(edge.id)) continue;
    changes.push({ kind: "interface removed", edge: edge.id });
    for (const c of edge.crossings) changes.push({ kind: "crossing removed", edge: edge.id, crossing: `${c.component}/${c.name}` });
  }
  return changes;
}
