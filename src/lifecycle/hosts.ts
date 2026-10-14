/**
 * The agent hosts Coherence installs into, and the folder each keeps in a
 * project, declared once. No import at all, so the project walk, telemetry
 * and the installer read these same names rather than a copy.
 */

export const HOSTS = ["claude", "codex"] as const;
export type Host = (typeof HOSTS)[number];

export function isHost(name: string): name is Host {
  return (HOSTS as readonly string[]).includes(name);
}

/** The folder each host keeps its settings in, relative to the project root. */
export const HOST_FOLDER: Readonly<Record<Host, string>> = {
  claude: ".claude",
  codex: ".codex",
};

/** The settings file each host reads, relative to the project root. */
export const SETTINGS_FILE: Readonly<Record<Host, string>> = {
  claude: `${HOST_FOLDER.claude}/settings.json`,
  codex: `${HOST_FOLDER.codex}/hooks.json`,
};

/**
 * The personal settings file a host reads beside the shared one, relative to
 * the folder holding it, for a host that has one: Claude Code's is never
 * committed, and launched in a subfolder it reads the one at the git root.
 */
export const LOCAL_SETTINGS_FILE: Partial<Record<Host, string>> = {
  claude: `${HOST_FOLDER.claude}/settings.local.json`,
};
