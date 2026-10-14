/**
 * The kinds of record and their id prefixes: the journal's, and the work
 * store's, whose ids come from the same minter. Kept apart from the record
 * model, with no import at all, so the Scope page, which runs in a browser,
 * reads a record id's kind from these same tables rather than a copy of them.
 */

/** Every kind the journal records, with the id prefix that marks it. */
export const KINDS = {
  decision: "d",
  retraction: "rt",
  conjecture: "c",
  resolution: "rs",
  dismissal: "dm",
  defect: "df",
  experiment: "x",
  close: "xc",
  unable: "u",
  escalation: "e",
  acknowledgement: "ak",
  enactment: "en",
} as const;

export type Kind = keyof typeof KINDS;

/**
 * The kinds the work store records, with their id prefixes. Work orders live
 * in their own files under .coherence/work; these kinds never appear in the
 * journal, but their ids come from the same minter.
 */
export const WORK_KINDS = {
  order: "w",
  move: "wm",
  owner: "wo",
  completion: "wc",
} as const;

export type WorkKind = keyof typeof WORK_KINDS;
