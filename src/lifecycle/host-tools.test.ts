/**
 * The agent hosts' tools, declared once: a tool that only reads never counts
 * as a write, and every tool that writes is matched by the hook install
 * writes and has its files read the way it names them.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readFileOf } from "../economy/trace.ts";
import { writtenFiles } from "./hook.ts";
import { matcherCovers, namesWrittenFiles, READERS, WRITERS, writersUnmatched, writtenNames, type Naming } from "./host-tools.ts";
import { installedEntry } from "./install.ts";
import { HOSTS } from "./project.ts";

const root = mkdtempSync(join(tmpdir(), "coherence-host-tools-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a tool not declared to write files writes nothing, whatever path its input names, unless a command in its input writes one", () => {
  mkdirSync(join(root, "src"), { recursive: true });
  const file = join(root, "src", "a.ts");
  const readers: [string, Record<string, unknown>][] = [
    ["Read", { file_path: file }],
    ["NotebookRead", { notebook_path: file }],
    ["Glob", { pattern: "**/*.ts", path: join(root, "src") }],
    ["Grep", { pattern: "x", path: file }],
    ["LS", { path: root }],
    ["view_image", { path: file }],
    ["read_file", { path: file }],
    ["mcp__files__read_file", { path: file }],
    ["Artifact", { file_path: file }],
    ["memory_read", { path: "src/a.ts" }],
    ["SomeToolNoReleaseHasYet", { file_path: file, path: file, notebook_path: file }],
  ];
  for (const [tool_name, tool_input] of readers) {
    assert.deepEqual(writtenFiles(root, { cwd: root, tool_name, tool_input }), [], `${tool_name} reads; it writes nothing`);
    assert.equal(namesWrittenFiles(tool_name), false, `${tool_name} routes by its cwd, not by a file it names`);
  }
  assert.deepEqual(writtenFiles(root, { cwd: root, tool_name: "mcp__runner__run", tool_input: { command: "echo x > src/b.ts" } }), ["src/b.ts"], "an undeclared tool's command is still read for its writes");
  assert.deepEqual(writtenFiles(root, { cwd: root, tool_name: "mcp__runner__run", tool_input: { command: "cat src/a.ts" } }), [], "and a command that writes nothing writes nothing");
});

/** A tool use of `tool` that writes src/w.ts, spelled the way its naming says. */
function writing(tool: string, naming: Naming): Record<string, unknown> {
  switch (naming) {
    case "patch":
      return { tool_name: tool, tool_input: { command: "*** Begin Patch\n*** Update File: src/w.ts\n@@\n-a\n+b\n*** End Patch" } };
    case "command":
      return { tool_name: tool, tool_input: { command: "echo x > src/w.ts" } };
    default:
      return { tool_name: tool, tool_input: { [naming]: "src/w.ts" } };
  }
}

test("every tool that writes files is matched by the hook install writes for its host and has the file it writes read from its input", () => {
  const matcher = installedEntry({ command: "coherence", host: "claude" }, "PreToolUse").matcher;
  assert.deepEqual(writersUnmatched(matcher), [], "Claude Code runs the PreToolUse hook for every tool of its that writes");
  for (const tool of Object.keys(WRITERS.claude)) assert.ok(matcherCovers(matcher, tool), tool);
  // Codex runs every tool through the hook: install writes no matcher.
  assert.equal(installedEntry({ command: "coherence", host: "codex" }, "PreToolUse").matcher, undefined);
  for (const host of HOSTS) {
    for (const [tool, naming] of Object.entries(WRITERS[host])) {
      const input = { cwd: root, ...writing(tool, naming) };
      assert.deepEqual(writtenFiles(root, input), ["src/w.ts"], `${host} ${tool} writes the file its ${naming} names`);
      assert.equal(namesWrittenFiles(tool), naming !== "command", `${tool} routes by ${naming === "command" ? "its cwd" : "the file it names"}`);
      const { named, shell } = writtenNames({ ...input, tool_name: `functions.${tool}` });
      assert.deepEqual([...named, ...shell], ["src/w.ts"], `a namespaced ${tool} is the same tool`);
    }
  }
});

test("the read trace records a declared reading tool's file and no other tool's", () => {
  writeFileSync(join(root, "read.ts"), "export {};\n");
  for (const host of HOSTS) {
    for (const [tool, field] of Object.entries(READERS[host])) assert.equal(readFileOf(root, { tool_name: tool, tool_input: { [field]: join(root, "read.ts") } }), "read.ts", `${host} ${tool}`);
  }
  assert.equal(readFileOf(root, { tool_name: "Write", tool_input: { file_path: join(root, "read.ts") } }), undefined, "a write is no read");
  assert.equal(readFileOf(root, { tool_name: "Read", tool_input: { path: join(root, "read.ts") } }), undefined, "a reader's file is in the field it names it in");
});
