export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  /** Context window fill, 0 to 100; null before the first response. */
  context: number | null
  limits: Limit[]
  /** US dollars this session; absent where the host keeps no ledger. */
  cost?: number
  /** When the session began, in `$.clock.now()`'s milliseconds. */
  startedAt?: number
}

export type Scoped = {
  /** When the account's usage was last asked for, in `$.clock.now()`'s ms. */
  fetchedAt: number
  limits: Limit[]
}

export type Tokens = {
  /** Input: uncached, cache-written and cache-read together. */
  input: number
  /** The part of `input` the prompt cache served. */
  cacheRead?: number
  output: number
}

export type Work = {
  /** Milliseconds of finished turns this session. */
  totalMs: number
  /** When the running turn began, in `$.clock.now()`'s milliseconds. */
  turnStartedAt: number | null
  /** Tool calls in the running turn. */
  tools?: number
  /** The last finished turn. */
  last?: { ms: number; tools: number }
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      snapshot: Snapshot | null
      work: Work
      /** The account's own windows: `five_hour`, and each per-model weekly
       * window, its `kind` the model's name lowercased. */
      scoped: Scoped | null
      /** Tokens of every turn that ended while the mod was loaded. */
      tokens: Tokens
    }
  }
}
