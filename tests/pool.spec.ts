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

  it('does NOT condemn an account on one dead-session answer', async () => {
    // A single 12153 is routinely jitter — a dropped connection, a lost race
    // with a token refresh. Disabling on the first one is how healthy accounts
    // get taken out of service for good, so the first two only cool softly.
    const pool = await makePool(['a'])
    pool.report('a', { ok: false, kind: 'session_dead', message: '12153' })
    expect(pool.entryView('a')?.cooldownKind).toBe('soft')
    pool.report('a', { ok: false, kind: 'session_dead', message: '12153' })
    expect(pool.entryView('a')?.cooldownKind).toBe('soft')
  })

  it('hard-cools a session that keeps dying, with a readable reason', async () => {
    const pool = await makePool(['a'])
    for (let attempt = 0; attempt < 3; attempt += 1) {
      pool.report('a', { ok: false, kind: 'session_dead', message: '12153' })
    }
    const entry = pool.entryView('a')
    expect(entry?.cooldownKind).toBe('hard')
    expect(entry?.lastError).toContain('重新登录')
  })

  it('clears the death count when a request finally succeeds', async () => {
    // The counter measures CONSECUTIVE deaths, so one good answer proves the
    // session is alive and the account starts from zero again.
    const pool = await makePool(['a'])
    pool.report('a', { ok: false, kind: 'session_dead', message: '12153' })
    pool.report('a', { ok: false, kind: 'session_dead', message: '12153' })
    pool.report('a', { ok: true })
    pool.report('a', { ok: false, kind: 'session_dead', message: '12153' })
    expect(pool.entryView('a')?.cooldownKind).toBe('soft')
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
describe('model-level cooldowns (6004)', () => {
  it('cools the MODEL, not the account, when the reset moment is known', async () => {
    // The account is healthy; only this model is over its limit. Parking the
    // account would idle a working credential for hours.
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    const resetAtMs = time.now() + 30 * 60_000
    pool.report('a', { ok: false, kind: 'model_rate', model: 'glm-5.3', resetAtMs, message: '6004' })
    // The account itself is NOT in an account-level cooldown.
    expect(pool.entryView('a')?.state).toBe('ready')
    // The limited model avoids that account: with only 'a' in the pool it can no
    // longer serve the request at all, which is the whole point.
    expect(pool.pick({ model: 'glm-5.3' }).ok).toBe(false)
    expect(pool.modelCooldownsOf('a').map(entry => entry.model)).toEqual(['glm-5.3'])
  })

  it('honours the upstream reset instant rather than an exponential guess', async () => {
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    const resetAtMs = time.now() + 5 * 60_000
    pool.report('a', { ok: false, kind: 'model_rate', model: 'm', resetAtMs, message: '6004' })
    // Exactly the upstream's moment, not 600s of local backoff.
    expect(pool.modelCooldownsOf('a')[0]?.untilMs).toBe(resetAtMs)
  })

  it('falls back to account-level soft cooling when no model is named', async () => {
    // Without a model name the cooldown could never be matched again, so the
    // caller's inability to name it degrades to the safe account-level path.
    const pool = await makePool(['a'])
    pool.report('a', { ok: false, kind: 'model_rate', message: '6004' })
    expect(pool.entryView('a')?.cooldownKind).toBe('soft')
  })

  it('expires a model cooldown without releasing the account-level state', async () => {
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    pool.report('a', { ok: false, kind: 'model_rate', model: 'm', resetAtMs: time.now() + 60_000, message: '6004' })
    expect(pool.modelCooldownsOf('a')).toHaveLength(1)
    time.advance(60_001)
    expect(pool.modelCooldownsOf('a')).toHaveLength(0)
  })

  it('negatively caches a model the backend does not have, with growing TTL', async () => {
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    pool.report('a', { ok: false, kind: 'model_blocked', model: 'ghost', message: '11102' })
    const first = pool.modelCooldownsOf('a')[0]
    expect(first?.reason).toContain('11102')
    const firstTtl = (first?.untilMs ?? 0) - time.now()
    time.advance(1_000)
    pool.report('a', { ok: false, kind: 'model_blocked', model: 'ghost', message: '11102' })
    const secondTtl = (pool.modelCooldownsOf('a')[0]?.untilMs ?? 0) - time.now()
    expect(secondTtl).toBeGreaterThan(firstTtl)
  })

  it('clears a model-blocked entry once that model answers', async () => {
    // The negative cache is a guess; a real answer from that model disproves it.
    const pool = await makePool(['a'])
    pool.report('a', { ok: false, kind: 'model_blocked', model: 'ghost', message: '11102' })
    expect(pool.modelCooldownsOf('a')).toHaveLength(1)
    pool.report('a', { ok: true, model: 'ghost' })
    expect(pool.modelCooldownsOf('a')).toHaveLength(0)
  })

  it('keeps a 6004 entry through an unrelated success', async () => {
    // A success on another request says nothing about the upstream's own reset
    // moment, so the model limit must survive it and expire on its own.
    const pool = await makePool(['a'])
    pool.report('a', { ok: false, kind: 'model_rate', model: 'm', message: '6004' })
    pool.report('a', { ok: true, model: 'm' })
    expect(pool.modelCooldownsOf('a')).toHaveLength(1)
  })

  it('lets an explicit recover clear the model refusals too', async () => {
    const pool = await makePool(['a'])
    pool.report('a', { ok: false, kind: 'model_blocked', model: 'ghost', message: '11102' })
    pool.reset('a')
    expect(pool.modelCooldownsOf('a')).toHaveLength(0)
  })
})

describe('a gateway (WAF) refusal', () => {
  it('cools the account down without ever disabling it', async () => {
    // The firewall answered, not the API. It is a per-IP signal that clears on
    // its own, so needing a human for it would be wrong.
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    pool.report('a', { ok: false, kind: 'waf_block', message: '403 html' })
    const entry = pool.entryView('a')
    expect(entry?.state).toBe('cooldown')
    expect(entry?.cooldownKind).toBe('soft')
    expect(entry?.enabled).toBe(true)
  })

  it('honours a Retry-After the gateway stated', async () => {
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    pool.report('a', { ok: false, kind: 'waf_block', retryAfterMs: 42_000, message: '403' })
    // The stated wait, not the 60s base and no exponential growth from it.
    expect((pool.entryView('a')?.cooldownUntil ?? 0) - time.now()).toBe(42_000)
  })
})

describe('the reset wall clock on account-level limits', () => {
  it('uses the upstream instant and does not grow it', async () => {
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    const resetAtMs = time.now() + 90_000
    pool.report('a', { ok: false, kind: 'soft_rate', resetAtMs, message: '429 将在 … 重置' })
    expect(pool.entryView('a')?.cooldownUntil).toBe(resetAtMs)
    // A second refusal must not push the deadline past what the upstream said.
    time.advance(1_000)
    pool.report('a', { ok: false, kind: 'soft_rate', resetAtMs: resetAtMs + 60_000, message: '429' })
    expect(pool.entryView('a')?.cooldownUntil).toBe(resetAtMs + 60_000)
  })

  it('prefers a body reset moment over a Retry-After header', async () => {
    // The body wording is the narrower statement about this very limit.
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    pool.report('a', { ok: false, kind: 'soft_rate', resetAtMs: time.now() + 10_000, retryAfterMs: 600_000, message: '429' })
    expect((pool.entryView('a')?.cooldownUntil ?? 0) - time.now()).toBe(10_000)
  })

  it('uses Retry-After when the body said nothing', async () => {
    const time = clock()
    const pool = await makePool(['a'], { now: time.now })
    pool.report('a', { ok: false, kind: 'soft_rate', retryAfterMs: 30_000, message: '429' })
    expect((pool.entryView('a')?.cooldownUntil ?? 0) - time.now()).toBe(30_000)
  })
})

describe('cost-tiered picking (layered picks)', () => {
  it('prefers an account observed FREE for this model', async () => {
    const pool = await makePool(['a', 'b'])
    // 'a' was measured free for this model; 'b' has no observation at all.
    pool.noteModelCost('a', 'promo', 0, 1000)
    const picked = new Set<string>()
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = pool.pick({ model: 'promo' })
      if (result.ok) {
        picked.add(result.entry.accountId)
        pool.release(result.entry.accountId)
      }
    }
    // Tier 0 is a hard filter, so 'b' is never chosen while 'a' qualifies.
    expect(picked).toEqual(new Set(['a']))
    // And the tier really is why: with no model named, both are eligible.
    const unnamed = new Set<string>()
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = pool.pick()
      if (result.ok) {
        unnamed.add(result.entry.accountId)
        pool.release(result.entry.accountId)
      }
    }
    expect(unnamed.size).toBe(2)
  })

  it('prefers an unobserved account over one known to charge', async () => {
    // The free status of a new account can only be learned by trying it, so a
    // known-paid account must not win every time.
    const pool = await makePool(['a', 'b'])
    pool.noteModelCost('a', 'promo', 5, 1000)
    const picked = new Set<string>()
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = pool.pick({ model: 'promo' })
      if (result.ok) {
        picked.add(result.entry.accountId)
        pool.release(result.entry.accountId)
      }
    }
    // 'b' is unobserved (tier 1) and 'a' is known to charge (tier 2), so the
    // unobserved account wins every draw.
    expect(picked).toEqual(new Set(['b']))
  })

  it('falls back to plain weighting when no model is named', async () => {
    const pool = await makePool(['a', 'b'])
    pool.noteModelCost('a', 'promo', 0, 1000)
    const picked = new Set<string>()
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = pool.pick()
      if (result.ok) {
        picked.add(result.entry.accountId)
        pool.release(result.entry.accountId)
      }
    }
    // With no model there is no tier, so both accounts stay eligible.
    expect(picked.has('b')).toBe(true)
  })

  it('keeps both paid accounts eligible and never shuts the cheaper one out', async () => {
    // Cost ranks WITHIN a tier; it does not exclude. Two paid accounts both stay
    // eligible (so a price spike on one cannot starve the other), while the
    // cheaper one heads the shortlist the weighted draw comes from.
    // Absolute exclusion is exactly what the FREE tier is for — see the next test.
    const pool = await makePool(['cheap', 'dear'])
    pool.noteModelCost('cheap', 'm', 1, 1000)
    pool.noteModelCost('dear', 'm', 9, 1000)
    const picked = new Set<string>()
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = pool.pick({ model: 'm' })
      if (result.ok) {
        picked.add(result.entry.accountId)
        pool.release(result.entry.accountId)
      }
    }
    expect(picked).toEqual(new Set(['cheap', 'dear']))
    expect(picked.has('cheap')).toBe(true)
  })

  it('EXCLUDES a paid account in favour of a free one', async () => {
    // Tier 0 is a hard filter: with a measured-free account available, a known
    // paid one is never chosen, which is the whole point of watching real cost.
    const pool = await makePool(['free', 'paid'])
    pool.noteModelCost('free', 'm', 0, 1000)
    pool.noteModelCost('paid', 'm', 5, 1000)
    const picked = new Set<string>()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = pool.pick({ model: 'm' })
      if (result.ok) {
        picked.add(result.entry.accountId)
        pool.release(result.entry.accountId)
      }
    }
    expect(picked).toEqual(new Set(['free']))
  })

  it('ignores a cost observation that has gone stale', async () => {
    // A "free at night" observation must not persist into the paid hours.
    const time = clock()
    const pool = await makePool(['a', 'b'], { now: time.now })
    pool.noteModelCost('a', 'm', 0, 1000)
    pool.noteModelCost('b', 'm', 5, 1000)
    time.advance(7 * 3_600_000)
    const picked = new Set<string>()
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = pool.pick({ model: 'm' })
      if (result.ok) {
        picked.add(result.entry.accountId)
        pool.release(result.entry.accountId)
      }
    }
    // Both observations expired, so both sit in the unobserved tier.
    expect(picked.size).toBe(2)
  })
})
describe('sticky allocation (idle-first)', () => {
  it('spreads simultaneous new conversations across idle accounts', async () => {
    // Without this, every new conversation's first request is decided by weight
    // alone, and the heaviest account collects them all.
    const pool = await makePool(['a', 'b', 'c'])
    // Give 'a' the strongest weight so pure weighting would always choose it.
    pool.setCredits('a', { total: 10_000, expiringSoon: 0 })
    pool.setCredits('b', { total: 1, expiringSoon: 0 })
    pool.setCredits('c', { total: 1, expiringSoon: 0 })
    const assigned: string[] = []
    for (const session of ['s1', 's2', 's3']) {
      const result = pool.pick({ stickyKey: session })
      if (!result.ok) continue
      assigned.push(result.entry.accountId)
      // Bind the session by reporting a success, exactly as the shim does.
      pool.report(result.entry.accountId, { ok: true }, session)
      pool.release(result.entry.accountId)
    }
    // Three different sessions take three different accounts, despite 'a'
    // carrying all the weight.
    expect(new Set(assigned).size).toBe(3)
  })

  it('still uses every account when all of them are already bound', async () => {
    // The idle preference is a preference: with no idle account left, the
    // weighted choice over the full candidate set decides.
    const pool = await makePool(['a', 'b'])
    pool.report('a', { ok: true }, 's1')
    pool.report('b', { ok: true }, 's2')
    const result = pool.pick({ stickyKey: 's3' })
    expect(result.ok).toBe(true)
  })

  it('keeps an existing conversation on its own account', async () => {
    // Idle-first must never move a bound session: that is the whole point of
    // stickiness, and the fast path returns before the idle filter is reached.
    const pool = await makePool(['a', 'b'])
    pool.setCredits('b', { total: 10_000, expiringSoon: 0 })
    pool.report('a', { ok: true }, 's1')
    const first = pool.pick({ stickyKey: 's1' })
    expect(first.ok && first.entry.accountId).toBe('a')
    pool.release('a')
    const again = pool.pick({ stickyKey: 's1' })
    // Still 'a' even though 'b' is far richer and idle.
    expect(again.ok && again.entry.accountId).toBe('a')
  })
})
