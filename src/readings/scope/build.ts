/**
 * The Scope reading's two halves: the state, and the fixed shell that shows it.
 *
 * The state: Coherence's lexicon (and the project's domain lexicon of the
 * same shape, when it has one), the spec model, the run records, the journal
 * records and the work orders, loaded into the model once by scopeState, the
 * one function every reader of the state goes through (the snapshot here,
 * the warm server's live reading in live.ts, the agent query).
 *
 * The shell: the styles, the embedded font and the browser script joined into
 * one HTML document whose bytes depend on no project content. Live, the warm
 * server serves it and the page fetches its state and follows the stores as
 * they grow (live.ts). A snapshot is the same shell with one inline state, a
 * self-contained file for sharing and CI (snapshotOf). The browser renders
 * either with the same pure render.
 *
 * With --root the state is read over another project: its spec tree, its
 * .coherence/runs, .coherence/journal and .coherence/work, and its lexicon
 * (named in coherence.config.json under `lexicon`, else lexicon.json at
 * its root) as the domain layer beside Coherence's own. The command line is
 * cli.ts.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { configuredName, projectName } from "../../adapters/project-config.ts";
import { stripTypeScriptTypes } from "node:module";
import { dirname, extname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor } from "../../adapters/index.ts";
import { readEnforcementConfig } from "../../enforcement/config.ts";
import { loadRuns } from "../../enforcement/record.ts";
import { loadJournal } from "../../journal/store.ts";
import { WORK_DIR, foldOrders, loadWork as loadWorkRecords, workDir } from "../../journal/work.ts";
import { lexiconCoverage } from "../../lifecycle/lexicon-coverage.ts";
import { COHERENCE_LEXICON, projectLexiconPath } from "../../lifecycle/project.ts";
import { loadSpecModel, projectPractices, type SpecModel } from "../../spec/model.ts";
import { KERNEL_PREFIX } from "../../spec/practices.ts";
import { projectLexiconCoverage } from "./lexicon-projection.ts";
import { windowJournal, windowRuns } from "./derive.ts";
import { parseLexicon, type Lexicon, type InterfaceReading, type Ladder, type PracticesData, type LadderRung, type Layer, type ShellState, type SpecData, type StructurePreview, type WorkData } from "./model.ts";
import { DEFAULT_VIEW, VIEWS } from "./shell.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The page's one entry. The browser bundle is not a list kept by hand: it is
 * every module the entry imports at run time, followed to the end and joined
 * dependencies first (browserSources). A module the page calls into cannot be
 * left out, and one the browser cannot run cannot be reached without failing
 * the build.
 */
export const BROWSER_ENTRY = "page.ts";

export interface BuildOptions {
  /** The project root whose specs, runs, journal and work are read. The working directory when absent. */
  root?: string;
  /** Path to Coherence's own lexicon. */
  lexiconPath: string;
  /** Path to a project domain lexicon of the same shape. Located from the root's config when absent. */
  domainPath?: string;
  /** Heading for the domain layer. Derived from the file's project name when not given. */
  domainTitle?: string;
  /** Project name shown in the masthead. */
  project: string;
  /** Ephemeral proposed crossings embedded only in this generated page. */
  structurePreview?: readonly StructurePreview[];
  /** False keeps every run and journal record in the state; the agent query reads them all. A page embeds a bounded window (default). */
  window?: boolean;
  /** The component interfaces as the language adapter read them (readComponentInterfaces); unread when absent. */
  componentInterfaces?: InterfaceReading;
}

export const DEFAULTS = {
  lexiconPath: "docs/lexicon.json",
  // Under .coherence, never a served folder: public/ is what web frameworks publish, and the page embeds the journal (df-f2f6b207).
  outPath: ".coherence/scope/_scope.html",
  domainTitle: "Domain lexicon",
  project: "Coherence",
} as const;

async function readLexicon(path: string): Promise<Lexicon> {
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${(error as Error).message})`);
  }
  return parseLexicon(parsed, path);
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/** The domain layer's heading: as given, else from the project's name (projectName: the config's, else the file's stored one), else the default. */
function domainTitle(options: BuildOptions, lexicon: Lexicon | undefined): string {
  if (options.domainTitle !== undefined) return options.domainTitle;
  if (lexicon === undefined) return DEFAULTS.domainTitle;
  const named = configuredName(options.root ?? process.cwd()) ?? lexicon.project;
  return named === undefined ? DEFAULTS.domainTitle : `${capitalize(named)} lexicon`;
}

/**
 * The grade ladder as the project's adapter defines it, each rung naming who
 * enforces it. The top rung and its because are the adapter's; the rungs
 * below are Coherence's own and the same for every language.
 */
export function ladderFor(root: string): Ladder {
  const language = readEnforcementConfig(root).language;
  const adapter = adapterFor(language, root).ladder;
  const rungs: LadderRung[] = [];
  if (adapter.top === "visibility-choked") {
    rungs.push({ grade: "visibility-choked", enforcedBy: `the language itself: ${adapter.because}` });
    rungs.push({
      grade: "reference-choked",
      enforcedBy: "Coherence's chokepoint check, at the edit and in the run: the protected thing is visible outside its module, and every resolved reference in the project is inside the chokepoint; a consumer outside the repository could still bypass",
    });
  } else {
    rungs.push({
      grade: "reference-choked",
      enforcedBy: `Coherence's chokepoint check, at the edit and in the run; the top rung for ${language} because ${adapter.because}`,
    });
  }
  rungs.push({
    grade: "broken",
    enforcedBy: "nobody: a reference outside the chokepoint stands, or the chokepoint cannot be resolved; a structural defect until every reference is routed through the chokepoint or a human acknowledges a retirement",
  });
  rungs.push({
    grade: "not chokeable",
    enforcedBy: "no structure: the protected thing cannot be resolved as a symbol or a module, so no reference can be counted; a totality oracle is the compromise and the bullet must say why structure was unavailable",
  });
  return { language, rungs };
}

/**
 * The spec model as the page carries it: the tool's own facts, minus the
 * machine's absolute root. The value is passed through JSON once so that a
 * field the model left undefined is absent, exactly as the page will embed
 * it: the state in memory and the state in the page are the same value.
 */
export function loadSpec(root: string, held?: SpecModel): SpecData {
  const model = held ?? loadSpecModel(root);
  const data: SpecData = {
    entry: model.entry,
    trustLevels: model.trustLevels.map((level) => ({ name: level.name, meaning: level.meaning, outside: level.outside })),
    // The spec model carries each bullet's latest run entries; the page does not. They are the
    // run records, which the page already holds, read by enforcement: derive.ts reads them back
    // at render so no copy can disagree with the records it came from.
    // A component's practices are held once, in the state's practices beside the kernel's; the spec keeps where its practice file is.
    components: model.components.map(({ practices: _practices, ...component }) => ({
      ...component,
      invariants: component.invariants.map(({ latest: _latest, verified: _verified, defects: _defects, ...invariant }) => invariant),
    })),
    problems: model.problems,
    counts: model.counts,
    ladder: ladderFor(root),
  };
  return JSON.parse(JSON.stringify(data)) as SpecData;
}

/**
 * Every practice a session at this root may enact, as the page holds it: the
 * project's own from its practice files and, in an adopter, the kernel
 * practices Coherence ships. The parser's line numbers stay behind.
 */
export function loadPractices(root: string): PracticesData {
  let practices: ReturnType<typeof projectPractices>;
  try {
    practices = projectPractices(root);
  } catch {
    return { practices: [] };
  }
  const data: PracticesData = {
    practices: practices.map((p) => ({
      id: p.id,
      name: p.name,
      sentence: p.sentence,
      component: p.component,
      file: p.file,
      kernel: p.id.startsWith(KERNEL_PREFIX),
      ...(p.reach === undefined ? {} : { reach: p.reach }),
      triggers: p.triggers,
      steps: p.steps.map((s) => (s.leaves === undefined ? { n: s.n, text: s.text } : { n: s.n, text: s.text, leaves: s.leaves })),
      pitfalls: p.pitfalls.map((pf) => ({ text: pf.text, cites: pf.cites })),
      learned: p.learned,
      invariants: p.invariants,
      ...(p.because === undefined ? {} : { because: p.because }),
      version: p.version,
      state: p.state,
      enactments: p.enactments,
    })),
  };
  return JSON.parse(JSON.stringify(data)) as PracticesData;
}

/**
 * The work orders as the journal folds them: every record under
 * .coherence/work is read through the journal's own loader, and each order
 * is the fold of its records (content, owner now, current state, history).
 * Absent when the folder does not exist; a line that will not parse is
 * reported. The page never re-derives an order from the raw store.
 */
export function loadWork(root: string): WorkData {
  if (!existsSync(workDir(root))) return { kind: "absent", because: `${WORK_DIR} does not exist under this project; the journal keeps no work orders yet.` };
  const loaded = loadWorkRecords(root);
  return { kind: "present", orders: foldOrders(loaded), damaged: loaded.damaged };
}

/** The domain lexicon path: as given, else the root's own when it is not Coherence's lexicon itself. */
async function domainPathFor(options: BuildOptions, root: string): Promise<string | undefined> {
  if (options.domainPath !== undefined) return options.domainPath;
  const located = await projectLexiconPath(root);
  if (located === undefined) return undefined;
  if (resolve(located) === resolve(options.lexiconPath) || resolve(located) === COHERENCE_LEXICON) return undefined;
  return located;
}

/** Load every truth into the shell's state. Absence of the domain layer is a rendered fact. */
export async function loadState(options: BuildOptions): Promise<ShellState> {
  const root = resolve(options.root ?? process.cwd());
  const coherence: Layer = {
    kind: "present",
    id: "coherence",
    title: "Coherence lexicon",
    lexicon: await readLexicon(options.lexiconPath),
  };
  const domainPath = await domainPathFor(options, root);
  const domainLexicon = domainPath === undefined ? undefined : await readLexicon(domainPath);
  const domain: Layer =
    domainLexicon === undefined
      ? {
          kind: "absent",
          id: "domain",
          title: domainTitle(options, undefined),
          because:
            "No domain lexicon is present. Supply a second lexicon file of the same shape to read the project's own vocabulary here, ahead of Coherence's terms.",
        }
      : {
          kind: "present",
          id: "domain",
          title: domainTitle(options, domainLexicon),
          lexicon: domainLexicon,
        };
  const runs = loadRuns(root);
  const journal = loadJournal(root);
  const spec = loadSpec(root);
  if (options.structurePreview !== undefined) {
    const levels = new Set(spec.trustLevels.map((level) => level.name));
    for (const preview of options.structurePreview) {
      if (!spec.components.some((component) => component.folder === preview.component)) throw new Error(`Structure preview: no component at ${preview.component}`);
      if (preview.name.trim() === "") throw new Error("Structure preview: invariant name is empty");
      if (spec.components.some((component) => component.folder === preview.component && component.invariants.some((invariant) => invariant.name === preview.name))) {
        throw new Error(`Structure preview: invariant ${preview.name} already exists in ${preview.component}`);
      }
      for (const end of [preview.crossing.from, preview.crossing.to]) {
        if (!levels.has(end)) throw new Error(`Structure preview: crossing names trust level ${end}; declared: ${[...levels].join(", ") || "none"}`);
      }
    }
  }
  return {
    project: options.project,
    views: VIEWS.map((v) => ({ id: v.id, label: v.label })),
    activeView: options.structurePreview === undefined || options.structurePreview.length === 0 ? DEFAULT_VIEW : "structure",
    lexicon: { layers: [coherence, domain], query: "", coverage: projectLexiconCoverage(await lexiconCoverage(root)) },
    spec,
    runs: { records: runs.records, damaged: runs.damaged },
    journal: { records: journal.records, damaged: journal.damaged, work: loadWork(root) },
    componentInterfaces: options.componentInterfaces ?? { kind: "unread", because: "no instrument was asked when this page was built" },
    components: { query: "" },
    structure: { preview: options.structurePreview === undefined ? [] : options.structurePreview.map((proposal) => ({ ...proposal, crossing: { ...proposal.crossing }, ...(proposal.chokepoints === undefined ? {} : { chokepoints: proposal.chokepoints.map((entry) => ({ ...entry })) }) })) },
    invariants: { query: "", state: "", component: "" },
    practices: loadPractices(root),
    practicesView: { query: "" },
    runsView: { query: "" },
    journalView: { query: "", kind: "", agent: "", session: "" },
  };
}

/**
 * The state a first load carries: every store whole except the two that grow
 * with every session, the run records and the journal, which are bounded
 * windows that keep every derivation the views make exact (see windowRuns and
 * windowJournal) and carry the count of what they leave out; the live page
 * loads the rest on demand, by cursor. The agent query reads without the
 * window, so its answers read every record.
 */
export function windowState(state: ShellState): ShellState {
  const runs = windowRuns(state.runs.records);
  const cited = new Set(state.practices.practices.flatMap((p) => [...p.pitfalls.flatMap((pf) => pf.cites), ...p.learned]));
  const journal = windowJournal(state.journal.records, undefined, state.journal.work.kind === "present" ? state.journal.work.orders : [], undefined, cited);
  return {
    ...state,
    runs: { ...state.runs, records: runs.records, ...(runs.omitted === 0 ? {} : { omitted: runs.omitted }), ...(Object.keys(runs.superseded).length === 0 ? {} : { superseded: runs.superseded }) },
    journal: { ...state.journal, records: journal.records, ...(journal.omitted === 0 ? {} : { omitted: journal.omitted }) },
  };
}

/** One browser source stripped to JavaScript, as the published package carries it beside its compiled modules. */
export function strippedName(name: string): string {
  return name.replace(/\.ts$/, ".browser.js");
}

/**
 * One browser source as JavaScript: stripped here in a checkout, and read
 * already stripped in the published package, whose build ran the same
 * stripper, so an installed Coherence never calls the experimental API.
 */
async function browserSource(name: string): Promise<string> {
  if (extname(fileURLToPath(import.meta.url)) === ".js") return readFile(resolve(here, strippedName(name)), "utf8");
  return stripTypeScriptTypes(await readFile(resolve(here, name), "utf8"), { mode: "strip" });
}

/**
 * A stripped module's import and re-export statements, each with the module
 * it names. Type stripping has already removed every type-only import, so
 * what is left is exactly what the module needs at run time. An empty
 * import list, all of whose names were types, is no edge.
 */
const MODULE_STATEMENT = /^(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["'];[^\S\n]*$|^import\s+["']([^"']+)["'];[^\S\n]*$/gm;

/** One import or re-export as the page may join it: a list of names under their own exported names, or a bare import for its effect. */
const JOINABLE = /^(?:import\s*\{[^}]*\}\s*from|export\s*\{[^}]*\}\s*from|import\s+["'])/;

function runtimeImports(stripped: string, name: string): string[] {
  return [...stripped.matchAll(MODULE_STATEMENT)].flatMap((m) => {
    const statement = m[0];
    if (/^import\s*\{\s*\}\s*from/.test(statement)) return [];
    // Joined into one module, a statement is removed and each name stands as its exporter declared it: a renamed, namespace
    // or default import would leave its local name undefined in the browser, so it is refused here instead.
    if (!JOINABLE.test(statement) || /\{[^}]*\sas\s[^}]*\}/.test(statement)) {
      throw new Error(`Scope: ${name} has ${statement.replace(/\s+/g, " ")}; the page joins its modules into one name space, so a browser source imports names by their exported names, in braces, never renamed, as a namespace or as a default`);
    }
    return [(m[1] ?? m[2])!];
  });
}

/**
 * Every browser source, dependencies first: the entry and each module it
 * imports at run time, followed to the end, as paths from this folder. An
 * import the browser cannot resolve inside the bundle (a package, a node:
 * module, anything but a relative path to another source) fails here, naming
 * the importer, so a page that would break in the browser is never built.
 */
export async function browserSources(read: (name: string) => Promise<string> = browserSource): Promise<string[]> {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = async (name: string): Promise<void> => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const target of runtimeImports(await read(name), name)) {
      if (!target.startsWith("./") && !target.startsWith("../")) {
        throw new Error(`Scope: ${name} imports ${target} at run time, and the page runs in a browser: a browser source imports only other sources by relative path, or types alone`);
      }
      await visit(posix.normalize(posix.join(posix.dirname(name), target)));
    }
    order.push(name);
  };
  await visit(BROWSER_ENTRY);
  return order;
}

/** Drop a stripped source's import and re-export statements: browserSources has followed each into the bundle, so every one names a module joined beside it. */
function toBrowserModule(stripped: string, name: string): string {
  // A statement may span several lines; the pattern's `[^;]` crosses them.
  return stripped.replace(MODULE_STATEMENT, "").concat(`\n// end of ${name}\n`);
}

/** The names a stripped module declares at its top level. */
function topLevelNames(module: string): string[] {
  return [...module.matchAll(/^(?:export )?(?:async )?(?:function|const|let|class) ([A-Za-z_$][A-Za-z0-9_$]*)/gm)].map((m) => m[1]!);
}

/**
 * The browser sources joined into one module. One module has one name space,
 * so a top-level name declared in two sources is refused here, by name, rather
 * than shipped as a page whose script fails to parse.
 */
async function browserScript(): Promise<string> {
  const parts: string[] = [];
  const declared = new Map<string, string>();
  for (const name of await browserSources()) {
    const module = toBrowserModule(await browserSource(name), name);
    for (const declaredName of topLevelNames(module)) {
      const earlier = declared.get(declaredName);
      if (earlier !== undefined) throw new Error(`Scope: ${name} declares ${declaredName} at top level, which ${earlier} already declares; the inline module has one name space`);
      declared.set(declaredName, name);
    }
    parts.push(module);
  }
  return parts.join("\n");
}

/** JSON that is safe inside a script element: no `<` can close it. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The Latin range of IBM Plex Mono's split build: every character a path, a symbol, or an identifier on the map uses. */
const PLEX_LATIN = "U+0020-007E, U+00A0-00FF, U+0131, U+0152-0153, U+02C6, U+02DA, U+02DC, U+2013-2014, U+2018-201A, U+201C-201E, U+2020-2022, U+2026, U+2030, U+2039-203A, U+2044, U+20AC, U+2122, U+2212, U+FB01-FB02";

/**
 * IBM Plex Mono for code-ish text (paths, symbols, identifiers), embedded as
 * base64 woff2 so the page stays self-contained: the regular weight of the
 * Latin subset the package ships (17.5 KB, 23.4 KB as base64), the only
 * weight the map and the page set mono text in; the medium weight would push
 * the page with a domain lexicon past its 2 MB budget. The file sits in fonts/
 * beside this module with its license, copied from the font package once, because
 * that package's install script is telemetry. Without it the page falls back
 * to the monospace stack it names after Plex.
 */
async function plexMono(): Promise<string> {
  const faces: string[] = [];
  for (const [weight, file] of [[400, "Regular"]] as const) {
    try {
      const bytes = await readFile(resolve(here, "fonts", `IBMPlexMono-${file}-Latin1.woff2`));
      faces.push(`@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: ${weight}; font-display: swap; src: url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2"); unicode-range: ${PLEX_LATIN}; }`);
    } catch {
      return "";
    }
  }
  return `/* IBM Plex Mono 2.5.0, Copyright © 2017 IBM Corp. with Reserved Font Name "Plex", licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org). Regular, Latin subset, embedded unmodified. */\n${faces.join("\n")}\n`;
}


/**
 * The state every reader of the Scope reading goes through: the loaded model,
 * windowed for a first load unless `window` is false. The same inputs in give
 * the same state out; a snapshot, the live server's first load and the agent
 * query all start here.
 */
export async function scopeState(options: BuildOptions): Promise<ShellState> {
  const loaded = await loadState(options);
  return options.window === false ? loaded : windowState(loaded);
}

/** The element a snapshot fills with its state; empty in the shell, where the page fetches the state instead. */
export const STATE_SLOT = '<script type="application/json" id="scope-state"></script>';

export interface Shell {
  /** The whole document: styles, the embedded font, the browser script, an empty state slot. */
  html: string;
  /** The CSP source for the one inline script, so the live server can allow exactly it. */
  scriptHash: string;
}

/**
 * The fixed shell: one HTML document built from the styles, the font and the
 * browser sources alone, so its bytes depend on no project content. The
 * title names the reading; the page names the project once its state is in.
 */
export async function buildShell(): Promise<Shell> {
  const css = (await plexMono()) + (await readFile(resolve(here, "styles.css"), "utf8"));
  const script = `\n${await browserScript()}\n`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Scope</title>
<style>
${css}
</style>
</head>
<body>
<noscript><p style="padding:1.25rem;font-family:system-ui,sans-serif">This reading renders from its state, carried in this file or loaded from the warm server, and needs scripts enabled to show it.</p></noscript>
<div id="scope-root"></div>
${STATE_SLOT}
<script type="module">${script}</script>
</body>
</html>
`;
  return { html, scriptHash: `sha256-${createHash("sha256").update(script, "utf8").digest("base64")}` };
}

/** A snapshot: the shell, byte for byte, with one state in its slot. Self-contained: it loads nothing. */
export function snapshotOf(shell: string, state: ShellState): string {
  const at = shell.indexOf(STATE_SLOT);
  if (at === -1) throw new Error("Scope: the shell has no state slot");
  const filled = `<script type="application/json" id="scope-state">${embedJson(state)}</script>`;
  return shell.slice(0, at) + filled + shell.slice(at + STATE_SLOT.length);
}

/** Build a snapshot page: the shell with the state inline. The same inputs in give the same bytes out. */
export async function buildScopePage(options: BuildOptions): Promise<{ html: string; state: ShellState }> {
  const state = await scopeState(options);
  const { html: shell } = await buildShell();
  return { html: snapshotOf(shell, state), state };
}

export async function writeScopePage(options: BuildOptions, outPath: string): Promise<{ bytes: number; state: ShellState }> {
  const { html, state } = await buildScopePage(options);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf8");
  return { bytes: Buffer.byteLength(html, "utf8"), state };
}

/**
 * Build a read-only project state with one ephemeral proposed crossing, select
 * Structure initially, and write only the requested generated page.
 */
export async function writeStructurePreview(root: string, preview: StructurePreview, outPath: string): Promise<{ bytes: number; state: ShellState }> {
  const projectRoot = resolve(root);
  const output = resolve(outPath);
  const withinRoot = relative(projectRoot, output);
  if (withinRoot === "" || (!withinRoot.startsWith(`..${sep}`) && withinRoot !== "..")) {
    throw new Error("Structure preview: write the generated page outside the project root so it cannot perturb the project's inputs");
  }
  return writeScopePage(
    { root: projectRoot, lexiconPath: COHERENCE_LEXICON, project: projectNameOf(projectRoot), structurePreview: [preview] },
    output,
  );
}

/** The project's name (projectName: its config's, else its folder's), capitalized. A config that will not parse is the spec model's to refuse, with its path. */
export function projectNameOf(root: string): string {
  return capitalize(projectName(root));
}

/** The options a reading of `root` builds with when nothing more is given: Coherence's lexicon, the project's own name. */
export function rootOptions(root: string): BuildOptions {
  return { root: resolve(root), lexiconPath: COHERENCE_LEXICON, project: projectNameOf(root) };
}

// Run directly, this file is the scope command (cli.ts), kept so an older invocation still writes its snapshot.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { scopeCommand } = await import("./cli.ts");
  process.exitCode = await scopeCommand(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
