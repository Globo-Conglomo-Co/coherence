// A/B the edit-time cost: alternate the specs as main has them (A) and with the new chokepoints (B),
// timing PostToolUse for an Edit of each file through the CLI. usage: node bench/chokepoints/edit-cost.mjs <root> <rounds> <file>...
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, roundsArg, ...files] = process.argv.slice(2);
const rounds = Number(roundsArg);
const specs = ["src/lifecycle/Lifecycle.spec.md", "src/journal/Journal.spec.md"];
const after = Object.fromEntries(specs.map((s) => [s, readFileSync(join(root, s), "utf8")]));
const before = Object.fromEntries(specs.map((s) => [s, execFileSync("git", ["show", `origin/main:${s}`], { cwd: root, encoding: "utf8" })]));
const put = (set) => { for (const s of specs) writeFileSync(join(root, s), set[s]); };

const time = (file) => {
  const input = JSON.stringify({ session_id: "bench-chokepoints", hook_event_name: "PostToolUse", cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, file), old_string: "x", new_string: "x" } });
  const t = performance.now();
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "src/cli.ts"), "hook", "PostToolUse"], { cwd: root, input, encoding: "utf8" });
  return Math.round(performance.now() - t);
};

const results = { before: {}, after: {} };
try {
  for (const [label, set] of [["before", before], ["after", after]]) { put(set); for (const f of files) time(f); } // warm each side once
  for (let r = 0; r < rounds; r++) {
    for (const [label, set] of r % 2 === 0 ? [["before", before], ["after", after]] : [["after", after], ["before", before]]) {
      put(set);
      for (const f of files) (results[label][f] ??= []).push(time(f));
    }
  }
} finally {
  put(after);
}
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const summary = {};
for (const f of files) summary[f] = { before: { median: med(results.before[f]), min: Math.min(...results.before[f]), times: results.before[f] }, after: { median: med(results.after[f]), min: Math.min(...results.after[f]), times: results.after[f] } };
console.log(JSON.stringify(summary, null, 1));
