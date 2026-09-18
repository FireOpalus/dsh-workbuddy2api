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
 * 改动：文档结构由「单账号 + 单目录」改为「账号池 + 每账号健康 + 合并目录」；
 *   积分从「每次轮询都打上游」改为「读池内缓存 + 显式刷新路由」，
 *   因为多账号下每次轮询都要打 N 个上游接口。
 *
 * @module dsh-workbuddy2api/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyAccountPool, WorkBuddyPoolPolicy } from './pool.ts'
import type { WorkBuddyCredits, WorkBuddyUpstreamClient } from './upstream.ts'
import {
  WORKBUDDY2API_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY2API_ACCOUNT_PARAM,
  WORKBUDDY2API_CHECKIN_PATH,
  WORKBUDDY2API_CREDITS_REFRESH_PATH,
  WORKBUDDY2API_MODELS_REFRESH_PATH,
  WORKBUDDY2API_POOL_ACTION_PATH,
  WORKBUDDY2API_USAGE_PATH,
} from './status-paths.ts'
import type {
  WorkBuddyWebAccount,
  WorkBuddyWebAccountCredits,
  WorkBuddyWebCredits,
  WorkBuddyWebModel,
  WorkBuddyWebPoolEntry,
  WorkBuddyWebPoolState,
  WorkBuddyWebUsage,
} from './status-paths.ts'

export {
  WORKBUDDY2API_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY2API_ACCOUNT_PARAM,
  WORKBUDDY2API_CHECKIN_PATH,
  WORKBUDDY2API_CREDITS_REFRESH_PATH,
  WORKBUDDY2API_MODELS_REFRESH_PATH,
  WORKBUDDY2API_POOL_ACTION_PATH,
  WORKBUDDY2API_USAGE_PATH,
}
export type { WorkBuddyWebUsage }

/** Constructor dependencies. */
export interface WorkBuddyStatusRouteOptions {
  store: WorkBuddyCredentialStore
  pool: WorkBuddyAccountPool
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits' | 'fetchCheckinStatus' | 'claimDailyCheckin'>
  /** The last-refreshed model directory (unfiltered) for card display. */
  displayModels(): readonly WorkBuddyModelInfo[]
  /** The user's selection, stored as model ids. */
  enabledModelIds(): readonly string[]
  /** Model ids the user opted into image input. */
  imageModelIds(): readonly string[]
  /** Saved local DSH context budgets by model id. */
  contextBudgets(): Readonly<Record<string, number | undefined>>
  /** Persisted per-account pool state, mirrored to the card for saving. */
  poolState(): readonly WorkBuddyWebPoolState[]
  /** The pool policy in force. */
  policy(): WorkBuddyPoolPolicy
  /** Re-read the live catalog from every account and merge it. */
  discoverModels?(signal?: AbortSignal): Promise<readonly WorkBuddyModelInfo[]>
  /** Fetch and cache one account's credits; resolves to the fetched answer. */
  refreshCredits?(accountId: string): Promise<WorkBuddyCredits>
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

/**
 * Assemble the card's document: the locally discovered accounts, the pool's
 * live health per account, the cached credits, and the model directory with
 * the user's selection. Credit queries never run here — the pool's cache is
 * read instead, so a 60-second card poll does not hammer N upstream billing
 * endpoints.
 */
export async function workBuddyWebStatus(deps: WorkBuddyStatusRouteOptions): Promise<WorkBuddyWebUsage> {
  try {
    await deps.pool.refresh()
  } catch (error: unknown) {
    return { status: 'error', message: safeMessage(error) }
  }
  const accounts: WorkBuddyWebAccount[] = (await deps.store.accounts()).map(account => ({
    id: account.id,
    accountName: account.accountName,
    ...account.uin === undefined ? {} : { uin: account.uin },
    domain: account.domain,
    region: account.region,
    source: account.source,
    tokenExpiresAtMs: account.tokenExpiresAtMs,
    present: true,
  }))
  const pool = deps.pool.snapshot()
  if (accounts.length === 0) {
    return {
      status: 'empty',
      accounts: [],
      pool,
      message: 'sign in once in the WorkBuddy desktop app, then refresh the account pool',
    }
  }
  const credits: WorkBuddyWebAccountCredits[] = pool.map(entry => ({
    accountId: entry.accountId,
    ...entry.credits === undefined ? {} : {
      credits: {
        total: entry.credits,
        packages: [],
        expiringSoon: entry.creditsExpiringSoon ?? 0,
      },
    },
  }))
  return {
    status: 'ready',
    accounts,
    pool,
    credits,
    models: deps.displayModels().map(model => toWebModel(model, deps.contextBudgets())),
    enabledModelIds: [...deps.enabledModelIds()],
    imageModelIds: [...deps.imageModelIds()],
    poolState: [...deps.poolState()],
    policy: deps.policy(),
  }
}

/** Map the pool's card view into the browser-facing entry shape. */
function toWebPoolEntry(entry: WorkBuddyWebPoolEntry): WorkBuddyWebPoolEntry {
  return { ...entry }
}

/**
 * Mount the routes on a context where `webServer` is available. The caller
 * uses `ctx.inject(['webServer'], ...)`, so Desktop startup order cannot make
 * this registration disappear.
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

    const disposeUsage = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY2API_USAGE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          json(res, 200, await workBuddyWebStatus(deps))
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
        try {
          await deps.pool.refresh()
          json(res, 200, {
            accounts: (await deps.store.accounts()).map(account => ({
              id: account.id,
              accountName: account.accountName,
              ...account.uin === undefined ? {} : { uin: account.uin },
              domain: account.domain,
              region: account.region,
              source: account.source,
              tokenExpiresAtMs: account.tokenExpiresAtMs,
              present: true,
            })),
            pool: deps.pool.snapshot().map(toWebPoolEntry),
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
        if (deps.refreshCredits === undefined) {
          json(res, 503, { error: 'credit refresh unavailable' })
          return
        }
        try {
          await deps.pool.refresh()
          const wanted = requestAccountId(req) === undefined
            ? deps.pool.snapshot().map(entry => entry.accountId)
            : [requestAccountId(req) as string]
          const results = await Promise.allSettled(wanted.map(async accountId => ({
            accountId,
            credits: await (deps.refreshCredits as (id: string) => Promise<WorkBuddyCredits>)(accountId),
          })))
          json(res, 200, {
            credits: results.map((result, index) => result.status === 'fulfilled'
              ? { accountId: wanted[index], credits: toCredits(result.value.credits) }
              : { accountId: wanted[index], creditsError: safeMessage(result.reason) }),
            pool: deps.pool.snapshot().map(toWebPoolEntry),
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
        const accountId = requestAccountId(req)
        if (accountId === undefined) {
          json(res, 400, { error: 'accountId is required' })
          return
        }
        try {
          const credential = await deps.store.resolve(accountId)
          const current = await deps.client.fetchCheckinStatus(credential)
          if (!current.active) {
            json(res, 409, { error: 'check-in activity is not active' })
            return
          }
          if (current.todayCheckedIn) {
            json(res, 200, { alreadyCheckedIn: true, checkin: current })
            return
          }
          const claim = await deps.client.claimDailyCheckin(credential)
          json(res, 200, { alreadyCheckedIn: false, claim, checkin: await deps.client.fetchCheckinStatus(credential) })
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
        if (deps.discoverModels === undefined) {
          json(res, 503, { error: 'model refresh unavailable' })
          return
        }
        try {
          const models = await deps.discoverModels()
          json(res, 200, { models: models.map(model => toWebModel(model, deps.contextBudgets())) })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    const disposePool = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY2API_POOL_ACTION_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req)
          const action = typeof body['action'] === 'string' ? body['action'] : ''
          const accountId = typeof body['accountId'] === 'string' ? body['accountId'] : undefined
          if (accountId === undefined) {
            json(res, 400, { error: 'accountId is required' })
            return
          }
          if (action === 'reset') {
            deps.pool.reset(accountId)
          } else if (action === 'release') {
            // Operator escape hatch for a slot leaked by a crashed request.
            deps.pool.release(accountId)
          } else {
            json(res, 400, { error: `unknown pool action: ${action}` })
            return
          }
          json(res, 200, { pool: deps.pool.snapshot().map(toWebPoolEntry), poolState: [...deps.poolState()] })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    return () => {
      disposePool()
      disposeModels()
      disposeCheckin()
      disposeCredits()
      disposeAccounts()
      disposeUsage()
    }
  }, 'dsh-workbuddy2api: Web status route')
}
