#!/usr/bin/env node
/**
 * Standalone status/diagnostics CLI for the dsh-workbuddy2api bundle.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 子命令（`doctor` / `status` / `logout`）、`--json` 输出、
 *     `safeMessage` 脱敏、schemaVersion 字段、以及「宿主心跳 + 桌面端凭据
 *     文件 + 登录态」三项联合诊断的结构，均由该项目沿用自
 *     corrinehu/dsh-workbuddy-connect（MIT）。
 * 改动：诊断对象从「每个区域一个账号」改为「账号池」，`status` 报告每个
 *   账号的健康、冷却与余额；新增 `pool` 子命令直接打印池快照（含权重、
 *   在途、连续失败、冷却截止），无需浏览器即可确认多账号调度状态。
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
import { FALLBACK_WORKBUDDY_MODELS_UNION } from './catalog.ts'
import { DEFAULT_WORKBUDDY_POOL_POLICY, WorkBuddyAccountPool } from './pool.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { WORKBUDDY2API_VERSION } from './version.ts'
import { isHeartbeatProcessAlive, readHostHeartbeat, workbuddyHostHeartbeatPath } from './host-heartbeat.ts'

type Action = 'doctor' | 'logout' | 'pool' | 'status'

const JSON_SCHEMA_VERSION = 1

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
    '  status   every pooled account: health, cooldown, and remaining credit',
    '  pool     the live pool snapshot (weights, in-flight, failures, cooldowns)',
    '  logout   remove every plugin-owned credential copy (the desktop app keeps its sign-in)',
    '  --json   emit one secret-free JSON document (doctor/status/pool only)',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** A store plus a pool over the real machine's credentials. */
function makePool(): { store: WorkBuddyCredentialStore; pool: WorkBuddyAccountPool; client: WorkBuddyUpstreamClient } {
  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyCredentialStore({ refresh: credential => client.refreshToken(credential) })
  const pool = new WorkBuddyAccountPool({ list: () => store.accounts() })
  return { store, pool, client }
}

async function doctor(jsonOutput: boolean): Promise<number> {
  const { store, pool } = makePool()
  const desktopPresent = await store.desktopFilePresent()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  let accounts: Awaited<ReturnType<WorkBuddyCredentialStore['accounts']>> = []
  let scanError: string | undefined
  try {
    accounts = await store.accounts()
  } catch (error: unknown) {
    scanError = safeMessage(error)
  }
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-workbuddy2api',
    version: WORKBUDDY2API_VERSION,
    node: process.version,
    desktopAuthFile: {
      path: store.desktopAuthPath() ?? '(no platform default; set WORKBUDDY_AUTH_FILE)',
      dir: defaultDesktopAuthDirs()[0] ?? '(no platform default)',
      candidates: defaultDesktopAuthCandidates(),
      present: desktopPresent,
    },
    hostHeartbeat: {
      path: workbuddyHostHeartbeatPath(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      ...heartbeat?.accounts === undefined ? {} : { accounts: heartbeat.accounts },
      processAlive: hostAlive,
    },
    accounts: accounts.map(account => ({
      id: account.id,
      accountName: account.accountName,
      region: account.region,
      domain: account.domain === '' ? undefined : account.domain,
      source: account.source,
      tokenExpiresAt: new Date(account.tokenExpiresAtMs).toISOString(),
    })),
    ...scanError === undefined ? {} : { scanError },
    fallbackModels: FALLBACK_WORKBUDDY_MODELS_UNION.length,
    poolPolicy: DEFAULT_WORKBUDDY_POOL_POLICY,
    hints: [
      ...accounts.length > 0 ? [] : ['Sign in once in the WorkBuddy desktop app, then run status again.'],
      ...desktopPresent ? [] : [`No WorkBuddy desktop auth file at the expected path; set ${WORKBUDDY_AUTH_FILE_ENV} if it lives elsewhere.`],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin.'],
    ],
  }
  void pool
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `WorkBuddy2API ${WORKBUDDY2API_VERSION} on ${process.version}`,
      `Desktop auth file: ${report.desktopAuthFile.present ? 'present' : 'missing'} (${report.desktopAuthFile.path})`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat?.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      `Local accounts: ${accounts.length}`,
      ...accounts.map(account => `  - ${account.accountName} (${account.id}, ${account.region})${account.domain === '' ? '' : ` · ${account.domain}`} expires ${new Date(account.tokenExpiresAtMs).toISOString()}`),
      `Static fallback models: ${report.fallbackModels}`,
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return accounts.length > 0 && desktopPresent ? 0 : 1
}

/** Refresh the pool from disk and report every account. */
async function status(jsonOutput: boolean): Promise<number> {
  const { store, pool, client } = makePool()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const hostState = hostAlive ? 'running' : heartbeat !== undefined ? 'stale' : 'not-started'
  await pool.refresh()
  const entries = pool.snapshot()
  interface CreditProbe {
    credits?: number
    expiringSoon?: number
    error?: string
  }
  const credits = await Promise.all(entries.map(async (entry): Promise<CreditProbe> => {
    if (!entry.present) return { error: 'credential file missing' }
    try {
      const credential = await store.resolve(entry.accountId)
      const answer = await client.fetchCredits(credential)
      pool.setCredits(entry.accountId, { total: answer.total, expiringSoon: answer.expiringSoon })
      return { credits: answer.total, expiringSoon: answer.expiringSoon }
    } catch (error: unknown) {
      return { error: safeMessage(error) }
    }
  }))
  const merged = entries.map((entry, index) => ({ ...entry, ...credits[index] as CreditProbe }))
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-workbuddy2api',
      version: WORKBUDDY2API_VERSION,
      accounts: merged,
      hostBundle: hostState,
    })
  } else {
    process.stdout.write([
      ...merged.flatMap(entry => [
        `${entry.accountName} (${entry.accountId}, ${entry.region}) — ${entry.state}${entry.enabled ? '' : ' / disabled'}`,
        ...entry.cooldownUntil === undefined ? [] : [`  cooldown(${entry.cooldownKind ?? 'soft'}) until ${new Date(entry.cooldownUntil).toISOString()}`],
        ...entry.breakerUntil === undefined ? [] : [`  breaker until ${new Date(entry.breakerUntil).toISOString()}`],
        ...entry.degradedUntil === undefined ? [] : [`  degraded until ${new Date(entry.degradedUntil).toISOString()}`],
        `  ok ${entry.successes} / failed ${entry.failures} / in-flight ${entry.inFlight}`,
        ...entry.credits === undefined
          ? entry.error === undefined ? [] : [`  credit: unavailable (${entry.error})`]
          : [`  credit: ${entry.credits}${entry.creditsExpiringSoon === undefined || entry.creditsExpiringSoon === 0 ? '' : ` (expiring soon ${entry.creditsExpiringSoon})`}`],
        ...entry.lastError === undefined ? [] : [`  last error: ${entry.lastError}`],
      ]),
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat?.pid})` : hostState === 'stale' ? 'stale heartbeat (DSH process exited)' : 'not started in this profile'}`,
      'Client card: load failures are logged to the browser console only; the host provider is unaffected.',
      '',
    ].join('\n'))
  }
  return entries.some(entry => entry.present && entry.enabled) ? 0 : 1
}

/** Print the live pool snapshot without touching the network. */
async function poolStatus(jsonOutput: boolean): Promise<number> {
  const { pool } = makePool()
  await pool.refresh()
  const entries = pool.snapshot()
  const policy = pool.currentPolicy()
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-workbuddy2api',
      version: WORKBUDDY2API_VERSION,
      entries,
      policy,
      stickyBindings: pool.stickySize(),
    })
  } else {
    process.stdout.write([
      ...entries.map(entry => [
        `${entry.accountName} (${entry.accountId}, ${entry.region}) — ${entry.state}`,
        `  weight ${entry.weight} · priority ${entry.priority} · in-flight ${entry.inFlight}`,
        `  ok ${entry.successes} / failed ${entry.failures} / consecutive ${entry.consecutiveFailures} / cooldowns ${entry.cooldownCount}`,
        ...entry.credits === undefined ? [] : [`  credits ${entry.credits}`],
        ...entry.lastUsedAt === undefined ? [] : [`  last used ${new Date(entry.lastUsedAt).toISOString()}`],
      ].join('\n')),
      `Policy: in-flight ${policy.maxInFlightPerAccount}/account (global ${policy.maxInFlightGlobalPerAccount}), total ${policy.maxInFlightTotal}; breaker ${policy.breakerThreshold} failures → ${policy.breakerCooldownMs}ms (max ${policy.breakerCooldownMaxMs}ms); soft cooldown ${policy.softRateCooldownMs}ms (max ${policy.softRateCooldownMaxMs}ms)`,
      `Sticky bindings: ${pool.stickySize()} (ttl ${policy.stickyTtlMs}ms)`,
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
        const { store } = makePool()
        await store.logout()
        process.stdout.write('WorkBuddy2API: removed the plugin-owned per-account credential copies; the desktop app\'s sign-ins are untouched\n')
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
