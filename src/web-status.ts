/**
 * Same-origin routes for the WorkBuddy account-pool card: pool state, the
 * read-only credit summary per account, model refresh, account rescan, and the
 * daily check-in action. The routes answer loopback browser requests only and
 * never carry token material.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 路由的注册方式（`ctx.webServer.register({kind:'exact', path, handler})`）、
 *     回环来源校验、`safeMessage` 的脱敏规则（JWT 与 token 查询参数截断）、
 *     以及「积分查询失败降级为 creditsError 而非让整个文档失败」的处理，
 *     均来自该项目（其源自 dsh-connect-trae，单条 status 路由的原始形态
 *     来自 corrinehu/dsh-workbuddy-connect）。
 * 改动：
 *   1. 文档结构由「单账号 + 单目录」改为「账号池 + 每账号健康 + 该区域目录」；
 *   2. **每条路由都按 `?region=cn|global` 参数化** —— 两个区域是两套独立的
 *      pool / store / catalog，一个 tab 的请求只可能读写自己那一套；
 *   3. 积分从「每次轮询都打上游」改为「读池内缓存 + 显式刷新路由」，
 *      因为多账号下每次轮询都要打 N 个上游计费接口。
 *
 * @module dsh-workbuddy2api/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyAccountPool, WorkBuddyPoolTuning } from './pool.ts'
import type { WorkBuddyCredits, WorkBuddyRegion, WorkBuddyUpstreamClient } from './upstream.ts'
import { regionOf as regionOfDomain } from './upstream.ts'
import {
  regionOfStatusUrl,
  WORKBUDDY2API_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY2API_ACCOUNT_PARAM,
  WORKBUDDY2API_CHECKIN_PATH,
  WORKBUDDY2API_CREDITS_REFRESH_PATH,
  WORKBUDDY2API_LOGIN_POLL_PATH,
  WORKBUDDY2API_LOGIN_START_PATH,
  WORKBUDDY2API_MODELS_REFRESH_PATH,
  WORKBUDDY2API_POOL_ACTION_PATH,
  WORKBUDDY2API_STATE_PARAM,
  WORKBUDDY2API_TASKS_PATH,
  WORKBUDDY2API_TASKS_RUN_PATH,
  WORKBUDDY2API_USAGE_PATH,
} from './status-paths.ts'
import type {
  WorkBuddyPoolPolicy,
  WorkBuddyWebAccount,
  WorkBuddyWebAccountCredits,
  WorkBuddyWebCredits,
  WorkBuddyWebLogin,
  WorkBuddyWebModel,
  WorkBuddyWebPoolState,
  WorkBuddyWebTask,
  WorkBuddyWebTaskSchedule,
  WorkBuddyWebTasks,
  WorkBuddyWebUsage,
} from './status-paths.ts'
import { WorkBuddyLoginUnknownStateError } from './login.ts'
import type { WorkBuddyLoginManager } from './login.ts'
import type { WorkBuddyTaskEngine, WorkBuddyTaskScheduleStatus, WorkBuddyTaskView } from './tasks.ts'
import { progressText } from './tasks.ts'

export {
  WORKBUDDY2API_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY2API_ACCOUNT_PARAM,
  WORKBUDDY2API_CHECKIN_PATH,
  WORKBUDDY2API_CREDITS_REFRESH_PATH,
  WORKBUDDY2API_LOGIN_POLL_PATH,
  WORKBUDDY2API_LOGIN_START_PATH,
  WORKBUDDY2API_MODELS_REFRESH_PATH,
  WORKBUDDY2API_POOL_ACTION_PATH,
  WORKBUDDY2API_STATE_PARAM,
  WORKBUDDY2API_TASKS_PATH,
  WORKBUDDY2API_TASKS_RUN_PATH,
  WORKBUDDY2API_USAGE_PATH,
}
export type { WorkBuddyWebUsage }

/** Constructor dependencies. Every region-scoped accessor takes the region. */
export interface WorkBuddyStatusRouteOptions {
  /** The region-scoped credential store backing that region's requests. */
  store(region: WorkBuddyRegion): WorkBuddyCredentialStore
  /** The region's own account pool. */
  pool(region: WorkBuddyRegion): WorkBuddyAccountPool
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits' | 'fetchCheckinStatus' | 'claimDailyCheckin'>
  /**
   * The requested region's last-refreshed model directory (unfiltered) for card
   * display. Region-scoped because the two gateways expose different rosters
   * AND can bill the same id differently; showing one region's directory on the
   * other is the bug the two-pool split exists to prevent.
   */
  displayModels(region: WorkBuddyRegion): readonly WorkBuddyModelInfo[]
  /** The requested region's selection, stored as model ids. */
  enabledModelIds(region: WorkBuddyRegion): readonly string[]
  /** Model ids the user opted into image input, for the requested region. */
  imageModelIds(region: WorkBuddyRegion): readonly string[]
  /** Saved local DSH context budgets by model id, for the requested region. */
  contextBudgets(region: WorkBuddyRegion): Readonly<Record<string, number | undefined>>
  /** Persisted per-account pool state, mirrored to the card for saving. */
  poolState(region: WorkBuddyRegion): readonly WorkBuddyWebPoolState[]
  /** The requested region's pool policy in force. */
  policy(region: WorkBuddyRegion): WorkBuddyPoolTuning
  /** Re-read one region's live catalog from that region's own accounts. */
  discoverModels?(region: WorkBuddyRegion, signal?: AbortSignal): Promise<readonly WorkBuddyModelInfo[]>
  /** Fetch and cache one account's credits inside its own region's pool. */
  refreshCredits?(region: WorkBuddyRegion, accountId: string): Promise<WorkBuddyCredits>
  /**
   * The in-process web sign-in. Absent when the host did not wire it, in which
   * case the two sign-in routes answer 503 instead of failing obscurely.
   */
  login?: WorkBuddyLoginManager
  /**
   * The growth-task engine. Absent when the host did not wire it, in which case
   * the two task routes answer 503.
   */
  tasks?: WorkBuddyTaskEngine
  /** The task schedule in force and what it last did. */
  taskSchedule?(): WorkBuddyTaskScheduleStatus
  /** Run one task sweep right now, over every eligible account. */
  runTaskSweep?(): Promise<void>
}

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Loopback browser origins only; other devices are refused. */
function loopbackOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const { hostname } = new URL(origin)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/** Map the credit answer to the card's compact document. */
function toCredits(answer: WorkBuddyCredits): WorkBuddyWebCredits {
  return {
    total: answer.total,
    packages: answer.packages.map(pack => ({
      packageName: pack.packageName,
      remain: pack.remain,
      size: pack.size,
      monthly: pack.monthly,
      ...pack.refreshAtMs === undefined ? {} : { cycleRefreshMs: pack.refreshAtMs },
      ...pack.expiresAtMs === undefined ? {} : { expiresAtMs: pack.expiresAtMs },
    })),
    expiringSoon: answer.expiringSoon,
    ...answer.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: answer.nearestExpiryMs },
  }
}

/**
 * One task, projected for the card. The title falls back through the upstream's
 * three text fields because which one is populated varies by task type.
 */
function toWebTask(view: WorkBuddyTaskView): WorkBuddyWebTask {
  const { task } = view
  return {
    taskCode: task.taskCode,
    title: task.title ?? task.taskDesc ?? task.taskCode,
    detail: task.taskDesc ?? task.description ?? '',
    current: task.current,
    target: task.target,
    credit: task.credit,
    energy: task.energy,
    locked: task.locked,
    claimable: task.claimable,
    claimed: task.claimed,
    ...task.acceptStatus === undefined ? {} : { acceptStatus: task.acceptStatus },
    automated: view.automated,
    ...view.unsupportedReason === undefined ? {} : { unsupportedReason: view.unsupportedReason },
  }
}

/** Project a model into the card's row, dropping empty optional fields. */
function toWebModel(
  model: WorkBuddyModelInfo,
  budgets: Readonly<Record<string, number | undefined>>,
): WorkBuddyWebModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow > 200_000
      ? Math.min(model.contextWindow, budgets[model.id] ?? 200_000)
      : model.contextWindow,
    nativeContextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...model.creditMultiplier === undefined ? {} : { creditMultiplier: model.creditMultiplier },
    ...model.multimodal === undefined ? {} : { multimodal: model.multimodal },
    ...model.reasoning === undefined ? {} : {
      reasoning: {
        ...model.reasoning.supportedEfforts === undefined ? {} : { supportedEfforts: [...model.reasoning.supportedEfforts] },
        ...model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
      },
    },
  }
}

/** The account id a request addresses, or undefined when it names none. */
function requestAccountId(req: IncomingMessage): string | undefined {
  const url = req.url ?? '/'
  const at = url.indexOf('?')
  if (at === -1) return undefined
  const value = new URLSearchParams(url.slice(at + 1)).get(WORKBUDDY2API_ACCOUNT_PARAM)
  return value === null || value === '' ? undefined : value
}

/** Read a small JSON body; unparsable or absent bodies answer `{}`. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** One region's account list, token-free, annotated with its pool's switch. */
async function accountsOf(
  deps: WorkBuddyStatusRouteOptions,
  region: WorkBuddyRegion,
): Promise<WorkBuddyWebAccount[]> {
  const pool = deps.pool(region)
  return (await deps.store(region).accounts()).map(account => ({
    id: account.id,
    accountName: account.accountName,
    ...account.uin === undefined ? {} : { uin: account.uin },
    domain: account.domain,
    region: account.region,
    source: account.source,
    tokenExpiresAtMs: account.tokenExpiresAtMs,
    enabled: pool.entryView(account.id)?.enabled ?? true,
    present: true,
  }))
}

/**
 * Assemble one region's card document: that region's locally discovered
 * accounts, its pool's live health per account, its cached credits, and its
 * model directory with the user's selection within it. Credit queries never run
 * here — the pool's cache is read instead, so a 60-second card poll does not
 * hammer N upstream billing endpoints.
 */
export async function workBuddyWebStatus(
  deps: WorkBuddyStatusRouteOptions,
  region: WorkBuddyRegion,
): Promise<WorkBuddyWebUsage> {
  const pool = deps.pool(region)
  try {
    await pool.refresh()
  } catch (error: unknown) {
    return { status: 'error', region, message: safeMessage(error) }
  }
  let accounts: WorkBuddyWebAccount[]
  try {
    accounts = await accountsOf(deps, region)
  } catch (error: unknown) {
    return { status: 'error', region, message: safeMessage(error) }
  }
  const entries = pool.snapshot()
  if (accounts.length === 0) {
    return {
      status: 'empty',
      region,
      accounts: [],
      pool: entries,
      message: region === 'global'
        ? 'no international WorkBuddy sign-in found; sign in once in the WorkBuddy AI app, then refresh this tab'
        : 'no domestic WorkBuddy sign-in found; sign in once in the WorkBuddy desktop app, then refresh this tab',
    }
  }
  const credits: WorkBuddyWebAccountCredits[] = entries.map(entry => ({
    accountId: entry.accountId,
    ...entry.credits === undefined ? {} : {
      credits: { total: entry.credits, packages: [], expiringSoon: entry.creditsExpiringSoon ?? 0 },
    },
  }))
  return {
    status: 'ready',
    region,
    accounts,
    pool: entries,
    credits,
    models: deps.displayModels(region).map(model => toWebModel(model, deps.contextBudgets(region))),
    enabledModelIds: [...deps.enabledModelIds(region)],
    imageModelIds: [...deps.imageModelIds(region)],
    poolState: [...deps.poolState(region)],
    policy: deps.policy(region),
  }
}

/**
 * Mount the routes on a context where `webServer` is available. The caller uses
 * `ctx.inject(['webServer'], ...)`, so Desktop startup order cannot make this
 * registration disappear.
 */
export function registerWorkBuddy2ApiStatusRoute(ctx: Context, deps: WorkBuddyStatusRouteOptions): void {
  ctx.effect(() => {
    const guard = (req: IncomingMessage, res: ServerResponse, method: 'GET' | 'POST'): boolean => {
      if (req.method !== method) {
        json(res, 405, { error: 'method not allowed' })
        return false
      }
      if (!loopbackOrigin(req)) {
        json(res, 403, { error: 'origin-not-trusted' })
        return false
      }
      return true
    }

    /**
     * The region a request addresses, or a 400 answer. Absent means the
     * domestic tab; an unknown value is refused rather than guessed, so a
     * malformed request can never silently address the wrong pool.
     */
    const requestRegion = (req: IncomingMessage, res: ServerResponse): WorkBuddyRegion | undefined => {
      const region = regionOfStatusUrl(req.url ?? '/')
      if (region === undefined) {
        json(res, 400, { error: 'unknown region' })
        return undefined
      }
      return region
    }

    const disposeUsage = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY2API_USAGE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          json(res, 200, await workBuddyWebStatus(deps, region))
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    const disposeAccounts = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY2API_ACCOUNTS_REFRESH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          await deps.pool(region).refresh()
          json(res, 200, {
            region,
            accounts: await accountsOf(deps, region),
            pool: deps.pool(region).snapshot(),
          })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    const disposeCredits = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY2API_CREDITS_REFRESH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        if (deps.refreshCredits === undefined) {
          json(res, 503, { error: 'credit refresh unavailable' })
          return
        }
        try {
          await deps.pool(region).refresh()
          const named = requestAccountId(req)
          const wanted = named === undefined
            ? deps.pool(region).snapshot().map(entry => entry.accountId)
            : [named]
          const refreshCredits = deps.refreshCredits
          const results = await Promise.allSettled(wanted.map(async accountId => ({
            accountId,
            credits: await refreshCredits(region, accountId),
          })))
          json(res, 200, {
            region,
            credits: results.map((result, index) => result.status === 'fulfilled'
              ? { accountId: wanted[index], credits: toCredits(result.value.credits) }
              : { accountId: wanted[index], creditsError: safeMessage(result.reason) }),
            pool: deps.pool(region).snapshot(),
          })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    const disposeCheckin = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY2API_CHECKIN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        const accountId = requestAccountId(req)
        if (accountId === undefined) {
          json(res, 400, { error: 'accountId is required' })
          return
        }
        try {
          const credential = await deps.store(region).resolve(accountId)
          const current = await deps.client.fetchCheckinStatus(credential)
          if (!current.active) {
            json(res, 409, { error: 'check-in activity is not active' })
            return
          }
          if (current.todayCheckedIn) {
            json(res, 200, { region, alreadyCheckedIn: true, checkin: current })
            return
          }
          const claim = await deps.client.claimDailyCheckin(credential)
          json(res, 200, {
            region,
            alreadyCheckedIn: false,
            claim,
            checkin: await deps.client.fetchCheckinStatus(credential),
          })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    const disposeModels = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY2API_MODELS_REFRESH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        if (deps.discoverModels === undefined) {
          json(res, 503, { error: 'model refresh unavailable' })
          return
        }
        try {
          // The refreshed catalog belongs to the requested region, so its
          // context budgets come from that same region's slot.
          const models = await deps.discoverModels(region)
          json(res, 200, { region, models: models.map(model => toWebModel(model, deps.contextBudgets(region))) })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    /** One account's growth tasks, annotated with what this plugin can finish. */
    const taskDocument = async (
      region: WorkBuddyRegion,
      accountId: string,
      engine: WorkBuddyTaskEngine,
    ): Promise<WorkBuddyWebTasks> => {
      const credential = await deps.store(region).resolve(accountId)
      const accountName = credential.nickname ?? credential.uin ?? credential.uid
      // The international gateway has no growth-task system: the call would
      // only 404, so the card is told up front instead of showing an error.
      if (credential.domain !== '' && regionOfDomain(credential.domain) !== 'cn') {
        return { accountId, accountName, supported: false, tasks: [] }
      }
      try {
        const views = await engine.view(credential)
        return { accountId, accountName, supported: true, tasks: views.map(toWebTask) }
      } catch (error: unknown) {
        return { accountId, accountName, supported: true, tasks: [], error: safeMessage(error) }
      }
    }

    const disposeTasks = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY2API_TASKS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        const engine = deps.tasks
        if (engine === undefined) {
          json(res, 503, { error: 'task engine unavailable' })
          return
        }
        try {
          const accountId = requestAccountId(req)
          if (accountId !== undefined) {
            json(res, 200, await taskDocument(region, accountId, engine))
            return
          }
          const accounts = await accountsOf(deps, region)
          json(res, 200, {
            region,
            schedule: deps.taskSchedule?.() ?? null,
            accounts: await Promise.all(accounts.map(entry => taskDocument(region, entry.id, engine))),
          })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    /**
     * Run the tasks. Without an `accountId` this is the one-click "finish
     * everything" for the requested region; with one it is that account only.
     * Either way the work is serialized per region by the engine's own pacing.
     */
    const disposeTasksRun = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY2API_TASKS_RUN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        const engine = deps.tasks
        if (engine === undefined) {
          json(res, 503, { error: 'task engine unavailable' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const named = typeof body['accountId'] === 'string' && body['accountId'] !== ''
            ? body['accountId']
            : undefined
          const codes = Array.isArray(body['taskCodes'])
            ? body['taskCodes'].filter((code): code is string => typeof code === 'string')
            : undefined
          const accounts = await accountsOf(deps, region)
          const wanted = named === undefined ? accounts : accounts.filter(entry => entry.id === named)
          if (named !== undefined && wanted.length === 0) {
            json(res, 404, { error: 'account not found' })
            return
          }
          const reports = []
          for (const entry of wanted) {
            const credential = await deps.store(region).resolve(entry.id)
            if (credential.domain !== '' && regionOfDomain(credential.domain) !== 'cn') {
              reports.push({
                accountId: entry.id,
                accountName: entry.accountName,
                credit: 0,
                energy: 0,
                finishedAtMs: Date.now(),
                results: [{
                  taskCode: '(任务体系)',
                  desc: '国际版没有任务体系',
                  outcome: 'unsupported' as const,
                  message: '该账号属于国际版，上游没有 growth 任务接口',
                }],
              })
              continue
            }
            reports.push(await engine.run(credential, codes === undefined ? {} : { taskCodes: codes }))
          }
          json(res, 200, {
            region,
            reports,
            schedule: deps.taskSchedule?.() ?? null,
            accounts: await Promise.all((await accountsOf(deps, region))
              .map(entry => taskDocument(region, entry.id, engine))),
          })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    /**
     * Start a browser sign-in. The authorization URL is returned to the page,
     * which opens it; the token bundle never crosses this route in either
     * direction.
     */
    const disposeLoginStart = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY2API_LOGIN_START_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        const login = deps.login
        if (login === undefined) {
          json(res, 503, { error: 'web sign-in unavailable' })
          return
        }
        try {
          const started = await login.start(region)
          json(res, 200, { region, state: started.state, url: started.url })
        } catch (error: unknown) {
          json(res, 502, { error: safeMessage(error) })
        }
      },
    })

    /**
     * Poll one sign-in. Unfinished answers `waiting`; a completed one answers
     * the account it created, which the card then re-reads through the normal
     * status route.
     */
    const disposeLoginPoll = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY2API_LOGIN_POLL_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        const login = deps.login
        if (login === undefined) {
          json(res, 503, { error: 'web sign-in unavailable' })
          return
        }
        const url = req.url ?? '/'
        const at = url.indexOf('?')
        const state = at === -1 ? null : new URLSearchParams(url.slice(at + 1)).get(WORKBUDDY2API_STATE_PARAM)
        if (state === null || state === '') {
          json(res, 400, { error: 'state is required' })
          return
        }
        try {
          const poll = await login.poll(state)
          if (!poll.done) {
            const waiting: WorkBuddyWebLogin = {
              status: 'waiting',
              region,
              ...poll.message === undefined ? {} : { message: poll.message },
            }
            json(res, 200, waiting)
            return
          }
          const listed = (await accountsOf(deps, region)).find(entry => entry.id === poll.account.accountId)
          // The credential is already on disk, so the account list normally
          // carries it; the fallback only covers a scan that ran mid-write.
          const account: WorkBuddyWebAccount = listed ?? {
            id: poll.account.accountId,
            accountName: poll.account.accountName,
            ...poll.account.nickname === undefined ? {} : { uin: poll.account.uid },
            domain: poll.account.domain,
            region,
            source: 'dsh',
            tokenExpiresAtMs: 0,
            enabled: true,
            present: true,
          }
          const done: WorkBuddyWebLogin = {
            status: 'done',
            region,
            account,
            ...poll.note === undefined ? {} : { note: poll.note },
          }
          json(res, 200, done)
        } catch (error: unknown) {
          if (error instanceof WorkBuddyLoginUnknownStateError) {
            json(res, 404, { error: safeMessage(error) })
            return
          }
          json(res, 502, { error: safeMessage(error) })
        }
      },
    })

    const disposePool = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY2API_POOL_ACTION_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          const body = await readJsonBody(req)
          const action = typeof body['action'] === 'string' ? body['action'] : ''
          const accountId = typeof body['accountId'] === 'string' ? body['accountId'] : undefined
          if (accountId === undefined) {
            json(res, 400, { error: 'accountId is required' })
            return
          }
          if (action === 'reset') {
            deps.pool(region).reset(accountId)
          } else if (action === 'release') {
            // Operator escape hatch for a slot leaked by a crashed request.
            deps.pool(region).release(accountId)
          } else {
            json(res, 400, { error: `unknown pool action: ${action}` })
            return
          }
          json(res, 200, {
            region,
            pool: deps.pool(region).snapshot(),
            poolState: [...deps.poolState(region)],
          })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    return () => {
      disposeTasksRun()
      disposeTasks()
      disposeLoginPoll()
      disposeLoginStart()
      disposePool()
      disposeModels()
      disposeCheckin()
      disposeCredits()
      disposeAccounts()
      disposeUsage()
    }
  }, 'dsh-workbuddy2api: Web status route')
}
