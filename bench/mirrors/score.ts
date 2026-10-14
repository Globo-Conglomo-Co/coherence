/**
 * Scores the mirror reading (src/readings/mirrors) against the hand sweep
 * the spike of PR #94 measured it by: truth.json, the hand lists found by a
 * manual sweep at v1.7.2, and labels.json, every group of the spike's
 * reading at v1.7.2 labeled hand-list, weak or not.
 *
 * usage: node bench/mirrors/score.ts [--rev v1.7.2] [--runs <n>]
 *
 * Prints recall (each truth item's group rank, and whether the threshold
 * policy surfaces it), precision at the top k and among the surfaced groups,
 * and the reading's time (median of --runs runs, in process).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMirrors } from "../../src/readings/mirrors/mirrors.ts";
import type { Group, SetRef } from "../../src/readings/mirrors/model.ts";
import { alarmsOf, alarmText, surfaced } from "../../src/readings/mirrors/policy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const rev = option("--rev") ?? "v1.7.2";
const runs = Number(option("--runs") ?? 1);

interface Side {
  file: string;
  name?: string;
  form?: string;
}
interface Truth {
  id: number | string;
  label: string;
  sides: Side[];
}
interface Label {
  exact?: boolean;
  match: string;
  label: "hand-list" | "weak" | "not";
  why: string;
}

const truth = JSON.parse(readFileSync(join(here, "truth.json"), "utf8")) as Truth[];
const labels = JSON.parse(readFileSync(join(here, "labels.json"), "utf8")) as Label[];

const hits = (s: SetRef, side: Side): boolean => s.file === side.file && (side.name === undefined || s.name.includes(side.name)) && (side.form === undefined || s.form === side.form);

function groupHits(t: Truth, g: Group): boolean {
  const first = t.sides[0]!;
  return g.findings.some((f) => {
    const all = [f.a, f.b, ...f.copies];
    return all.some((s) => hits(s, first)) && t.sides.some((y, j) => j !== 0 && all.some((s) => hits(s, y) && !hits(s, first)));
  });
}

function labelOf(g: Group): Label | undefined {
  const names = g.findings.flatMap((f) => [f.a, f.b, ...f.copies]).map((s) => `${s.file} ${s.name}`);
  return labels.find((l) => names.some((n) => (l.exact === true ? n === l.match : n.includes(l.match))));
}

function tally(groups: readonly Group[]): string {
  const ls = groups.map(labelOf);
  const n = (label: Label["label"]): number => ls.filter((l) => l?.label === label).length;
  const unlabeled = ls.filter((l) => l === undefined).length;
  return `${n("hand-list")} hand-list, ${n("weak")} weak, ${n("not")} not${unlabeled > 0 ? `, ${unlabeled} unlabeled` : ""} of ${groups.length}`;
}

const root = process.cwd();
const times: number[] = [];
let reading = await readMirrors(root, { rev });
times.push(reading.ms);
for (let i = 1; i < runs; i++) {
  reading = await readMirrors(root, { rev });
  times.push(reading.ms);
}
times.sort((a, b) => a - b);
const { groups } = reading;
const shown = groups.filter(surfaced);

console.log(`mirror reading at ${rev} (${reading.commit.slice(0, 7)}): ${reading.sets} sets, ${groups.length} groups, ${shown.length} surfaced; median ${times[Math.floor(times.length / 2)]} ms over ${runs} run(s) (last: ${Object.entries(reading.phases).map(([k, v]) => `${k} ${v}`).join(", ")})`);
console.log("\nrecall against the manual sweep (group rank):");
let found = 0;
let top10 = 0;
let top20 = 0;
let surfacedFound = 0;
for (const t of truth) {
  const at = groups.findIndex((g) => groupHits(t, g));
  const g = at >= 0 ? groups[at] : undefined;
  if (g !== undefined) {
    found += 1;
    if (at < 10) top10 += 1;
    if (at < 20) top20 += 1;
    if (surfaced(g)) surfacedFound += 1;
  }
  console.log(`  #${t.id} ${t.label}: ${g === undefined ? "missed" : `rank ${at + 1}${surfaced(g) ? ", surfaced" : ""}`}`);
}
console.log(`  found ${found} of ${truth.length}: ${top10} in the top 10, ${top20} in the top 20, ${surfacedFound} surfaced`);
console.log("\nprecision (labels):");
for (const k of [10, 20, 40, groups.length]) console.log(`  top ${k}: ${tally(groups.slice(0, k))}`);
console.log(`  surfaced: ${tally(shown)}`);
const alarms = alarmsOf(groups);
console.log(`\nalarms: ${alarms.length}`);
for (const f of alarms) console.log(`  ${alarmText(f)}`);
