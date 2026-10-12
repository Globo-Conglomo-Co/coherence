/**
 * Commits a record or a practice names, asked of git. A shallow clone, such
 * as a hosted agent's sandbox at depth 1, does not hold the commits its depth
 * cut off, and cannot tell one from a name that is no commit at all: there a
 * name is missing only when it names some other object the clone holds, or
 * more than one. Outside a git checkout, or when git fails, nothing is known.
 */

import { spawnSync } from "../lifecycle/work-meter.ts";

/** The names among these that are no commit this repository can show; undefined when git cannot be asked. */
export function missingCommits(root: string, commits: readonly string[]): Set<string> | undefined {
  if (commits.length === 0) return new Set();
  const asCommits = batchCheck(root, commits.map((c) => `${c}^{commit}`));
  if (asCommits === undefined) return undefined;
  const missing = commits.filter((_, index) => / missing$| ambiguous$/.test(asCommits[index] ?? ""));
  if (missing.length === 0 || !isShallow(root)) return new Set(missing);
  const asObjects = batchCheck(root, missing);
  if (asObjects === undefined) return undefined;
  return new Set(missing.filter((_, index) => !/ missing$/.test(asObjects[index] ?? "")));
}

/** git cat-file --batch-check's answer for each name, in order; undefined when git cannot be asked. */
function batchCheck(root: string, names: readonly string[]): string[] | undefined {
  const result = spawnSync("git", ["cat-file", "--batch-check"], { cwd: root, input: names.join("\n") + "\n", encoding: "utf8" });
  return result.status === 0 ? result.stdout.split("\n") : undefined;
}

function isShallow(root: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "true";
}
