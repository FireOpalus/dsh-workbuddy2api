/**
 * Account-pool scheduling semantics.
 *
 * 参考：Sliverkiss/workbuddy2api（MIT）— 用例逐条对应其
 * `internal/pool/*_test.go` 的关键不变量：健康或门、权重三因子、
 * Top5 + 防撞号 + LRU 兜底、冷却退避的「已在冷却中不翻倍」、
 * 熔断指数增长与封顶、降权只由无分类失败触发、会话粘性的绑定与解绑。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKBUDDY_POOL_POLICY,
  nextDay4Am,
  stickyKeyOf,
  WorkBuddyAccountPool,
} from '../src/pool.ts'
import type { WorkBuddyPoolAccount } from '../src/pool.ts'

/** A fixed clock the tests advance explicitly. */
function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start
  return { now: () => value, advance: ms => { value += ms } }
}

function account(id: string, region: 'cn' | 'global' = 'cn'): WorkBuddyPoolAccount {
  return { id, accountName: id, region, tokenExpiresAtMs: 0 }
}

/** A pool over `ids`, with a deterministic RNG that always takes the first draw. */
async function makePool(
  ids: readonly string[],
  options: {
    now?: () => number
    random?: () => number
    policy?: Record<string, unknown>
    global?: readonly string[]
  } = {},
): Promise<WorkBuddyAccountPool> {
  const globals = new Set(options.global ?? [])
  const pool = new WorkBuddyAccountPool({
    list: async () => ids.map(id => account(id, globals.has(id) ? 'global' : 'cn')),
    ...options.now === undefined ? {} : { now: options.now },
    ...options.random === undefined ? {} : { random: options.random },
    ...options.policy === undefined ? {} : { policy: options.policy },
  })
  await pool.refresh()
  return pool
}

describe('pool discovery', () => {
  it('keeps accounts that vanished, marks them missing, and revives them on return', async () => {
    let ids = ['a', 'b']
    const pool = new WorkBuddyAccountPool({ list: async () => ids.map(id => account(id)) })
    await pool.refresh()
    expect(pool.snapshot().map(entry => entry.state)).toEqual(['ready', 'ready'])
    ids = ['a']
    await pool.refresh()
    expect(pool.snapshot().map(entry => [entry.accountId, entry.state])).toEqual([['a', 'ready'], ['b', 'missing']])
    // A missing account is never picked, but its entry survives the scan.
    expect(pool.pick().ok).toBe(true)
    expect(pool.pick().ok && (pool.pick() as { entry: { accountId: string } }).entry.accountId).toBe('a')
    ids = ['a', 'b']
    await pool.refresh()
    expect(pool.snapshot().map(entry => entry.state)).toEqual(['ready', 'ready'])
  })

  it('reports all-disabled when every account is switched off', async () => {
    const pool = await makePool(['a', 'b'])
    pool.configure([{ accountId: 'a', enabled: false }, { accountId: 'b', enabled: false }])
    expect(pool.pick()).toEqual({ ok: false, reason: 'all-disabled' })
  })

  it('reports no-accounts for an empty pool', async () => {
    const pool = await makePool([])
    expect(pool.pick()).toEqual({ ok: false, reason: 'no-accounts' })
  })
})

describe('pool concurrency ceilings', () => {
  it('refuses an account at its ceiling and falls back to another', async () => {
    const pool = await makePool(['a'], { policy: { maxInFlightPerAccount: 1, maxInFlightTotal: 8 } })
    const first = pool.pick()
    expect(first.ok).toBe(true)
    expect(pool.entryView('a')?.inFlight).toBe(1)
    // The only account is at its ceiling and has no running cooldown, so the
    // picker has nothing to fall back to.
    expect(pool.pick()).toEqual({ ok: false, reason: 'pool-saturated' })
    pool.release('a')
    expect(pool.entryView('a')?.inFlight).toBe(0)
    expect(pool.pick().ok).toBe(true)
  })

  it('applies the tighter international ceiling to global accounts', async () => {
    const pool = await makePool(['g'], {
      policy: { maxInFlightPerAccount: 3, maxInFlightGlobalPerAccount: 1 },
      global: ['g'],
    })
    expect(pool.pick().ok).toBe(true)
    expect(pool.entryView('g')?.inFlight).toBe(1)
    expect(pool.pick()).toEqual({ ok: false, reason: 'pool-saturated' })
  })

  it('stops dispatching once the whole-pool ceiling is reached', async () => {
    const pool = await makePool(['a', 'b'], {
      policy: { maxInFlightPerAccount: 5, maxInFlightTotal: 1, minPickGapMs: 0 },
    })
    expect(pool.pick().ok).toBe(true)
    // The pool-wide ceiling is a hard stop: falling back "around" it would
    // defeat the reason it exists.
    expect(pool.pick()).toEqual({ ok: false, reason: 'pool-saturated' })
    pool.release('a')
    expect(pool.pick().ok).toBe(true)
  })
})

describe('pool health transitions', () => {
  it('cools an out-of-credit account down until the next local 04:00', async () => {
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    pool.report('a', { ok: false, kind: 'hard_credit', message: 'insufficient credit' })
    const entry = pool.entryView('a')
    expect(entry?.state).toBe('cooldown')
    expect(entry?.cooldownKind).toBe('hard')
    expect(entry?.cooldownUntil).toBe(nextDay4Am(time.now()))
    // A hard cooldown is excluded from the all-cooling fallback.
    expect(pool.pick().ok).toBe(false)
    time.advance(nextDay4Am(time.now()) - time.now() + 1)
    expect(pool.entryView('a')?.state).toBe('ready')
  })

  it('gives a dead session the same long cooldown and a readable reason', async () => {
    const pool = await makePool(['a'])
    pool.report('a', { ok: false, kind: 'session_dead', message: '12153' })
    const entry = pool.entryView('a')
    expect(entry?.state).toBe('cooldown')
    expect(entry?.cooldownKind).toBe('hard')
    expect(entry?.lastError).toContain('重新登录')
  })

  it('backs a rate limit off exponentially and never extends a running cooldown', async () => {
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    pool.report('a', { ok: false, kind: 'soft_rate', message: '429' })
    const first = pool.entryView('a')?.cooldownUntil as number
    expect(first - time.now()).toBe(DEFAULT_WORKBUDDY_POOL_POLICY.softRateCooldownMs)
    // Hammering retry while the cooldown runs must not push it further out.
    time.advance(1_000)
    pool.report('a', { ok: false, kind: 'soft_rate', message: '429' })
    expect(pool.entryView('a')?.cooldownUntil).toBe(first)
    // Once the cooldown lapses, the next rate limit doubles the base.
    time.advance(DEFAULT_WORKBUDDY_POOL_POLICY.softRateCooldownMs + 1)
    pool.report('a', { ok: false, kind: 'soft_rate', message: '429' })
    expect((pool.entryView('a')?.cooldownUntil as number) - time.now())
      .toBe(DEFAULT_WORKBUDDY_POOL_POLICY.softRateCooldownMs * 2)
  })

  it('caps the rate-limit backoff at the configured ceiling', async () => {
    const time = clock()
    const pool = await makePool(['a'], {
      now: time.now,
      policy: { softRateCooldownMs: 1_000, softRateCooldownMaxMs: 4_000 },
    })
    for (let attempt = 0; attempt < 6; attempt += 1) {
      pool.report('a', { ok: false, kind: 'soft_rate', message: '429' })
      time.advance(10_000)
    }
    pool.report('a', { ok: false, kind: 'soft_rate', message: '429' })
    expect((pool.entryView('a')?.cooldownUntil as number) - time.now()).toBe(4_000)
  })

  it('cools a 404 down for the fixed not-found window without touching the breaker', async () => {
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    pool.report('a', { ok: false, kind: 'not_found', message: '404' })
    expect((pool.entryView('a')?.cooldownUntil as number) - time.now())
      .toBe(DEFAULT_WORKBUDDY_POOL_POLICY.notFoundCooldownMs)
    expect(pool.entryView('a')?.breakerUntil).toBeUndefined()
  })

  it('opens the breaker only after the configured consecutive server failures', async () => {
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    pool.report('a', { ok: false, kind: 'server', message: '500' })
    pool.report('a', { ok: false, kind: 'server', message: '500' })
    expect(pool.entryView('a')?.breakerUntil).toBeUndefined()
    pool.report('a', { ok: false, kind: 'server', message: '500' })
    expect((pool.entryView('a')?.breakerUntil as number) - time.now())
      .toBe(DEFAULT_WORKBUDDY_POOL_POLICY.breakerCooldownMs)
    expect(pool.entryView('a')?.state).toBe('degraded')
  })

  it('doubles the breaker cooldown per trip and caps it', async () => {
    const time = clock()
    const pool = await makePool(['a'], {
      now: time.now,
      policy: { breakerCooldownMs: 1_000, breakerCooldownMaxMs: 4_000, breakerThreshold: 1 },
    })
    pool.report('a', { ok: false, kind: 'server', message: '500' })
    expect((pool.entryView('a')?.breakerUntil as number) - time.now()).toBe(1_000)
    time.advance(2_000)
    pool.report('a', { ok: false, kind: 'server', message: '500' })
    expect((pool.entryView('a')?.breakerUntil as number) - time.now()).toBe(2_000)
    time.advance(3_000)
    pool.report('a', { ok: false, kind: 'server', message: '500' })
    expect((pool.entryView('a')?.breakerUntil as number) - time.now()).toBe(4_000)
  })

  it('degrades after consecutive unclassified failures but never cools down', async () => {
    const time = clock()
    const pool = await makePool(['a'], { now: time.now, policy: { degradeThreshold: 2, degradeCooldownMs: 5_000 } })
    pool.report('a', { ok: false, message: 'transport error' })
    expect(pool.entryView('a')?.state).toBe('ready')
    pool.report('a', { ok: false, message: 'transport error' })
    expect(pool.entryView('a')?.state).toBe('degraded')
    expect(pool.entryView('a')?.cooldownUntil).toBeUndefined()
    // A degraded account is still pickable.
    expect(pool.pick().ok).toBe(true)
  })

  it('caps the degrade window and never extends a running one', async () => {
    const time = clock()
    const pool = await makePool(['a'], {
      now: time.now,
      policy: { degradeThreshold: 1, degradeCooldownMs: 60_000, degradeCooldownMaxMs: 30_000 },
    })
    pool.report('a', { ok: false, message: 'transport error' })
    const until = pool.entryView('a')?.degradedUntil as number
    expect(until - time.now()).toBe(30_000)
    // Re-reaching the threshold inside the window leaves the deadline alone.
    time.advance(1_000)
    pool.report('a', { ok: false, message: 'transport error' })
    expect(pool.entryView('a')?.degradedUntil).toBe(until)
  })

  it('clears every counter on success and rolls the sticky binding forward', async () => {
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    pool.report('a', { ok: false, kind: 'server', message: '500' })
    pool.report('a', { ok: true }, 'session-1')
    const entry = pool.entryView('a')
    expect(entry?.consecutiveFailures).toBe(0)
    expect(entry?.lastError).toBeUndefined()
    expect(pool.stickySize()).toBe(1)
    time.advance(DEFAULT_WORKBUDDY_POOL_POLICY.stickyTtlMs + 1)
    // An expired binding is dropped on read, and the next dispatch only
    // re-binds once its own outcome comes back.
    expect(pool.pick({ stickyKey: 'session-1' }).ok).toBe(true)
    expect(pool.stickySize()).toBe(0)
    pool.report('a', { ok: true }, 'session-1')
    expect(pool.stickySize()).toBe(1)
  })

  it('reset() clears cooldown, breaker, and degrade state', async () => {
    const pool = await makePool(['a'])
    pool.report('a', { ok: false, kind: 'hard_credit', message: 'no credit' })
    expect(pool.entryView('a')?.state).toBe('cooldown')
    pool.reset('a')
    expect(pool.entryView('a')?.state).toBe('ready')
  })
})

describe('pool selection', () => {
  it('pins a conversation to one account while it is healthy', async () => {
    const time = clock()
    const pool = await makePool(['a', 'b', 'c'], { now: time.now, random: () => 0.99 })
    const first = pool.pick({ stickyKey: 'session-1' })
    expect(first.ok).toBe(true)
    const chosen = first.ok ? first.entry.accountId : ''
    // The binding is written by the outcome, exactly as the shim reports it.
    pool.report(chosen, { ok: true }, 'session-1')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Move past the anti-collision gap so the gap cannot mask the binding.
      time.advance(1_000)
      const next = pool.pick({ stickyKey: 'session-1' })
      expect(next.ok && next.entry.accountId).toBe(chosen)
      pool.release(chosen)
    }
  })

  it('re-picks for a conversation whose bound account went unhealthy', async () => {
    const time = clock()
    const pool = await makePool(['a', 'b'], { now: time.now, random: () => 0.99 })
    const first = pool.pick({ stickyKey: 'session-1' })
    const chosen = first.ok ? first.entry.accountId : ''
    const other = chosen === 'a' ? 'b' : 'a'
    pool.report(chosen, { ok: true }, 'session-1')
    pool.report(chosen, { ok: false, kind: 'hard_credit', message: 'no credit' })
    const next = pool.pick({ stickyKey: 'session-1' })
    expect(next.ok && next.entry.accountId).toBe(other)
  })

  it('never returns an account the caller already tried', async () => {
    const pool = await makePool(['a', 'b'], { random: () => 0.99 })
    // No sticky key here: the caller's exclude set must be honoured on its own.
    const first = pool.pick()
    const firstId = first.ok ? first.entry.accountId : ''
    const second = pool.pick({ exclude: new Set([firstId]) })
    expect(second.ok && second.entry.accountId).not.toBe(firstId)
  })

  it('prefers the account holding credits that expire soon', async () => {
    const time = clock()
    const pool = await makePool(['a', 'b'], { now: time.now, random: () => 0 })
    pool.setCredits('a', { total: 100, expiringSoon: 0 })
    pool.setCredits('b', { total: 100, expiringSoon: 100 })
    const picked = pool.pick()
    expect(picked.ok && picked.entry.accountId).toBe('b')
  })

  it('ignores credits entirely when balance-aware ordering is off', async () => {
    const time = clock()
    const pool = await makePool(['a', 'b'], { now: time.now, random: () => 0, policy: { balanceAware: false } })
    pool.setCredits('a', { total: 1, expiringSoon: 0 })
    pool.setCredits('b', { total: 1_000_000, expiringSoon: 1_000_000 })
    // With both accounts never used, the weighted draw decides; a deterministic
    // zero draw must not be steered by the credit numbers.
    const picked = pool.pick()
    expect(picked.ok).toBe(true)
    expect(picked.ok && picked.entry.accountId).toBe('a')
  })

  it('spreads consecutive picks across accounts via the anti-collision gap', async () => {
    const time = clock()
    const pool = await makePool(['a', 'b'], { now: time.now, random: () => 0 })
    const first = pool.pick()
    const second = pool.pick()
    expect(first.ok && second.ok).toBe(true)
    // The clock did not move, so the first account is inside the 100 ms gap and
    // the second pick must land on the other one.
    expect(first.ok && first.entry.accountId).not.toBe(second.ok && second.entry.accountId)
  })

  it('falls back to the account whose cooldown expires first when all are cooling', async () => {
    const time = clock()
    const pool = await makePool(['a', 'b'], { now: time.now, policy: { softRateCooldownMs: 1_000 } })
    pool.report('a', { ok: false, kind: 'soft_rate', message: '429' })
    time.advance(100)
    pool.report('b', { ok: false, kind: 'soft_rate', message: '429' })
    const picked = pool.pick()
    expect(picked.ok).toBe(true)
    expect(picked.ok && picked.fallback).toBe(true)
    expect(picked.ok && picked.entry.accountId).toBe('a')
  })

  it('reports the persisted slice with only still-running deadlines', async () => {
    const time = clock()
    const pool = await makePool(['a', 'b'], { now: time.now })
    pool.configure([{ accountId: 'b', enabled: false, weight: 42, priority: 7 }])
    pool.report('a', { ok: false, kind: 'soft_rate', message: '429' })
    const persisted = pool.toPersisted()
    expect(persisted.map(record => record.accountId)).toEqual(['b', 'a'])
    const b = persisted.find(record => record.accountId === 'b')
    expect(b).toMatchObject({ enabled: false, weight: 42, priority: 7 })
    expect(b?.cooldownUntil).toBeUndefined()
    const a = persisted.find(record => record.accountId === 'a')
    expect(a?.cooldownUntil).toBeGreaterThan(time.now())
    expect(a?.cooldownKind).toBe('soft')
    time.advance(DEFAULT_WORKBUDDY_POOL_POLICY.softRateCooldownMs + 1)
    expect(pool.toPersisted().find(record => record.accountId === 'a')?.cooldownUntil).toBeUndefined()
  })

  it('restores a persisted cooldown across restarts', async () => {
    const time = clock()
    const until = time.now() + 60_000
    const pool = new WorkBuddyAccountPool({
      list: async () => [account('a')],
      now: time.now,
      state: [{ accountId: 'a', enabled: true, weight: 10, priority: 100, cooldownUntil: until, cooldownKind: 'soft' }],
    })
    await pool.refresh()
    expect(pool.entryView('a')?.state).toBe('cooldown')
    expect(pool.entryView('a')?.cooldownUntil).toBe(until)
  })

  it('clamps configured weights into the 1..100 range', async () => {
    const pool = await makePool(['a'])
    pool.configure([{ accountId: 'a', weight: 0 }])
    expect(pool.entryView('a')?.weight).toBe(1)
    pool.configure([{ accountId: 'a', weight: 1_000 }])
    expect(pool.entryView('a')?.weight).toBe(100)
  })
})

describe('sticky keys', () => {
  const body = (system: string, user: string): string => JSON.stringify({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'a later turn' },
    ],
  })

  it('derives one key per conversation and a different one per prompt', () => {
    const first = stickyKeyOf(body('you are dsh', 'first question'))
    const same = stickyKeyOf(body('you are dsh', 'first question'))
    const other = stickyKeyOf(body('you are dsh', 'second question'))
    expect(first).toBeDefined()
    expect(first).toBe(same)
    expect(first).not.toBe(other)
    expect(first?.startsWith('d-')).toBe(true)
  })

  it('ignores later turns so a conversation keeps its key as it grows', () => {
    const short = JSON.stringify({ messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
    ] })
    const long = JSON.stringify({ messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'follow-up' },
    ] })
    expect(stickyKeyOf(short)).toBe(stickyKeyOf(long))
  })

  it('treats the developer role as the system prompt and handles array content', () => {
    const withDeveloper = JSON.stringify({ messages: [
      { role: 'developer', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
    ] })
    expect(stickyKeyOf(withDeveloper)).toBe(stickyKeyOf(JSON.stringify({ messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
    ] })))
  })

  it('answers undefined for a body with no usable text', () => {
    expect(stickyKeyOf('not json')).toBeUndefined()
    expect(stickyKeyOf('{}')).toBeUndefined()
    expect(stickyKeyOf(JSON.stringify({ messages: [{ role: 'user', content: '' }] }))).toBeUndefined()
  })
})

describe('nextDay4Am', () => {
  it('returns the same day before 04:00 and the next day after it', () => {
    const before = new Date(2026, 0, 5, 3, 30, 0).getTime()
    expect(new Date(nextDay4Am(before)).getDate()).toBe(5)
    const after = new Date(2026, 0, 5, 4, 30, 0).getTime()
    expect(new Date(nextDay4Am(after)).getDate()).toBe(6)
  })
})
