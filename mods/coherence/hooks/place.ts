// Where Coherence is for this session, as the mod's setup found it: written by
// register.tsx once it is set up, read by the Journal pane. Data only; the
// engine interface never crosses a module.

export const place = {
  /** The session's project root; '' until the mod is set up. */
  root: '',
  /** The Coherence command line found for the project, when there is one. */
  cli: undefined as string | undefined,
}
