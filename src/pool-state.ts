/**
 * Durable account-pool counters: dispatch totals, last-used/error marks, and the
 * cached credit figures.
 *
 * Why this exists as its own file rather than DSH settings: these are RUNTIME
 * facts the host produces on its own (every dispatch updates them), while the
 * settings namespace is the user's configuration, written by the card under
 * revision checks. Writing counters into settings would make the host and the
 * card fight over one document — and a card save would clobber whatever the host
 * had just recorded.
 *
 * What is deliberately NOT persisted: `inFlight`. After a restart there are no
 * requests in flight, so restoring a count nothing will ever release would
 * permanently consume that account's concurrency slot. The other counters are
 * cumulative and therefore meaningful across restarts.
 *
 * @module dsh-workbuddy2api/pool-state
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyRegion } from './upstream.ts'

/** Basename of the counter file inside the Harness home. */
export const WORKBUDDY2API_POOL_STATE_FILENAME = '.workbuddy2api-pool-state.json'

/** Current on-disk format; readers reject others. */
export const WORKBUDDY2API_POOL_STATE_VERSION = 1

/**
 * One account's durable counters. Every field is optional on read so an older or
 * partial file still loads, and absent means "unknown" rather than zero.
 */
export interface WorkBuddyPoolCounterRecord {
  accountId: string
  /** Dispatches that completed successfully, lifetime. */
  successes?: number
  /** Dispatches that failed, lifetime. */
  failures?: number
  /** Monotonic per-account dispatch counter, the LRU tie-breaker. */
  usedSeq?: number
  lastUsedAt?: number
  lastSuccessAt?: number
  lastErrorAt?: number
  lastError?: string
  /** Cached remaining credits and the allowance they are measured against. */
  credits?: number
  creditsExpiringSoon?: number
  creditsCapacity?: number
  /** When the cached credits were read, so the card can show their age. */
  creditsAtMs?: number
  /** Escalation state, so a backoff resumes instead of restarting. */
  softStreak?: number
  breakerFails?: number
  breakerTrips?: number
  consecutiveFails?: number
}

/** The whole file: counters per region, keyed by account id. */
export interface WorkBuddyPoolStateDocument {
  version: typeof WORKBUDDY2API_POOL_STATE_VERSION
  regions: Partial<Record<WorkBuddyRegion, WorkBuddyPoolCounterRecord[]>>
}

/** Absolute path of the counter file. */
export function workbuddyPoolStatePath(storeDir: string = resolveDshHome()): string {
  return join(storeDir, WORKBUDDY2API_POOL_STATE_FILENAME)
}

/** A finite, non-negative number, or undefined. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** An optional non-empty string. */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Parse one counter record, keeping only fields that carry a real value. */
export function parsePoolCounterRecord(value: unknown): WorkBuddyPoolCounterRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const accountId = typeof raw['accountId'] === 'string' ? raw['accountId'] : ''
  if (accountId === '') return undefined
  const lastError = optionalText(raw['lastError'])
  return {
    accountId,
    ...finiteNumber(raw['successes']) === undefined ? {} : { successes: finiteNumber(raw['successes']) as number },
    ...finiteNumber(raw['failures']) === undefined ? {} : { failures: finiteNumber(raw['failures']) as number },
    ...finiteNumber(raw['usedSeq']) === undefined ? {} : { usedSeq: finiteNumber(raw['usedSeq']) as number },
    ...finiteNumber(raw['lastUsedAt']) === undefined ? {} : { lastUsedAt: finiteNumber(raw['lastUsedAt']) as number },
    ...finiteNumber(raw['lastSuccessAt']) === undefined ? {} : { lastSuccessAt: finiteNumber(raw['lastSuccessAt']) as number },
    ...finiteNumber(raw['lastErrorAt']) === undefined ? {} : { lastErrorAt: finiteNumber(raw['lastErrorAt']) as number },
    ...lastError === undefined ? {} : { lastError },
    ...finiteNumber(raw['credits']) === undefined ? {} : { credits: finiteNumber(raw['credits']) as number },
    ...finiteNumber(raw['creditsExpiringSoon']) === undefined
      ? {}
      : { creditsExpiringSoon: finiteNumber(raw['creditsExpiringSoon']) as number },
    ...finiteNumber(raw['creditsCapacity']) === undefined
      ? {}
      : { creditsCapacity: finiteNumber(raw['creditsCapacity']) as number },
    ...finiteNumber(raw['creditsAtMs']) === undefined ? {} : { creditsAtMs: finiteNumber(raw['creditsAtMs']) as number },
    ...finiteNumber(raw['softStreak']) === undefined ? {} : { softStreak: finiteNumber(raw['softStreak']) as number },
    ...finiteNumber(raw['breakerFails']) === undefined ? {} : { breakerFails: finiteNumber(raw['breakerFails']) as number },
    ...finiteNumber(raw['breakerTrips']) === undefined ? {} : { breakerTrips: finiteNumber(raw['breakerTrips']) as number },
    ...finiteNumber(raw['consecutiveFails']) === undefined
      ? {}
      : { consecutiveFails: finiteNumber(raw['consecutiveFails']) as number },
  }
}

/** Read the counter document; absent, unreadable, or malformed reads as empty. */
export async function readPoolState(
  storeDir: string = resolveDshHome(),
): Promise<WorkBuddyPoolStateDocument> {
  const empty: WorkBuddyPoolStateDocument = { version: WORKBUDDY2API_POOL_STATE_VERSION, regions: {} }
  let text: string
  try {
    text = await readFile(workbuddyPoolStatePath(storeDir), 'utf8')
  } catch {
    return empty
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return empty
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty
  const document = parsed as Record<string, unknown>
  if (document['version'] !== WORKBUDDY2API_POOL_STATE_VERSION) return empty
  const regions = typeof document['regions'] === 'object' && document['regions'] !== null
    ? document['regions'] as Record<string, unknown>
    : {}
  const out: WorkBuddyPoolStateDocument = { version: WORKBUDDY2API_POOL_STATE_VERSION, regions: {} }
  for (const region of ['cn', 'global'] as const) {
    const list = regions[region]
    if (!Array.isArray(list)) continue
    const records: WorkBuddyPoolCounterRecord[] = []
    for (const entry of list) {
      const record = parsePoolCounterRecord(entry)
      if (record !== undefined) records.push(record)
    }
    if (records.length > 0) out.regions[region] = records
  }
  return out
}

/** Write the counter document atomically. */
export async function writePoolState(
  document: WorkBuddyPoolStateDocument,
  storeDir: string = resolveDshHome(),
): Promise<void> {
  await writeFileAtomic(workbuddyPoolStatePath(storeDir), JSON.stringify(document, null, 2) + '\n', {
    mode: 0o600,
    dirMode: 0o700,
  })
}

/** Remove the counter file; used when the user forgets stored credentials. */
export async function clearPoolState(storeDir: string = resolveDshHome()): Promise<void> {
  await rm(workbuddyPoolStatePath(storeDir), { force: true })
  await rm(workbuddyPoolStatePath(storeDir) + '.lock', { force: true })
}
