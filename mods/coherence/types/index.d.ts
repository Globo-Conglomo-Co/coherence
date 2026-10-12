/** The verdict line an edit's check left for one tool call's row, by its tool_use_id. */
export type CoherenceVerdict = { text: string; isFailed: boolean }

declare module 'claude-code' {
  interface PluginState {
    coherence: { verdict: StateFamily<CoherenceVerdict> }
  }
}
