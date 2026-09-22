/**
 * Check every account in once, at DSH startup.
 *
 * The reward is small; what makes this worth doing is the side effect. An account
 * parked in a cooldown because it ran out of credits is unfrozen by its own
 * check-in, so starting DSH quietly returns starved accounts to service instead
 * of leaving them idle until a human notices.
 *
 * 参考：Sliverkiss/workbuddy2api（MIT）— 语义对齐其
 *   `internal/scheduler/scheduler.go` 的 `RunCheckinNow`：
 *     1. 先查签到状态，已签到就跳过（幂等，不重复打上游）；
 *     2. 签到后再查一次余额，余额回来就解冻该账号；
 *     3. 「今天已签到」是**幂等成功**（上游对重复签到返回非 0 业务码），
 *        不当失败；网络错误则**必须**当失败，否则一次抖动会被记成已签到；
 *     4. 解冻只清**冷却域**、不清熔断（签到证明计费通道正常，不证明对话通道）；
 *     5. global 账号没有签到体系，**不发任何上游调用**。
 *
 * @module dsh-workbuddy2api/startup-checkin
 */

import type { WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyAccountPool } from './pool.ts'
import type { WorkBuddyRegion, WorkBuddyUpstreamClient } from './upstream.ts'

/**
 * Markers the upstream uses for "this account already checked in today". They
 * arrive as a non-zero business code, i.e. as an error-shaped success.
 */
const ALREADY_MARKERS: readonly string[] = ['已签到', 'already']

/** The prefix every business-envelope failure carries (see upstream.ts). */
const BUSINESS_ERROR_PREFIX = 'workbuddy upstream '

/**
 * Whether a failure means today's check-in was already done.
 *
 * Two conditions, both required:
 *   - the gateway ANSWERED with a business envelope, so a dropped connection —
 *     which also throws — can never be mistaken for a completed check-in;
 *   - the message names the redundant check-in.
 */
export function isAlreadyCheckedIn(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (!error.message.startsWith(BUSINESS_ERROR_PREFIX)) return false
  const lower = error.message.toLowerCase()
  return ALREADY_MARKERS.some(marker => error.message.includes(marker) || lower.includes(marker.toLowerCase()))
}

/** One account's outcome. */
export interface WorkBuddyCheckinResult {
  accountId: string
  accountName: string
  outcome: 'claimed' | 'already' | 'inactive' | 'error'
  message: string
  /** Credits granted by this run, when it claimed the reward. */
  credit?: number
  /** Whether the balance refresh actually unfroze the account. */
  unfrozen?: boolean
}

/**
 * Check in every configured account once.
 *
 * Never throws: a startup step that can take the whole plugin down would turn a
 * nice-to-have into a liability, so every failure is reported in the results.
 */
export async function checkinAllAccounts(options: {
  client: Pick<WorkBuddyUpstreamClient, 'fetchCheckinStatus' | 'claimDailyCheckin' | 'fetchCredits'>
  /** Region-scoped pools, so an account is unfrozen in the pool that owns it. */
  pool(region: WorkBuddyRegion): WorkBuddyAccountPool
  /**
   * The accounts to visit, each with the region that owns it.
   *
   * `accountId` is the POOL's key (derived from `uin`), which is deliberately
   * not the same string as `credential.uid` (the upstream's own id). Passing the
   * wrong one silently misses the entry, so the caller supplies it explicitly.
   */
  accounts(): Promise<readonly {
    credential: WorkBuddyCredential
    accountId: string
    region: WorkBuddyRegion
  }[]>
  log(message: string): void
}): Promise<readonly WorkBuddyCheckinResult[]> {
  const results: WorkBuddyCheckinResult[] = []
  let accounts: readonly { credential: WorkBuddyCredential; accountId: string; region: WorkBuddyRegion }[] = []
  try {
    accounts = await options.accounts()
  } catch (error: unknown) {
    options.log('checkin at startup: 账号列表读取失败 ' + (error instanceof Error ? error.message : String(error)))
    return results
  }
  for (const account of accounts) {
    const credential = account.credential
    const name = credential.nickname ?? credential.uin ?? credential.uid
    const base = { accountId: account.accountId, accountName: name }
    // The international gateway has no check-in system, so it is skipped WITHOUT
    // any upstream call: the request would only 404 and add noise to the logs.
    if (account.region !== 'cn') {
      results.push({ ...base, outcome: 'inactive', message: '国际版没有签到体系' })
      continue
    }
    let outcome: WorkBuddyCheckinResult['outcome'] = 'claimed'
    let message = '签到成功'
    let credit: number | undefined
    try {
      const status = await options.client.fetchCheckinStatus(credential)
      if (!status.active) {
        outcome = 'inactive'
        message = '签到活动未开启'
      } else if (status.todayCheckedIn) {
        // Idempotent, not a failure: reporting it as one would make every startup
        // after the first look broken.
        outcome = 'already'
        message = '今日已签到'
      } else {
        const claim = await options.client.claimDailyCheckin(credential)
        credit = claim.credit
      }
    } catch (error: unknown) {
      if (isAlreadyCheckedIn(error)) {
        outcome = 'already'
        message = '今日已签到'
      } else {
        outcome = 'error'
        message = error instanceof Error ? error.message : String(error)
      }
    }

    // Refresh the balance and unfreeze the account if the check-in restored it.
    // This runs after success AND failure, because it is what decides whether a
    // cooling account comes back — so it must not depend on the claim working.
    let unfrozen = false
    try {
      const credits = await options.client.fetchCredits(credential)
      // The POOL decides whether anything was cleared: a caller that only sees a
      // balance would report a recovery for every healthy account.
      // Keyed by the pool's own account id — NOT by credential.uid, which is a
      // different id and would make this a silent no-op.
      unfrozen = options.pool(account.region).reenableIfCredits(account.accountId, {
        total: credits.total,
        expiringSoon: credits.expiringSoon,
        capacity: credits.capacity,
      })
    } catch {
      // A failed balance read never changes the check-in verdict.
    }

    results.push({
      ...base,
      outcome,
      message,
      ...credit === undefined ? {} : { credit },
      ...unfrozen ? { unfrozen: true } : {},
    })
  }

  const claimed = results.filter(result => result.outcome === 'claimed').length
  const already = results.filter(result => result.outcome === 'already').length
  const failed = results.filter(result => result.outcome === 'error').length
  const unfrozen = results.filter(result => result.unfrozen === true).length
  const credit = results.reduce((sum, result) => sum + (result.credit ?? 0), 0)
  options.log(
    'checkin at startup: ' + String(claimed) + ' 签到成功'
    + (already === 0 ? '' : '，' + String(already) + ' 今日已签到')
    + (failed === 0 ? '' : '，' + String(failed) + ' 失败')
    + (unfrozen === 0 ? '' : '，解冻 ' + String(unfrozen) + ' 个账号')
    + '，+ ' + String(credit) + ' 积分',
  )
  for (const result of results) {
    if (result.outcome === 'error') options.log('  ' + result.accountName + ': ' + result.message)
  }
  return results
}
