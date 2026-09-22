/**
 * The startup check-in.
 *
 * Small feature, specific invariants:
 *   - a redundant check-in is a business answer and therefore a SUCCESS, while a
 *     dropped connection must never be mistaken for one;
 *   - a cooling account IS checked in (unfreezing it is the point), a disabled one
 *     is not disturbed;
 *   - the international gateway is skipped without any upstream call;
 *   - one failing account never costs the others their reward.
 */

import { describe, expect, it } from 'vitest'
import { checkinAllAccounts, isAlreadyCheckedIn } from '../src/startup-checkin.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/** A credential for the domestic gateway. */
function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.workbuddy.cn',
    uid: 'uid-1',
    nickname: 'tester',
    source: 'desktop',
    filePath: '/x.info',
    ...overrides,
  }
}

/** A business-envelope failure, the shape the client throws on code != 0. */
function businessError(message: string): Error {
  return new Error(`workbuddy upstream client (http 200): ${message}`)
}

/** A scripted upstream, recording every call. */
function fakeClient(options: {
  active?: boolean
  todayCheckedIn?: boolean
  claim?: { credit: number; streakDays: number; isStreakDay: boolean }
  claimError?: Error
  statusError?: Error
  creditTotal?: number
} = {}): {
  client: Parameters<typeof checkinAllAccounts>[0]['client']
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    client: {
      async fetchCheckinStatus() {
        calls.push('status')
        if (options.statusError !== undefined) throw options.statusError
        return {
          active: options.active ?? true,
          todayCheckedIn: options.todayCheckedIn ?? false,
          streakDays: 3,
          dailyCredit: 100,
          todayCredit: 100,
          isStreakDay: false,
          nextStreakDay: 7,
          streakBonusDays: 7,
          streakBonusCredit: 300,
        }
      },
      async claimDailyCheckin() {
        calls.push('claim')
        if (options.claimError !== undefined) throw options.claimError
        return options.claim ?? { credit: 100, streakDays: 4, isStreakDay: false }
      },
      async fetchCredits() {
        calls.push('credits')
        return { total: options.creditTotal ?? 500, capacity: 1000, packages: [], expiringSoon: 0 }
      },
    },
  }
}

/** A pool stub that reports whether it actually unfroze anything. */
function fakePool(unfrozen: boolean): { pool: Parameters<typeof checkinAllAccounts>[0]['pool']; seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    pool: () => ({ reenableIfCredits: (accountId: string) => { seen.push(accountId); return unfrozen } }) as never,
  }
}

describe('isAlreadyCheckedIn', () => {
  it('accepts the markers the upstream uses for a redundant check-in', () => {
    expect(isAlreadyCheckedIn(businessError('今天已签到'))).toBe(true)
    expect(isAlreadyCheckedIn(businessError('今日已签到'))).toBe(true)
    expect(isAlreadyCheckedIn(businessError('already checked in'))).toBe(true)
  })

  it('refuses anything that is not a business answer', () => {
    // This is the whole reason the prefix check exists: a dropped connection also
    // throws, and with the same words it must still be a failure.
    expect(isAlreadyCheckedIn(new Error('fetch failed'))).toBe(false)
    expect(isAlreadyCheckedIn(new Error('今天已签到'))).toBe(false)
    expect(isAlreadyCheckedIn('今天已签到')).toBe(false)
    expect(isAlreadyCheckedIn(undefined)).toBe(false)
  })
})

describe('checkinAllAccounts', () => {
  it('claims the reward, refreshes the balance, and unfreezes', async () => {
    const { client, calls } = fakeClient({ claim: { credit: 120, streakDays: 4, isStreakDay: false } })
    const { pool, seen } = fakePool(true)
    const logs: string[] = []
    const results = await checkinAllAccounts({
      client,
      pool,
      accounts: async () => [{ credential: credential(), accountId: 'pool-key', region: 'cn' }],
      log: message => { logs.push(message) },
    })
    expect(results[0]?.outcome).toBe('claimed')
    expect(results[0]?.credit).toBe(120)
    expect(results[0]?.unfrozen).toBe(true)
    expect(calls).toEqual(['status', 'claim', 'credits'])
    expect(seen).toEqual(['pool-key'])
    expect(logs.join('\n')).toContain('1 签到成功')
    expect(logs.join('\n')).toContain('解冻 1 个账号')
  })

  it('treats an already-done check-in as success, not failure', async () => {
    const { client, calls } = fakeClient({ todayCheckedIn: true })
    const { pool } = fakePool(false)
    const results = await checkinAllAccounts({
      client,
      pool,
      accounts: async () => [{ credential: credential(), accountId: 'pool-key', region: 'cn' }],
      log: () => {},
    })
    expect(results[0]?.outcome).toBe('already')
    // The claim was never sent, because the status already answered.
    expect(calls).toEqual(['status', 'credits'])
  })

  it('treats a redundant claim rejected by business code as success', async () => {
    const { client } = fakeClient({ claimError: businessError('今天已签到') })
    const { pool } = fakePool(false)
    const results = await checkinAllAccounts({
      client,
      pool,
      accounts: async () => [{ credential: credential(), accountId: 'pool-key', region: 'cn' }],
      log: () => {},
    })
    expect(results[0]?.outcome).toBe('already')
  })

  it('reports a network failure as an error, never as already done', async () => {
    const { client } = fakeClient({ statusError: new Error('fetch failed') })
    const { pool } = fakePool(false)
    const results = await checkinAllAccounts({
      client,
      pool,
      accounts: async () => [{ credential: credential(), accountId: 'pool-key', region: 'cn' }],
      log: () => {},
    })
    expect(results[0]?.outcome).toBe('error')
    expect(results[0]?.message).toContain('fetch failed')
  })

  it('still refreshes the balance after a failed claim', async () => {
    // The balance is what decides whether a cooling account comes back, so it
    // must not be skipped just because the claim failed.
    const { client, calls } = fakeClient({ claimError: new Error('boom') })
    const { pool, seen } = fakePool(true)
    await checkinAllAccounts({
      client,
      pool,
      accounts: async () => [{ credential: credential(), accountId: 'pool-key', region: 'cn' }],
      log: () => {},
    })
    expect(calls).toContain('credits')
    expect(seen).toEqual(['pool-key'])
  })

  it('reports unfrozen only when the pool really cleared something', async () => {
    // A funded healthy account is not a recovery; only the pool can tell.
    const { client } = fakeClient()
    const { pool } = fakePool(false)
    const results = await checkinAllAccounts({
      client,
      pool,
      accounts: async () => [{ credential: credential(), accountId: 'pool-key', region: 'cn' }],
      log: () => {},
    })
    expect(results[0]?.outcome).toBe('claimed')
    expect(results[0]?.unfrozen).toBeUndefined()
  })

  it('skips the international gateway without any upstream call', async () => {
    const { client, calls } = fakeClient()
    const { pool } = fakePool(false)
    const results = await checkinAllAccounts({
      client,
      pool,
      accounts: async () => [{ credential: credential({ domain: 'www.workbuddy.ai' }), accountId: 'g', region: 'global' }],
      log: () => {},
    })
    expect(results[0]?.outcome).toBe('inactive')
    expect(results[0]?.message).toContain('国际版')
    expect(calls).toEqual([])
  })

  it('reports an inactive activity instead of claiming', async () => {
    const { client, calls } = fakeClient({ active: false })
    const { pool } = fakePool(false)
    const results = await checkinAllAccounts({
      client,
      pool,
      accounts: async () => [{ credential: credential(), accountId: 'pool-key', region: 'cn' }],
      log: () => {},
    })
    expect(results[0]?.outcome).toBe('inactive')
    expect(calls).not.toContain('claim')
  })

  it('keeps going when one account fails', async () => {
    let seen = 0
    const base = fakeClient()
    const { pool } = fakePool(false)
    const client = {
      ...base.client,
      async fetchCheckinStatus(credential: WorkBuddyCredential) {
        seen += 1
        if (seen === 1) throw new Error('dead credential')
        return base.client.fetchCheckinStatus(credential)
      },
    }
    const results = await checkinAllAccounts({
      client,
      pool,
      accounts: async () => [
        { credential: credential({ uid: 'a' }), accountId: 'a', region: 'cn' },
        { credential: credential({ uid: 'b' }), accountId: 'b', region: 'cn' },
      ],
      log: () => {},
    })
    expect(results[0]?.outcome).toBe('error')
    expect(results[1]?.outcome).toBe('claimed')
  })

  it('never throws when the account list itself fails', async () => {
    // A startup step that can take the plugin down would be a liability.
    const { client } = fakeClient()
    const { pool } = fakePool(false)
    const results = await checkinAllAccounts({
      client,
      pool,
      accounts: async () => { throw new Error('no credential store') },
      log: () => {},
    })
    expect(results).toEqual([])
  })
})
