/**
 * The agent hosts' tools, declared once: for each host, the tools that write
 * files and how each names what it writes, and the tools whose reading the
 * read trace records. Everything that asks about a tool derives from here:
 * the PreToolUse matcher install writes for Claude Code, the tools whose
 * event routes by the files it names, the hook's reading of what an event
 * wrote, and the read trace.
 *
 * Writing is an allow list. A tool not declared here writes nothing, whatever
 * its input names (a Read's file_path, Codex's view_image path, an MCP
 * server's read_file), unless its input carries a shell command whose words
 * write a file (shell-writes.ts), which is a write whatever tool ran it. So a
 * new reading tool can never count as a write; a new writing tool that names
 * its file is missed until it is declared here, and the test beside this
 * module fails for any host tool the matcher does not cover.
 *
 * Light by rule: it imports only the shell reading, which imports nothing, so
 * the install, the hook, the trace and a mod can all read it.
 */

import type { Host } from "./project.ts";
import { shellCommandOf, shellWrittenPaths } from "./shell-writes.ts";

/** How a tool names what it writes: an input field holding one path, a patch body, or a shell command read for its writes. */
export type Naming = "file_path" | "notebook_path" | "path" | "patch" | "command";

/**
 * The tools that write files, per host, each with how it names them. Claude
 * Code's are those of 2.1.296 (MultiEdit is kept for the releases that still
 * have it); Codex's are its patch tool and its shell tools, under the names
 * its tool calls and its hooks give them.
 */
export const WRITERS: Readonly<Record<Host, Readonly<Record<string, Naming>>>> = {
  claude: { Bash: "command", Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path", PowerShell: "command", Monitor: "command" },
  codex: { apply_patch: "patch", shell: "command", local_shell: "command", shell_command: "command", exec_command: "command", Bash: "command" },
};

/** The tools whose reading of a file the read trace records, per host, each with the field naming the file. */
export const READERS: Readonly<Record<Host, Readonly<Record<string, Exclude<Naming, "patch" | "command">>>>> = {
  claude: { Read: "file_path", NotebookRead: "notebook_path" },
  codex: { read_file: "path" },
};

/** A tool's own name: Codex may namespace one (functions.apply_patch). */
function bare(tool: unknown): string {
  return typeof tool === "string" ? tool.split(".").at(-1)! : "";
}

function lookup<T>(table: Readonly<Record<Host, Readonly<Record<string, T>>>>, tool: unknown): T | undefined {
  const name = bare(tool);
  for (const tools of Object.values(table)) if (Object.hasOwn(tools, name)) return tools[name];
  return undefined;
}

/** How a declared writer names what it writes; undefined for every other tool. */
export function writerNaming(tool: unknown): Naming | undefined {
  return lookup(WRITERS, tool);
}

/** The field a declared reader names its file in; undefined for every other tool. */
export function readerNaming(tool: unknown): Exclude<Naming, "patch" | "command"> | undefined {
  return lookup(READERS, tool);
}

/** A tool whose event names the files it writes, so the files, not the cwd, say which project it is about. */
export function namesWrittenFiles(tool: unknown): boolean {
  const naming = writerNaming(tool);
  return naming !== undefined && naming !== "command";
}

/** The PreToolUse matcher install writes for Claude Code: every tool of its that writes, since a practice fires on a command or a written file. */
export const CLAUDE_WRITER_MATCHER = Object.keys(WRITERS.claude).join("|");

/**
 * Whether a Claude Code hook matcher runs the hook for `tool`: no matcher,
 * an empty one or `*` match every tool; one of letters, digits, _ and | is a
 * list of exact names; anything else is a regular expression.
 */
export function matcherCovers(matcher: unknown, tool: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (typeof matcher !== "string") return false;
  if (/^[\w|]+$/.test(matcher)) return matcher.split("|").includes(tool);
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
}

/** The Claude Code tools that write files which `matcher` would not run the hook for, in declared order. */
export function writersUnmatched(matcher: unknown): string[] {
  return Object.keys(WRITERS.claude).filter((tool) => !matcherCovers(matcher, tool));
}

/** The parts of a tool event this module reads. */
export interface ToolEvent {
  tool_name?: unknown;
  tool_input?: unknown;
  [key: string]: unknown;
}

/**
 * What a tool event writes, as the event spells it, never resolved: the
 * named files of a declared writer, the files a patch adds, updates, deletes
 * or moves to, and what a shell command writes, read from its words (`shell`,
 * against the folder it runs in). A tool not declared a writer writes
 * nothing unless its input carries a shell command that writes. Words only.
 */
export function writtenNames(input: ToolEvent): { named: string[]; shell: string[] } {
  const naming = writerNaming(input.tool_name);
  const record = typeof input.tool_input === "object" && input.tool_input !== null ? (input.tool_input as Record<string, unknown>) : {};
  if (naming === "patch") {
    const patch = typeof input.tool_input === "string" ? input.tool_input : [record["patch"], record["input"], record["command"]].find((v): v is string => typeof v === "string");
    const named: string[] = [];
    if (patch?.trimStart().startsWith("*** Begin Patch") && patch.trimEnd().endsWith("*** End Patch")) {
      for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) named.push(match[1]!.trim());
    }
    return { named, shell: [] };
  }
  if (naming !== undefined && naming !== "command") {
    const value = record[naming];
    return { named: typeof value === "string" && value !== "" ? [value] : [], shell: [] };
  }
  // A declared shell tool, or any other tool whose input carries a command: what its words write.
  const command = shellCommandOf(record);
  return { named: [], shell: command === undefined ? [] : shellWrittenPaths(command) };
}
