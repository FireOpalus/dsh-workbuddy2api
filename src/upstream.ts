/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
 * token refresh, model catalog, credit balance, and daily check-in.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 本文件的 wire 行为逐项沿用该项目（其上游协议本身参照
 *     Sliverkiss/workbuddy2api (MIT) 与 corrinehu/dsh-workbuddy-connect (MIT)）：
 *     按 domain 选择 CN/global base、强制 stream:true、tool_choice 压平为
 *     字符串、developer→system 角色改写、CLI 形态请求头、
 *     chat 请求绝不携带 refresh token 的安全红线、中英文额度不足标记与
 *     错误分类、token 刷新的 X-Refresh-Token 头、模型目录的两种文档形态、
 *     积分套餐的月度/一次性判定。
 * 改动：
 *   1. 模型目录改为「双区域择新」——本插件同时持有两个区域的账号，
 *      单一区域的目录会让另一区域的账号看不到自己的模型，因此按账号
 *      所属区域取各自文档，并把两边的结果合并成一份目录（见
 *      `WorkBuddyUpstreamClient.fetchModelsForAnyRegion`）；
 *   2. 新增 `WorkBuddyModelCatalog`：账号池要为每个账号解析出可用模型
 *     集合，因此把「解析 → 去重」独立成可复用的解析器；
 *   3. 错误分类补上 `UpstreamErrorKind` 到账号池状态迁移所需的
 *     判定（额度不足 / 会话失效 / 限流），供 pool 直接消费。
 *
 * @module dsh-workbuddy2api/upstream
 */

import { createHash } from 'node:crypto'
import type { WorkBuddyCredential } from './auth.ts'

/** WorkBuddy region selected by the credential's login domain. */
export type WorkBuddyRegion = 'cn' | 'global'

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'not_found'
  | 'server'
  | 'client'

/** Reasoning capability as the upstream catalog declares it. */
export interface WorkBuddyReasoning {
  supportedEfforts?: readonly string[]
  defaultEffort?: string
  canDisableThinking?: boolean
}

/** One CLI-usable model, carrying everything the plugin card displays. */
export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /** Credit multiplier parsed from the upstream `credits` string. */
  creditMultiplier?: number
  /**
   * Image-input support decided by the user's explicit selection
   * (imageModelIds), not inferred from upstream capability flags.
   */
  multimodal?: boolean
  reasoning?: WorkBuddyReasoning
  descriptionZh?: string
  descriptionEn?: string
  supportsToolCall?: boolean
}

/** One billing package as the upstream returns it, dates already parsed. */
export interface WorkBuddyCreditPackage {
  packageName: string
  remain: number
  size: number
  /** CapacityType 4: refreshed every cycle and never expires. */
  monthly: boolean
  /** Next cycle start (the monthly refresh point); only on monthly packages. */
  refreshAtMs?: number
  /** One-off expiry; the package disappears from the account at this time. */
  expiresAtMs?: number
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyCredits {
  total: number
  packages: readonly WorkBuddyCreditPackage[]
  /** Credits expiring within 3 days across every package. */
  expiringSoon: number
  /** When the nearest package expires, in ms. */
  nearestExpiryMs?: number
}

/** Daily check-in activity state. */
export interface WorkBuddyCheckinStatus {
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  isStreakDay: boolean
  nextStreakDay: number
  streakBonusDays: number
  streakBonusCredit: number
  claimButtonText?: string
}

/** Daily check-in claim result. */
export interface WorkBuddyCheckinClaim {
  credit: number
  streakDays: number
  isStreakDay: boolean
}

/** Token refresh answer; fields the upstream omits stay absent. */
export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

/** Chat answer: either a live SSE response or a classified failure. */
export type WorkBuddyChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: UpstreamErrorKind; message: string }

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
/** Product origin (the growth centre and its reward endpoints live here). */
const CN_WEB_BASE = 'https://www.workbuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/** Growth-domain paths: the task list, registration, and the report channel. */
const TASKS_LIST_PATH = '/v2/activity/growth/tasks'
const TASKS_ACCEPT_PATH = '/v2/activity/growth/tasks/accept'
const REPORT_PATH = '/v2/report'

/** Browser user agent used by the web-fingerprint report channel. */
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)'
  + ' Chrome/152.0.0.0 Safari/537.36'

/** Model-catalog path used by the CN region. */
const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models'

/** Remote product-config path on the global gateway (desktop channel). */
const GLOBAL_CONFIG_PATH = '/v3/config'

const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
/** User agent of the WorkBuddy desktop app (see dsh-connect-workbuddy). */
const DESKTOP_UA = 'WorkBuddy/5.5.2'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', '12153']

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'client'
}

/**
 * Region for a login domain; an empty domain means CN. The international
 * product is reachable under TWO brand domains (`workbuddy.ai` desktop and
 * `codebuddy.ai` CLI), both served by the same gateway stack.
 */
export function regionOf(domain: string): WorkBuddyRegion {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  return 'cn'
}

/**
 * Gateway for a global credential. International accounts are NOT
 * interchangeable across brand domains, so the base follows the credential's
 * OWN domain; anything unrecognised falls back to the desktop gateway.
 */
export function globalBase(domain: string): string {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return GLOBAL_BASE
}

function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    // 安全红线：chat 请求绝不携带 refresh token。
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-Product': 'SaaS',
  }
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers. */
function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
 * force `stream: true` (the upstream rejects non-streaming), rewrite DSH's
 * `developer` role to `system`, and flatten `tool_choice`.
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  if (Array.isArray(obj['messages'])) {
    for (const value of obj['messages']) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const message = value as Record<string, unknown>
      if (message['role'] === 'developer') message['role'] = 'system'
    }
  }
  normalizeToolChoice(obj)
  return JSON.stringify(obj)
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj['tools']
    delete obj['functions']
  }
  if (!('tool_choice' in obj)) return
  const choice: unknown = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
    } else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
        ? (wrapped['function'] as Record<string, unknown>)
        : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
    } else {
      delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
  code: number
  msg: string
  data: unknown
}

/**
 * Gateway (openresty/APISIX) rejection of a token it no longer accepts: the
 * business APIs answer JSON, an edge rejection answers an HTML error page.
 */
function isGatewayAuthRejection(status: number, text: string): boolean {
  if (status !== 401 && status !== 403) return false
  const lower = text.toLowerCase()
  return lower.includes('openresty') || lower.includes('apisix') || lower.includes('authorization required')
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    if (isGatewayAuthRejection(response.status, text)) {
      throw new Error(
        `workbuddy: the signed-in credential was rejected by the upstream gateway (http ${response.status}).`
        + ' The stored token is no longer accepted — most likely a stale credential file from an earlier'
        + ' sign-in was selected. Re-sign in to the WorkBuddy desktop app, then refresh the account pool'
        + ' in the plugin card.',
      )
    }
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status: number, envelope: Envelope): Error {
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`)
}

/**
 * Parse the upstream's `credits` string into a multiplier. Observed forms:
 * `"x0.79 credits"`, `"x0.05"`, `"x0.00 credits"`, and absent. Unparsable
 * values yield undefined rather than a guess.
 */
export function parseCreditMultiplier(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value)
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * The effort vocabulary the upstream's plural-form payloads declare across
 * both gateways; the singular `effort` value is a DEFAULT, never the model's
 * only level.
 */
const SINGULAR_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** The singular spelling of reasoning metadata: `effort` and none of the plural fields. */
function isSingularEffortForm(raw: Record<string, unknown>): boolean {
  return typeof raw['effort'] === 'string'
    && !Array.isArray(raw['supportedEfforts'])
    && typeof raw['defaultEffort'] !== 'string'
    && typeof raw['canDisableThinking'] !== 'boolean'
}

/** Fold a singular-form `effort` into the plural shape the rest of the plugin understands. */
function singularEffortLadder(raw: Record<string, unknown>): string[] | undefined {
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  if (effort === undefined) return undefined
  return (SINGULAR_EFFORT_LADDER as readonly string[]).includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort]
}

/** Parse the upstream's `reasoning` object; unknown shapes degrade to undefined. */
export function parseReasoning(value: unknown): WorkBuddyReasoning | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  const supportedEfforts = Array.isArray(raw['supportedEfforts'])
    ? raw['supportedEfforts'].filter((entry): entry is string => typeof entry === 'string')
    : singularEffortLadder(raw)
  const defaultEffort = typeof raw['defaultEffort'] === 'string' ? raw['defaultEffort'] : effort
  const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean'
    ? raw['canDisableThinking']
    : isSingularEffortForm(raw) ? true : undefined
  if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) {
    return undefined
  }
  return {
    ...supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    ...canDisableThinking === undefined ? {} : { canDisableThinking },
  }
}

/** Parse one catalog entry; entries without usable token limits are dropped. */
export function parseUpstreamModel(value: unknown): WorkBuddyUpstreamModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  if (id === '' || raw['disabled'] === true) return undefined
  const input = typeof raw['maxInputTokens'] === 'number' ? raw['maxInputTokens'] : 0
  const output = typeof raw['maxOutputTokens'] === 'number' ? raw['maxOutputTokens'] : 0
  if (input <= 0 || output <= 0) return undefined
  const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id
  const descriptionZh = typeof raw['descriptionZh'] === 'string' && raw['descriptionZh'] !== '' ? raw['descriptionZh'] : undefined
  const descriptionEn = typeof raw['descriptionEn'] === 'string' && raw['descriptionEn'] !== '' ? raw['descriptionEn'] : undefined
  const creditMultiplier = parseCreditMultiplier(raw['credits'])
  const reasoning = parseReasoning(raw['reasoning'])
  const supportsToolCall = typeof raw['supportsToolCall'] === 'boolean' ? raw['supportsToolCall'] : undefined
  return {
    id,
    name,
    contextWindow: input,
    maxTokens: output,
    ...creditMultiplier === undefined ? {} : { creditMultiplier },
    ...reasoning === undefined ? {} : { reasoning },
    ...descriptionZh === undefined ? {} : { descriptionZh },
    ...descriptionEn === undefined ? {} : { descriptionEn },
    ...supportsToolCall === undefined ? {} : { supportsToolCall },
  }
}

/**
 * Select the chat-capable models from a catalog-shaped document: parse every
 * entry, then keep the `cli` agent's roster in its declared order. Without a
 * usable `cli` roster the whole parsed catalog is exposed rather than nothing.
 */
export function selectCliModels(rawModels: unknown, agents: unknown): WorkBuddyUpstreamModel[] {
  const byId = new Map<string, WorkBuddyUpstreamModel>()
  for (const model of Array.isArray(rawModels) ? rawModels : []) {
    const parsed = parseUpstreamModel(model)
    if (parsed !== undefined) byId.set(parsed.id, parsed)
  }
  let cliIds: readonly string[] | undefined
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (typeof agent === 'object' && agent !== null) {
      const wrapped = agent as Record<string, unknown>
      if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
        cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
        break
      }
    }
  }
  const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()]
  const models = ids
    .map(id => byId.get(id))
    .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
  if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
  return models
}


/**
 * Parse one growth task. The progress shape varies by task type: some entries
 * carry a nested `progress: {current,target}` object and others flat
 * `current`/`target` fields, so both are read and the nested one wins when it
 * carries a real value.
 */
export function parseUpstreamTask(value: unknown): WorkBuddyTask | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const taskCode = typeof raw['task_code'] === 'string' ? raw['task_code'] : ''
  if (taskCode === '') return undefined
  const numberField = (source: Record<string, unknown>, key: string): number =>
    typeof source[key] === 'number' ? source[key] as number : 0
  let current = numberField(raw, 'current')
  let target = numberField(raw, 'target')
  const progress = raw['progress']
  if (typeof progress === 'object' && progress !== null && !Array.isArray(progress)) {
    const nested = progress as Record<string, unknown>
    const nestedCurrent = numberField(nested, 'current')
    const nestedTarget = numberField(nested, 'target')
    if (nestedTarget > 0 || nestedCurrent > 0) {
      current = nestedCurrent
      target = nestedTarget
    }
  }
  const acceptStatus = typeof raw['accept_status'] === 'string' ? raw['accept_status'] : undefined
  const claimed = acceptStatus === 'claimed'
  const text = (key: string): string | undefined =>
    typeof raw[key] === 'string' && (raw[key] as string) !== '' ? raw[key] as string : undefined
  const title = text('title')
  const description = text('description')
  const taskDesc = text('task_desc')
  const taskType = text('task_type')
  const tag = text('tag')
  const jumpUrl = text('jump_url')
  const status = text('status')
  return {
    taskCode,
    ...title === undefined ? {} : { title },
    ...description === undefined ? {} : { description },
    ...taskDesc === undefined ? {} : { taskDesc },
    credit: numberField(raw, 'reward_credit'),
    energy: numberField(raw, 'reward_energy'),
    hasReward: raw['has_reward'] === true,
    ...taskType === undefined ? {} : { taskType },
    ...tag === undefined ? {} : { tag },
    ...jumpUrl === undefined ? {} : { jumpUrl },
    locked: raw['locked'] === true,
    target,
    current,
    ...acceptStatus === undefined ? {} : { acceptStatus },
    ...status === undefined ? {} : { status },
    claimable: !claimed && target > 0 && current >= target,
    claimed,
  }
}

/** One growth task as the upstream returns it, progress already normalized. */
export interface WorkBuddyTask {
  taskCode: string
  title?: string
  description?: string
  taskDesc?: string
  /** Reward in credits. */
  credit: number
  /** Reward in energy. */
  energy: number
  hasReward: boolean
  taskType?: string
  tag?: string
  jumpUrl?: string
  locked: boolean
  target: number
  current: number
  acceptStatus?: string
  status?: string
  /** Progress reached and reward not taken (computed locally). */
  claimable: boolean
  /** Reward already taken (accept_status == "claimed"). */
  claimed: boolean
}

/** A reward the gateway paid out. */
export interface WorkBuddyTaskReward {
  credit: number
  energy: number
  /** The gateway says this reward was taken before; no new credits. */
  alreadyClaimed: boolean
}

/** A desktop-fingerprint event; the shared fingerprint is merged in on send. */
export type WorkBuddyDesktopEvent = Record<string, unknown>

/** The desktop fingerprint every report event carries. */
function desktopFingerprint(credential: WorkBuddyCredential): Record<string, unknown> {
  const now = Date.now()
  const derive = (salt: string): string =>
    createHash('sha256').update(salt + ':' + credential.uid).digest('hex').slice(0, 36)
  return {
    timezone: 'Asia/Shanghai',
    reportDelay: 2000,
    userId: credential.uid,
    username: credential.nickname ?? '',
    userNickname: credential.nickname ?? '',
    product: 'SaaS',
    releaseDate: 1789036585355,
    commit: '5f9692923c93033111c51ad7b003eb80204a9b75',
    ideName: 'WorkBuddy',
    ideType: 'WorkBuddy',
    ideVersion: '5.5.6',
    machineId: derive('machine'),
    sessionId: derive('session'),
    extName: 'workbuddy-desktop',
    extVersion: '5.5.6',
    os: 'win32',
    arch: 'x64',
    osVersion: '10.0.26220',
    cpuCores: 20,
    memorySize: 24,
    timestamp: now,
    presentAt: now,
  }
}

/**
 * Build the full chat_request_send event the desktop client sends. The minimal
 * three-field shape is NOT accepted: the gateway answers 200 and silently drops
 * an event whose field set or userId does not match the client's, which would
 * make a task look "reported but never scored".
 */
function chatRequestEvent(
  credential: WorkBuddyCredential,
  conversationId: string,
  requestId: string,
  modelId: string,
  modelName: string,
): Record<string, unknown> {
  const now = Date.now()
  return {
    eventCode: 'chat_request_send',
    timestamp: now,
    reportDelay: 0,
    mode: 'craft',
    conversationId,
    requestId,
    inputLength: 12,
    requestModelId: modelId,
    requestModelName: modelName,
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: '',
    mentionContextCount: 0,
    command: '',
    expertId: '',
    recommendId: '',
    skillId: '',
    skillCount: 0,
    totalCount: 0,
    fileUri: '',
    presentAt: now,
    traceId: '',
    rootRequestId: requestId,
    parentConversationId: conversationId,
    agentName: 'default',
    agentType: 'conversation',
    userId: credential.uid,
  }
}

/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 */
export class WorkBuddyUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: bodyJson,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (accessToken === '') throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
    const outcome: WorkBuddyRefreshOutcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
    return outcome
  }

  /**
   * Read the model directory for the credential's region. CN answers
   * `/v2/enterprises/personal/models`; the global gateway answers `/v3/config`
   * for the desktop channel (its personal-models path returns HTTP 500 and the
   * CLI channel omits chat-usable models).
   */
  async fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]> {
    const timeout = signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS)
    if (regionOf(credential.domain) === 'global') {
      const response = await fetch(`${globalBase(credential.domain)}${GLOBAL_CONFIG_PATH}`, {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          ...credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
          ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
          'X-Product': 'SaaS',
          'X-Requested-With': 'XMLHttpRequest',
          'Connection': 'close',
          'User-Agent': DESKTOP_UA,
        },
        signal: timeout,
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const data = typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data as Record<string, unknown>
        : {}
      return selectCliModels(data['models'], data['agents'])
    }
    const response = await fetch(`${chatBase(credential)}${MODELS_CATALOG_PATH}`, {
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        'Origin': originReferer(credential),
        'Referer': `${originReferer(credential)}/`,
        'User-Agent': CLIENT_UA,
      },
      signal: timeout,
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    return selectCliModels(data['models'], data['agents'])
  }

  /**
   * Read ONE region's pooled accounts' directories and merge them into that
   * region's catalog.
   *
   * Every credential handed in must belong to the same region: this method
   * merges on model id, and the upstream reuses ids across regions for models
   * that are billed differently (`deepseek-v4.1-flash` is x0.00 on the
   * international gateway and x0.03 on the domestic one). Merging across
   * regions would therefore let one side's rate silently replace the other's,
   * which is exactly the bug the two-pool split exists to prevent. The region is
   * asserted rather than assumed so a caller mistake fails loudly.
   *
   * Accounts are queried in parallel and a failing account never fails the
   * merge: the catalog is what the pool can actually serve, so one expired
   * sign-in must not blank the model picker. When EVERY account fails the first
   * real cause is thrown instead of returning an empty catalog.
   */
  async fetchModelsForCredentials(
    credentials: readonly WorkBuddyCredential[],
    signal?: AbortSignal,
  ): Promise<WorkBuddyUpstreamModel[]> {
    if (credentials.length === 0) throw new Error('workbuddy: no signed-in account to read a model catalog from')
    const regions = new Set(credentials.map(credential => regionOf(credential.domain)))
    if (regions.size > 1) {
      throw new Error(
        `workbuddy: refusing to merge model catalogs across regions (${[...regions].join(', ')});`
        + ' each region owns a separate pool and a separate directory',
      )
    }
    const settled = await Promise.allSettled(credentials.map(credential => this.fetchModels(credential, signal)))
    const byId = new Map<string, WorkBuddyUpstreamModel>()
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue
      for (const model of result.value) {
        // Within one region a repeated id is the same model advertised by several
        // accounts; the first account's copy wins, which keeps the listing stable
        // as the pool is reordered.
        if (!byId.has(model.id)) byId.set(model.id, model)
      }
    }
    if (byId.size === 0) {
      const failure = settled.find(result => result.status === 'rejected')
      throw failure !== undefined && failure.status === 'rejected'
        ? failure.reason
        : new Error('workbuddy: every account returned an empty model catalog')
    }
    return [...byId.values()]
  }

  /** Query today's check-in status without changing account state. */
  async fetchCheckinStatus(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinStatus> {
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    return {
      active: data['active'] === true,
      todayCheckedIn: data['today_checked_in'] === true,
      streakDays: numberField('streak_days'),
      dailyCredit: numberField('daily_credit'),
      todayCredit: numberField('today_credit'),
      isStreakDay: data['is_streak_day'] === true,
      nextStreakDay: numberField('next_streak_day'),
      streakBonusDays: numberField('streak_bonus_days'),
      streakBonusCredit: numberField('streak_bonus_credit'),
      ...typeof data['claim_button_text'] === 'string' && data['claim_button_text'] !== ''
        ? { claimButtonText: data['claim_button_text'] }
        : {},
    }
  }

  /** Claim today's check-in reward. The browser route guards this mutation. */
  async claimDailyCheckin(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinClaim> {
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    return {
      credit: numberField('credit'),
      streakDays: numberField('streak_days'),
      isStreakDay: data['is_streak_day'] === true,
    }
  }

  /**
   * POST the billing endpoint for the remaining credit, keeping every package
   * separate: the card groups monthly-cycle packages itself and lists the
   * nearest-expiring one-off packages, so aggregation here would lose the
   * dates it needs.
   */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    const now = new Date()
    const format = (date: Date): string => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const responseWrapper = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const data = typeof responseWrapper['Response'] === 'object' && responseWrapper['Response'] !== null
      ? responseWrapper['Response'] as Record<string, unknown>
      : {}
    const inner = typeof data['Data'] === 'object' && data['Data'] !== null
      ? data['Data'] as Record<string, unknown>
      : {}
    const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []

    let total = 0
    let nearestExpiryMs: number | undefined
    let expiringSoon = 0
    const SOON_MS = 3 * 24 * 60 * 60 * 1000
    const parseDate = (raw: unknown): number | undefined => {
      if (typeof raw === 'number' && raw > 1_000_000_000_000) return raw
      if (typeof raw === 'string' && raw !== '') {
        const parsed = Date.parse(raw)
        if (!Number.isNaN(parsed)) return parsed
      }
      return undefined
    }
    const packages: WorkBuddyCreditPackage[] = []
    for (const raw of rawAccounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw as Record<string, unknown>
      const numberField = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
      // CapacityType 4 = monthly capacity resource (refreshed every cycle,
      // never expires). CapacityType 1 = deduction-based gift that drains.
      const monthly = numberField('CapacityType') === 4
      const size = monthly ? numberField('CycleCapacitySize') : numberField('CapacitySize')
      const remain = monthly ? numberField('CycleCapacityRemain') : numberField('CapacityRemain')
      const cappedRemain = remain < 0 ? 0 : remain
      const cycleEndMs = parseDate(account['CycleEndTime'])
      const expiresAtMs = monthly ? undefined : parseDate(account['ExpiredTime']) ?? cycleEndMs
      const refreshAtMs = monthly
        ? cycleEndMs === undefined ? undefined : cycleEndMs + 1_000
        : undefined
      if (!monthly && (cappedRemain <= 0 || (expiresAtMs !== undefined && expiresAtMs <= Date.now()))) {
        continue
      }
      total += cappedRemain
      const expiryMs = expiresAtMs
      if (expiryMs !== undefined) {
        if (nearestExpiryMs === undefined || expiryMs < nearestExpiryMs) nearestExpiryMs = expiryMs
        if (expiryMs - Date.now() <= SOON_MS) expiringSoon += cappedRemain
      }
      packages.push({
        packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
        remain: cappedRemain,
        size,
        monthly,
        ...refreshAtMs === undefined ? {} : { refreshAtMs },
        ...expiresAtMs === undefined ? {} : { expiresAtMs },
      })
    }
    return {
      total,
      packages,
      expiringSoon,
      ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs },
    }
  }

  /**
   * Read the growth task list. This is the whole task surface: accept, claim,
   * and every "did it score yet" read all key off it.
   */
  async listTasks(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<WorkBuddyTask[]> {
    const response = await fetch(chatBase(credential) + TASKS_LIST_PATH, {
      headers: { ...billingHeaders(credential), 'Accept': 'application/json' },
      signal: signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const raw = Array.isArray(data['tasks']) ? data['tasks'] : []
    const tasks: WorkBuddyTask[] = []
    for (const entry of raw) {
      const parsed = parseUpstreamTask(entry)
      if (parsed !== undefined) tasks.push(parsed)
    }
    return tasks
  }

  /** Register for tasks (idempotent: an already-accepted task is not an error). */
  async acceptTasks(credential: WorkBuddyCredential, taskCodes: readonly string[]): Promise<void> {
    if (taskCodes.length === 0) return
    const response = await fetch(chatBase(credential) + TASKS_ACCEPT_PATH, {
      method: 'POST',
      headers: { ...billingHeaders(credential), 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_codes: [...taskCodes] }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /**
   * Take one task's reward.
   *
   * The path matters and is NOT the CLI one: the reward endpoint lives on the
   * WEB origin (`workbuddy.cn/activity/growth/tasks/<code>/claim`, task code in
   * the path, `x-client-platform: web`). The CLI-shaped
   * `copilot.tencent.com/v2/activity/growth/tasks/reward/claim` does not exist
   * and answers "task not completed" for every task.
   */
  async claimTaskReward(credential: WorkBuddyCredential, taskCode: string): Promise<WorkBuddyTaskReward> {
    const base = regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_WEB_BASE
    const response = await fetch(base + '/activity/growth/tasks/' + encodeURIComponent(taskCode) + '/claim', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + credential.accessToken,
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Origin': base,
        'Referer': base + '/profile/growth-center',
        'x-client-platform': 'web',
        ...credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
        ...credential.enterpriseId === undefined || credential.enterpriseId === ''
          ? {}
          : { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId },
        ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
      },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    const alreadyClaimed = data['already_claimed'] === true
    return alreadyClaimed
      ? { credit: 0, energy: 0, alreadyClaimed: true }
      : { credit: numberField('credit'), energy: numberField('energy'), alreadyClaimed: false }
  }

  /**
   * Report one conversation-activity event (chat_request_send). This is what
   * actually lights up most tasks — registering for a task produces no
   * progress; the gateway scores behavior events.
   */
  async reportChatActivity(
    credential: WorkBuddyCredential,
    conversationId: string,
    requestId: string,
    model?: { id: string; name: string },
  ): Promise<void> {
    const event = chatRequestEvent(
      credential,
      conversationId,
      requestId === '' ? conversationId : requestId,
      model?.id ?? 'deepseek-v4-flash',
      model?.name ?? 'DeepSeek V4 Flash',
    )
    await this.reportEvents(credential, CN_BILLING_BASE, [event], 'cli')
  }

  /** Report desktop-fingerprint events to the chat origin's /v2/report. */
  async reportDesktopEvents(
    credential: WorkBuddyCredential,
    events: readonly WorkBuddyDesktopEvent[],
  ): Promise<void> {
    if (events.length === 0) return
    const fingerprint = desktopFingerprint(credential)
    const payload = events.map(event => ({ ...fingerprint, ...event }))
    await this.reportEvents(credential, chatBase(credential), payload, 'desktop')
  }

  /** Report web-fingerprint events to the product's own origin. */
  async reportWebEvents(
    credential: WorkBuddyCredential,
    events: readonly WorkBuddyDesktopEvent[],
  ): Promise<void> {
    if (events.length === 0) return
    const base = regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_WEB_BASE
    await this.reportEvents(credential, base, events, 'web')
  }

  /**
   * POST one batch of events. The three channels differ only in origin and
   * headers: the CLI/billing channel authenticates with the billing headers,
   * the desktop one mimics the app, and the web one mimics the growth centre.
   */
  private async reportEvents(
    credential: WorkBuddyCredential,
    base: string,
    events: readonly WorkBuddyDesktopEvent[],
    channel: 'cli' | 'desktop' | 'web',
  ): Promise<void> {
    const headers: Record<string, string> = channel === 'cli'
      ? { ...billingHeaders(credential), 'Content-Type': 'application/json' }
      : channel === 'desktop'
        ? {
          'Authorization': 'Bearer ' + credential.accessToken,
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json;charset=UTF-8',
          'User-Agent': DESKTOP_UA,
          'X-Domain': base,
          'X-Product': 'SaaS',
          'X-Request-ID': createHash('sha256').update('req:' + credential.uid).digest('hex').slice(0, 36)
            + String(Date.now() % 1_000_000),
          ...credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
        }
        : {
          'Authorization': 'Bearer ' + credential.accessToken,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-client-platform': 'web',
          'Origin': base,
          'Referer': base + '/',
          'User-Agent': WEB_UA,
          ...credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
        }
    const response = await fetch(base + REPORT_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }
}
