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
import type { UpstreamErrorKind, WorkBuddyRegion } from './upstream.ts'

export type { WorkBuddyPoolPolicy, WorkBuddyPoolStateRecord } from './status-paths.ts'

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
  creditsAtMs: number
}

/** Outcome of one dispatch, reported back by the shim. */
export interface WorkBuddyDispatchOutcome {
  ok: boolean
  /** Upstream failure class; `transport` covers a failed connection. */
  kind?: UpstreamErrorKind
  /** Redacted, human-readable reason stored on the entry. */
  message?: string
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
      creditsAtMs: 0,
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

  /** The earliest still-running deadline of an entry, or 0 when it is clear. */
  private expiryOf(entry: EntryState, now: number): number {
    const deadlines = [entry.cooldownUntil, entry.breakerUntil, entry.degradedUntil]
      .filter(deadline => deadline > now)
    return deadlines.length === 0 ? 0 : Math.min(...deadlines)
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
  pick(options: { exclude?: ReadonlySet<string>; stickyKey?: string } = {}): WorkBuddyPickResult {
    const now = this.now()
    const excluded = options.exclude ?? new Set<string>()
    const all = [...this.entries.values()]
    if (all.length === 0) return { ok: false, reason: 'no-accounts' }
    if (all.every(entry => !entry.enabled)) return { ok: false, reason: 'all-disabled' }
    // A disabled account is never picked, not even as an all-cooling fallback.
    const pickable = all.filter(entry => entry.enabled && entry.present)
    if (pickable.length === 0) return { ok: false, reason: 'pool-saturated' }

    const bound = this.stickyBinding(options.stickyKey, now)
    if (bound !== undefined && this.healthy(bound, now) && !excluded.has(bound.accountId)
      && this.totalInFlight < this.policy.maxInFlightTotal) {
      return { ok: true, entry: this.view(this.dispatch(bound, now), now), fallback: false }
    }

    // The pool-wide ceiling is a hard stop: falling back "around" it would
    // defeat the reason it exists, so a saturated pool refuses instead.
    if (this.policy.maxInFlightTotal > 0 && this.totalInFlight >= this.policy.maxInFlightTotal) {
      return { ok: false, reason: 'pool-saturated' }
    }

    const candidates = all.filter(entry => !excluded.has(entry.accountId) && this.healthy(entry, now))
    if (candidates.length === 0) {
      const fallback = this.pickEarliestExpiry(pickable, excluded, now)
      if (fallback === undefined) return { ok: false, reason: this.missReason(all) }
      return { ok: true, entry: this.view(this.dispatch(fallback, now), now), fallback: true }
    }

    let maxCredits = 0
    for (const entry of candidates) {
      if (entry.credits !== undefined && entry.credits > maxCredits) maxCredits = entry.credits
    }
    const ranked = candidates
      .map(entry => ({ entry, weight: this.weightOf(entry, maxCredits, now) }))
      .sort((left, right) => right.weight - left.weight || left.entry.usedSeq - right.entry.usedSeq)
    const shortlist = ranked.slice(0, 5)
    const eligible = shortlist.filter(candidate => now - candidate.entry.lastUsedAt >= this.policy.minPickGapMs)
    const chosen = eligible.length > 0
      ? this.pickWeighted(eligible.map(candidate => candidate.entry), eligible.map(candidate => candidate.weight))
      // Everything on the shortlist was used inside the gap: take the globally
      // least-recently-used candidate so no account is starved by the cutoff.
      : ranked.reduce((best, candidate) =>
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
      entry.lastSuccessAt = now
      entry.lastError = ''
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
      case 'session_dead':
        entry.cooldownKind = 'hard'
        entry.cooldownUntil = nextDay4Am(now)
        entry.lastError = '会话已失效，请在 WorkBuddy 桌面端重新登录该账号'
        return
      case 'soft_rate': {
        // The "already cooling" rule: a user hammering retry must not push the
        // account further into the future than the first refusal did.
        if (entry.cooldownKind === 'soft' && entry.cooldownUntil > now) return
        const shift = Math.min(entry.softStreak, 16)
        const grown = this.policy.softRateCooldownMs * 2 ** shift
        const capped = Math.min(grown, this.policy.softRateCooldownMaxMs)
        entry.cooldownKind = 'soft'
        entry.cooldownUntil = now + capped
        entry.softStreak += 1
        return
      }
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

  /** Cache the credits the card or the CLI read for one account. */
  setCredits(accountId: string, credits: { total: number; expiringSoon: number }): void {
    const entry = this.entries.get(accountId)
    if (entry === undefined) return
    entry.credits = credits.total
    entry.creditsExpiring = credits.expiringSoon
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
