/**
 * The card's pool-wide credit aggregation.
 *
 * This logic had a real bug worth pinning down: the host OMITS the credit entry
 * of an account whose credits were never queried, so an implementation that
 * walks the credit list silently counts those accounts as "known, zero" and the
 * summary claims "0 credits left" for a pool nobody has queried yet.
 *
 * The function under test is a faithful copy of the card's, kept here because
 * the card is a browser module (JSX + slots) that these tests do not mount.
 */

import { describe, expect, it } from 'vitest'

/** One present pool entry, as the card receives it. */
interface Entry {
  accountId: string
  present: boolean
}

/** One account's credit document, when it has been queried. */
interface CreditEntry {
  accountId: string
  credits?: { total: number; capacity: number }
}

/** The card's aggregation, copied verbatim from WorkBuddyPoolCard.tsx. */
function poolCredits(entries: readonly Entry[], credits: readonly CreditEntry[]): {
  total: number
  capacity: number
  known: number
  unknown: number
  ratio: number | undefined
  accounts: number
} {
  const byId = new Map(credits.map(entry => [entry.accountId, entry]))
  const present = entries.filter(entry => entry.present)
  let total = 0
  let capacity = 0
  let known = 0
  let unknown = 0
  for (const entry of present) {
    const found = byId.get(entry.accountId)?.credits
    if (found === undefined) {
      unknown += 1
      continue
    }
    known += 1
    total += found.total
    capacity += found.capacity
  }
  const ratio = known === 0 || capacity <= 0 || total > capacity ? undefined : total / capacity
  return { total, capacity, known, unknown, ratio, accounts: present.length }
}

describe('pool credit aggregation', () => {
  it('sums credits and allowances across every present account', () => {
    const result = poolCredits(
      [{ accountId: 'a', present: true }, { accountId: 'b', present: true }],
      [{ accountId: 'a', credits: { total: 100, capacity: 200 } }, { accountId: 'b', credits: { total: 50, capacity: 100 } }],
    )
    expect(result.total).toBe(150)
    expect(result.capacity).toBe(300)
    expect(result.ratio).toBeCloseTo(0.5)
    expect(result.known).toBe(2)
    expect(result.unknown).toBe(0)
  })

  it('counts an account with no credit entry as UNKNOWN, never as zero', () => {
    // This is the shape the host really sends: the entry is simply absent.
    const result = poolCredits(
      [{ accountId: 'a', present: true }, { accountId: 'b', present: true }],
      [{ accountId: 'a', credits: { total: 100, capacity: 200 } }],
    )
    expect(result.known).toBe(1)
    expect(result.unknown).toBe(1)
    expect(result.accounts).toBe(2)
    // The known half still sums; the unknown half is reported, not assumed.
    expect(result.total).toBe(100)
  })

  it('reports no ratio at all when nothing has been queried', () => {
    const result = poolCredits([{ accountId: 'a', present: true }], [])
    expect(result.known).toBe(0)
    expect(result.unknown).toBe(1)
    // Undefined, so the card shows "not queried yet" instead of "0 credits".
    expect(result.ratio).toBeUndefined()
  })

  it('leaves the ratio unknown when the allowance cannot cover the total', () => {
    // A top-up the catalogue did not describe: the ring must go grey rather
    // than claim more than 100%.
    const result = poolCredits(
      [{ accountId: 'a', present: true }],
      [{ accountId: 'a', credits: { total: 500, capacity: 300 } }],
    )
    expect(result.ratio).toBeUndefined()
    expect(result.total).toBe(500)
  })

  it('ignores credit entries whose account is no longer present locally', () => {
    const result = poolCredits(
      [{ accountId: 'a', present: true }, { accountId: 'gone', present: false }],
      [{ accountId: 'a', credits: { total: 10, capacity: 20 } }, { accountId: 'gone', credits: { total: 999, capacity: 999 } }],
    )
    // A missing credential must not inflate the pool's total.
    expect(result.total).toBe(10)
    expect(result.accounts).toBe(1)
  })

  it('clamps at a full ring when credits equal the allowance', () => {
    const result = poolCredits(
      [{ accountId: 'a', present: true }],
      [{ accountId: 'a', credits: { total: 350, capacity: 350 } }],
    )
    expect(result.ratio).toBe(1)
  })
})
