import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Timer,
  Register,
  SessionContextUsage,
  SessionCost,
  SessionRateLimit,
} from 'claude-code'

import type { Limit, Scoped, Snapshot, Tokens, Work } from '../types'

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)

const idle: Work = { totalMs: 0, turnStartedAt: null }
const work = atom({ plugin: 'usage-band', key: 'work' } as const, idle)

const scoped = atom({ plugin: 'usage-band', key: 'scoped' } as const, null)

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const REFRESH_MS = 5 * 60 * 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// The per-model weekly windows in the account's usage answer: its `limits`
// rows of kind `weekly_scoped`, each named by `scope.model.display_name`.
const scopedFrom = (text: string): Limit[] => {
  const body: unknown = JSON.parse(text)
  const rows = isRecord(body) && Array.isArray(body.limits) ? body.limits : []
  // The 5-hour window too, which a plan without one answers as null.
  const short = isRecord(body) ? body.five_hour : undefined
  const fiveHour: Limit[] =
    isRecord(short) && typeof short.utilization === 'number'
      ? [
          {
            kind: 'five_hour',
            percentUsed: short.utilization,
            ...(typeof short.resets_at === 'string'
              ? { resetsAt: short.resets_at }
              : {}),
          },
        ]
      : []

  // And the weekly window for every model, under the session feed's name.
  const weekly = rows.flatMap((row: unknown): Limit[] =>
    isRecord(row) && row.kind === 'weekly_all' && typeof row.percent === 'number'
      ? [
          {
            kind: 'seven_day',
            percentUsed: row.percent,
            ...(typeof row.resets_at === 'string'
              ? { resetsAt: row.resets_at }
              : {}),
          },
        ]
      : [],
  )

  return fiveHour.concat(weekly, rows.flatMap((row: unknown): Limit[] => {
    if (!isRecord(row) || row.kind !== 'weekly_scoped') {
      return []
    }

    const model = isRecord(row.scope) ? row.scope.model : undefined
    const name = isRecord(model) ? model.display_name : undefined

    if (typeof name !== 'string' || typeof row.percent !== 'number') {
      return []
    }

    return [
      {
        kind: name.toLowerCase(),
        percentUsed: row.percent,
        ...(typeof row.resets_at === 'string'
          ? { resetsAt: row.resets_at }
          : {}),
      },
    ]
  }))
}

const none: Tokens = { input: 0, output: 0 }
const tokens = atom({ plugin: 'usage-band', key: 'tokens' } as const, none)

// 950, 12.3k, 4.56M
const showCount = (n: number): string => {
  if (n < 1000) {
    return String(n)
  }

  return n < 1_000_000
    ? `${(n / 1000).toFixed(1)}k`
    : `${(n / 1_000_000).toFixed(2)}M`
}

const showTime = (ms: number): string => {
  const minutes = Math.floor(ms / 60000)

  if (minutes < 1) {
    return `${Math.floor(ms / 1000)}s`
  }

  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// "2d 5h", "5h 12m" or "12m" until an ISO timestamp; null when it is
// missing, unreadable or already past.
const showUntil = (resetsAt: string | undefined, nowMs: number): string | null => {
  const ms = resetsAt === undefined ? NaN : Date.parse(resetsAt) - nowMs

  if (!(ms > 0)) {
    return null
  }

  const minutes = Math.ceil(ms / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  if (days > 0) {
    return `${days}d ${hours}h`
  }

  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

const toSnapshot = (
  context: SessionContextUsage,
  rateLimits: readonly SessionRateLimit[],
  cost: SessionCost | undefined,
): Snapshot => ({
  ...(cost === undefined ? {} : { cost: cost.usd }),
  context: context.percent ?? null,
  limits: rateLimits.map(l => ({
    kind: l.kind,
    percentUsed: l.percentUsed,
    ...(l.resetsAt === undefined ? {} : { resetsAt: l.resetsAt }),
  })),
})

const colorFor = (percent: number | null): string | undefined => {
  if (percent === null) {
    return undefined
  }

  if (percent >= 90) {
    return 'red'
  }

  return percent >= 70 ? 'yellow' : 'green'
}

const show = (percent: number | null): string =>
  percent === null ? '—' : `${Math.round(percent)}%`

const percentOf = (limit: Limit | undefined): number | null =>
  limit === undefined ? null : limit.percentUsed

// Asks the account's usage for the per-model weekly windows, which the
// session's own measurements leave out; at most once in REFRESH_MS, and a
// failure keeps what was read before.
// `isForced` skips the wait: a session just opened always asks.
const refresh = async ($: EngineInterface, isForced = false) => {
  const nowMs = await $.clock.now()
  const before = await read($, scoped)

  if (!isForced && before !== null && nowMs - before.fetchedAt < REFRESH_MS) {
    return
  }

  const auth = await $.session.authorize()

  if (auth === null || auth.kind !== 'bearer') {
    return
  }

  const answer = await $.http.fetch(USAGE_URL, {
    auth: auth.handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
  })

  if (!answer.ok) {
    return
  }

  const next: Scoped = { fetchedAt: nowMs, limits: scopedFrom(answer.text) }
  await update($, scoped, () => next)
}

// The window's fill as the composer and /context count it: every category
// estimated locally (no request sent) against the compaction window, which
// may be smaller than the model's. Null when no breakdown comes back.
const composerPercent = async ($: EngineInterface): Promise<number | null> => {
  const { context } = await $.session.usage({ breakdown: 'summary' })

  return context.breakdown?.percentage ?? null
}

export const register: Register = on => {
  // Keeps the account's windows fresh in a session nobody is typing in: a
  // reopened or idle one has no new response to report them.
  let timer: Timer | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const { context, rateLimits, cost, startedAt } = await $.session.usage()
    const filled = await composerPercent($).catch(() => null)
    await update($, snapshot, () => ({
      ...toSnapshot(context, rateLimits, cost),
      ...(filled === null ? {} : { context: filled }),
      startedAt,
    }))

    await refresh($, true).catch(() => undefined)
    timer?.cancel()
    timer = $.clock.every(REFRESH_MS + 1000, () => {
      void refresh($).catch(() => undefined)
    })

    return result
  })

  on('session.attach', async ($, e, next) => {
    await refresh($, true).catch(() => undefined)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const filled = await composerPercent($).catch(() => null)
    await update($, snapshot, before => ({
      ...toSnapshot(e.context, e.rateLimits, e.cost),
      ...(filled === null ? {} : { context: filled }),
      ...(before?.startedAt === undefined
        ? {}
        : { startedAt: before.startedAt }),
    }))
    await refresh($).catch(() => undefined)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Timing must never hold a prompt back: a failure here is dropped.
    await (async () => {
      const startedAt = await $.clock.now()
      await update($, work, w => ({
        ...(w ?? idle),
        turnStartedAt: startedAt,
        tools: 0,
      }))
    })().catch(() => undefined)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // Counting must never hold a tool call back: a failure here is dropped.
    await update($, work, w => ({
      ...(w ?? idle),
      tools: ((w ?? idle).tools ?? 0) + 1,
    })).catch(() => undefined)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Every loop's tokens count, a subagent's too; the clock below is the
    // main loop's alone.
    const used = e.usage

    if (used !== undefined) {
      await update($, tokens, t => ({
        input:
          (t ?? none).input +
          used.input_tokens +
          used.cache_read_input_tokens +
          used.cache_creation_input_tokens,
        cacheRead:
          ((t ?? none).cacheRead ?? 0) + used.cache_read_input_tokens,
        output: (t ?? none).output + used.output_tokens,
      }))
    }

    if (e.agentId !== undefined) {
      return next(e)
    }

    const endedAt = await $.clock.now()
    await update($, work, w => {
      const { totalMs, turnStartedAt, tools = 0, last } = w ?? idle

      if (turnStartedAt === null) {
        return { totalMs, turnStartedAt, ...(last ? { last } : {}) }
      }

      const ms = endedAt - turnStartedAt

      return {
        totalMs: totalMs + ms,
        turnStartedAt: null,
        last: { ms, tools },
      }
    })

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, snapshot)

    if (e.props.hasSurvey || now === null) {
      return next(e)
    }

    // The weekly window for every model, and the weekly window that names
    // Fable (a per-model window, reported only on plans that have one).
    // The account's own reading comes first: it is re-read on a timer, where
    // the session's is as old as its last response.
    const account = (await read($, scoped))?.limits ?? []
    const sevenDay = [...account, ...now.limits].find(
      l => l.kind === 'seven_day',
    )
    const weekly = percentOf(sevenDay)
    const nowMs = await $.clock.now()
    const weeklyReset = showUntil(sevenDay?.resetsAt, nowMs)
    const fableLimit = [
      ...((await read($, scoped))?.limits ?? []),
      ...now.limits,
    ].find(l => l.kind.toLowerCase().includes('fable'))
    const fable = percentOf(fableLimit)
    // The 5-hour window shows on every plan that reports one: the session's
    // own reading first, else the account's.
    const fiveHour = [...account, ...now.limits].find(
      l => l.kind === 'five_hour',
    )
    const resets: Record<string, string | null> = {
      '5h': showUntil(fiveHour?.resetsAt, nowMs),
      Weekly: weeklyReset,
    }
    const cells: [string, number | null][] = [
      ...(fiveHour === undefined
        ? []
        : [['5h', fiveHour.percentUsed] satisfies [string, number]]),
      ['Weekly', weekly],
      ['Fable', fable],
      ['Context', now.context],
    ]
    const { totalMs, turnStartedAt, last } = await read($, work)
    const workedMs =
      turnStartedAt === null ? totalMs : totalMs + nowMs - turnStartedAt
    const spent = await read($, tokens)
    const { Box, Text } = $.ui.resolve(e)

    type Cell = { label: string; value: string; color?: string; note?: string }
    const all: Cell[] = [
      ...cells.map(([label, percent]): Cell => {
        const color = colorFor(percent)
        const reset = resets[label]

        return {
          label,
          value: show(percent),
          ...(color === undefined ? {} : { color }),
          ...(reset ? { note: `resets in ${reset}` } : {}),
        }
      }),
      ...(now.startedAt === undefined
        ? []
        : [{ label: 'Session', value: showTime(nowMs - now.startedAt) }]),
      { label: 'Worked', value: showTime(workedMs) },
      ...(last === undefined
        ? []
        : [
            {
              label: 'Last turn',
              value: `${showTime(last.ms)}, ${last.tools} ${last.tools === 1 ? 'tool' : 'tools'}`,
            },
          ]),
      ...(spent.input + spent.output === 0
        ? []
        : [
            {
              label: 'Tokens',
              value: `${showCount(spent.input)} in / ${showCount(spent.output)} out`,
              note: `${showCount(spent.cacheRead ?? 0)} cache read`,
            },
          ]),
      ...(now.cost === undefined
        ? []
        : [{ label: 'Cost', value: '$' + now.cost.toFixed(2) }]),
    ]

    // Each cell keeps its own width and never breaks inside; where the row
    // runs out of room, whole cells move to the next line.
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={0}>
        {all.map((cell, i) => (
          <Box key={cell.label} flexShrink={0}>
            <Text wrap="truncate-end" size="caption" tabular>
              <Text dimColor>{cell.label} </Text>
              <Text bold color={cell.color}>
                {cell.value}
              </Text>
              {cell.note === undefined ? null : (
                <Text dimColor> ({cell.note})</Text>
              )}
              {i === all.length - 1 ? null : <Text dimColor> ·</Text>}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
