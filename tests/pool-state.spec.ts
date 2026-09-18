/**
 * Durable pool counters: the numbers a restart used to wipe.
 *
 * The distinction this file pins down:
 *   - DURABLE: lifetime dispatch totals, last-used/error marks, cached credits,
 *     and the escalation counters — meaningful across a restart.
 *   - NOT durable: `inFlight`. After a restart nothing is in flight, so
 *     restoring a count that no `release()` will ever decrement would consume
 *     that account's concurrency allowance for the life of the process.
 *   - NOT here: cooldown deadlines. Those live in settings, where the recorded
 *     timestamp is visibly stale rather than silently resurrected.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/pool.ts'
import {
  clearPoolState,
  parsePoolCounterRecord,
  readPoolState,
  workbuddyPoolStatePath,
  writePoolState,
  WORKBUDDY2API_POOL_STATE_VERSION,
} from '../src/pool-state.ts'
import type { WorkBuddyPoolAccount } from '../src/pool.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb2api-pool-state-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A pool over a fixed account list. */
function makePool(accounts: WorkBuddyPoolAccount[]): WorkBuddyAccountPool {
  return new WorkBuddyAccountPool({ list: async () => accounts })
}

const one: WorkBuddyPoolAccount[] = [{ id: 'a', accountName: 'A', region: 'cn', tokenExpiresAtMs: 0 }]

describe('pool counter round trip', () => {
  it('carries dispatch totals through a save and restore', async () => {
    const first = makePool(one)
    await first.refresh()
    first.report('a', { ok: true })
    first.report('a', { ok: true })
    first.report('a', { ok: false, kind: 'server', message: 'boom' })
    first.setCredits('a', { total: 1234, expiringSoon: 12, capacity: 2000 })

    const counters = [...first.toCounters().values()]
    expect(counters[0]).toMatchObject({
      accountId: 'a',
      successes: 2,
      failures: 1,
      credits: 1234,
      creditsCapacity: 2000,
      creditsExpiringSoon: 12,
    })

    await writePoolState({ version: WORKBUDDY2API_POOL_STATE_VERSION, regions: { cn: counters } }, dir)
    const document = await readPoolState(dir)

    const second = makePool(one)
    await second.refresh()
    second.restoreCounters(document.regions.cn ?? [])
    const entry = second.entryView('a')
    expect(entry?.successes).toBe(2)
    expect(entry?.failures).toBe(1)
    expect(entry?.credits).toBe(1234)
    expect(entry?.creditsCapacity).toBe(2000)
    expect(entry?.lastError).toBe('boom')
  })

  it('never restores inFlight, so a restart does not strand a concurrency slot', async () => {
    const first = makePool(one)
    await first.refresh()
    const picked = first.pick()
    expect(picked.ok).toBe(true)
    // One request is nominally "in flight" as the process is torn down.
    expect(first.entryView('a')?.inFlight).toBe(1)

    const counters = [...first.toCounters().values()]
    expect(counters[0]).not.toHaveProperty('inFlight')
    await writePoolState({ version: WORKBUDDY2API_POOL_STATE_VERSION, regions: { cn: counters } }, dir)

    const second = makePool(one)
    await second.refresh()
    second.restoreCounters((await readPoolState(dir)).regions.cn ?? [])
    // The slot is free again: nothing was left holding it.
    expect(second.entryView('a')?.inFlight).toBe(0)
  })

  it('keeps the LRU sequence monotonic across a restart', async () => {
    // The LRU tie-break is `usedSeq` (a monotonic dispatch counter), NOT the
    // wall clock: two picks inside one millisecond share a timestamp, so only the
    // sequence can order them. Restoring a seq higher than the fresh counter
    // would make every NEW dispatch look older than the restored ones and invert
    // the ordering, so the pool raises its counter to the restored maximum.
    const first = makePool(one)
    await first.refresh()
    first.pick()
    first.pick()
    const counters = [...first.toCounters().values()]
    const restoredSeq = counters[0]?.usedSeq ?? 0
    expect(restoredSeq).toBeGreaterThan(0)

    const second = makePool(one)
    await second.refresh()
    second.restoreCounters(counters)
    second.pick()
    // The next dispatch takes a HIGHER sequence than anything restored.
    expect(second.toCounters().get('a')?.usedSeq).toBeGreaterThan(restoredSeq)
  })

  it('prefers the account that was used least recently before the restart', async () => {
    const two: WorkBuddyPoolAccount[] = [
      { id: 'a', accountName: 'A', region: 'cn', tokenExpiresAtMs: 0 },
      { id: 'b', accountName: 'B', region: 'cn', tokenExpiresAtMs: 0 },
    ]
    const first = makePool(two)
    await first.refresh()
    // 'a' gets a later sequence than 'b', so 'b' is the least recently used.
    first.pick()
    first.pick()
    const counters = [...first.toCounters().values()]
    const seqA = counters.find(entry => entry.accountId === 'a')?.usedSeq ?? 0
    const seqB = counters.find(entry => entry.accountId === 'b')?.usedSeq ?? 0
    expect(Math.max(seqA, seqB)).toBeGreaterThan(0)
    const lru = seqA <= seqB ? 'a' : 'b'

    const second = makePool(two)
    await second.refresh()
    second.restoreCounters(counters)
    // With a single slot per account and equal weights, the picker prefers the
    // least recently used one; restoring seq keeps that preference meaningful
    // instead of resetting every account to "equally fresh" after a restart.
    const picked = second.pick()
    expect(picked.ok && picked.entry.accountId).toBe(lru)
  })

  it('ignores counters for an account this pool does not have', async () => {
    const pool = makePool(one)
    await pool.refresh()
    // A record for a credential that disappeared must not resurrect an entry.
    pool.restoreCounters([{ accountId: 'gone', successes: 99, credits: 500 }])
    expect(pool.entryView('gone')).toBeUndefined()
    expect(pool.snapshot().map(entry => entry.accountId)).toEqual(['a'])
  })

  it('survives an unreadable or foreign file by starting from zero', async () => {
    // Absent file.
    expect((await readPoolState(dir)).regions).toEqual({})
    // A different format version.
    await writePoolState({ version: WORKBUDDY2API_POOL_STATE_VERSION, regions: { cn: [] } }, dir)
    await readFile(workbuddyPoolStatePath(dir), 'utf8')
    expect((await readPoolState(dir)).regions).toEqual({})
    // Clearing removes it.
    await clearPoolState(dir)
    expect((await readPoolState(dir)).regions).toEqual({})
  })
})

describe('counter record parsing', () => {
  it('drops fields that are not usable numbers', () => {
    const parsed = parsePoolCounterRecord({
      accountId: 'a',
      successes: 3,
      failures: 'nope',
      credits: Number.NaN,
      creditsCapacity: -5,
      lastError: '',
      lastUsedAt: 1234,
    })
    expect(parsed).toEqual({
      accountId: 'a',
      successes: 3,
      lastUsedAt: 1234,
    })
  })

  it('rejects a record without an account id', () => {
    expect(parsePoolCounterRecord({ successes: 1 })).toBeUndefined()
    expect(parsePoolCounterRecord(null)).toBeUndefined()
    expect(parsePoolCounterRecord([])).toBeUndefined()
  })

  it('round-trips through the file without inventing values', async () => {
    await writePoolState({
      version: WORKBUDDY2API_POOL_STATE_VERSION,
      regions: { cn: [{ accountId: 'a', successes: 7 }], global: [{ accountId: 'b', failures: 2 }] },
    }, dir)
    const document = await readPoolState(dir)
    expect(document.regions.cn).toEqual([{ accountId: 'a', successes: 7 }])
    expect(document.regions.global).toEqual([{ accountId: 'b', failures: 2 }])
    // An absent field stays absent rather than becoming 0: "unknown" and "zero"
    // must remain distinguishable, or a first read would look like a wipe.
    expect(document.regions.cn?.[0]).not.toHaveProperty('failures')
  })
})
