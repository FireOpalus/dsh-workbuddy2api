/**
 * Node-free constants and types shared by the Host and browser halves.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 「同源只读路由 + 一份与浏览器共享的 node-free 类型定义」的 host↔client
 *     桥梁形态来自该项目（其源自 dsh-connect-trae，并注明沿用
 *     corrinehu/dsh-workbuddy-connect 的 status-route 模式）。
 * 改动：
 *   1. 文档结构从「一个账号 + 一份目录」改成「账号池 + 每账号健康 + 一份目录」；
 *   2. 区域（cn | global）从可选字段升级为路由、配置与 provider 的主键 ——
 *      国内版与国际版是两个独立账号池、两个独立 provider、两份独立目录。
 *
 * @module dsh-workbuddy2api/status-paths
 */

/** Plugin-owned usage endpoint consumed by its browser half. */
export const WORKBUDDY2API_USAGE_PATH = '/plugins/dsh-workbuddy2api/usage'
/** Plugin-owned live model refresh endpoint. */
export const WORKBUDDY2API_MODELS_REFRESH_PATH = '/plugins/dsh-workbuddy2api/models/refresh'
/** Plugin-owned local account rescan endpoint. */
export const WORKBUDDY2API_ACCOUNTS_REFRESH_PATH = '/plugins/dsh-workbuddy2api/accounts/refresh'
/** Plugin-owned per-account credit refresh endpoint. */
export const WORKBUDDY2API_CREDITS_REFRESH_PATH = '/plugins/dsh-workbuddy2api/credits/refresh'
/** Plugin-owned daily check-in action endpoint. */
export const WORKBUDDY2API_CHECKIN_PATH = '/plugins/dsh-workbuddy2api/checkin'
/** Plugin-owned pool control endpoint (reset / release). */
export const WORKBUDDY2API_POOL_ACTION_PATH = '/plugins/dsh-workbuddy2api/pool'
/** Plugin-owned web sign-in start endpoint: returns an authorization URL. */
export const WORKBUDDY2API_LOGIN_START_PATH = '/plugins/dsh-workbuddy2api/login/start'
/** Plugin-owned web sign-in poll endpoint: reports progress and finishes it. */
export const WORKBUDDY2API_LOGIN_POLL_PATH = '/plugins/dsh-workbuddy2api/login/poll'

/** Query parameter carrying the sign-in state a poll addresses. */
export const WORKBUDDY2API_STATE_PARAM = 'state'

/** Plugin-owned growth-task list endpoint. */
export const WORKBUDDY2API_TASKS_PATH = '/plugins/dsh-workbuddy2api/tasks'
/** Plugin-owned growth-task run endpoint (one-click finish). */
export const WORKBUDDY2API_TASKS_RUN_PATH = '/plugins/dsh-workbuddy2api/tasks/run'

/** Query parameter naming the account a card request addresses. */
export const WORKBUDDY2API_ACCOUNT_PARAM = 'accountId'

/** Query parameter naming the REGION (i.e. which pool) a card request addresses. */
export const WORKBUDDY2API_REGION_PARAM = 'region'

/**
 * Both regions, in tab order.
 *
 * The two regions are NOT a display grouping: each owns a separate account
 * pool, a separate provider route, and a separate model directory. They must
 * stay separate because the upstream reuses one model id for different things
 * per region — `deepseek-v4.1-flash` is a free promotional model on the
 * international gateway and a paid one on the domestic gateway — so merging
 * the two directories silently replaces one region's rate with the other's.
 */
export const WORKBUDDY2API_REGIONS: readonly WorkBuddyWebRegion[] = ['cn', 'global']

/**
 * Address one region's status route. Every card request carries the region
 * whose tab the user is on, so a tab can only ever read and write its own
 * pool, credits, and model slot.
 */
export function withWorkBuddyRegion(path: string, region: WorkBuddyWebRegion): string {
  return `${path}?${WORKBUDDY2API_REGION_PARAM}=${region}`
}

/**
 * Read the region parameter off a status-route URL. Absent means the domestic
 * tab (`cn`); a present-but-unknown value returns undefined so the route can
 * answer 400 instead of silently addressing the wrong pool.
 */
export function regionOfStatusUrl(url: string): WorkBuddyWebRegion | undefined {
  const at = url.indexOf('?')
  const value = at === -1 ? null : new URLSearchParams(url.slice(at + 1)).get(WORKBUDDY2API_REGION_PARAM)
  if (value === null || value === '') return 'cn'
  return (WORKBUDDY2API_REGIONS as readonly string[]).includes(value) ? value as WorkBuddyWebRegion : undefined
}

/**
 * Region of the signed-in credential: the CN app (`codebuddy.cn` /
 * `workbuddy.cn`) or the international WorkBuddy AI app (`workbuddy.ai` /
 * `codebuddy.ai`). The card uses this to pick the pool and model slot a tab
 * reads and writes.
 */
export type WorkBuddyWebRegion = 'cn' | 'global'

/** One credit package as the upstream returns it, node-free. */
export interface WorkBuddyWebCreditPackage {
  packageName: string
  remain: number
  size: number
  /** CapacityType 4: refreshed every cycle and never expires. */
  monthly: boolean
  /** Next cycle start (the monthly refresh point) in ms. */
  cycleRefreshMs?: number
  /** One-off expiry in ms; the package disappears from the account then. */
  expiresAtMs?: number
}

/** Aggregated credit answer rendered by the plugin card. */
export interface WorkBuddyWebCredits {
  total: number
  /**
   * The allowance `total` is measured against, for the card's remaining-share
   * ring. 0 means "unknown", never "empty".
   */
  capacity: number
  packages: readonly WorkBuddyWebCreditPackage[]
  /** Credits expiring within 3 days across every package. */
  expiringSoon: number
  /** When the nearest package expires, in ms. */
  nearestExpiryMs?: number
}

/** Daily check-in state rendered next to an account's credits. */
export interface WorkBuddyWebCheckin {
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

/** Editable WorkBuddy model row rendered by the plugin-owned settings card. */
export interface WorkBuddyWebModel {
  id: string
  name: string
  /** Effective DSH context after applying the saved local budget. */
  contextWindow: number
  /** Native maximum advertised by WorkBuddy; models above 200K expose 200K/max. */
  nativeContextWindow: number
  maxTokens: number
  creditMultiplier?: number
  multimodal?: boolean
  reasoning?: {
    supportedEfforts?: readonly string[]
    defaultEffort?: string
  }
  description?: string
}

/**
 * Project one card row into its persisted `lastCatalog` shape: the native
 * context window becomes the stored `contextWindow`, and the card-only
 * presentation fields (`nativeContextWindow`, `multimodal`) are removed BY
 * KEY. They must never be set to `undefined`: explicit `undefined` values
 * survive `structuredClone` and are rejected by the settings write path's
 * strict JSON codec, which fails the whole save.
 */
export function toPersistedWorkBuddyModel(
  model: WorkBuddyWebModel,
): Omit<WorkBuddyWebModel, 'nativeContextWindow' | 'multimodal'> {
  const { nativeContextWindow, multimodal: _cardOnly, ...rest } = model
  return { ...rest, contextWindow: nativeContextWindow }
}

/** One selectable local account, token-free. */
export interface WorkBuddyWebAccount {
  id: string
  accountName: string
  uin?: string
  domain: string
  region: WorkBuddyWebRegion
  source: 'desktop' | 'dsh'
  tokenExpiresAtMs: number
  /** Whether this account's pool currently counts it as enabled. */
  enabled: boolean
  /** Whether a credential file for this account is still on disk. */
  present: boolean
}

/** One account's pool health, as the card renders it. */
export interface WorkBuddyWebPoolEntry {
  accountId: string
  accountName: string
  region: WorkBuddyWebRegion
  enabled: boolean
  weight: number
  priority: number
  state: 'ready' | 'cooldown' | 'degraded' | 'missing' | 'disabled'
  cooldownUntil?: number
  cooldownKind?: 'soft' | 'hard'
  breakerUntil?: number
  degradedUntil?: number
  inFlight: number
  successes: number
  failures: number
  consecutiveFailures: number
  cooldownCount: number
  lastUsedAt?: number
  lastSuccessAt?: number
  lastErrorAt?: number
  lastError?: string
  credits?: number
  creditsAtMs?: number
  creditsExpiringSoon?: number
  /** The allowance `credits` is measured against; 0 means "unknown". */
  creditsCapacity?: number
  /**
   * Per-model refusals currently in force: a 6004 rate limit or an 11102
   * "this backend has no such model". Listed so a model that keeps failing is
   * visible as the MODEL's problem rather than the account looking broken.
   */
  modelCooldowns?: readonly { model: string; untilMs: number; reason: string; hits: number }[]
  present: boolean
  tokenExpiresAtMs: number
}

/** One account's credit panel document. */
export interface WorkBuddyWebAccountCredits {
  accountId: string
  credits?: WorkBuddyWebCredits
  creditsError?: string
  checkin?: WorkBuddyWebCheckin
  checkinError?: string
}

export type WorkBuddyWebPackage = WorkBuddyWebCreditPackage

/**
 * The persisted per-account pool slice. Declared node-free because the browser
 * half saves it back verbatim through `settingsScope`; `pool.ts` owns the
 * semantics and the host writes the values.
 */
export interface WorkBuddyPoolStateRecord {
  accountId: string
  enabled: boolean
  weight: number
  priority: number
  // Deliberately NOT the dispatch counters or cached credits: those are RUNTIME
  // facts the host updates on every request, and this document is written by the
  // CARD under settings revision checks. Two writers on one document means one
  // clobbers the other — a card save would wipe whatever the host just recorded.
  // The counters live in the host-owned $DSH_HOME/.workbuddy2api-pool-state.json
  // (see pool-state.ts) and survive a restart from there.
  cooldownUntil?: number
  cooldownKind?: 'soft' | 'hard'
  cooldownCount?: number
  breakerUntil?: number
  degradedUntil?: number
}

/** The card's view of the persisted pool slice: the same document. */
export type WorkBuddyWebPoolState = WorkBuddyPoolStateRecord

/**
 * Health-policy knobs for one account pool. Declared here (node-free) so the
 * browser half and the host's `pool.ts` share ONE definition; the defaults live
 * in `pool.ts`.
 *
 * Each region carries its OWN policy: the international gateway enforces a
 * visibly tighter WAF, so its pool keeps a lower concurrency ceiling and a
 * longer cooldown than the domestic one.
 */
export interface WorkBuddyPoolPolicy {
  /** Concurrent requests per account; 0 means unlimited. */
  maxInFlightPerAccount: number
  /** Ceiling for this region's accounts when the region is the global one. */
  maxInFlightGlobalPerAccount: number
  /** Concurrent requests across the whole pool; 0 means unlimited. */
  maxInFlightTotal: number
  /** Soft-rate-limit cooldown base. */
  softRateCooldownMs: number
  /** Soft-rate-limit exponential backoff ceiling. */
  softRateCooldownMaxMs: number
  /** Fixed cooldown for an upstream 404. */
  notFoundCooldownMs: number
  /** Consecutive failures before the breaker opens. */
  breakerThreshold: number
  /** First breaker cooldown; doubles per consecutive trip. */
  breakerCooldownMs: number
  /** Ceiling for the breaker cooldown. */
  breakerCooldownMaxMs: number
  /** Consecutive unclassified failures before an account is degraded. */
  degradeThreshold: number
  /** How long a degraded account stays deprioritized. */
  degradeCooldownMs: number
  /** Ceiling for the degrade window. */
  degradeCooldownMaxMs: number
  /** Session stickiness lifetime; 0 disables stickiness. */
  stickyTtlMs: number
  /** How often expired sticky bindings are collected. */
  stickyGcIntervalMs: number
  /** Ignore credit- and idle-based weighting, picking uniformly. */
  balanceAware: boolean
}

/** The card's view of one region's policy: the same document, under its web name. */
export type WorkBuddyWebPoolPolicy = WorkBuddyPoolPolicy

/** One growth task as the card renders it. */
export interface WorkBuddyWebTask {
  taskCode: string
  title: string
  /** What the task asks for. */
  detail: string
  current: number
  target: number
  credit: number
  energy: number
  locked: boolean
  claimable: boolean
  claimed: boolean
  acceptStatus?: string
  /** Whether this plugin can finish the task without the official client. */
  automated: boolean
  /** Why it cannot, when it cannot. */
  unsupportedReason?: string
}

/** One task run's per-account report, as the card renders it. */
export interface WorkBuddyWebTaskReport {
  accountId: string
  accountName: string
  credit: number
  energy: number
  finishedAtMs: number
  results: readonly {
    taskCode: string
    desc: string
    outcome: 'done' | 'skipped' | 'error' | 'unsupported'
    message: string
    progressBefore?: string
    progressAfter?: string
  }[]
}

/** The task schedule, as the card displays and edits it. */
export interface WorkBuddyWebTaskSchedule {
  /** Whether the daily sweep is armed. */
  enabled: boolean
  /** Local hour (0-23) the daily sweep starts at. */
  hour: number
  /** Local minute (0-59) the daily sweep starts at. */
  minute: number
  /** Whether a sweep also runs shortly after DSH starts. */
  runOnStart: boolean
  /** `HH:MM` form of `hour`/`minute`, for display only. */
  dailyAt: string
  nextRunAtMs?: number
  lastRunAtMs?: number
  running: boolean
  lastReports: readonly WorkBuddyWebTaskReport[]
  lastSkipped: readonly { accountName: string; reason: string }[]
}

/** The whole task document for one account. */
export interface WorkBuddyWebTasks {
  accountId: string
  accountName: string
  /** False for the international gateway, which has no task system. */
  supported: boolean
  tasks: readonly WorkBuddyWebTask[]
  error?: string
}

/**
 * One browser sign-in, as the card drives it. The host never returns the token
 * bundle to the page — only the account it produced.
 */
export type WorkBuddyWebLogin =
  | { status: 'pending'; state: string; url: string; region: WorkBuddyWebRegion }
  | { status: 'waiting'; region: WorkBuddyWebRegion; message?: string }
  | { status: 'done'; region: WorkBuddyWebRegion; account: WorkBuddyWebAccount; note?: string }
  | { status: 'error'; region: WorkBuddyWebRegion; message: string }

/** The JSON document one region's card tab renders. */
export type WorkBuddyWebUsage =
  | {
    status: 'empty'
    region: WorkBuddyWebRegion
    accounts: readonly WorkBuddyWebAccount[]
    pool: readonly WorkBuddyWebPoolEntry[]
    message?: string
  }
  | {
    status: 'ready'
    region: WorkBuddyWebRegion
    accounts: readonly WorkBuddyWebAccount[]
    pool: readonly WorkBuddyWebPoolEntry[]
    credits: readonly WorkBuddyWebAccountCredits[]
    models: readonly WorkBuddyWebModel[]
    enabledModelIds: readonly string[]
    imageModelIds: readonly string[]
    /** Persisted per-account pool state, so the card can save it back. */
    poolState: readonly WorkBuddyWebPoolState[]
    /** Effective pool policy, so the card can display and edit it. */
    policy: WorkBuddyWebPoolPolicy
  }
  | { status: 'error'; region: WorkBuddyWebRegion; message: string }
