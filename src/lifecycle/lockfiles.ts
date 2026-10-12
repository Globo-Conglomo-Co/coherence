/**
 * The lockfiles Coherence recognizes and the package manager each one names,
 * declared once: the update line reads the project's package manager from
 * them, and the CI workflow picks the install it sets up from them.
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Each lockfile and its package manager, in the order a folder holding several is read. */
export const LOCKFILES: readonly (readonly [file: string, manager: PackageManager])[] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];
