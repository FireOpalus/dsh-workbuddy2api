/**
 * Host-side heartbeat: a small JSON file written under `$DSH_HOME` once the
 * `workbuddy2api` provider is registered. The status CLI reads it to report
 * whether the host bundle is alive, independent of the browser card.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 心跳机制由其沿用自 corrinehu/dsh-workbuddy-connect（MIT）：浏览器端
 *     无法写文件，其健康只能靠 console.error 上报，因此由宿主写心跳文件，
 *     缺失即代表宿主从未启动；崩溃后的陈旧心跳通过 PID 存活检查识别。
 * 改动：文件名与包名改成本插件；额外记录账号池规模，便于 `status` 直接
 *   报出池子大小。
 *
 * @module dsh-workbuddy2api/host-heartbeat
 */

import { execFileSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { WORKBUDDY2API_VERSION } from './version.ts'

/** Basename of the host heartbeat file inside the Harness home. */
export const WORKBUDDY2API_HOST_HEARTBEAT_FILENAME = '.workbuddy2api-host-heartbeat.json'

/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1

/** The package name recorded in the heartbeat, checked by the reader. */
const PACKAGE_NAME = 'dsh-workbuddy2api'

/** On-disk shape of the heartbeat. */
export interface WorkBuddyHostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION
  package: typeof PACKAGE_NAME
  pluginVersion: string
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number
  /** Accounts the pool held when the heartbeat was written. */
  accounts?: number
}

/** Absolute path of the host heartbeat file. */
export function workbuddyHostHeartbeatPath(): string {
  return join(resolveDshHome(), WORKBUDDY2API_HOST_HEARTBEAT_FILENAME)
}

/**
 * Process start time in epoch milliseconds; undefined when unavailable.
 *
 * POSIX reads `ps -o lstart=`; Windows has no such command, so the creation
 * time is taken from PowerShell's `Get-Process` StartTime, emitted as UTC ISO
 * 8601 so `Date.parse` understands it without locale assumptions.
 */
export function processStartTimeMs(pid: number): number | undefined {
  try {
    const output = process.platform === 'win32'
      ? execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`,
      ], { encoding: 'utf8' })
      : execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
    const parsed = Date.parse(output.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the recorded host process still matches the heartbeat's PID.
 *
 * A PID can be reused after a crash, so the recorded start time is compared
 * against the live process: a different start time means a different process.
 */
export function isHeartbeatProcessAlive(heartbeat: WorkBuddyHostHeartbeat): boolean {
  if (!Number.isInteger(heartbeat.pid) || heartbeat.pid <= 0) return false
  try {
    // Signal 0 probes existence without delivering a signal.
    process.kill(heartbeat.pid, 0)
  } catch {
    return false
  }
  const startedAt = processStartTimeMs(heartbeat.pid)
  if (startedAt === undefined) return true
  // Allow clock skew between the ps timestamp and Date.now().
  return Math.abs(startedAt - heartbeat.registeredAt) < 60_000
}

/** Read the heartbeat; absent or unparsable files report undefined. */
export async function readHostHeartbeat(): Promise<WorkBuddyHostHeartbeat | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(workbuddyHostHeartbeatPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const document = parsed as Record<string, unknown>
    if (document['version'] !== HEARTBEAT_FORMAT_VERSION) return undefined
    if (document['package'] !== PACKAGE_NAME) return undefined
    const pid = document['pid']
    const registeredAt = document['registeredAt']
    if (typeof pid !== 'number' || typeof registeredAt !== 'number') return undefined
    return {
      version: HEARTBEAT_FORMAT_VERSION,
      package: PACKAGE_NAME,
      pluginVersion: typeof document['pluginVersion'] === 'string' ? document['pluginVersion'] : WORKBUDDY2API_VERSION,
      registeredAt,
      pid,
      ...typeof document['accounts'] === 'number' ? { accounts: document['accounts'] } : {},
    }
  } catch {
    return undefined
  }
}

/** Write the heartbeat for the current process. */
export async function writeHostHeartbeat(accounts?: number): Promise<void> {
  const heartbeat: WorkBuddyHostHeartbeat = {
    version: HEARTBEAT_FORMAT_VERSION,
    package: PACKAGE_NAME,
    pluginVersion: WORKBUDDY2API_VERSION,
    registeredAt: Date.now(),
    pid: process.pid,
    ...accounts === undefined ? {} : { accounts },
  }
  await writeFile(workbuddyHostHeartbeatPath(), `${JSON.stringify(heartbeat, null, 2)}\n`, { mode: 0o600 })
}

/** Remove the heartbeat; called when the plugin is disposed. */
export async function clearHostHeartbeat(): Promise<void> {
  await rm(workbuddyHostHeartbeatPath(), { force: true })
}
