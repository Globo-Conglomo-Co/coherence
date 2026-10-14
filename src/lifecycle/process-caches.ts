/**
 * The answers a module keeps for the life of its process about a project:
 * whether a folder is a repository, its registry, the projects below it, the
 * files a root owns, the identity of Coherence's code under a salt the
 * environment sets. A command that runs once per process never sees one
 * outlive a change. A process that runs many commands does: the in-process
 * command line harness (cli-harness.ts) runs each test's command in the test
 * file's own process, where a test that runs git init, adds a project or
 * ignores a file between two calls must get the second call's answers, as a
 * fresh process would. So each such cache is made here, and the harness
 * forgets every one before each call.
 *
 * What stays across calls keys on Coherence's own installation, never on a
 * project: its version (hook-latency.ts, statusline.ts) and the shipped
 * well-known names (well-known.ts). The spec model a hook event shares
 * (hook.ts) lives for one event and is gone after it.
 */

const caches = new Set<{ clear(): void }>();

/** Register a cache a call must not inherit from the call before it; returns it. */
export function perProcess<Cache extends { clear(): void }>(cache: Cache): Cache {
  caches.add(cache);
  return cache;
}

/** Forget every registered cache: what the next call asks is asked afresh. */
export function forgetPerProcess(): void {
  for (const cache of caches) cache.clear();
}
