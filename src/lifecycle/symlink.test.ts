/**
 * A project reached through a symbolic link: the hooks route an event by the
 * directory it names, whatever spelling of that directory the host, the
 * event's cwd or the edited file's path uses. On macOS every temporary folder
 * is one (/var -> /private/var), and a home or checkout behind a link is
 * another.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cli, type CliResult } from "./cli-fixture.ts";
import { writtenFiles } from "./hook.ts";


const SPEC = "# Knobs\n\nKnobs turn.\n";

function practiceText(cite: string): string {
  return [
    "- oil the knob: A knob is oiled before it turns.",
    "  when: edit src/knobs/**/*.ts adding knob",
    "  step: wipe the knob",
    "  step: oil the knob",
    `  pitfall: a dry knob seized (${cite})`,
    "  because: a dry knob seizes",
  ].join("\n") + "\n";
}

/** A project in a real folder, and a second spelling of it through a symbolic link beside it. */
async function linkedProject(): Promise<{ real: string; linked: string; done: () => void }> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "coherence-symlink-")));
  const real = join(base, "real", "knobs");
  mkdirSync(join(real, "src", "knobs"), { recursive: true });
  mkdirSync(join(real, ".claude"), { recursive: true });
  writeFileSync(join(real, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(real, "coherence.config.json"), JSON.stringify({ name: "knobs" }) + "\n");
  writeFileSync(join(real, "src", "knobs", "Knobs.spec.md"), SPEC);
  writeFileSync(join(real, "src", "knobs", "dial.ts"), "export const dial = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: real });
  const decided = await cli(["decide", "oil knobs", "--because", "one seized", "--session", "s0", "--agent", "main"], { cwd: real });
  assert.equal(decided.status, 0, decided.stderr);
  const cite = /\bd-[0-9a-f]{8}\b/.exec(decided.stdout)![0];
  writeFileSync(join(real, "src", "knobs", "Knobs.practice.md"), practiceText(cite));
  symlinkSync(join(base, "real"), join(base, "linked"), "dir");
  return { real, linked: join(base, "linked", "knobs"), done: () => rmSync(base, { recursive: true, force: true }) };
}

function preEdit(projectDir: string, cwd: string, file: string): Promise<CliResult> {
  const input = { hook_event_name: "PreToolUse", session_id: "s1", cwd, tool_name: "Edit", tool_input: { file_path: file, old_string: "dial", new_string: "knob" } };
  return cli(["hook", "PreToolUse"], { cwd, stdin: JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, COHERENCE_NO_WARM_UP: "1" } });
}

test("a project behind a symbolic link hears its hooks whichever spelling the host, the cwd and the edited file use", async () => {
  const { real, linked, done } = await linkedProject();
  try {
    // writtenFiles names the project's own file under either spelling of the root or of the file.
    for (const [root, file] of [[real, join(linked, "src/knobs/dial.ts")], [linked, join(real, "src/knobs/dial.ts")], [linked, join(linked, "src/knobs/dial.ts")], [real, join(real, "src/knobs/dial.ts")]] as const) {
      assert.deepEqual(writtenFiles(root, { tool_name: "Edit", tool_input: { file_path: file } }), ["src/knobs/dial.ts"], `root ${root}, file ${file}`);
    }
    // The edit's PreToolUse delivers the project's practice for every mix of spellings.
    const spellings: [string, string, string][] = [
      [linked, linked, join(linked, "src/knobs/dial.ts")],
      [real, real, join(linked, "src/knobs/dial.ts")],
      [linked, linked, join(real, "src/knobs/dial.ts")],
      [real, linked, join(real, "src/knobs/dial.ts")],
    ];
    for (const [projectDir, cwd, file] of spellings) {
      const ran = await preEdit(projectDir, cwd, file);
      assert.equal(ran.status, 0, ran.stderr);
      assert.match(ran.stdout, /oil the knob/, `CLAUDE_PROJECT_DIR ${projectDir}, cwd ${cwd}, file ${file}: the practice was not delivered\n${ran.stdout}${ran.stderr}`);
    }
  } finally {
    done();
  }
});
