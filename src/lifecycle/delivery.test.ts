import assert from "node:assert/strict";
import { cli as run } from "./cli-fixture.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deliveries, formatDeliveries } from "./delivery.ts";
import { HOOK_EVENTS, startContext } from "./hook.ts";
import { status } from "./install.ts";


test("status says what each event delivers: orient at the starts, the peer feed at the boundaries, regulate at the stops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coherence-delivery-"));
  const cli = (...args: string[]) => run(args, { cwd: dir });
  try {
    const escalated = await cli("escalate", "retire the thing", "--because", "it moved", "--session", "s-1", "--agent", "a");
    assert.equal(escalated.status, 0, escalated.stderr);

    const list = await deliveries(dir);
    assert.deepEqual(list.map((d) => [d.event, d.reading]), [
      ["SessionStart", "orient"],
      ["SubagentStart", "orient"],
      ["UserPromptSubmit", "peer feed"],
      ["PreToolUse", "practice"],
      ["PostToolUse", "peer feed"],
      ["Stop", "regulate"],
      ["SubagentStop", "regulate"],
    ]);
    const start = list[0]!.carries.join("\n");
    assert.match(start, /escalations awaiting a human: 1 /, "measured from this project's journal");
    assert.match(start, /no project lexicon, delivered at detail "full"/);
    assert.match(start, new RegExp(`size now: ${(await startContext(dir, {})).length.toLocaleString("en-US")} of 9,500 characters`), "the size is the injection's own");
    assert.match(list[3]!.carries.join("\n"), /a practice whose trigger the tool use about to run fires[\s\S]*never blocks the tool/);
    assert.match(list[4]!.carries.join("\n"), /never whole records[\s\S]*revelation at the edit/);
    assert.match(list[5]!.carries.join("\n"), /never refuses/);
    assert.match(list[6]!.carries.join("\n"), /refuses the stop \(exit 2\)/);

    // Nothing installed: every event says it delivers nothing.
    const none = formatDeliveries(list, [await status(dir, "claude"), await status(dir, "codex")]);
    for (const event of HOOK_EVENTS) assert.match(none, new RegExp(`\\n  ${event} \\([a-z ]+\\): not wired on any agent host; delivers nothing`));

    assert.equal((await cli("hooks", "install", "--host", "codex")).status, 0);
    const shown = await cli("hooks", "status");
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /\nwhat each event delivers for this project:\n  SessionStart \(orient\) via codex:\n    escalations awaiting a human: 1 /);
    assert.match(shown.stdout, /\n  SubagentStop \(regulate\) via codex:\n/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
