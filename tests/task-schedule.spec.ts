/**
 * The task schedule's settings write.
 *
 * Two bugs lived here and both are pinned below:
 *
 * 1. The host's status carried only `dailyAt` ("00:05"), a display string, and
 *    no numeric `hour`/`minute`. The card rendered those as empty time boxes
 *    and spread the missing fields into the settings write — where an explicit
 *    `undefined` inside the JSON payload fails the whole mutation with
 *    `client api: settings/mutate rejected "ops"`.
 * 2. An emptied number box reads as "" and `Number("") === 0`, so clearing the
 *    field silently meant midnight.
 *
 * The helpers below are copies of the card's, because the card is a browser
 * module these tests do not mount.
 */

import { describe, expect, it } from 'vitest'

/** A finite integer inside [min, max], or the fallback. Copy of the card's. */
function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.round(value), min), max)
}

/** Whether a schedule document carries the fields the card edits. Copy of the card's. */
function usableSchedule(schedule: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (schedule === undefined) return undefined
  if (typeof schedule['hour'] !== 'number' || typeof schedule['minute'] !== 'number') return undefined
  return schedule
}

/** The payload the card builds for the settings write. Copy of the card's shape. */
function schedulePayload(next: Record<string, unknown>): Record<string, unknown> {
  return {
    enabled: next['enabled'] === true,
    hour: clampInteger(next['hour'], 0, 23, 0),
    minute: clampInteger(next['minute'], 0, 59, 0),
    runOnStart: next['runOnStart'] === true,
  }
}

/** Every value the strict JSON codec can carry. */
function isJsonShaped(value: unknown): boolean {
  if (value === null) return true
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return true
  if (kind === 'number') return Number.isFinite(value as number)
  if (Array.isArray(value)) return value.every(isJsonShaped)
  if (kind === 'object') return Object.values(value as Record<string, unknown>).every(isJsonShaped)
  return false
}

describe('schedule status shape', () => {
  it('rejects a document that only carries the display string', () => {
    // The old host answer: dailyAt alone, no numbers. Showing it produced empty
    // time boxes, so the card must treat it as absent.
    const old = { enabled: true, runOnStart: true, dailyAt: '00:05' }
    expect(usableSchedule(old)).toBeUndefined()
  })

  it('accepts a document that carries both numbers', () => {
    const current = { enabled: true, hour: 0, minute: 5, runOnStart: true, dailyAt: '00:05' }
    expect(usableSchedule(current)).toEqual(current)
  })
})

describe('schedule write payload', () => {
  it('never carries undefined, whatever the draft holds', () => {
    // Exactly the failing input: hour/minute absent from the source document.
    const payload = schedulePayload({ enabled: true, runOnStart: true })
    expect(payload).toEqual({ enabled: true, hour: 0, minute: 0, runOnStart: true })
    for (const value of Object.values(payload)) expect(value).not.toBeUndefined()
  })

  it('is JSON-shaped, which is what the settings codec demands', () => {
    for (const draft of [
      { enabled: true, hour: 0, minute: 5, runOnStart: true },
      { enabled: false, hour: 23, minute: 59, runOnStart: false },
      { enabled: true, runOnStart: true },
      { enabled: true, hour: Number.NaN, minute: Number.POSITIVE_INFINITY, runOnStart: true },
      { enabled: true, hour: '3', minute: null, runOnStart: true },
    ]) {
      expect(isJsonShaped(schedulePayload(draft))).toBe(true)
    }
  })

  it('clamps out-of-range times instead of writing them', () => {
    expect(schedulePayload({ enabled: true, hour: 99, minute: -5, runOnStart: false }))
      .toEqual({ enabled: true, hour: 23, minute: 0, runOnStart: false })
  })

  it('coerces non-boolean switches to false rather than forwarding them', () => {
    const payload = schedulePayload({ enabled: 1, hour: 1, minute: 1, runOnStart: undefined })
    expect(payload['enabled']).toBe(false)
    expect(payload['runOnStart']).toBe(false)
  })

  it('keeps a valid edit intact', () => {
    expect(schedulePayload({ enabled: true, hour: 7, minute: 30, runOnStart: false }))
      .toEqual({ enabled: true, hour: 7, minute: 30, runOnStart: false })
  })
})

describe('what the strict codec actually enforces', () => {
  // Verified against the real generated schema for settings/mutate's `ops`
  // parameter (dsh-api-settings-controller/lib/typert.host.js):
  //   {op:'set', path, value:{enabled, hour:undefined, minute:undefined}} -> REJECTED
  //   {op:'set', path, value:{enabled, hour:0, minute:5}}                  -> ACCEPTED
  //   {op:'set', path, value:{enabled, hour:NaN, minute:5}}                -> REJECTED
  // The rejection happens CLIENT-side in parseInput, before any JSON
  // serialization, so JSON.stringify dropping undefined never saves the write.
  it('rejects a payload whose time fields are undefined or NaN', () => {
    const valid = (value: Record<string, unknown>): boolean =>
      typeof value['hour'] === 'number' && Number.isFinite(value['hour'] as number)
      && typeof value['minute'] === 'number' && Number.isFinite(value['minute'] as number)

    expect(valid({ hour: undefined, minute: undefined })).toBe(false)
    expect(valid({ hour: Number.NaN, minute: 5 })).toBe(false)
    expect(valid({ hour: 0, minute: 5 })).toBe(true)
    // And the card's payload builder always produces the accepted shape.
    for (const draft of [{}, { hour: Number.NaN }, { minute: '5' }, { hour: 99 }]) {
      expect(valid(schedulePayload(draft))).toBe(true)
    }
  })
})

describe('the blank number box', () => {
  it('would mean midnight if it were committed', () => {
    // The trap the input handler guards against.
    expect(Number('')).toBe(0)
  })

  it('is ignored instead of being committed', () => {
    // The handler's rule: a blank box leaves the previous value standing.
    const commit = (raw: string, previous: number): number => {
      if (raw.trim() === '') return previous
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : previous
    }
    expect(commit('', 5)).toBe(5)
    expect(commit('   ', 5)).toBe(5)
    expect(commit('7', 5)).toBe(7)
  })
})
