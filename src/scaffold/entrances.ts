/**
 * Scaffold entrances: the `## entrances` bullets for the detected entrances
 * no declared entrance covers (entrance-coverage.ts), in the spec grammar,
 * grouped by the component that owns each handler's file.
 *
 * Each bullet is one detected entrance: a name drawn from its symbol (a
 * route from its file's path under the routes folder, a script from its
 * file), the handler as the spec resolves it (`symbol in file`, the file
 * relative to the owning component; a file-grain entrance names its module),
 * and two placeholders only the agent can fill: the one-line meaning and the
 * trust level, listing the levels the entry spec declares. A placeholder
 * trust reads as absent, so an entrance pasted unfilled is still untrusted
 * and orient and regulate name it as a gap.
 *
 * Printed, never written: every bullet carries placeholders, and the
 * scaffold never writes one into a spec where a reader would take it for a
 * declaration (as control: none is never written with a placeholder reason).
 */

import { posix } from "node:path";
import { NEXT_ROUTE_METHODS, REMIX_ROUTE_EXPORTS, type EntranceCandidate } from "../adapters/entrance-candidates.ts";
import { languagesReadLine, type LanguagesRead } from "../readings/scope/languages-read.ts";
import { isModuleHandler } from "../spec/grammar.ts";
import { componentHolding } from "../spec/model.ts";
import { rulesText } from "../readings/scope/undeclared.ts";
import { symbolWords } from "./control.ts";

/** The exports a framework names for the route, not for what it does: the route's path names the entrance instead. */
const ROUTE_EXPORTS = new Set(["Route", "ServerRoute", "APIRoute", "default"]);
/** The exports named for the request they answer, as entrance detection reads them: the route's path and the export name the entrance. */
const METHOD_EXPORTS: ReadonlySet<string> = new Set([...NEXT_ROUTE_METHODS, ...REMIX_ROUTE_EXPORTS]);

/** The meaning slot: what the agent writes, never guessed from the code. */
export const MEANING_PLACEHOLDER = "<one line: what work enters here, and from whom>";

export interface ProposedEntrance {
  candidate: EntranceCandidate;
  name: string;
  handler: string;
}

export interface EntranceGroup {
  /** The owning component's folder; undefined when no component's folder holds the file. */
  component: string | undefined;
  specPath: string | undefined;
  entrances: ProposedEntrance[];
}

interface Owner {
  folder: string;
  specPath: string;
  entrances: readonly { name: string }[];
}

function stem(file: string): string {
  const base = posix.basename(file);
  const dot = base.indexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

/** A route file's path under its routes folder, without its extension: src/routes/api/users.$id.ts is api/users.$id. */
function routePath(file: string): string {
  const parts = file.replace(/\.[A-Za-z]+$/, "").split("/");
  const at = Math.max(parts.lastIndexOf("routes"), parts.lastIndexOf("app"), parts.lastIndexOf("pages"));
  return (at === -1 ? parts : parts.slice(at + 1)).join("/") || stem(file);
}

/** The name a bullet proposes: words from the symbol; the route's path for a route export or a page; the file's for a file-grain entrance. Never a colon, which ends a name. */
export function entranceName(c: Pick<EntranceCandidate, "file" | "symbol" | "rule">): string {
  let name: string;
  if (c.rule === "page route") name = `page ${routePath(c.file).replace(/(?:^|\/)page$/, "") || "/"}`;
  else if (c.symbol === "") name = symbolWords(stem(c.file)).join(" ") || stem(c.file);
  else if (ROUTE_EXPORTS.has(c.symbol)) name = `route ${routePath(c.file)}`;
  else if (METHOD_EXPORTS.has(c.symbol)) name = `${c.symbol} ${routePath(c.file)}`;
  else if (c.symbol === "Command") name = `command ${stem(c.file)}`;
  else name = symbolWords(c.symbol).join(" ") || c.symbol;
  return name.replace(/:/g, " ").replace(/\s+/g, " ").trim();
}

/** The handler line's value, as the spec resolves it: the file relative to the owning component (the spec reads it there first, then under the root). */
export function entranceHandler(c: Pick<EntranceCandidate, "file" | "symbol" | "registered">, folder: string | undefined): string {
  const file = folder === undefined || folder === "." || !c.file.startsWith(`${folder}/`) ? c.file : c.file.slice(folder.length + 1);
  if (c.symbol === "") return isModuleHandler(file) ? file : c.file;
  // Registered here and declared elsewhere: the spec finds a bare name under the component.
  if (c.registered === true) return c.symbol;
  return `${c.symbol} in ${file}`;
}

/** Whether a detected entrance lies under a folder or is the file given; "." or nothing is every one. */
export function under(file: string, target: string | undefined): boolean {
  if (target === undefined || target === "." || target === "") return true;
  const t = target.replace(/\/+$/, "");
  return file === t || file.startsWith(`${t}/`);
}

/**
 * The proposed bullets for the undeclared entrances, grouped by the component
 * holding each file (the deepest spec folder above it), components in folder
 * order and bullets in file order. A name another entrance of that spec
 * already has, or another bullet proposed, is told apart by its file, then
 * its line.
 */
export function proposeEntrances(undeclared: readonly EntranceCandidate[], components: readonly Owner[]): EntranceGroup[] {
  const groups = new Map<string, EntranceGroup>();
  const taken = new Map<string, Set<string>>();
  for (const c of undeclared) {
    const owner = componentHolding(components, c.file);
    const id = owner?.folder ?? "";
    let group = groups.get(id);
    if (group === undefined) {
      group = { component: owner?.folder, specPath: owner?.specPath, entrances: [] };
      groups.set(id, group);
      taken.set(id, new Set((owner?.entrances ?? []).map((e) => e.name)));
    }
    const names = taken.get(id)!;
    let name = entranceName(c);
    if (names.has(name)) name = `${name} in ${stem(c.file)}`;
    if (names.has(name)) name = `${name} line ${c.line}`;
    names.add(name);
    group.entrances.push({ candidate: c, name, handler: entranceHandler(c, owner?.folder) });
  }
  return [...groups.values()].sort((a, b) => (a.component === undefined ? 1 : b.component === undefined ? -1 : a.component.localeCompare(b.component)));
}

/** The trust slot: a placeholder listing the levels the entry spec declares. */
export function trustPlaceholder(levels: readonly { name: string }[]): string {
  return levels.length === 0 ? "<trust level: declare ## trust levels in the entry spec first>" : `<trust level: ${levels.map((l) => l.name).join(" | ")}>`;
}

/** One bullet in the spec grammar: the name and meaning, then the indented handler: and trust: lines. */
export function renderEntrance(p: ProposedEntrance, trust: string): string {
  return [`- ${p.name}: ${MEANING_PLACEHOLDER}`, `  handler: ${p.handler}`, `  trust: ${trust}`].join("\n");
}

/**
 * The whole proposal: a count against what was detected, then each owning
 * component's bullets under the spec to paste them into, then what to do
 * with each.
 */
export function renderEntrances(input: { groups: readonly EntranceGroup[]; detected: number; declared: number; target: string | undefined; levels: readonly { name: string }[]; cli: string; languages: LanguagesRead }): string {
  const { groups, detected, declared, target, levels, cli } = input;
  const count = groups.reduce((n, g) => n + g.entrances.length, 0);
  const where = target === undefined || target === "." ? "" : ` under ${target}`;
  const read = languagesReadLine(input.languages);
  const said = read === undefined ? "" : `\n${read}`;
  if (count === 0) return `Every detected entrance${where} is declared (${declared} declared, ${detected} detected in the project).${said}`;
  const trust = trustPlaceholder(levels);
  const lines = [`${count} undeclared ${count === 1 ? "entrance" : "entrances"}${where} (${detected} detected in the project, ${declared} declared). Paste each group under ## entrances in the spec named; write each meaning, and set trust: to the level its caller or data carries in.`];
  for (const g of groups) {
    lines.push("");
    lines.push(g.specPath === undefined ? `# no component holds these files: ${cli} scaffold component <folder> "<intent>" first (${rulesText(g.entrances.map((e) => e.candidate))})` : `# ${g.specPath} (${rulesText(g.entrances.map((e) => e.candidate))})`);
    for (const p of g.entrances) lines.push(renderEntrance(p, trust));
  }
  lines.push("");
  lines.push(`A bullet whose work several entrances share can be one grouped entrance whose handler is what they are registered through. For one that is not an entrance, record why with ${cli} decide; it stays counted as undeclared.`);
  if (read !== undefined) lines.push(read);
  return lines.join("\n");
}
