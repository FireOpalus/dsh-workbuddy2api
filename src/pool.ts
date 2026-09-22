/**
 * Multi-account pool: account health state, weighted pick, session stickiness,
 * cooldown/breaker/degrade transitions, and credit-aware ordering.
 *
 * 参考：Sliverkiss/workbuddy2api（MIT）— 本模块是该项目账号池
 *   （`internal/pool/` + `internal/session/`）在单进程 Node 下的移植，
 *   机制与默认值逐项对齐：
 *     1. 四维正交状态机（禁用 / 冷却 / 熔断 / 降权）与 `healthy()` 或门；
 *     2. 选号 = 「候选过滤 → 全冷却兜底 → 权重 → Top5 截断 → 防撞号 →
 *        加权随机，全撞号时按单调序号 LRU 兜底」；
 *     3. 权重三因子：余额占比 ×10、快过期占比 ×8、闲置补偿 0.5/h 封顶 5；
 *     4. 失败分类迁移：额度不足 → 次日 04:00 硬冷却；限流 → 600s 基数、
 *        指数退避封顶 2h，且「已在软冷却中不推进不延长」；连续失败达 3 次
 *        熔断（30m 起、翻倍封顶 6h）；无分类的失败（传输层/未知 4xx）
 *        连败 5 次降权 10m（封顶 2h）；
 *     5. 会话粘性：同一会话固定同一账号，TTL 30m 滚动续期，GC 5m。
 *   简化（单进程、无 Redis、无外部调度）：
 *     - 不实现 realm 分池的快照镜像与跨进程恢复，状态落在 DSH settings；
 *     - 不实现签到/旅行/夜猫子等额度增益排程（那是服务端职责）；
 *     - 模型级冷却退化为账号级（本插件的模型目录是多账号合并的，
 *       按模型冷却会让一个账号的坏模型影响整池选号）；
 *     - `inFlight` 用普通计数器（Node 单线程无竞态），保留 Acquire/Release
 *       语义与「选中即占名额、函数出口释放」模式；
 *     - 时间来源与随机数可注入，便于测试确定化。
 *
 * @module dsh-workbuddy2api/pool
 */

import { createHash } from 'node:crypto'
import type { WorkBuddyPoolPolicy, WorkBuddyPoolStateRecord } from './status-paths.ts'
import type { WorkBuddyPoolCounterRecord } from './pool-state.ts'
import type { UpstreamErrorKind, WorkBuddyRegion } from './upstream.ts'

export type { WorkBuddyPoolPolicy, WorkBuddyPoolStateRecord } from './status-paths.ts'
export type { WorkBuddyPoolCounterRecord } from './pool-state.ts'

/** One account as the credential store sees it. */
export interface WorkBuddyPoolAccount {
  id: string
  accountName: string
  region: WorkBuddyRegion
  tokenExpiresAtMs: number
}

/** Runtime health of one pool entry, as the card reports it. */
export type WorkBuddyPoolState = 'ready' | 'cooldown' | 'degraded' | 'missing' | 'disabled'

/** One pool entry, as the settings card renders it. */
export interface WorkBuddyPoolEntry {
  accountId: string
  accountName: string
  region: WorkBuddyRegion
  /** The user's per-account switch; a disabled account is never picked. */
  enabled: boolean
  /** Relative pick weight (integer 1..100). */
  weight: number
  /** Lower number = preferred; orders the pool listing and breaks ties. */
  priority: number
  /** Derived health, never stored. */
  state: WorkBuddyPoolState
  /** Soft/hard cooldown deadline (epoch ms), when one is running. */
  cooldownUntil?: number
  /** `hard` cooldowns come from out-of-credit or dead-session answers. */
  cooldownKind?: 'soft' | 'hard'
  /** Breaker deadline, when the breaker is open. */
  breakerUntil?: number
  /** Degrade deadline, when the account is being deprioritized. */
  degradedUntil?: number
  /** Requests currently dispatched to this account. */
  inFlight: number
  successes: number
  failures: number
  /** Consecutive failures; drives the breaker and the degrade window. */
  consecutiveFailures: number
  /** How many times the soft/credit cooldown has been extended. */
  cooldownCount: number
  lastUsedAt?: number
  lastSuccessAt?: number
  lastErrorAt?: number
  lastError?: string
  /** Remaining credits, when the card or the CLI last queried them. */
  credits?: number
  creditsAtMs?: number
  /** Credits expiring inside the configured window (default 7 days). */
  creditsExpiringSoon?: number
  /**
   * The allowance `credits` is measured against, for the card's
   * remaining-share ring. 0 means the upstream reported no sizes.
   */
  creditsCapacity?: number
  /**
   * Per-model refusals currently in force for this account: a 6004 rate limit or
   * an 11102 "no such model here". Separate from the account's own health,
   * because the account is fine — only these models are unavailable on it.
   */
  modelCooldowns?: readonly { model: string; untilMs: number; reason: string; hits: number }[]
  /** Whether the account still has a local credential file. */
  present: boolean
  tokenExpiresAtMs: number
}

/**
 * Pool policy as this module consumes it: the shared, node-free knobs plus the
 * weighting constants that only the host needs.
 */
export interface WorkBuddyPoolTuning extends WorkBuddyPoolPolicy {
  /** Idle compensation: weight gained per hour of not being used. */
  idleWeightPerHour: number
  /** Idle compensation ceiling. */
  idleWeightMax: number
  /** Weight multiplier for the share of credits expiring inside the window. */
  expiringWeight: number
  /** The "expiring soon" window used both for weighting and credit bucketing. */
  expiringSoonMs: number
  /** Two picks inside this gap never choose the same account. */
  minPickGapMs: number
}

/** The workbuddy2api-derived default policy. */
export const DEFAULT_WORKBUDDY_POOL_POLICY: WorkBuddyPoolTuning = {
  maxInFlightPerAccount: 3,
  maxInFlightGlobalPerAccount: 2,
  maxInFlightTotal: 8,
  softRateCooldownMs: 600_000,
  softRateCooldownMaxMs: 7_200_000,
  notFoundCooldownMs: 60_000,
  breakerThreshold: 3,
  breakerCooldownMs: 1_800_000,
  breakerCooldownMaxMs: 21_600_000,
  degradeThreshold: 5,
  degradeCooldownMs: 600_000,
  degradeCooldownMaxMs: 7_200_000,
  stickyTtlMs: 1_800_000,
  stickyGcIntervalMs: 300_000,
  balanceAware: true,
  idleWeightPerHour: 0.5,
  idleWeightMax: 5,
  expiringWeight: 8,
  expiringSoonMs: 168 * 3_600_000,
  minPickGapMs: 100,
}

/**
 * Consecutive session-dead answers before the account is condemned.
 *
 * A single 12153 is routinely jitter — a dropped connection, a lost race with a
 * token refresh — and disabling on the first one is how perfectly healthy
 * accounts get taken out of service for good, needing a human to bring them back.
 */
const SESSION_DEAD_THRESHOLD = 3

/** First TTL for the "this backend has no such model" negative cache. */
const MODEL_BLOCK_BASE_MS = 6 * 3_600_000
/** How far the model-block TTL doubles per repeat; capped at one day. */
const MODEL_BLOCK_MAX_MS = 24 * 3_600_000
const MODEL_BLOCK_SHIFT = 4
/** Base soft cooldown for a gateway (WAF) refusal, jittered below. */
const WAF_COOLDOWN_BASE_MS = 60_000
/** How long a cost observation stays usable: covers a "free at night" window. */
const MODEL_COST_TTL_MS = 6 * 3_600_000

/** Mutable per-account bookkeeping the picker reads and the report writes. */
interface EntryState {
  accountId: string
  accountName: string
  region: WorkBuddyRegion
  present: boolean
  tokenExpiresAtMs: number
  enabled: boolean
  weight: number
  priority: number
  cooldownUntil: number
  cooldownKind: 'none' | 'soft' | 'hard'
  /** Extensions already applied to the soft cooldown; the backoff exponent. */
  softStreak: number
  breakerUntil: number
  /** Failures accumulated toward the next breaker trip. */
  breakerFails: number
  /** Breaker trips so far; the cooldown doubles per trip. */
  breakerTrips: number
  degradedUntil: number
  /** Consecutive unclassified failures; the degrade trigger. */
  consecutiveFails: number
  /** Consecutive "session is dead" answers; only the threshold condemns. */
  sessionDeadFails: number
  inFlight: number
  successes: number
  failures: number
  /** Monotonic dispatch counter: the LRU tie-breaker. Never a wall clock. */
  usedSeq: number
  lastUsedAt: number
  lastSuccessAt: number
  lastErrorAt: number
  lastError: string
  credits: number | undefined
  creditsExpiring: number
  creditsCapacity: number
  creditsAtMs: number
  /**
   * Per-MODEL cooldowns, separate from the account-level ones.
   *
   * A 6004 answer says "this model's usage is over its limit" — the account is
   * healthy and other models still work. Parking the account instead would take a
   * working credential out of service for hours and hide the real cause, so the
   * deadline is recorded per model and only that model avoids the account.
   */
  modelCooldowns: Map<string, { untilMs: number; reason: string; hits: number }>
  /**
   * Observed cost per 1k tokens, per model, from the upstream's own
   * `usage.credit`. This is what makes the cost-tier layer possible: a free
   * promotional model stays free only while it is actually free, and the only
   * way to know is to watch what was charged.
   */
  modelCost: Map<string, { costPer1k: number; lastSeenMs: number }>
}

/** Outcome of one dispatch, reported back by the shim. */
export interface WorkBuddyDispatchOutcome {
  ok: boolean
  /** Upstream failure class; `transport` covers a failed connection. */
  kind?: UpstreamErrorKind
  /** Redacted, human-readable reason stored on the entry. */
  message?: string
  /**
   * The model this dispatch used, when the caller knows it. A model-level
   * cooldown is recorded against this name, so a 6004 for one model does not
   * park the account for the others.
   */
  model?: string
  /**
   * The wall-clock moment the upstream promised the limit lifts, from the 429
   * body's own wording. Preferred over any computed backoff: it is what actually
   * happens, and guessing longer only idles a healthy account.
   */
  resetAtMs?: number
  /**
   * A wait the upstream stated in its response headers. Honoured when there is
   * no body wording; ignored when there is, since the body is the narrower
   * statement.
   */
  retryAfterMs?: number
}

/** Why the pool could not pick any account at all. */
export type WorkBuddyPoolMissReason = 'no-accounts' | 'all-disabled' | 'pool-saturated'

/** What {@link WorkBuddyAccountPool.pick} answers. */
export type WorkBuddyPickResult =
  | {
    ok: true
    entry: WorkBuddyPoolEntry
    /**
     * True when every account was cooling down and the picker fell back to the
     * one whose cooldown expires first. The request is still worth attempting:
     * a cooldown is a local guess, not an upstream verdict.
     */
    fallback: boolean
  }
  | { ok: false; reason: WorkBuddyPoolMissReason }

/** Constructor dependencies. */
export interface WorkBuddyAccountPoolOptions {
  /** Re-read the locally discoverable accounts. */
  list: () => Promise<readonly WorkBuddyPoolAccount[]>
  /** The persisted per-account state, keyed by account id. */
  state?: readonly WorkBuddyPoolStateRecord[]
  policy?: Partial<WorkBuddyPoolTuning>
  /** Injected clock, for deterministic tests. */
  now?: () => number
  /** Injected randomness in [0, 1), for deterministic tests. */
  random?: () => number
}

/**
 * Session-stickiness key for one chat request.
 *
 * DSH identifies a conversation by its system prompt plus its first user
 * message; hashing both keeps one conversation on one account while different
 * conversations spread across the pool, which is what makes pooled use look
 * like a single account to the upstream's own conversation memory.
 */
export function stickyKeyOf(bodyJson: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const messages = (parsed as Record<string, unknown>)['messages']
  if (!Array.isArray(messages)) return undefined
  let system = ''
  let firstUser = ''
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    const role = typeof record['role'] === 'string' ? record['role'] : ''
    const content = record['content']
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.flatMap(part => typeof part === 'object' && part !== null
          && typeof (part as Record<string, unknown>)['text'] === 'string'
          ? [(part as Record<string, unknown>)['text'] as string]
          : []).join('')
        : ''
    if (text === '') continue
    if ((role === 'system' || role === 'developer') && system === '') {
      system = text
      continue
    }
    if (role === 'user') {
      firstUser = text
      break
    }
  }
  if (system === '' && firstUser === '') return undefined
  return `d-${createHash('sha256').update(`${system}\u0000${firstUser}`).digest('hex').slice(0, 32)}`
}

/** The local 04:00 following `now`, the hard-credit cooldown deadline. */
export function nextDay4Am(now: number): number {
  const date = new Date(now)
  date.setHours(4, 0, 0, 0)
  if (date.getTime() <= now) date.setDate(date.getDate() + 1)
  return date.getTime()
}

/**
 * A weighted account pool over locally discovered WorkBuddy sign-ins.
 *
 * The pool owns no credentials: it decides *which* account id should serve a
 * request, and the shim resolves that account's credential from the store.
 * That split keeps token material out of the scheduling layer and makes the
 * whole pick deterministic under an injected clock and RNG.
 */
export class WorkBuddyAccountPool {
  private readonly list: WorkBuddyAccountPoolOptions['list']
  private readonly now: () => number
  private readonly random: () => number
  private readonly entries = new Map<string, EntryState>()
  private readonly sticky = new Map<string, { accountId: string; at: number }>()
  private policy: WorkBuddyPoolTuning
  private totalInFlight = 0
  private seq = 0
  private gcTimer: NodeJS.Timeout | undefined

  constructor(options: WorkBuddyAccountPoolOptions) {
    this.list = options.list
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? Math.random
    this.policy = { ...DEFAULT_WORKBUDDY_POOL_POLICY, ...options.policy }
    for (const record of options.state ?? []) {
      const entry = this.blankEntry(record.accountId)
      entry.enabled = record.enabled
      entry.weight = record.weight
      entry.priority = record.priority
      entry.cooldownUntil = record.cooldownUntil ?? 0
      entry.cooldownKind = record.cooldownKind ?? (entry.cooldownUntil > 0 ? 'soft' : 'none')
      entry.softStreak = record.cooldownCount ?? 0
      entry.breakerUntil = record.breakerUntil ?? 0
      entry.degradedUntil = record.degradedUntil ?? 0
      this.entries.set(record.accountId, entry)
    }
    this.startGc()
  }

  /** Replace the health policy; the next pick uses the new numbers. */
  setPolicy(policy: Partial<WorkBuddyPoolTuning>): void {
    this.policy = { ...this.policy, ...policy }
  }

  /** The policy in force. */
  currentPolicy(): WorkBuddyPoolTuning {
    return { ...this.policy }
  }

  private blankEntry(accountId: string): EntryState {
    return {
      accountId,
      accountName: accountId,
      region: 'cn',
      present: true,
      tokenExpiresAtMs: 0,
      enabled: true,
      weight: 10,
      priority: 100,
      cooldownUntil: 0,
      cooldownKind: 'none',
      softStreak: 0,
      breakerUntil: 0,
      breakerFails: 0,
      breakerTrips: 0,
      degradedUntil: 0,
      consecutiveFails: 0,
      inFlight: 0,
      successes: 0,
      failures: 0,
      usedSeq: 0,
      lastUsedAt: 0,
      lastSuccessAt: 0,
      lastErrorAt: 0,
      lastError: '',
      credits: undefined,
      creditsExpiring: 0,
      creditsCapacity: 0,
      creditsAtMs: 0,
      sessionDeadFails: 0,
      modelCooldowns: new Map(),
      modelCost: new Map(),
    }
  }

  /**
   * Re-read the local accounts and merge them into the pool. Accounts that
   * vanished keep their entry (so their counters and the user's switch survive
   * a temporarily unreadable auth file) but are marked `present: false` and
   * become unpickable. Accounts that reappear are un-marked.
   */
  async refresh(): Promise<void> {
    const accounts = await this.list()
    const seen = new Set<string>()
    for (const account of accounts) {
      seen.add(account.id)
      const existing = this.entries.get(account.id)
      if (existing === undefined) {
        const entry = this.blankEntry(account.id)
        entry.accountName = account.accountName
        entry.region = account.region
        entry.tokenExpiresAtMs = account.tokenExpiresAtMs
        this.entries.set(account.id, entry)
        continue
      }
      existing.accountName = account.accountName
      existing.region = account.region
      existing.tokenExpiresAtMs = account.tokenExpiresAtMs
      existing.present = true
    }
    for (const entry of this.entries.values()) {
      if (!seen.has(entry.accountId)) entry.present = false
    }
  }

  /** Drop every entry whose account no longer exists locally. */
  prune(): void {
    for (const [id, entry] of [...this.entries]) {
      if (!entry.present) this.entries.delete(id)
    }
    for (const [key, binding] of [...this.sticky]) {
      if (!this.entries.has(binding.accountId)) this.sticky.delete(key)
    }
  }

  /** Every entry, in card order: by priority, then by account name. */
  snapshot(): WorkBuddyPoolEntry[] {
    const now = this.now()
    return [...this.entries.values()]
      .sort((left, right) => left.priority - right.priority || left.accountName.localeCompare(right.accountName))
      .map(entry => this.view(entry, now))
  }

  /** One entry's card view, or undefined when the account is unknown. */
  entryView(accountId: string): WorkBuddyPoolEntry | undefined {
    const entry = this.entries.get(accountId)
    return entry === undefined ? undefined : this.view(entry, this.now())
  }

  private view(entry: EntryState, now: number): WorkBuddyPoolEntry {
    return {
      accountId: entry.accountId,
      accountName: entry.accountName,
      region: entry.region,
      enabled: entry.enabled,
      weight: entry.weight,
      priority: entry.priority,
      state: this.stateOf(entry, now),
      ...entry.cooldownUntil > now ? { cooldownUntil: entry.cooldownUntil } : {},
      ...entry.cooldownKind === 'none' || entry.cooldownUntil <= now ? {} : { cooldownKind: entry.cooldownKind },
      ...entry.breakerUntil > now ? { breakerUntil: entry.breakerUntil } : {},
      ...entry.degradedUntil > now ? { degradedUntil: entry.degradedUntil } : {},
      inFlight: entry.inFlight,
      successes: entry.successes,
      failures: entry.failures,
      consecutiveFailures: entry.consecutiveFails + entry.breakerFails,
      cooldownCount: entry.softStreak + entry.breakerTrips,
      ...entry.lastUsedAt === 0 ? {} : { lastUsedAt: entry.lastUsedAt },
      ...entry.lastSuccessAt === 0 ? {} : { lastSuccessAt: entry.lastSuccessAt },
      ...entry.lastErrorAt === 0 ? {} : { lastErrorAt: entry.lastErrorAt },
      ...entry.lastError === '' ? {} : { lastError: entry.lastError },
      ...entry.credits === undefined ? {} : { credits: entry.credits },
      ...entry.creditsAtMs === 0 ? {} : { creditsAtMs: entry.creditsAtMs },
      ...entry.creditsExpiring === 0 ? {} : { creditsExpiringSoon: entry.creditsExpiring },
      ...entry.creditsCapacity === 0 ? {} : { creditsCapacity: entry.creditsCapacity },
      ...(() => {
        const active = [...entry.modelCooldowns]
          .filter(([, cooldown]) => cooldown.untilMs > now)
          .map(([model, cooldown]) => ({ model, untilMs: cooldown.untilMs, reason: cooldown.reason, hits: cooldown.hits }))
          .sort((left, right) => left.model.localeCompare(right.model))
        return active.length === 0 ? {} : { modelCooldowns: active }
      })(),
      present: entry.present,
      tokenExpiresAtMs: entry.tokenExpiresAtMs,
    }
  }

  private stateOf(entry: EntryState, now: number): WorkBuddyPoolState {
    if (!entry.present) return 'missing'
    if (!entry.enabled) return 'disabled'
    if (entry.cooldownUntil > now) return 'cooldown'
    if (entry.breakerUntil > now) return 'degraded'
    if (entry.degradedUntil > now) return 'degraded'
    return 'ready'
  }

  /** The per-account concurrency ceiling for this account's region. */
  private inFlightLimit(entry: EntryState): number {
    if (entry.region === 'global' && this.policy.maxInFlightGlobalPerAccount > 0) {
      return this.policy.maxInFlightGlobalPerAccount
    }
    return this.policy.maxInFlightPerAccount
  }

  /** Whether the account is below its concurrency ceiling. */
  private inFlightFull(entry: EntryState): boolean {
    const limit = this.inFlightLimit(entry)
    return limit > 0 && entry.inFlight >= limit
  }

  /**
   * The four-dimension health gate: present, enabled, out of every cooldown,
   * and below the concurrency ceiling.
   */
  private healthy(entry: EntryState, now: number): boolean {
    if (!entry.present || !entry.enabled) return false
    if (entry.cooldownUntil > now) return false
    if (entry.breakerUntil > now) return false
    if (entry.degradedUntil > now) return false
    return !this.inFlightFull(entry)
  }

  /**
   * Health as seen by ONE model: the account-level gate, plus the per-model
   * cooldowns.
   *
   * This is what makes a model-level limit non-punitive. A 6004 on model A says
   * nothing about model B, so an account cooling down for A is still a perfectly
   * good candidate for B — the account's credentials, credits and health are all
   * intact. Judging it with the account-level gate alone would idle a working
   * credential; judging it with no gate at all would keep sending A into a wall.
   */
  private healthyForModel(entry: EntryState, now: number, model: string | undefined): boolean {
    if (!this.healthy(entry, now)) return false
    if (model === undefined || model === '') return true
    const blocked = entry.modelCooldowns.get(model)
    return blocked === undefined || blocked.untilMs <= now
  }

  /** Drop per-model cooldowns that have expired, so the map cannot grow forever. */
  private pruneModelCooldowns(entry: EntryState, now: number): void {
    if (entry.modelCooldowns.size === 0) return
    for (const [model, cooldown] of entry.modelCooldowns) {
      if (cooldown.untilMs <= now) entry.modelCooldowns.delete(model)
    }
  }

  /** The earliest still-running deadline of an entry, or 0 when it is clear. */
  private expiryOf(entry: EntryState, now: number): number {
    const deadlines = [entry.cooldownUntil, entry.breakerUntil, entry.degradedUntil]
      .filter(deadline => deadline > now)
    return deadlines.length === 0 ? 0 : Math.min(...deadlines)
  }

  /**
   * Accounts currently bound by some live session.
   *
   * The initial assignment prefers accounts NOT in this set. Without that step,
   * a new conversation's first request is decided purely by weight — and since
   * the weight favours the richest account, many conversations opening at once
   * tend to land on the same one. Preferring an unbound account spreads new
   * sessions across the pool while still letting weight order the choice within
   * whichever group is used.
   */
  private boundAccountIds(): Set<string> {
    const bound = new Set<string>()
    for (const binding of this.sticky.values()) bound.add(binding.accountId)
    return bound
  }

  /** The sticky binding for a session key, when it is alive. */
  private stickyBinding(key: string | undefined, now: number): EntryState | undefined {
    if (key === undefined || this.policy.stickyTtlMs <= 0) return undefined
    const binding = this.sticky.get(key)
    if (binding === undefined) return undefined
    if (now - binding.at > this.policy.stickyTtlMs) {
      this.sticky.delete(key)
      return undefined
    }
    const entry = this.entries.get(binding.accountId)
    if (entry === undefined) {
      this.sticky.delete(key)
      return undefined
    }
    return entry
  }

  /** Weight of one candidate, per the reference's three-factor formula. */
  private weightOf(entry: EntryState, maxCredits: number, now: number): number {
    let weight = 1
    if (this.policy.balanceAware && maxCredits > 0 && entry.credits !== undefined) {
      weight += (entry.credits / maxCredits) * 10
    }
    if (this.policy.balanceAware && entry.credits !== undefined && entry.credits > 0 && entry.creditsExpiring > 0) {
      weight += (Math.min(entry.creditsExpiring, entry.credits) / entry.credits) * this.policy.expiringWeight
    }
    if (this.policy.balanceAware) {
      if (entry.lastUsedAt === 0) {
        weight += this.policy.idleWeightMax
      } else {
        const idle = Math.min(
          Math.max(((now - entry.lastUsedAt) / 3_600_000) * this.policy.idleWeightPerHour, 0),
          this.policy.idleWeightMax,
        )
        weight += idle
      }
    }
    // The user's per-account weight multiplies the automatic factors, so a
    // deliberately favoured account stays favoured however the credits move.
    return weight * Math.max(entry.weight, 1)
  }

  /**
   * Choose the account for one request and reserve its concurrency slot. The
   * caller MUST call {@link release} once the request settles.
   *
   * Decision order, mirroring workbuddy2api's picker:
   *
   * 1. a live session binding wins whenever its account is healthy — one
   *    conversation must not bounce between accounts mid-flight;
   * 2. otherwise filter to healthy accounts the caller has not already tried;
   * 3. when nothing is healthy, fall back to the cooling account whose deadline
   *    expires first (never a hard-credit cooldown): a cooldown is a local
   *    guess, so it is still better to try than to fail the request;
   * 4. rank by weight (credits ×10, expiring credits ×8, idle 0.5/h up to 5);
   * 5. take the top five and drop those used inside the anti-collision gap,
   *    falling back to the least-recently-used account in the FULL candidate
   *    set — never only the shortlist, which would starve tied accounts;
   * 6. draw one weighted-random from what remains.
   */
  pick(options: {
    exclude?: ReadonlySet<string>
    stickyKey?: string
    /** The model this request asks for; enables model-level gates and tiers. */
    model?: string
  } = {}): WorkBuddyPickResult {
    const now = this.now()
    const excluded = options.exclude ?? new Set<string>()
    const all = [...this.entries.values()]
    if (all.length === 0) return { ok: false, reason: 'no-accounts' }
    if (all.every(entry => !entry.enabled)) return { ok: false, reason: 'all-disabled' }
    // A disabled account is never picked, not even as an all-cooling fallback.
    const pickable = all.filter(entry => entry.enabled && entry.present)
    if (pickable.length === 0) return { ok: false, reason: 'pool-saturated' }

    const model = options.model
    const bound = this.stickyBinding(options.stickyKey, now)
    // The stickiness fast path is judged by the SAME model-aware gate as the
    // general path: a binding must not pin a conversation to an account that is
    // currently limited for the very model being asked for.
    if (bound !== undefined && this.healthyForModel(bound, now, model) && !excluded.has(bound.accountId)
      && this.totalInFlight < this.policy.maxInFlightTotal) {
      return { ok: true, entry: this.view(this.dispatch(bound, now), now), fallback: false }
    }

    // The pool-wide ceiling is a hard stop: falling back "around" it would
    // defeat the reason it exists, so a saturated pool refuses instead.
    if (this.policy.maxInFlightTotal > 0 && this.totalInFlight >= this.policy.maxInFlightTotal) {
      return { ok: false, reason: 'pool-saturated' }
    }

    for (const entry of all) this.pruneModelCooldowns(entry, now)
    let candidates = all.filter(entry =>
      !excluded.has(entry.accountId) && this.healthyForModel(entry, now, model))
    // A conversation being (re)assigned prefers an account no other session is
    // using yet, so simultaneous new sessions spread across the pool instead of
    // all landing on the heaviest account. Sessions that still hold a live
    // binding never reach here — they returned from the fast path above — so this
    // can only move a conversation that was going to be reassigned anyway.
    if (options.stickyKey !== undefined && candidates.length > 1) {
      const inUse = this.boundAccountIds()
      const idle = candidates.filter(entry => !inUse.has(entry.accountId))
      if (idle.length > 0) candidates = idle
    }
    if (candidates.length === 0) {
      const fallback = this.pickEarliestExpiry(pickable, excluded, now)
      if (fallback === undefined) return { ok: false, reason: this.missReason(all) }
      return { ok: true, entry: this.view(this.dispatch(fallback, now), now), fallback: true }
    }

    // Cost tiering (the "layered pick"), only when the request names a model.
    //   0 = observed FREE for this model — the strongest preference
    //   1 = no observation
    //   2 = observed to cost credits
    // "No observation" deliberately outranks "observed to cost": a promotional
    // model's free status can only be discovered by trying it, so if the
    // known-paid accounts always won, the free one would never be reached and
    // its status never learned. Ties inside a tier still compare observed price.
    const tierOf = (entry: EntryState): { tier: number; cost: number } => {
      if (model === undefined || model === '') return { tier: 1, cost: 0 }
      const observed = entry.modelCost.get(model)
      if (observed === undefined || now - observed.lastSeenMs > MODEL_COST_TTL_MS) return { tier: 1, cost: 0 }
      return { tier: observed.costPer1k <= 0 ? 0 : 2, cost: observed.costPer1k }
    }
    const tiered = candidates.map(entry => ({ entry, ...tierOf(entry) }))
    const bestTier = tiered.reduce((best, candidate) => Math.min(best, candidate.tier), 2)
    const inTier = tiered.filter(candidate => candidate.tier === bestTier)
    let maxCredits = 0
    for (const candidate of inTier) {
      const credits = candidate.entry.credits
      if (credits !== undefined && credits > maxCredits) maxCredits = credits
    }
    const ranked = inTier
      .map(candidate => ({ entry: candidate.entry, weight: this.weightOf(candidate.entry, maxCredits, now), cost: candidate.cost }))
      .sort((left, right) =>
        left.cost - right.cost
        || right.weight - left.weight
        || left.entry.usedSeq - right.entry.usedSeq)
    // The full ranked list is kept for the LRU fallback, so a shortlist cutoff
    // can never starve a tied account.
    const fullRanked = ranked
    const shortlist = ranked.slice(0, 5)
    const eligible = shortlist.filter(candidate => now - candidate.entry.lastUsedAt >= this.policy.minPickGapMs)
    const chosen = eligible.length > 0
      ? this.pickWeighted(eligible.map(candidate => candidate.entry), eligible.map(candidate => candidate.weight))
      // Everything on the shortlist was used inside the gap: take the globally
      // least-recently-used candidate so no account is starved by the cutoff.
      : fullRanked.reduce((best, candidate) =>
        candidate.entry.usedSeq < best.entry.usedSeq ? candidate : best).entry
    return { ok: true, entry: this.view(this.dispatch(chosen, now), now), fallback: false }
  }

  /** Why nothing could be picked, in the most specific available terms. */
  private missReason(all: readonly EntryState[]): WorkBuddyPoolMissReason {
    if (all.length === 0) return 'no-accounts'
    if (all.every(entry => !entry.enabled)) return 'all-disabled'
    return 'pool-saturated'
  }

  /**
   * The all-cooling fallback: the account whose earliest running deadline is
   * closest. Hard-credit cooldowns are excluded — the account is out of
   * credits, so retrying it only burns a request.
   */
  private pickEarliestExpiry(
    all: readonly EntryState[],
    excluded: ReadonlySet<string>,
    now: number,
  ): EntryState | undefined {
    let best: EntryState | undefined
    let bestExpiry = 0
    for (const entry of all) {
      if (excluded.has(entry.accountId)) continue
      if (!entry.present || !entry.enabled) continue
      if (entry.cooldownKind === 'hard' && entry.cooldownUntil > now) continue
      if (this.inFlightFull(entry)) continue
      const expiry = this.expiryOf(entry, now)
      if (expiry === 0) continue
      if (best === undefined || expiry < bestExpiry) {
        best = entry
        bestExpiry = expiry
      }
    }
    return best
  }

  /** Fixed-point weighted draw over the candidates. */
  private pickWeighted(candidates: readonly EntryState[], weights: readonly number[]): EntryState {
    if (candidates.length === 1) return candidates[0] as EntryState
    const scale = 1_000_000
    const fixed = weights.map(weight => Math.max(Math.round(weight * scale), 1))
    const total = fixed.reduce((sum, value) => sum + value, 0)
    if (!(total > 0)) {
      return candidates[Math.min(Math.floor(this.random() * candidates.length), candidates.length - 1)] as EntryState
    }
    let ticket = Math.floor(this.random() * total)
    for (let index = 0; index < candidates.length; index += 1) {
      ticket -= fixed[index] as number
      if (ticket < 0) return candidates[index] as EntryState
    }
    return candidates[candidates.length - 1] as EntryState
  }

  /** Reserve one concurrency slot on an entry and record the dispatch. */
  private dispatch(entry: EntryState, now: number): EntryState {
    entry.inFlight += 1
    this.totalInFlight += 1
    entry.lastUsedAt = now
    this.seq += 1
    entry.usedSeq = this.seq
    return entry
  }

  /**
   * Return a reserved slot. Safe to call once per successful {@link pick};
   * a double release would corrupt the ceilings, so the caller must pair them.
   */
  release(accountId: string): void {
    const entry = this.entries.get(accountId)
    if (entry === undefined) return
    if (entry.inFlight > 0) entry.inFlight -= 1
    if (this.totalInFlight > 0) this.totalInFlight -= 1
  }

  /**
   * Record one dispatch outcome and apply the health transition.
   *
   * | outcome | transition |
   * |---|---|
   * | success | clear every counter and rolling-renew the sticky binding |
   * | `hard_credit` | hard cooldown until the next local 04:00 |
   * | `session_dead` | hard cooldown until the next local 04:00 (re-sign-in) |
   * | `soft_rate` | soft cooldown, base 600s doubling per streak, capped at 2h; an already-running soft cooldown is never extended |
   * | `not_found` | fixed 60s soft cooldown |
   * | `server` | breaker: opens at 3 consecutive failures, 30m doubling, capped at 6h |
   * | `transport` / `client` | degrade after 5 consecutive failures (10m) — an unknown failure is not the account's fault |
   */
  report(accountId: string, outcome: WorkBuddyDispatchOutcome, stickyKey?: string): void {
    const entry = this.entries.get(accountId)
    if (entry === undefined) return
    const now = this.now()
    if (outcome.ok) {
      entry.successes += 1
      entry.consecutiveFails = 0
      entry.breakerFails = 0
      entry.breakerTrips = 0
      entry.softStreak = 0
      entry.degradedUntil = 0
      // A working request proves the session is alive, so the death count resets.
      entry.sessionDeadFails = 0
      entry.lastSuccessAt = now
      entry.lastError = ''
      // A model-blocked entry is a guess that this backend lacks the model; an
      // answer from that very model disproves it, so the negative cache clears.
      // Model-level RATE limits are deliberately NOT cleared here: their deadline
      // came from the upstream's own reset moment, and one success on a different
      // request says nothing about that. They expire on their own.
      if (outcome.model !== undefined && outcome.model !== '') {
        const cached = entry.modelCooldowns.get(outcome.model)
        if (cached !== undefined && cached.reason.startsWith('11102')) {
          entry.modelCooldowns.delete(outcome.model)
        }
      }
      if (stickyKey !== undefined && this.policy.stickyTtlMs > 0) {
        this.sticky.set(stickyKey, { accountId, at: now })
      }
      return
    }
    entry.failures += 1
    entry.lastErrorAt = now
    if (outcome.message !== undefined && outcome.message !== '') entry.lastError = outcome.message.slice(0, 240)

    switch (outcome.kind) {
      case 'hard_credit':
        entry.cooldownKind = 'hard'
        entry.cooldownUntil = nextDay4Am(now)
        return
      case 'model_rate': {
        // The MODEL is over its limit, so only that model avoids this account.
        // The deadline follows the upstream's own reset moment when it gave one
        // (never the exponential backoff: the reset is a fact, the backoff a
        // guess, and guessing longer only idles a healthy account).
        const model = outcome.model !== undefined && outcome.model !== '' ? outcome.model : ''
        if (model === '') {
          // No model name means the caller could not tell; fall back to the
          // account-level path rather than recording a cooldown nobody can match.
          this.applySoftRate(entry, now, outcome)
          return
        }
        const ceiling = this.policy.softRateCooldownMaxMs
        const until = outcome.resetAtMs !== undefined
          ? Math.min(outcome.resetAtMs, now + ceiling)
          : now + Math.min(this.policy.softRateCooldownMs, ceiling)
        const previous = entry.modelCooldowns.get(model)
        entry.modelCooldowns.set(model, {
          untilMs: until,
          reason: outcome.resetAtMs !== undefined ? '6004 model rate limit' : 'model rate limited',
          hits: (previous?.hits ?? 0) + 1,
        })
        return
      }
      case 'model_blocked': {
        // "This backend has no such model": retrying it is pointless, so the
        // (account, model) pair is negatively cached with exponential TTL. The
        // account keeps serving every other model.
        const model = outcome.model !== undefined && outcome.model !== '' ? outcome.model : ''
        if (model === '') return
        const previous = entry.modelCooldowns.get(model)
        const hits = (previous?.hits ?? 0) + 1
        const ttl = Math.min(MODEL_BLOCK_BASE_MS * 2 ** Math.min(hits - 1, MODEL_BLOCK_SHIFT), MODEL_BLOCK_MAX_MS)
        entry.modelCooldowns.set(model, { untilMs: now + ttl, reason: '11102 model not available', hits })
        return
      }
      case 'waf_block':
        // The gateway's firewall answered, not the API. It is a per-IP/per-
        // fingerprint signal that clears on its own, so the account is cooled
        // down and never disabled — disabling would need a human for a fault the
        // account did not commit. A stated wait wins over the local backoff.
        if (outcome.retryAfterMs !== undefined) {
          entry.cooldownKind = 'soft'
          entry.cooldownUntil = now + Math.min(outcome.retryAfterMs, this.policy.softRateCooldownMaxMs)
          return
        }
        this.applySoftRate(entry, now, outcome, WAF_COOLDOWN_BASE_MS)
        return
      case 'session_dead':
        // A single 12153 is often jitter (a dropped connection, a refresh race),
        // so it takes consecutive failures to condemn the account. Disabling on
        // the first one is how healthy accounts get killed off for good.
        entry.sessionDeadFails += 1
        if (entry.sessionDeadFails < SESSION_DEAD_THRESHOLD) {
          entry.cooldownKind = 'soft'
          entry.cooldownUntil = now + this.policy.softRateCooldownMs
          return
        }
        entry.sessionDeadFails = 0
        entry.cooldownKind = 'hard'
        entry.cooldownUntil = nextDay4Am(now)
        entry.lastError = '会话已失效（连续 ' + String(SESSION_DEAD_THRESHOLD) + ' 次），请在 WorkBuddy 桌面端重新登录该账号'
        return
      case 'soft_rate':
        this.applySoftRate(entry, now, outcome)
        return
      case 'not_found':
        entry.cooldownKind = 'soft'
        entry.cooldownUntil = now + this.policy.notFoundCooldownMs
        return
      case 'server': {
        entry.breakerFails += 1
        if (entry.breakerFails < this.policy.breakerThreshold) return
        const grown = this.policy.breakerCooldownMs * 2 ** Math.min(entry.breakerTrips, 8)
        entry.breakerUntil = now + Math.min(grown, this.policy.breakerCooldownMaxMs)
        entry.breakerTrips += 1
        entry.breakerFails = 0
        return
      }
      default: {
        // transport / client: no authoritative verdict, so only count failures.
        entry.consecutiveFails += 1
        if (entry.consecutiveFails < this.policy.degradeThreshold) return
        entry.consecutiveFails = 0
        // Inside an existing window the deadline is left alone: re-reaching the
        // threshold must not push it further out (the same rule the soft
        // cooldown follows, and the reason a retry storm cannot lock an account
        // out for ever).
        if (entry.degradedUntil > now) return
        entry.degradedUntil = now + Math.min(this.policy.degradeCooldownMs, this.policy.degradeCooldownMaxMs)
      }
    }
  }

  /**
   * Apply an account-level soft cooldown.
   *
   * Order of authority: the upstream's own reset moment, then its stated wait,
   * then the local bounded backoff. This is the "reset wall clock" rule — when
   * the upstream says when it lifts, waiting longer than that only idles a
   * healthy account, and no amount of local doubling makes the answer truer.
   *
   * The already-cooling rule is deliberately preserved on the backoff path: a
   * user hammering retry must not push the deadline further out than the first
   * refusal did.
   */
  private applySoftRate(
    entry: EntryState,
    now: number,
    outcome: WorkBuddyDispatchOutcome,
    baseOverrideMs?: number,
  ): void {
    const base = baseOverrideMs ?? this.policy.softRateCooldownMs
    if (outcome.resetAtMs !== undefined) {
      entry.cooldownKind = 'soft'
      entry.cooldownUntil = Math.min(outcome.resetAtMs, now + this.policy.softRateCooldownMaxMs)
      entry.modelCooldowns.clear()
      return
    }
    if (outcome.retryAfterMs !== undefined) {
      entry.cooldownKind = 'soft'
      entry.cooldownUntil = now + Math.min(outcome.retryAfterMs, this.policy.softRateCooldownMaxMs)
      entry.modelCooldowns.clear()
      return
    }
    if (entry.cooldownKind === 'soft' && entry.cooldownUntil > now) return
    const shift = Math.min(entry.softStreak, 16)
    const grown = base * 2 ** shift
    entry.cooldownKind = 'soft'
    entry.cooldownUntil = now + Math.min(grown, this.policy.softRateCooldownMaxMs)
    entry.softStreak += 1
    entry.modelCooldowns.clear()
  }

  /**
   * Record what one request actually cost on one model.
   *
   * The upstream reports the real charge in the stream's final `usage.credit`,
   * so this is measurement rather than configuration: a model advertised at
   * x0.00 that starts billing shows up here, and the cost tier follows the
   * observation instead of the catalogue. Tokens are needed to normalise the
   * charge; without them the observation is skipped rather than invented.
   */
  noteModelCost(accountId: string, model: string, credit: number, totalTokens: number): void {
    if (model === '' || !Number.isFinite(credit) || credit < 0 || !Number.isFinite(totalTokens) || totalTokens <= 0) {
      return
    }
    const entry = this.entries.get(accountId)
    if (entry === undefined) return
    entry.modelCost.set(model, { costPer1k: (credit / totalTokens) * 1000, lastSeenMs: this.now() })
    // Bound the ledger: only recently-seen models are meaningful, and an
    // unbounded map would grow with every model ever used.
    const now = this.now()
    for (const [name, observation] of entry.modelCost) {
      if (now - observation.lastSeenMs > MODEL_COST_TTL_MS * 4) entry.modelCost.delete(name)
    }
  }

  /** Cache the credits the card or the CLI read for one account. */
  setCredits(accountId: string, credits: { total: number; expiringSoon: number; capacity?: number }): void {
    const entry = this.entries.get(accountId)
    if (entry === undefined) return
    entry.credits = credits.total
    entry.creditsExpiring = credits.expiringSoon
    // A cache entry that does not know the allowance keeps the one it had: the
    // card's ring would otherwise collapse to "unknown" on every refresh.
    if (credits.capacity !== undefined) entry.creditsCapacity = credits.capacity
    entry.creditsAtMs = this.now()
  }

  /** Apply the card's per-account switches and weights. */
  configure(updates: readonly {
    accountId: string
    enabled?: boolean
    weight?: number
    priority?: number
  }[]): void {
    for (const update of updates) {
      const entry = this.entries.get(update.accountId)
      if (entry === undefined) continue
      if (update.enabled !== undefined) entry.enabled = update.enabled
      if (update.weight !== undefined) entry.weight = Math.min(Math.max(Math.round(update.weight), 1), 100)
      if (update.priority !== undefined) entry.priority = Math.round(update.priority)
    }
  }

  /** Forget one account's cooldown, breaker, and degrade marks. */
  reset(accountId: string): void {
    const entry = this.entries.get(accountId)
    if (entry === undefined) return
    entry.cooldownUntil = 0
    entry.cooldownKind = 'none'
    entry.softStreak = 0
    entry.breakerUntil = 0
    entry.breakerFails = 0
    entry.breakerTrips = 0
    entry.degradedUntil = 0
    entry.consecutiveFails = 0
    entry.sessionDeadFails = 0
    // An explicit human "recover" clears the model-level refusals too: the user
    // is telling us the account is fine, so every local guess about it goes.
    entry.modelCooldowns.clear()
  }

  /**
   * Record an account's refreshed balance, and unfreeze it when the balance came
   * back.
   *
   * This is what the startup check-in is FOR: an account parked in a hard
   * cooldown because it ran out of credits has its balance restored by the daily
   * check-in, and until something clears that cooldown the pool keeps ignoring a
   * perfectly usable account.
   *
   * Two deliberate limits:
   *   - the COOLING domain is cleared, the BREAKER is not: a successful check-in
   *     proves the billing channel works and the balance is back, which says
   *     nothing about the chat channel that tripped the breaker;
   *   - a disabled account stays disabled (that is the user's own switch), and an
   *     account with nothing left is not unfrozen — it would only fail again.
   *
   * @returns whether anything was actually cleared. Only the pool knows this; a
   *   caller that only sees a balance would report a recovery every time.
   */
  reenableIfCredits(
    accountId: string,
    credits: { total: number; expiringSoon?: number; capacity?: number },
  ): boolean {
    const entry = this.entries.get(accountId)
    if (entry === undefined) return false
    entry.credits = credits.total
    if (credits.expiringSoon !== undefined) entry.creditsExpiring = credits.expiringSoon
    if (credits.capacity !== undefined) entry.creditsCapacity = credits.capacity
    entry.creditsAtMs = this.now()
    if (credits.total <= 0 || !entry.enabled) return false
    const unfrozen = entry.cooldownUntil > 0
      || entry.cooldownKind !== 'none'
      || entry.softStreak > 0
      || entry.degradedUntil > 0
      || entry.modelCooldowns.size > 0
    entry.cooldownUntil = 0
    entry.cooldownKind = 'none'
    entry.softStreak = 0
    entry.degradedUntil = 0
    entry.consecutiveFails = 0
    entry.modelCooldowns.clear()
    entry.lastError = ''
    return unfrozen
  }

  /** Live per-model cooldowns for one account, for the card and the CLI. */
  modelCooldownsOf(accountId: string): { model: string; untilMs: number; reason: string; hits: number }[] {
    const entry = this.entries.get(accountId)
    if (entry === undefined) return []
    const now = this.now()
    return [...entry.modelCooldowns]
      .filter(([, cooldown]) => cooldown.untilMs > now)
      .map(([model, cooldown]) => ({ model, untilMs: cooldown.untilMs, reason: cooldown.reason, hits: cooldown.hits }))
      .sort((left, right) => left.model.localeCompare(right.model))
  }

  /**
   * The durable counters for every entry, keyed by account id.
   *
   * `inFlight` is NOT included on purpose: after a restart nothing is in flight,
   * so restoring a count that no `release()` will ever decrement would consume
   * that account's concurrency allowance for the life of the process.
   */
  toCounters(): Map<string, WorkBuddyPoolCounterRecord> {
    const out = new Map<string, WorkBuddyPoolCounterRecord>()
    for (const entry of this.entries.values()) {
      out.set(entry.accountId, {
        accountId: entry.accountId,
        successes: entry.successes,
        failures: entry.failures,
        usedSeq: entry.usedSeq,
        ...entry.lastUsedAt === 0 ? {} : { lastUsedAt: entry.lastUsedAt },
        ...entry.lastSuccessAt === 0 ? {} : { lastSuccessAt: entry.lastSuccessAt },
        ...entry.lastErrorAt === 0 ? {} : { lastErrorAt: entry.lastErrorAt },
        ...entry.lastError === '' ? {} : { lastError: entry.lastError },
        ...entry.credits === undefined ? {} : { credits: entry.credits },
        ...entry.creditsExpiring === 0 ? {} : { creditsExpiringSoon: entry.creditsExpiring },
        ...entry.creditsCapacity === 0 ? {} : { creditsCapacity: entry.creditsCapacity },
        ...entry.creditsAtMs === 0 ? {} : { creditsAtMs: entry.creditsAtMs },
        softStreak: entry.softStreak,
        breakerFails: entry.breakerFails,
        breakerTrips: entry.breakerTrips,
        consecutiveFails: entry.consecutiveFails,
      })
    }
    return out
  }

  /**
   * Merge previously saved counters into the entries that exist NOW.
   *
   * Applied after the first {@link refresh}, so an account whose credential
   * disappeared meanwhile simply does not receive its counters — and a record
   * for an account this pool never loaded is ignored rather than resurrecting a
   * phantom entry.
   *
   * Cumulative totals and the escalation counters are restored as-is. The
   * `inFlight` slot is not touched (see {@link toCounters}), and cooldown
   * deadlines are NOT taken from here: those live in settings, where a stale
   * timestamp cannot outlive the process that wrote it.
   */
  restoreCounters(records: Iterable<WorkBuddyPoolCounterRecord>): void {
    for (const record of records) {
      const entry = this.entries.get(record.accountId)
      if (entry === undefined) continue
      if (record.successes !== undefined) entry.successes = record.successes
      if (record.failures !== undefined) entry.failures = record.failures
      if (record.usedSeq !== undefined) entry.usedSeq = record.usedSeq
      if (record.lastUsedAt !== undefined) entry.lastUsedAt = record.lastUsedAt
      if (record.lastSuccessAt !== undefined) entry.lastSuccessAt = record.lastSuccessAt
      if (record.lastErrorAt !== undefined) entry.lastErrorAt = record.lastErrorAt
      if (record.lastError !== undefined) entry.lastError = record.lastError
      if (record.credits !== undefined) entry.credits = record.credits
      if (record.creditsExpiringSoon !== undefined) entry.creditsExpiring = record.creditsExpiringSoon
      if (record.creditsCapacity !== undefined) entry.creditsCapacity = record.creditsCapacity
      if (record.creditsAtMs !== undefined) entry.creditsAtMs = record.creditsAtMs
      if (record.softStreak !== undefined) entry.softStreak = record.softStreak
      if (record.breakerFails !== undefined) entry.breakerFails = record.breakerFails
      if (record.breakerTrips !== undefined) entry.breakerTrips = record.breakerTrips
      if (record.consecutiveFails !== undefined) entry.consecutiveFails = record.consecutiveFails
    }
    // The LRU sequence must keep increasing across a restart: a restored seq
    // higher than the fresh counter would make every new dispatch look "older"
    // than the restored ones and invert the least-recently-used ordering.
    for (const entry of this.entries.values()) {
      if (entry.usedSeq > this.seq) this.seq = entry.usedSeq
    }
  }

  /** The pool slice to persist into settings. */
  toPersisted(): WorkBuddyPoolStateRecord[] {
    const now = this.now()
    return [...this.entries.values()]
      .sort((left, right) => left.priority - right.priority || left.accountId.localeCompare(right.accountId))
      .map(entry => ({
        accountId: entry.accountId,
        enabled: entry.enabled,
        weight: entry.weight,
        priority: entry.priority,
        // Only a still-running deadline is worth persisting: a stale timestamp
        // from an earlier process would otherwise resurface as a live cooldown
        // after the machine's clock moved forward.
        ...entry.cooldownUntil > now ? { cooldownUntil: entry.cooldownUntil, cooldownKind: entry.cooldownKind === 'none' ? 'soft' as const : entry.cooldownKind } : {},
        ...entry.softStreak === 0 ? {} : { cooldownCount: entry.softStreak },
        ...entry.breakerUntil > now ? { breakerUntil: entry.breakerUntil } : {},
        ...entry.degradedUntil > now ? { degradedUntil: entry.degradedUntil } : {},
      }))
  }

  /** Live sticky-binding count, for diagnostics. */
  stickySize(): number {
    return this.sticky.size
  }

  /** Stop the sticky GC timer; called when the plugin is disposed. */
  dispose(): void {
    if (this.gcTimer !== undefined) clearInterval(this.gcTimer)
    this.gcTimer = undefined
    this.sticky.clear()
  }

  private startGc(): void {
    if (this.policy.stickyGcIntervalMs <= 0) return
    this.gcTimer = setInterval(() => {
      const now = this.now()
      for (const [key, binding] of [...this.sticky]) {
        if (now - binding.at > this.policy.stickyTtlMs) this.sticky.delete(key)
      }
    }, this.policy.stickyGcIntervalMs)
    // The pool must never hold the host process open on its own.
    this.gcTimer.unref?.()
  }
}
