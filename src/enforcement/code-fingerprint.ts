/**
 * The identity of the Coherence code on disk: a hash of every source file
 * under this installation's src (tests aside) and of package.json. The warm
 * server reports it so a client never talks to stale code, and every parse
 * Coherence keeps across hook calls is keyed by it, so a release that
 * changes a parser can never serve a parse the old one made.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { perProcess } from "../lifecycle/process-caches.ts";

const CODE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = join(CODE_DIR, "..", "package.json");
const CODE_FILE = /\.(ts|mts|cts|js|mjs|cjs|json)$/;

/**
 * Mixed into the fingerprint when set: a test's way to make two processes
 * disagree about their code without editing it. Inherited by a spawned server.
 */
export const CODE_SALT_ENV = "COHERENCE_CODE_SALT";

function codeFiles(dir: string, into: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) codeFiles(path, into);
    else if (entry.isFile() && CODE_FILE.test(entry.name) && !entry.name.includes(".test.")) into.push(path);
  }
  return into;
}

function allCodeFiles(): string[] {
  const files = codeFiles(CODE_DIR, []).sort();
  if (existsSync(PACKAGE_JSON)) files.push(PACKAGE_JSON);
  return files;
}

function salted(hash: ReturnType<typeof createHash>): string {
  const salt = process.env[CODE_SALT_ENV];
  if (salt !== undefined && salt !== "") hash.update(`salt\0${salt}`);
  return hash.digest("hex").slice(0, 16);
}

/** The fingerprint, read from disk each time, so a client compares a running server with the code as it is now. */
export function codeFingerprint(): string {
  const hash = createHash("sha256");
  for (const file of allCodeFiles()) {
    hash.update(relative(CODE_DIR, file)).update("\0");
    try {
      hash.update(readFileSync(file));
    } catch {
      hash.update("<unreadable>");
    }
    hash.update("\0");
  }
  return salted(hash);
}

const held = perProcess(new Map<string, string>());

/** The data files any parse may read at run time: every JSON file under src, the docs' JSON and package.json. */
function dataFiles(): string[] {
  const docs = join(CODE_DIR, "..", "docs");
  const fromDocs = existsSync(docs) ? readdirSync(docs).filter((n) => n.endsWith(".json")).map((n) => join(docs, n)) : [];
  return [...codeFiles(CODE_DIR, []).filter((f) => f.endsWith(".json")), ...fromDocs, ...(existsSync(PACKAGE_JSON) ? [PACKAGE_JSON] : [])].sort();
}

/**
 * The modules `entries` import, transitively, by relative specifier: the code
 * a parse they make depends on. Entries are named as in src; this
 * installation's own files are what is followed, the sources in a checkout
 * and the compiled modules beside each other in the published package.
 */
export function closureOf(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) visit(resolve(dirname(file), m[1]!.replace(/\.js$/, extname(file))));
  };
  // Entries are named as in src; compiled, each is the .js beside the others.
  for (const entry of entries) visit(resolve(CODE_DIR, entry.replace(/\.ts$/, extname(fileURLToPath(import.meta.url)))));
  return [...seen].filter((f) => existsSync(f)).sort();
}

function statKey(files: readonly string[]): string {
  const stats = createHash("sha256");
  for (const file of files) {
    try {
      const s = statSync(file);
      stats.update(`${file}\0${s.dev}\0${s.ino}\0${s.size}\0${s.mtimeMs}\0${s.ctimeMs}\0`);
    } catch {
      stats.update(`${file}\0gone\0`);
    }
  }
  return salted(stats);
}

function hashFiles(files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(CODE_DIR, file)).update("\0");
    try {
      hash.update(readFileSync(file));
    } catch {
      hash.update("<unreadable>");
    }
    hash.update("\0");
  }
  return salted(hash);
}

/**
 * The identity of the code a kept parse depends on: the modules `entries`
 * import, transitively, and every data file, hashed. A parse kept under it
 * is served only to that same code, so an edit to a parser, or anything it
 * imports, discards it, and an edit to code it never runs does not. Hashed
 * again only when one of those files' device, inode, size, modification or
 * change time moved since the hash kept under `cacheDir` (a change time no
 * tool can set back), and once per process.
 */
export function codeIdentity(cacheDir: string, entries: readonly string[]): string {
  const name = [...entries].sort().join("+");
  const known = held.get(name);
  if (known !== undefined) return known;
  const path = join(cacheDir, `code-${createHash("sha1").update(name).digest("hex").slice(0, 12)}.json`);
  try {
    const kept = JSON.parse(readFileSync(path, "utf8")) as { files?: unknown; key?: unknown; fingerprint?: unknown };
    if (Array.isArray(kept.files) && typeof kept.fingerprint === "string" && kept.key === statKey(kept.files as string[])) {
      held.set(name, kept.fingerprint);
      return kept.fingerprint;
    }
  } catch {
    // Missing or torn: hashed again below.
  }
  const files = [...closureOf(entries), ...dataFiles()];
  const fingerprint = hashFiles(files);
  held.set(name, fingerprint);
  try {
    mkdirSync(cacheDir, { recursive: true });
    const aside = `${path}.${process.pid}.tmp`;
    writeFileSync(aside, JSON.stringify({ files, key: statKey(files), fingerprint }));
    renameSync(aside, path);
  } catch {
    // Without the kept hash the next call hashes again; nothing is lost but time.
  }
  return fingerprint;
}

/** Forget the identity held for this process: a test that changes the salt asks again. */
export function forgetCodeIdentity(): void {
  held.clear();
}
