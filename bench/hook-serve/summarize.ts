/**
 * The medians (and ranges) per step and arm of a run.ts result, as a Markdown table.
 *
 *   node bench/hook-serve/summarize.ts <out.json>
 */

import { readFileSync } from "node:fs";

type Row = { label: string; wall: number; served?: number; exit: number | null };
type Session = { round: number; arm: "cli" | "warm"; start?: number; rows: Row[] };

const data = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { kind: string; rounds: number; power: string; battery: string; after: string; results: Session[] };
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const fmt = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const range = (xs: number[]): string => `${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))}`;

const labels = data.results[0]!.rows.map((r) => r.label);
const of = (arm: string, label: string, key: "wall" | "served"): number[] => data.results.filter((s) => s.arm === arm).map((s) => s.rows.find((r) => r.label === label)?.[key]).filter((x): x is number => typeof x === "number");

const lines = [
  `${data.kind}, ${data.rounds} interleaved rounds; ${/powermode\s+(\d)/.exec(data.power)?.[0] ?? "powermode ?"}; ${data.battery.split("\n")[0]?.trim()}; after: ${data.after.split("\n")[1]?.trim()}`,
  "",
  "| step | CLI per event (median, range) | warm process (median, range) | warm, runHook's own (median) | saved |",
  "| --- | --- | --- | --- | --- |",
];
let cliTotal = 0;
let warmTotal = 0;
for (const label of labels) {
  const cli = of("cli", label, "wall");
  const warm = of("warm", label, "wall");
  const served = of("warm", label, "served");
  cliTotal += median(cli);
  warmTotal += median(warm);
  lines.push(`| ${label} | ${fmt(median(cli))} (${range(cli)}) | ${fmt(median(warm))} (${range(warm)}) | ${fmt(median(served))} | ${fmt(median(cli) - median(warm))} |`);
}
const starts = data.results.filter((s) => s.arm === "warm").map((s) => s.start!);
lines.push(`| **session (sum of medians)** | ${fmt(cliTotal)} | ${fmt(warmTotal)} | | ${fmt(cliTotal - warmTotal)} |`);
lines.push("", `Warm process start (spawn to ready, off the event path): median ${fmt(median(starts))} (${range(starts)}).`);
const exits = data.results.flatMap((s) => s.rows.map((r) => r.exit)).filter((e) => e !== 0);
lines.push(exits.length === 0 ? "Every event exited 0 on both arms." : `Non-zero exits: ${exits.join(", ")}.`);
process.stdout.write(lines.join("\n") + "\n");
