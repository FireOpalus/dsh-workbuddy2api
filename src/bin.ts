#!/usr/bin/env node
/**
 * Standalone status/diagnostics CLI for the dsh-workbuddy2api bundle.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 子命令（`doctor` / `status` / `logout`）、`--json` 输出、
 *     `safeMessage` 脱敏、schemaVersion 字段、以及「宿主心跳 + 桌面端凭据
 *     文件 + 登录态」三项联合诊断的结构，均由该项目沿用自
 *     corrinehu/dsh-workbuddy-connect（MIT）。
 * 改动：诊断对象按区域分开报告 —— 两个区域是两个独立账号池，
 *   `status` / `pool` 分别列出每个池的账号、健康、余额；
 *   `logout` 清除两个区域的全部插件自有凭据副本。
 *
 * @module dsh-workbuddy2api/bin
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthDirs,
  WORKBUDDY_AUTH_FILE_ENV,
  WorkBuddyCredentialStore,
} from './auth.ts'
import { fallbackModelsFor } from './catalog.ts'
import { DEFAULT_WORKBUDDY_POOL_POLICY, WorkBuddyAccountPool } from './pool.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import { WORKBUDDY2API_VERSION } from './version.ts'
import { isHeartbeatProcessAlive, readHostHeartbeat, workbuddyHostHeartbeatPath } from './host-heartbeat.ts'
import { clearPoolState, readPoolState, workbuddyPoolStatePath } from './pool-state.ts'

type Action = 'doctor' | 'logout' | 'pool' | 'status'

const JSON_SCHEMA_VERSION = 1

/** Both regions, in reporting order. */
const REGIONS: readonly WorkBuddyRegion[] = ['cn', 'global']

/** Region labels for human output. */
const REGION_LABELS: Readonly<Record<WorkBuddyRegion, string>> = {
  cn: 'CN (domestic)',
  global: 'Global',
}

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-workbuddy2api <doctor|status|pool|logout> [--json]',
    '',
    '  doctor   secret-free sign-in, credential-path, and host diagnostics',
    '  status   every pooled account per region: health, cooldown, and credit',
    '  pool     each region\'s live pool snapshot (weights, in-flight, failures)',
    '  logout   remove every plugin-owned credential copy (the desktop app keeps its sign-in)',
    '  --json   emit one secret-free JSON document (doctor/status/pool only)',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** A region-scoped store over the real machine's credentials. */
function makeStore(region: WorkBuddyRegion, client: WorkBuddyUpstreamClient): WorkBuddyCredentialStore {
  return new WorkBuddyCredentialStore({
    region,
    refresh: credential => client.refreshToken(credential),
  })
}

async function doctor(jsonOutput: boolean): Promise<number> {
  const client = new WorkBuddyUpstreamClient()
  const anyStore = new WorkBuddyCredentialStore({ refresh: credential => client.refreshToken(credential) })
  const desktopPresent = await anyStore.desktopFilePresent()
  const heartbeat = await readHostHeartbeat()
  const counterDocument = await readPoolState()
  /**
   * What is actually on disk. `readPoolState` answers an EMPTY document for a
   * missing or foreign file, so "present" has to mean "has records", not "the
   * read returned something" — otherwise a fresh install reports its counters as
   * saved when there is no file at all.
   */
  const counterSummary = (): {
    path: string
    present: boolean
    accounts: { accountId: string; successes: number; failures: number; credits?: number; creditsAt?: string }[]
  } => {
    const records = Object.values(counterDocument.regions).flatMap(entries => entries ?? [])
    return {
      path: workbuddyPoolStatePath(),
      present: records.length > 0,
      accounts: records.map(record => ({
        accountId: record.accountId,
        successes: record.successes ?? 0,
        failures: record.failures ?? 0,
        ...record.credits === undefined ? {} : { credits: record.credits },
        ...record.creditsAtMs === undefined ? {} : { creditsAt: new Date(record.creditsAtMs).toISOString() },
      })),
    }
  }
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const regionLists = await Promise.all(REGIONS.map(async region => {
    try {
      return { region, accounts: await makeStore(region, client).accounts(), error: undefined }
    } catch (error: unknown) {
      return { region, accounts: [], error: safeMessage(error) }
    }
  }))
  const totalAccounts = regionLists.reduce((sum, entry) => sum + entry.accounts.length, 0)
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-workbuddy2api',
    version: WORKBUDDY2API_VERSION,
    node: process.version,
    desktopAuthFile: {
      path: anyStore.desktopAuthPath() ?? '(no platform default; set WORKBUDDY_AUTH_FILE)',
      dir: defaultDesktopAuthDirs()[0] ?? '(no platform default)',
      candidates: defaultDesktopAuthCandidates(),
      present: desktopPresent,
    },
    providerRoutes: { cn: 'workbuddy2api', global: 'workbuddy2api-global' },
    hostHeartbeat: {
      path: workbuddyHostHeartbeatPath(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      ...heartbeat?.accounts === undefined ? {} : { accounts: heartbeat.accounts },
      processAlive: hostAlive,
    },
    regions: Object.fromEntries(regionLists.map(({ region, accounts, error }) => [region, {
      accounts: accounts.map(account => ({
        id: account.id,
        accountName: account.accountName,
        domain: account.domain === '' ? undefined : account.domain,
        source: account.source,
        tokenExpiresAt: new Date(account.tokenExpiresAtMs).toISOString(),
      })),
      ...error === undefined ? {} : { error },
      fallbackModels: fallbackModelsFor(region).length,
    }])),
    poolPolicy: DEFAULT_WORKBUDDY_POOL_POLICY,
    // The durable counters live in their own file; report whether it is there so
    // "my counters reset" is answerable without guessing.
    poolCounters: counterSummary(),
    hints: [
      ...totalAccounts > 0 ? [] : ['Sign in once in the WorkBuddy desktop app (either region), then run status again.'],
      ...desktopPresent ? [] : [`No WorkBuddy desktop auth file at the expected path; set ${WORKBUDDY_AUTH_FILE_ENV} if it lives elsewhere.`],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card and providers are unavailable until DSH starts the plugin.'],
    ],
  }
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `WorkBuddy2API ${WORKBUDDY2API_VERSION} on ${process.version}`,
      `Desktop auth file: ${desktopPresent ? 'present' : 'missing'} (${report.desktopAuthFile.path})`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat?.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      `Account counters: ${report.poolCounters.present ? `saved for ${report.poolCounters.accounts.length} account(s)` : 'none saved yet'} (${report.poolCounters.path})`,
      ...regionLists.flatMap(({ region, accounts, error }) => [
        `${REGION_LABELS[region]} — provider ${region === 'global' ? 'workbuddy2api-global' : 'workbuddy2api'}: ${accounts.length} account(s)`,
        ...error === undefined ? [] : [`  scan error: ${error}`],
        ...accounts.map(account => `  - ${account.accountName} (${account.id})${account.domain === '' ? '' : ` · ${account.domain}`} expires ${new Date(account.tokenExpiresAtMs).toISOString()}`),
      ]),
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return totalAccounts > 0 && desktopPresent ? 0 : 1
}

/** One region's pool plus its per-account credit probe. */
async function regionStatus(region: WorkBuddyRegion, client: WorkBuddyUpstreamClient): Promise<{
  region: WorkBuddyRegion
  provider: string
  entries: Awaited<ReturnType<WorkBuddyAccountPool['snapshot']>>
  credits: { accountId: string; total?: number; expiringSoon?: number; error?: string }[]
}> {
  const store = makeStore(region, client)
  const pool = new WorkBuddyAccountPool({ list: () => store.accounts() })
  await pool.refresh()
  const entries = pool.snapshot()
  const credits = await Promise.all(entries.map(async (entry) => {
    if (!entry.present) return { accountId: entry.accountId, error: 'credential file missing' }
    try {
      const credential = await store.resolve(entry.accountId)
      const answer = await client.fetchCredits(credential)
      pool.setCredits(entry.accountId, { total: answer.total, expiringSoon: answer.expiringSoon })
      return { accountId: entry.accountId, total: answer.total, expiringSoon: answer.expiringSoon }
    } catch (error: unknown) {
      return { accountId: entry.accountId, error: safeMessage(error) }
    }
  }))
  pool.dispose()
  return {
    region,
    provider: region === 'global' ? 'workbuddy2api-global' : 'workbuddy2api',
    entries: entries.map((entry, index) => ({ ...entry, ...credits[index] })),
    credits,
  }
}

async function status(jsonOutput: boolean): Promise<number> {
  const client = new WorkBuddyUpstreamClient()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const hostState = hostAlive ? 'running' : heartbeat !== undefined ? 'stale' : 'not-started'
  const fragments = await Promise.all(REGIONS.map(region => regionStatus(region, client)))
  const signedIn = fragments.some(fragment => fragment.entries.some(entry => entry.present && entry.enabled))
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-workbuddy2api',
      version: WORKBUDDY2API_VERSION,
      regions: Object.fromEntries(fragments.map(fragment => [fragment.region, fragment])),
      hostBundle: hostState,
    })
  } else {
    process.stdout.write([
      ...fragments.flatMap(fragment => [
        `${REGION_LABELS[fragment.region]} — provider ${fragment.provider}: ${fragment.entries.length} account(s)`,
        ...fragment.entries.flatMap(entry => [
          `  ${entry.accountName} (${entry.accountId}) — ${entry.state}${entry.enabled ? '' : ' / disabled'}`,
          ...entry.cooldownUntil === undefined ? [] : [`    cooldown(${entry.cooldownKind ?? 'soft'}) until ${new Date(entry.cooldownUntil).toISOString()}`],
          ...entry.breakerUntil === undefined ? [] : [`    breaker until ${new Date(entry.breakerUntil).toISOString()}`],
          ...entry.degradedUntil === undefined ? [] : [`    degraded until ${new Date(entry.degradedUntil).toISOString()}`],
          `    ok ${entry.successes} / failed ${entry.failures} / in-flight ${entry.inFlight}`,
        ]),
        ...fragment.credits.flatMap(probe => probe.error === undefined
          ? [`  credit ${probe.accountId.slice(0, 8)}…: ${probe.total}${probe.expiringSoon === undefined || probe.expiringSoon === 0 ? '' : ` (expiring soon ${probe.expiringSoon})`}`]
          : [`  credit ${probe.accountId.slice(0, 8)}…: unavailable (${probe.error})`]),
      ]),
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat?.pid})` : hostState === 'stale' ? 'stale heartbeat (DSH process exited)' : 'not started in this profile'}`,
      'Client card: load failures are logged to the browser console only; the host providers are unaffected.',
      '',
    ].join('\n'))
  }
  return signedIn ? 0 : 1
}

/** Print each region's live pool snapshot without touching the network. */
async function poolStatus(jsonOutput: boolean): Promise<number> {
  const client = new WorkBuddyUpstreamClient()
  const fragments = await Promise.all(REGIONS.map(async region => {
    const store = makeStore(region, client)
    const pool = new WorkBuddyAccountPool({ list: () => store.accounts() })
    await pool.refresh()
    const snapshot = { region, entries: pool.snapshot(), policy: pool.currentPolicy(), sticky: pool.stickySize() }
    pool.dispose()
    return snapshot
  }))
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-workbuddy2api',
      version: WORKBUDDY2API_VERSION,
      regions: Object.fromEntries(fragments.map(fragment => [fragment.region, fragment])),
    })
  } else {
    process.stdout.write([
      ...fragments.flatMap(fragment => [
        `${REGION_LABELS[fragment.region]} — provider ${fragment.region === 'global' ? 'workbuddy2api-global' : 'workbuddy2api'}`,
        ...fragment.entries.length === 0 ? ['  (no accounts in this region)'] : [],
        ...fragment.entries.flatMap(entry => [
          `  ${entry.accountName} (${entry.accountId}) — ${entry.state}`,
          `    weight ${entry.weight} · priority ${entry.priority} · in-flight ${entry.inFlight}`,
          `    ok ${entry.successes} / failed ${entry.failures} / consecutive ${entry.consecutiveFailures} / cooldowns ${entry.cooldownCount}`,
          ...entry.credits === undefined ? [] : [`    credits ${entry.credits}`],
        ]),
        `  policy: in-flight ${fragment.policy.maxInFlightPerAccount}/account (global cap ${fragment.policy.maxInFlightGlobalPerAccount}), total ${fragment.policy.maxInFlightTotal}`,
        `  sticky bindings: ${fragment.sticky} (ttl ${fragment.policy.stickyTtlMs}ms)`,
      ]),
      '',
    ].join('\n'))
  }
  return 0
}

/** Execute one boot-free command. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  const actions: readonly Action[] = ['doctor', 'logout', 'pool', 'status']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-workbuddy2api: expected doctor, logout, pool, or status; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')
  const unknown = flags.filter(flag => flag !== '--json')
  if (unknown.length > 0 || (jsonOutput && action === 'logout')) {
    process.stderr.write(`dsh-workbuddy2api: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  try {
    switch (action) {
      case 'doctor':
        return await doctor(jsonOutput)
      case 'status':
        return await status(jsonOutput)
      case 'pool':
        return await poolStatus(jsonOutput)
      case 'logout': {
        // Both regions write per-account copies into the same store directory,
        // so logout must sweep it once per region to cover every account.
        const client = new WorkBuddyUpstreamClient()
        for (const region of REGIONS) await makeStore(region, client).logout()
        // The counters describe credentials that were just forgotten; keeping
        // them would attach a new account's history to a re-used account id.
        await clearPoolState()
        process.stdout.write('WorkBuddy2API: removed the plugin-owned per-account credential copies and their account counters for both regions; the desktop app\'s sign-ins are untouched\n')
        return 0
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-workbuddy2api: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
