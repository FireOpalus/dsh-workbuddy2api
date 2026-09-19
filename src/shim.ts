/**
 * Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
 * shim applies the WorkBuddy wire quirks (forced streaming, string
 * `tool_choice`, CLI-shaped headers) and forwards to the real upstream. It
 * binds 127.0.0.1 only and never serves another interface.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 入站加固的四重校验（Host 必须回环、Origin 必须回环、chat POST 必须
 *     JSON、bearer 必须匹配进程内随机 secret）、常量时间比对、随机端口绑定、
 *     body 上限、上游错误分类到 HTTP 状态码的映射，均由该项目设计并验证
 *     （其源自 corrinehu/dsh-workbuddy-connect (MIT)）。
 * 改动：chat 请求的凭据不再来自「当前选中的唯一账号」，而是每一步都向
 *   账号池要一个账号（会话粘性 → 加权选号），请求结束后把结果回报给池
 *   做健康迁移；失败时按「可重试分类 + 剩余尝试次数」换号重试，
 *   这正是多账号相对单账号的核心增量。安全相关代码不做「改善」，原样沿用。
 *
 * @module dsh-workbuddy2api/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { stickyKeyOf, type WorkBuddyAccountPool, type WorkBuddyPoolMissReason } from './pool.ts'
import { prepareChatBody, WorkBuddyUpstreamClient, type UpstreamErrorKind } from './upstream.ts'

/** Minimal logger surface the plugin context already provides. */
export interface ShimLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** What the plugin needs from a running shim. */
export interface WorkBuddyShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of any upstream token, because the shim resolves the
   * real credential itself via the store and the pool.
   */
  token(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface WorkBuddyShimOptions {
  store: WorkBuddyCredentialStore
  pool: WorkBuddyAccountPool
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>
  catalog: WorkBuddyCatalog
  logger?: ShimLogger
  /** Maximum upstream attempts for one chat request (account switches included). */
  maxAttempts?: number
  /**
   * Called after every dispatch is reported to the pool, so the host can persist
   * the counters that just changed. The shim itself knows nothing about files:
   * it only says "the pool state moved".
   */
  onDispatch?(): void
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/** Loopback hostnames the shim's own in-process client uses. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Failure classes worth retrying on a different account. */
const RETRYABLE: ReadonlySet<UpstreamErrorKind> = new Set<UpstreamErrorKind>([
  'hard_credit', 'soft_rate', 'session_dead', 'server',
])

/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/**
 * The request's Host header must name the loopback interface. A DNS-rebinding
 * page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
 * Host, so this check drops those before any routing happens.
 */
function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * A browser-sent Origin (present header) must be loopback. Non-browser clients
 * (the plugin's own fetch calls) send no Origin at all and pass.
 */
function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * The model a chat body asks for, or undefined when it names none.
 *
 * Only the request's own field is read — never inferred from the catalog — so a
 * model-aware decision is always about what the caller actually requested.
 */
function modelOf(bodyJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyJson)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const model = (parsed as Record<string, unknown>)['model']
    return typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * The charge and token count the upstream reports in the last SSE frame.
 *
 * This is measurement, not configuration: the model catalogue advertises a
 * multiplier, but the gateway reports what a request actually cost. Watching the
 * real number means a promotional model that quietly starts billing is noticed.
 */
function usageOf(frame: string): { credit: number; totalTokens: number } | undefined {
  const at = frame.indexOf('"usage"')
  if (at === -1) return undefined
  const tail = frame.slice(at)
  const credit = /"credit"s*:s*(-?d+(?:.d+)?)/u.exec(tail)
  const tokens = /"total_tokens"s*:s*(d+)/u.exec(tail)
  if (credit === null || tokens === null) return undefined
  return { credit: Number(credit[1]), totalTokens: Number(tokens[1]) }
}

/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  // A model-level limit is not the client's fault and not an auth failure; 429
  // is still the honest status, since the client should simply wait or switch.
  model_rate: 429,
  model_blocked: 404,
  // The gateway refused before the API ever saw the request.
  waf_block: 403,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

/** HTTP status each "the pool could not find an account" answer surfaces as. */
const MISS_STATUS: Readonly<Record<WorkBuddyPoolMissReason, number>> = {
  'no-accounts': 401,
  'all-disabled': 503,
  'pool-saturated': 503,
}

const MISS_MESSAGE: Readonly<Record<WorkBuddyPoolMissReason, string>> = {
  'no-accounts': 'no WorkBuddy account is signed in; sign in once in the WorkBuddy desktop app, then refresh the pool',
  'all-disabled': 'every account in the WorkBuddy pool is switched off; enable one in the plugin card',
  'pool-saturated': 'every WorkBuddy account is busy or cooling down; retry shortly',
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Start the loopback endpoint. Requests must carry the shim's shared secret;
 * the loopback bind alone is not a trust boundary.
 */
export function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim {
  const { store, pool, client, catalog } = options
  const onDispatch = options.onDispatch
  const logger = options.logger
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3)

  // Per-process shared secret. Lives only in memory; the adapter resolves it
  // as the OpenAI apiKey, which pi-ai sends as `Authorization: Bearer ...`.
  // The shim never forwards it upstream — the real credential comes from the
  // store. A local attacker who can hit the port still cannot forge this.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const a = Buffer.from(match[1] as string)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('workbuddy shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true, accounts: pool.snapshot().length })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'workbuddy',
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
      } else {
        res.end()
      }
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    const raw = (await readBody(req)).toString('utf8')
    const prepared = prepareChatBody(raw)
    // One conversation keeps one account for the whole session: the upstream
    // keys its own conversation state on the account, so bouncing between
    // accounts mid-conversation would degrade answers and waste credits.
    const stickyKey = stickyKeyOf(raw)
    // The model this request asks for. It gates the per-model cooldowns (a 6004
    // must not park the account for other models) and drives the cost tiers.
    const model = modelOf(raw)

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    const attempted = new Set<string>()
    let lastFailure: { status: number; kind: UpstreamErrorKind; message: string } | undefined
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const picked = pool.pick({
        exclude: attempted,
        ...stickyKey === undefined ? {} : { stickyKey },
        ...model === undefined ? {} : { model },
      })
      if (!picked.ok) {
        if (lastFailure !== undefined) {
          writeOpenAIError(
            res,
            lastFailure.status,
            lastFailure.kind,
            `workbuddy upstream ${lastFailure.kind} (http ${lastFailure.status}): ${lastFailure.message.slice(0, 400)}`,
          )
          return
        }
        writeOpenAIError(res, MISS_STATUS[picked.reason], picked.reason, MISS_MESSAGE[picked.reason])
        return
      }
      const accountId = picked.entry.accountId
      if (picked.fallback) {
        logger?.warn(
          `dsh-workbuddy2api: every account is cooling down; trying ${accountId}, whose cooldown expires first`,
        )
      }
      attempted.add(accountId)
      let credential
      try {
        credential = await store.resolve(accountId)
      } catch (error: unknown) {
        pool.report(accountId, { ok: false, kind: 'session_dead', message: String(error) })
        // The counters just moved (a failure was recorded); let the host persist.
        options.onDispatch?.()
        lastFailure = { status: 401, kind: 'session_dead', message: String(error) }
        pool.release(accountId)
        continue
      }
      let result
      try {
        result = await client.chatStream(credential, prepared, controller.signal)
      } finally {
        pool.release(accountId)
      }
      if (result.ok) {
        pool.report(accountId, { ok: true, ...model === undefined ? {} : { model } }, stickyKey)
        // Counters moved (a success, and possibly a sticky renewal).
        onDispatch?.()
        if (controller.signal.aborted) {
          result.response.body?.cancel().catch(() => {})
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        let sawDone = false
        // Usage arrives in the final frame, so the tail of the stream is kept
        // rather than the whole answer: enough to read the report, bounded.
        let usageTail = ''
        const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
        body.on('data', (chunk: Buffer) => {
          if (chunk.includes('[DONE]')) {
            sawDone = true
            const usage = usageOf(usageTail)
            if (usage !== undefined && model !== undefined) {
              pool.noteModelCost(accountId, model, usage.credit, usage.totalTokens)
            }
          }
          usageTail = (usageTail + chunk.toString('utf8')).slice(-4096)
        })
        body.on('error', (error: unknown) => {
          logger?.warn('dsh-workbuddy2api: upstream stream failed mid-flight', error)
          if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
        })
        body.pipe(res)
        return
      }

      // A transport failure (status 0) carries no upstream verdict, so it is
      // reported without a kind: the pool counts it toward degradation rather
      // than tripping the breaker on a local network hiccup.
      pool.report(accountId, {
        ok: false,
        ...result.status === 0 ? {} : { kind: result.kind },
        message: result.message,
        ...model === undefined ? {} : { model },
        // The upstream's own statements about when the limit lifts travel with
        // the failure, so the pool can honour them rather than guess.
        ...result.resetAtMs === undefined ? {} : { resetAtMs: result.resetAtMs },
        ...result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs },
      })
      // Counters moved (a failure, and possibly a cooldown/breaker transition).
      onDispatch?.()
      lastFailure = { status: KIND_STATUS[result.kind], kind: result.kind, message: result.message }
      if (!RETRYABLE.has(result.kind) || controller.signal.aborted) break
      logger?.warn(
        `dsh-workbuddy2api: account ${accountId} failed with ${result.kind}; retrying on another account`,
      )
    }

    if (lastFailure !== undefined) {
      writeOpenAIError(
        res,
        lastFailure.status,
        lastFailure.kind,
        `workbuddy upstream ${lastFailure.kind} (http ${lastFailure.status}): ${lastFailure.message.slice(0, 400)}`,
      )
      return
    }
    writeOpenAIError(res, 503, 'pool-exhausted', 'every WorkBuddy account failed for this request')
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}
