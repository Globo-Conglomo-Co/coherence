/**
 * The shell text of the hook command, read back: what an installed hook's
 * command spells, so a hook an earlier Coherence wrote can be told from the
 * one install writes now. Like install.ts, which writes that shell, this
 * spells paths into node_modules, because the command is shell an agent host
 * runs before any Node resolver exists; it builds no path to open.
 */

import { PACKAGE_NAME, SIBLING } from "./project.ts";

/** Whether a command is Coherence's hook for `event`: this tool's binary or its own src/cli.ts, followed by hook <event>, as install's ownership test reads it. */
export function isOwnHook(command: unknown, event: string): boolean {
  return typeof command === "string" && new RegExp(`(?:^|[\\s"'/$])(?:coherence|src/cli\\.ts)"?\\s+hook\\s+${event}\\s*$`).test(command);
}

/**
 * Whether a command of ours is the located command an earlier Coherence
 * wrote, which looked at a checkout beside the project before the installed
 * package, so a stale clone there answered instead of the installed release.
 */
export function searchesCheckoutFirst(command: string): boolean {
  const sibling = command.indexOf(`/../${SIBLING}/src/cli.ts`);
  const installed = command.indexOf(`node_modules/${PACKAGE_NAME}/dist/cli.js`);
  return sibling !== -1 && installed !== -1 && sibling < installed;
}
