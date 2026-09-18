/**
 * Web sign-in: the WorkBuddy device-authorization flow, run inside the plugin.
 *
 * The card offers an "Add account" button; the host asks the gateway for an
 * authorization URL, the user finishes the sign-in in their browser, and the
 * host polls until the gateway hands over the token bundle. The resulting
 * credential is written to this plugin's own per-account copy (the desktop
 * app's files are never touched) and the account is usable immediately — no
 * restart, no desktop app.
 *
 * 参考：Sliverkiss/workbuddy2api（MIT）— 设备授权三端点（POST
 *   `/v2/plugin/auth/state?platform=CLI` 取 state+authUrl、
 *   GET `/v2/plugin/auth/token?state=` 轮询登录态、
 *   GET `/v2/plugin/login/account?state=` 带 Bearer 取 uid/nickname）、
 *   CLI 形态请求头、按 realm 切换 base/origin、以及「state 存进程内、
 *   poll 完成即落盘并热加载」的面板做法（其 `internal/panel/login.go` 与
 *   `cmd/login/main.go`）来自该项目。
 * 改动：
 *   1. 每个登录会话记录自己的**区域**，并与该区域的 store / pool 绑定，
 *      因此一次登录只可能落进自己那一侧的账号池；
 *   2. 落盘写的是本插件自有的每账号副本（`.workbuddy2api-auth.<id>.json`），
 *      不写桌面端 auth 文件；
 *   3. 完成后直接写回池（save → refresh → reset），
 *      并回调宿主做签到 / 积分 / 目录刷新。
 *
 * @module dsh-workbuddy2api/login
 */

import type { WorkBuddyCredential, WorkBuddyCredentialStore } from './auth.ts'
import { workbuddyAccountId } from './auth.ts'
import type { WorkBuddyAccountPool } from './pool.ts'
import { regionOf, type WorkBuddyRegion } from './upstream.ts'

/** Upstream base URLs of the two sign-in realms. */
const CN_BASE = 'https://copilot.tencent.com'
const CN_ORIGIN = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'
const GLOBAL_ORIGIN = 'https://www.workbuddy.ai'

/** Canonical login domain per region, used when the gateway omits the field. */
const CANONICAL_DOMAIN: Record<WorkBuddyRegion, string> = {
  cn: 'www.workbuddy.cn',
  global: 'www.workbuddy.ai',
}

/** Request headers the CLI-shaped sign-in endpoints expect. */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** How long an unfinished authorization URL stays pollable. */
export const WORKBUDDY_LOGIN_TTL_MS = 15 * 60 * 1000

/** Per-request timeout for the sign-in endpoints. */
const LOGIN_TIMEOUT_MS = 30_000

/** The three sign-in endpoints of one realm, plus the Origin/Referer to send. */
export interface WorkBuddyLoginEndpoints {
  state: string
  token: string
  account: string
  origin: string
}

/**
 * Endpoints for one region. The international product answers on the same
 * workbuddy.ai origin it signs in on; the domestic one signs in through
 * codebuddy.cn but issues tokens from copilot.tencent.com.
 */
export function loginEndpointsFor(region: WorkBuddyRegion): WorkBuddyLoginEndpoints {
  const base = region === 'global' ? GLOBAL_BASE : CN_BASE
  const origin = region === 'global' ? GLOBAL_ORIGIN : CN_ORIGIN
  return {
    state: base + '/v2/plugin/auth/state?platform=CLI',
    token: base + '/v2/plugin/auth/token?state=',
    account: base + '/v2/plugin/login/account?state=',
    origin,
  }
}

/** The gateway's {code,msg,data} envelope. */
interface LoginEnvelope {
  code: number
  msg: string
  data: unknown
}

/** A started-but-unfinished sign-in. */
interface LoginSession {
  region: WorkBuddyRegion
  createdAtMs: number
}

/** Answer of WorkBuddyLoginManager.start. */
export interface WorkBuddyLoginStart {
  state: string
  url: string
  region: WorkBuddyRegion
}

/** One account the sign-in produced, token-free. */
export interface WorkBuddyLoginAccount {
  accountId: string
  accountName: string
  uid: string
  nickname?: string
  domain: string
  region: WorkBuddyRegion
}

/** Answer of WorkBuddyLoginManager.poll. */
export type WorkBuddyLoginPoll =
  | { done: false; message?: string }
  | {
    done: true
    account: WorkBuddyLoginAccount
    /** Credits read right after signing in, when the host could read them. */
    credits?: { total: number; expiringSoon: number }
    /** Non-fatal follow-up result (check-in, credit or catalog refresh). */
    note?: string
  }

/** A poll for a state this manager never issued, or one that expired. */
export class WorkBuddyLoginUnknownStateError extends Error {
  constructor() {
    super('unknown or expired sign-in session; start the sign-in again')
    this.name = 'WorkBuddyLoginUnknownStateError'
  }
}
/** Constructor dependencies. */
export interface WorkBuddyLoginManagerOptions {
  /** Region-scoped credential store that owns the resulting copy. */
  store(region: WorkBuddyRegion): WorkBuddyCredentialStore
  /** Region-scoped pool, so a new account is usable without a restart. */
  pool(region: WorkBuddyRegion): WorkBuddyAccountPool
  /** Run after the credential is persisted; failures are reported, not thrown. */
  onSignedIn?(region: WorkBuddyRegion, credential: WorkBuddyCredential): Promise<string | undefined>
  /** Injected for tests. */
  fetch?: typeof fetch
  now?: () => number
  ttlMs?: number
}

/** Whether a trimmed string carries a value. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A finite, positive number, or undefined. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * In-process device-authorization manager. One instance serves both regions;
 * every session remembers the region it was started for, so a poll can only
 * ever write into that region's store and pool.
 */
export class WorkBuddyLoginManager {
  private readonly options: WorkBuddyLoginManagerOptions
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly sessions = new Map<string, LoginSession>()

  constructor(options: WorkBuddyLoginManagerOptions) {
    this.options = options
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? WORKBUDDY_LOGIN_TTL_MS
  }

  /** Unfinished sessions, for diagnostics. */
  pendingCount(): number {
    return this.sessions.size
  }

  /** Forget every unfinished session; called when the plugin is disposed. */
  dispose(): void {
    this.sessions.clear()
  }

  /**
   * Begin a sign-in for one region: ask the gateway for a state and an
   * authorization URL, remember which region asked, and hand the URL back.
   * The caller opens it in the user's browser.
   */
  async start(region: WorkBuddyRegion): Promise<WorkBuddyLoginStart> {
    const endpoints = loginEndpointsFor(region)
    const envelope = await this.request(endpoints.state, endpoints.origin, { method: 'POST', body: '{}' })
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const state = nonEmpty(data['state'])
    const url = nonEmpty(data['authUrl'])
    if (state === undefined || url === undefined) {
      throw new Error('workbuddy sign-in: the gateway answered without a state or an authorization URL')
    }
    this.collect()
    this.sessions.set(state, { region, createdAtMs: this.now() })
    return { state, url, region }
  }

  /**
   * Poll one sign-in. Unfinished sign-ins answer `{done:false}`; a completed
   * one yields the credential, which is persisted into the region's own
   * per-account copy and written back into that region's pool.
   */
  async poll(state: string): Promise<WorkBuddyLoginPoll> {
    const session = this.sessions.get(state)
    if (session === undefined) throw new WorkBuddyLoginUnknownStateError()
    // The gateway keeps a state alive for far longer than a human needs; the
    // local TTL is what stops a forgotten browser tab from completing a
    // sign-in hours later, against a flow the user has stopped watching.
    if (this.now() - session.createdAtMs > this.ttlMs) {
      this.sessions.delete(state)
      throw new WorkBuddyLoginUnknownStateError()
    }
    const endpoints = loginEndpointsFor(session.region)

    // The token endpoint is the authoritative login-state answer: while the
    // user is still in the browser it answers a non-zero business code.
    const tokenEnvelope = await this.request(
      endpoints.token + encodeURIComponent(state),
      endpoints.origin,
      { method: 'GET' },
    )
    const tokenData = typeof tokenEnvelope.data === 'object' && tokenEnvelope.data !== null
      ? tokenEnvelope.data as Record<string, unknown>
      : {}
    const accessToken = nonEmpty(tokenData['accessToken'])
    if (accessToken === undefined) {
      return { done: false, ...tokenEnvelope.msg === '' ? {} : { message: tokenEnvelope.msg } }
    }

    const identity = await this.readAccount(
      endpoints.account + encodeURIComponent(state),
      endpoints.origin,
      accessToken,
    )
    const nickname = nonEmpty(identity['nickname'])
    const uid = nonEmpty(identity['uid'])
    if (uid === undefined && nickname === undefined) {
      throw new Error('workbuddy sign-in: the gateway issued a token but no account identity')
    }

    const requestedDomain = nonEmpty(tokenData['domain'])
    // A sign-in that lands in the other realm means the user finished the wrong
    // browser flow; accepting it would file the account under the wrong pool.
    if (requestedDomain !== undefined && regionOf(requestedDomain) !== session.region) {
      throw new Error(
        'workbuddy sign-in: the browser flow completed on ' + requestedDomain
        + ', which belongs to the ' + regionOf(requestedDomain) + ' pool, not the ' + session.region
        + ' one; start the sign-in from the tab you meant to add the account to',
      )
    }
    const domain = requestedDomain ?? CANONICAL_DOMAIN[session.region]
    const expiresInSec = positiveNumber(tokenData['expiresIn'])
    const refreshExpiresInSec = positiveNumber(tokenData['refreshExpiresIn'])
    const enterpriseId = nonEmpty(identity['enterpriseId'])
    const uin = nonEmpty(identity['uin'])

    const credential: WorkBuddyCredential = {
      accessToken,
      refreshToken: nonEmpty(tokenData['refreshToken']) ?? '',
      expiresAtMs: expiresInSec === undefined ? 0 : this.now() + expiresInSec * 1000,
      ...refreshExpiresInSec === undefined ? {} : { refreshExpiresAtMs: this.now() + refreshExpiresInSec * 1000 },
      domain,
      uid: uid ?? '',
      ...enterpriseId === undefined ? {} : { enterpriseId },
      ...nickname === undefined ? {} : { nickname },
      ...uin === undefined ? {} : { uin },
      lastRefreshAtMs: this.now(),
      source: 'dsh',
      filePath: '',
    }

    const store = this.options.store(session.region)
    // The account endpoint does not always repeat the billing identity the
    // desktop files carry (uin). When the same account is already known
    // locally, adopt its identity so both paths key to ONE pool entry instead
    // of two.
    const stored = await store.save(await store.reconcileIdentity(credential))
    const accountId = workbuddyAccountId(stored)
    await this.adoptIntoPool(session.region, accountId)

    const account: WorkBuddyLoginAccount = {
      accountId,
      accountName: stored.nickname ?? stored.uin ?? stored.uid,
      uid: stored.uid,
      ...stored.nickname === undefined ? {} : { nickname: stored.nickname },
      domain: stored.domain,
      region: session.region,
    }
    this.sessions.delete(state)

    let note: string | undefined
    try {
      note = await this.options.onSignedIn?.(session.region, stored)
    } catch (error: unknown) {
      note = error instanceof Error ? error.message : String(error)
    }
    let credits: { total: number; expiringSoon: number } | undefined
    const cached = this.options.pool(session.region).entryView(accountId)
    if (cached?.credits !== undefined) {
      credits = { total: cached.credits, expiringSoon: cached.creditsExpiringSoon ?? 0 }
    }
    return {
      done: true,
      account,
      ...credits === undefined ? {} : { credits },
      ...note === undefined || note === '' ? {} : { note },
    }
  }

  /** Write the freshly signed-in account into its region's pool and revive it. */
  private async adoptIntoPool(region: WorkBuddyRegion, accountId: string): Promise<void> {
    const pool = this.options.pool(region)
    await pool.refresh()
    // A brand-new sign-in is an explicit human action, so it clears whatever
    // cooldown, breaker or degrade mark a previous sign-in left behind.
    pool.reset(accountId)
  }

  /** Read the signed-in account's identity; a failure is not fatal by itself. */
  private async readAccount(url: string, origin: string, accessToken: string): Promise<Record<string, unknown>> {
    try {
      const envelope = await this.request(url, origin, { method: 'GET', bearer: accessToken })
      return typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  }

  /** Drop sessions whose authorization URL has gone stale. */
  private collect(): void {
    const now = this.now()
    for (const [state, session] of [...this.sessions]) {
      if (now - session.createdAtMs > this.ttlMs) this.sessions.delete(state)
    }
  }

  /** One JSON request against a sign-in endpoint, envelope already unwrapped. */
  private async request(
    url: string,
    origin: string,
    init: { method: 'GET' | 'POST'; body?: string; bearer?: string },
  ): Promise<LoginEnvelope> {
    const headers: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': origin,
      'Referer': origin + '/',
      'User-Agent': CLIENT_UA,
      ...init.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...init.bearer === undefined ? {} : { 'Authorization': 'Bearer ' + init.bearer },
    }
    const response = await this.fetchImpl(url, {
      method: init.method,
      headers,
      ...init.body === undefined ? {} : { body: init.body },
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    })
    const text = (await response.text()).slice(0, 64 * 1024)
    if (response.status >= 300) {
      throw new Error('workbuddy sign-in: the gateway answered http ' + String(response.status))
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('workbuddy sign-in: the gateway answered a non-JSON document (http ' + String(response.status) + ')')
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('workbuddy sign-in: the gateway answered an unexpected document')
    }
    const document = parsed as Record<string, unknown>
    return {
      code: typeof document['code'] === 'number' ? document['code'] : 0,
      msg: typeof document['msg'] === 'string' ? document['msg'] : '',
      data: document['data'],
    }
  }
}
