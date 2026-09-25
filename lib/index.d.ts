import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/status-paths.d.ts
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
declare const WORKBUDDY2API_USAGE_PATH = "/plugins/dsh-workbuddy2api/usage";
/** Plugin-owned live model refresh endpoint. */
declare const WORKBUDDY2API_MODELS_REFRESH_PATH = "/plugins/dsh-workbuddy2api/models/refresh";
/** Plugin-owned local account rescan endpoint. */
declare const WORKBUDDY2API_ACCOUNTS_REFRESH_PATH = "/plugins/dsh-workbuddy2api/accounts/refresh";
/** Plugin-owned per-account credit refresh endpoint. */
declare const WORKBUDDY2API_CREDITS_REFRESH_PATH = "/plugins/dsh-workbuddy2api/credits/refresh";
/** Plugin-owned daily check-in action endpoint. */
declare const WORKBUDDY2API_CHECKIN_PATH = "/plugins/dsh-workbuddy2api/checkin";
/** Plugin-owned pool control endpoint (reset / release). */
declare const WORKBUDDY2API_POOL_ACTION_PATH = "/plugins/dsh-workbuddy2api/pool";
/** Plugin-owned web sign-in start endpoint: returns an authorization URL. */
declare const WORKBUDDY2API_LOGIN_START_PATH = "/plugins/dsh-workbuddy2api/login/start";
/** Plugin-owned web sign-in poll endpoint: reports progress and finishes it. */
declare const WORKBUDDY2API_LOGIN_POLL_PATH = "/plugins/dsh-workbuddy2api/login/poll";
/** Query parameter carrying the sign-in state a poll addresses. */
declare const WORKBUDDY2API_STATE_PARAM = "state";
/** Query parameter naming the account a card request addresses. */
declare const WORKBUDDY2API_ACCOUNT_PARAM = "accountId";
/** Query parameter naming the REGION (i.e. which pool) a card request addresses. */
declare const WORKBUDDY2API_REGION_PARAM = "region";
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
declare const WORKBUDDY2API_REGIONS: readonly WorkBuddyWebRegion[];
/**
 * Address one region's status route. Every card request carries the region
 * whose tab the user is on, so a tab can only ever read and write its own
 * pool, credits, and model slot.
 */
declare function withWorkBuddyRegion(path: string, region: WorkBuddyWebRegion): string;
/**
 * Read the region parameter off a status-route URL. Absent means the domestic
 * tab (`cn`); a present-but-unknown value returns undefined so the route can
 * answer 400 instead of silently addressing the wrong pool.
 */
declare function regionOfStatusUrl(url: string): WorkBuddyWebRegion | undefined;
/**
 * Region of the signed-in credential: the CN app (`codebuddy.cn` /
 * `workbuddy.cn`) or the international WorkBuddy AI app (`workbuddy.ai` /
 * `codebuddy.ai`). The card uses this to pick the pool and model slot a tab
 * reads and writes.
 */
type WorkBuddyWebRegion = 'cn' | 'global';
/** One credit package as the upstream returns it, node-free. */
interface WorkBuddyWebCreditPackage {
  packageName: string;
  remain: number;
  size: number;
  /** CapacityType 4: refreshed every cycle and never expires. */
  monthly: boolean;
  /** Next cycle start (the monthly refresh point) in ms. */
  cycleRefreshMs?: number;
  /** One-off expiry in ms; the package disappears from the account then. */
  expiresAtMs?: number;
}
/** Aggregated credit answer rendered by the plugin card. */
interface WorkBuddyWebCredits {
  total: number;
  /**
   * The allowance `total` is measured against, for the card's remaining-share
   * ring. 0 means "unknown", never "empty".
   */
  capacity: number;
  packages: readonly WorkBuddyWebCreditPackage[];
  /** Credits expiring within 3 days across every package. */
  expiringSoon: number;
  /** When the nearest package expires, in ms. */
  nearestExpiryMs?: number;
}
/** Daily check-in state rendered next to an account's credits. */
interface WorkBuddyWebCheckin {
  active: boolean;
  todayCheckedIn: boolean;
  streakDays: number;
  dailyCredit: number;
  todayCredit: number;
  isStreakDay: boolean;
  nextStreakDay: number;
  streakBonusDays: number;
  streakBonusCredit: number;
  claimButtonText?: string;
}
/** Editable WorkBuddy model row rendered by the plugin-owned settings card. */
interface WorkBuddyWebModel {
  id: string;
  name: string;
  /** Effective DSH context after applying the saved local budget. */
  contextWindow: number;
  /** Native maximum advertised by WorkBuddy; models above 200K expose 200K/max. */
  nativeContextWindow: number;
  maxTokens: number;
  creditMultiplier?: number;
  multimodal?: boolean;
  reasoning?: {
    supportedEfforts?: readonly string[];
    defaultEffort?: string;
  };
  description?: string;
}
/**
 * Project one card row into its persisted `lastCatalog` shape: the native
 * context window becomes the stored `contextWindow`, and the card-only
 * presentation fields (`nativeContextWindow`, `multimodal`) are removed BY
 * KEY. They must never be set to `undefined`: explicit `undefined` values
 * survive `structuredClone` and are rejected by the settings write path's
 * strict JSON codec, which fails the whole save.
 */
declare function toPersistedWorkBuddyModel(model: WorkBuddyWebModel): Omit<WorkBuddyWebModel, 'nativeContextWindow' | 'multimodal'>;
/** One selectable local account, token-free. */
interface WorkBuddyWebAccount {
  id: string;
  accountName: string;
  uin?: string;
  domain: string;
  region: WorkBuddyWebRegion;
  source: 'desktop' | 'dsh';
  tokenExpiresAtMs: number;
  /** Whether this account's pool currently counts it as enabled. */
  enabled: boolean;
  /** Whether a credential file for this account is still on disk. */
  present: boolean;
}
/** One account's pool health, as the card renders it. */
interface WorkBuddyWebPoolEntry {
  accountId: string;
  accountName: string;
  region: WorkBuddyWebRegion;
  enabled: boolean;
  weight: number;
  priority: number;
  state: 'ready' | 'cooldown' | 'degraded' | 'missing' | 'disabled';
  cooldownUntil?: number;
  cooldownKind?: 'soft' | 'hard';
  breakerUntil?: number;
  degradedUntil?: number;
  inFlight: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  cooldownCount: number;
  lastUsedAt?: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  credits?: number;
  creditsAtMs?: number;
  creditsExpiringSoon?: number;
  /** The allowance `credits` is measured against; 0 means "unknown". */
  creditsCapacity?: number;
  /**
   * Per-model refusals currently in force: a 6004 rate limit or an 11102
   * "this backend has no such model". Listed so a model that keeps failing is
   * visible as the MODEL's problem rather than the account looking broken.
   */
  modelCooldowns?: readonly {
    model: string;
    untilMs: number;
    reason: string;
    hits: number;
  }[];
  present: boolean;
  tokenExpiresAtMs: number;
}
/**
 * The plugin's own configuration document, as the card reads and edits it.
 *
 * Read through {@link WORKBUDDY2API_CONFIG_PATH} on hosts that no longer ship the
 * browser-side settings scope; the whole section is returned verbatim so the card
 * can pick out the fields it owns exactly as it did before.
 */
interface WorkBuddyWebConfig {
  /** Whether this deployment accepts configuration edits at all. */
  writable: boolean;
  /** The whole section, or absent when nothing is stored yet. */
  value?: unknown;
  /** Present only on a refusal, for the card to show. */
  error?: string;
}
/** One account's credit panel document. */
interface WorkBuddyWebAccountCredits {
  accountId: string;
  credits?: WorkBuddyWebCredits;
  creditsError?: string;
  checkin?: WorkBuddyWebCheckin;
  checkinError?: string;
}
type WorkBuddyWebPackage = WorkBuddyWebCreditPackage;
/**
 * The persisted per-account pool slice. Declared node-free because the browser
 * half saves it back verbatim through `settingsScope`; `pool.ts` owns the
 * semantics and the host writes the values.
 */
interface WorkBuddyPoolStateRecord {
  accountId: string;
  enabled: boolean;
  weight: number;
  priority: number;
  cooldownUntil?: number;
  cooldownKind?: 'soft' | 'hard';
  cooldownCount?: number;
  breakerUntil?: number;
  degradedUntil?: number;
}
/** The card's view of the persisted pool slice: the same document. */
type WorkBuddyWebPoolState = WorkBuddyPoolStateRecord;
/**
 * Health-policy knobs for one account pool. Declared here (node-free) so the
 * browser half and the host's `pool.ts` share ONE definition; the defaults live
 * in `pool.ts`.
 *
 * Each region carries its OWN policy: the international gateway enforces a
 * visibly tighter WAF, so its pool keeps a lower concurrency ceiling and a
 * longer cooldown than the domestic one.
 */
interface WorkBuddyPoolPolicy {
  /** Concurrent requests per account; 0 means unlimited. */
  maxInFlightPerAccount: number;
  /** Ceiling for this region's accounts when the region is the global one. */
  maxInFlightGlobalPerAccount: number;
  /** Concurrent requests across the whole pool; 0 means unlimited. */
  maxInFlightTotal: number;
  /** Soft-rate-limit cooldown base. */
  softRateCooldownMs: number;
  /** Soft-rate-limit exponential backoff ceiling. */
  softRateCooldownMaxMs: number;
  /** Fixed cooldown for an upstream 404. */
  notFoundCooldownMs: number;
  /** Consecutive failures before the breaker opens. */
  breakerThreshold: number;
  /** First breaker cooldown; doubles per consecutive trip. */
  breakerCooldownMs: number;
  /** Ceiling for the breaker cooldown. */
  breakerCooldownMaxMs: number;
  /** Consecutive unclassified failures before an account is degraded. */
  degradeThreshold: number;
  /** How long a degraded account stays deprioritized. */
  degradeCooldownMs: number;
  /** Ceiling for the degrade window. */
  degradeCooldownMaxMs: number;
  /** Session stickiness lifetime; 0 disables stickiness. */
  stickyTtlMs: number;
  /** How often expired sticky bindings are collected. */
  stickyGcIntervalMs: number;
  /** Ignore credit- and idle-based weighting, picking uniformly. */
  balanceAware: boolean;
}
/** The card's view of one region's policy: the same document, under its web name. */
type WorkBuddyWebPoolPolicy = WorkBuddyPoolPolicy;
/**
 * One browser sign-in, as the card drives it. The host never returns the token
 * bundle to the page — only the account it produced.
 */
type WorkBuddyWebLogin = {
  status: 'pending';
  state: string;
  url: string;
  region: WorkBuddyWebRegion;
} | {
  status: 'waiting';
  region: WorkBuddyWebRegion;
  message?: string;
} | {
  status: 'done';
  region: WorkBuddyWebRegion;
  account: WorkBuddyWebAccount;
  note?: string;
} | {
  status: 'error';
  region: WorkBuddyWebRegion;
  message: string;
};
/** The JSON document one region's card tab renders. */
type WorkBuddyWebUsage = {
  status: 'empty';
  region: WorkBuddyWebRegion;
  accounts: readonly WorkBuddyWebAccount[];
  pool: readonly WorkBuddyWebPoolEntry[];
  message?: string;
} | {
  status: 'ready';
  region: WorkBuddyWebRegion;
  accounts: readonly WorkBuddyWebAccount[];
  pool: readonly WorkBuddyWebPoolEntry[];
  credits: readonly WorkBuddyWebAccountCredits[];
  models: readonly WorkBuddyWebModel[];
  enabledModelIds: readonly string[];
  imageModelIds: readonly string[];
  /** Persisted per-account pool state, so the card can save it back. */
  poolState: readonly WorkBuddyWebPoolState[];
  /** Effective pool policy, so the card can display and edit it. */
  policy: WorkBuddyWebPoolPolicy;
} | {
  status: 'error';
  region: WorkBuddyWebRegion;
  message: string;
};
//#endregion
//#region src/auth.d.ts
/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
interface WorkBuddyCredential {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
  uin?: string;
  /** Which auth file this came from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh';
  /** Absolute path of the auth file this credential was read from. */
  filePath: string;
  /**
   * Epoch ms the upstream last issued this token (`auth.lastRefreshTime`).
   *
   * This is the ONLY trustworthy freshness signal. `expiresAtMs` cannot be
   * used for ranking: when the upstream revokes a token it leaves the stored
   * `expiresAt` untouched, so a long-dead backup can claim a LATER expiry than
   * the live sign-in (observed on a real machine — a 2026-07-08 backup claimed
   * 2027-07-06 while the live file expired 2026-11-14).
   */
  lastRefreshAtMs?: number;
}
/** Read-only sign-in summary for status and doctor output. */
interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out';
  expiresAtMs?: number;
  refreshExpiresAtMs?: number;
  nickname?: string;
  domain?: string;
  source?: 'desktop' | 'dsh';
}
/** One selectable local account, token-free. */
interface WorkBuddyAccountChoice {
  /** Stable id derived from `uin` (or `uid` when uin is absent). */
  id: string;
  accountName: string;
  uin?: string;
  domain: string;
  /** Region derived from `domain`; the pool reports it per account. */
  region: WorkBuddyRegion;
  source: 'desktop' | 'dsh';
  tokenExpiresAtMs: number;
  /** The auth file this account was read from; newest is preferred. */
  filePath: string;
}
/** Constructor options; only {@link WorkBuddyCredentialStoreOptions.refresh} is required. */
interface WorkBuddyCredentialStoreOptions {
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string;
  /**
   * Auth directories to scan, overriding the platform defaults. Injectable so
   * the multi-account scan is testable without touching a real machine.
   */
  authDirs?: readonly string[];
  /** Directory for the per-account refreshed copies; defaults to $DSH_HOME. */
  storeDir?: string;
  /**
   * Region this store serves. When set, only credentials whose login domain
   * maps to this region are discovered or resolved — the two regions' pools
   * run side by side without ever seeing each other's accounts.
   */
  region?: WorkBuddyRegion;
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number;
}
/** Env variable that overrides the desktop auth-file location. */
declare const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/**
 * Plugin-owned copy path for one account inside the Harness home. One file per
 * account id means N simultaneously signed-in accounts never overwrite each
 * other's refreshed token — the property the pool depends on.
 */
declare function workbuddyOwnAuthPath(accountId: string, storeDir?: string): string;
/**
 * Platform-default directories holding the WorkBuddy desktop app's auth file.
 *
 * Windows and Linux prefer the OS-issued env location and fall back to the
 * home-derived convention when it is unset, so a redirected profile (OneDrive
 * folder backup, enterprise policy) still resolves. macOS has no equivalent
 * env variable; the single Application Support path is used as-is.
 */
declare function defaultDesktopAuthDirs(platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv): string[];
/** The live auth file's platform candidates, in probe order. */
declare function defaultDesktopAuthCandidates(): string[];
/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
declare function defaultDesktopAuthPath(): string | undefined;
/** Normalize an expiry that may arrive in seconds or milliseconds. */
declare function expiryToMs(value: number): number;
/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
declare function parseWorkBuddyAuth(text: string, filePath: string): WorkBuddyCredential | undefined;
/**
 * Filename of a path regardless of the host separator: Windows paths use `\`
 * and this helper must keep working when a Windows path is compared on a
 * POSIX host (e.g. tests injecting a Windows-style auth dir).
 */
declare function authFileName(path: string): string;
/**
 * Whether `candidate` is a better pick than `incumbent` for the same account.
 * Ordering, strongest signal first: the live file; then the most recent
 * `lastRefreshAtMs` (the upstream's own issuance time); then `expiresAtMs`
 * as a fallback for documents that omit the field.
 */
declare function isFresher(candidate: WorkBuddyCredential, incumbent: WorkBuddyCredential): boolean;
/**
 * Stable account id. `uin` is the billing identity the upstream keys on and
 * survives across re-login; `uid` is the fallback for documents without one.
 */
declare function workbuddyAccountId(credential: Pick<WorkBuddyCredential, 'uin' | 'uid' | 'nickname'>): string;
/**
 * Read-only credential registry with demand-driven refresh and multi-account
 * discovery.
 *
 * Refresh policy: refresh only when the access token is inside the margin (or
 * already expired), keep the refreshed credential in the account's own
 * plugin-owned copy, and never write the desktop app's files. A failed refresh
 * still returns a not-yet-expired token so an unreachable refresh endpoint does
 * not take down a working session.
 */
declare class WorkBuddyCredentialStore {
  private readonly refresh;
  private readonly refreshMarginMs;
  private readonly authDirs;
  private readonly storeDir;
  private readonly region;
  private desktopPathOverride;
  /** In-flight refresh per account id; concurrent callers share one request. */
  private readonly inflight;
  constructor(options: WorkBuddyCredentialStoreOptions);
  /** Whether a credential's login domain belongs to this store's region. */
  private matchesRegion;
  /** The region this store serves, when it is region-scoped. */
  regionOf(): WorkBuddyRegion | undefined;
  /** Repoint the desktop file or directory; applies on the next read. */
  setDesktopPath(path: string | undefined): void;
  /** The auth-file path candidates, in probe order. */
  private resolveDesktopCandidates;
  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined;
  /**
   * Every auth file to scan: the live file plus the timestamped backups
   * WorkBuddy leaves beside it.
   *
   * An explicitly configured path pins the *directory*: its siblings are still
   * scanned, because a user who points the plugin at their auth file expects
   * account switching to work the same way it does on the default path. Only
   * the file ordering changes.
   */
  private candidateFiles;
  /** Timestamped siblings of one auth file, newest first by filename. */
  private backupsBeside;
  /** Every plugin-owned copy currently on disk, keyed by account id. */
  private readOwns;
  /**
   * Read every local credential, deduplicated by account id. Files are probed
   * newest-first, so the first entry for an account is its freshest. Every
   * account — both regions — is returned: the pool decides which ones to use.
   */
  readAll(): Promise<WorkBuddyCredential[]>;
  /** Token-free account list for the plugin card, in discovery order. */
  accounts(): Promise<WorkBuddyAccountChoice[]>;
  /** The freshest stored credential for one account id, no refresh. */
  current(accountId: string): Promise<WorkBuddyCredential | undefined>;
  /**
   * Every requested credential that is present locally, in the order asked.
   * Ids with no local credential are dropped: the pool must be able to tell
   * "this account vanished" from "this account is unhealthy".
   */
  byIds(accountIds: readonly string[]): Promise<WorkBuddyCredential[]>;
  /** The credential to send upstream for one account: {@link current}, refreshed on demand. */
  resolve(accountId: string): Promise<WorkBuddyCredential>;
  /** Read-only sign-in summary for one account; never refreshes and never throws. */
  status(accountId: string): Promise<WorkBuddyAuthStatus>;
  /**
   * Remove every plugin-owned copy this store wrote; the desktop files are
   * untouched. `logout` is the user's "forget what the plugin stored" action,
   * not a per-account toggle, so every per-account copy is cleared.
   */
  logout(): Promise<void>;
  /** Whether any desktop candidate file exists as a regular file; diagnostics only. */
  desktopFilePresent(): Promise<boolean>;
  private needsRefresh;
  private refreshNow;
  /**
   * Persist a credential the plugin obtained ITSELF — currently only through
   * the card's web sign-in. It lands in this store's own per-account copy, so
   * the pool treats it exactly like a discovered desktop sign-in, and the
   * desktop app's files stay untouched.
   *
   * A credential for the other region is refused rather than stored: the two
   * regions are two separate pools, and a mis-filed account would appear in
   * the wrong tab and be billed through the wrong gateway.
   */
  save(credential: WorkBuddyCredential): Promise<WorkBuddyCredential>;
  /**
   * Adopt the local identity of an already-known account when a freshly
   * obtained credential for that same account omits fields the local copy
   * carries. The sign-in endpoint answers `uid` and `nickname` but not the
   * billing `uin` the desktop files hold, and the account id is derived from
   * `uin` first — so without this the same human would occupy two pool
   * entries, one of which the desktop app keeps refreshing.
   */
  reconcileIdentity(credential: WorkBuddyCredential): Promise<WorkBuddyCredential>;
  private saveOwn;
}
//#endregion
//#region src/upstream.d.ts
/** WorkBuddy region selected by the credential's login domain. */
type WorkBuddyRegion = 'cn' | 'global';
/** Upstream failure classes the shim maps onto distinct HTTP answers. */
type UpstreamErrorKind = 'hard_credit' | 'soft_rate' |
/** 429 + code 6004: the MODEL is rate-limited, not the account. */
'model_rate' |
/** 11102 "service info not found": this backend has no such model at all. */
'model_blocked' |
/** 403 with no business envelope: the gateway's WAF answered, not the API. */
'waf_block' | 'session_dead' | 'not_found' | 'server' | 'client';
/** Reasoning capability as the upstream catalog declares it. */
interface WorkBuddyReasoning {
  supportedEfforts?: readonly string[];
  defaultEffort?: string;
  canDisableThinking?: boolean;
}
/** One CLI-usable model, carrying everything the plugin card displays. */
interface WorkBuddyUpstreamModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /** Credit multiplier parsed from the upstream `credits` string. */
  creditMultiplier?: number;
  /**
   * Image-input support decided by the user's explicit selection
   * (imageModelIds), not inferred from upstream capability flags.
   */
  multimodal?: boolean;
  reasoning?: WorkBuddyReasoning;
  descriptionZh?: string;
  descriptionEn?: string;
  supportsToolCall?: boolean;
}
/** One billing package as the upstream returns it, dates already parsed. */
interface WorkBuddyCreditPackage {
  packageName: string;
  remain: number;
  size: number;
  /** CapacityType 4: refreshed every cycle and never expires. */
  monthly: boolean;
  /** Next cycle start (the monthly refresh point); only on monthly packages. */
  refreshAtMs?: number;
  /** One-off expiry; the package disappears from the account at this time. */
  expiresAtMs?: number;
}
/** Aggregated credit answer for one credential. */
interface WorkBuddyCredits {
  total: number;
  /**
   * The allowance every counted package adds up to — the denominator of
   * "how much is left". A monthly package contributes its per-cycle capacity
   * and a one-off gift its original size, so the ratio means "remaining share
   * of everything this account was granted". 0 means the upstream did not
   * report any sizes, and callers must treat the ratio as unknown rather than
   * as "nothing left".
   */
  capacity: number;
  packages: readonly WorkBuddyCreditPackage[];
  /** Credits expiring within 3 days across every package. */
  expiringSoon: number;
  /** When the nearest package expires, in ms. */
  nearestExpiryMs?: number;
}
/** Daily check-in activity state. */
interface WorkBuddyCheckinStatus {
  active: boolean;
  todayCheckedIn: boolean;
  streakDays: number;
  dailyCredit: number;
  todayCredit: number;
  isStreakDay: boolean;
  nextStreakDay: number;
  streakBonusDays: number;
  streakBonusCredit: number;
  claimButtonText?: string;
}
/** Daily check-in claim result. */
interface WorkBuddyCheckinClaim {
  credit: number;
  streakDays: number;
  isStreakDay: boolean;
}
/** Token refresh answer; fields the upstream omits stay absent. */
interface WorkBuddyRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  domain?: string;
}
/** Chat answer: either a live SSE response or a classified failure. */
type WorkBuddyChatResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  status: number;
  kind: UpstreamErrorKind;
  message: string;
  /** The upstream's own reset moment, when the body named one. */
  resetAtMs?: number;
  /** A wait the upstream stated in a response header, when it sent one. */
  retryAfterMs?: number;
};
/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 *
 * The order is specific-before-broad, and every step has a reason:
 *
 * 1. `model_blocked` (11102) first — it is the most specific verdict the upstream
 *    gives ("this model does not exist on this backend"), and letting the broad
 *    4xx fallback take it would leave a broken model in rotation;
 * 2. 402 — the only real "out of credit" status, and the least self-healing;
 * 3. `session_dead` — a terminal state needing a human, so it outranks the
 *    rate-limit wording that a mixed-up gateway error page can contain;
 * 4. 429 — the STATUS is more authoritative than keywords, because rate-limit
 *    bodies often carry "quota exceeded", which would otherwise be read as
 *    "out of credit" and park the account until 04:00;
 * 5. remaining credit wording on other statuses;
 * 6. rate-limit wording on other statuses;
 * 7. 404 / 5xx;
 * 8. WAF — 403 without an envelope, before the generic 4xx fallback;
 * 9. everything else.
 */
declare function classifyUpstreamError(status: number, body: string): UpstreamErrorKind;
/**
 * Region for a login domain; an empty domain means CN. The international
 * product is reachable under TWO brand domains (`workbuddy.ai` desktop and
 * `codebuddy.ai` CLI), both served by the same gateway stack.
 */
declare function regionOf(domain: string): WorkBuddyRegion;
/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
 * force `stream: true` (the upstream rejects non-streaming), rewrite DSH's
 * `developer` role to `system`, and flatten `tool_choice`.
 */
declare function prepareChatBody(source: string): string;
/**
 * Parse the upstream's `credits` string into a multiplier. Observed forms:
 * `"x0.79 credits"`, `"x0.05"`, `"x0.00 credits"`, and absent. Unparsable
 * values yield undefined rather than a guess.
 */
declare function parseCreditMultiplier(value: unknown): number | undefined;
/** Parse the upstream's `reasoning` object; unknown shapes degrade to undefined. */
declare function parseReasoning(value: unknown): WorkBuddyReasoning | undefined;
/** Parse one catalog entry; entries without usable token limits are dropped. */
declare function parseUpstreamModel(value: unknown): WorkBuddyUpstreamModel | undefined;
/**
 * Select the chat-capable models from a catalog-shaped document: parse every
 * entry, then keep the `cli` agent's roster in its declared order. Without a
 * usable `cli` roster the whole parsed catalog is exposed rather than nothing.
 */
declare function selectCliModels(rawModels: unknown, agents: unknown): WorkBuddyUpstreamModel[];
/**
 * Parse one growth task. The progress shape varies by task type: some entries
 * carry a nested `progress: {current,target}` object and others flat
 * `current`/`target` fields, so both are read and the nested one wins when it
 * carries a real value.
 */
declare function parseUpstreamTask(value: unknown): WorkBuddyTask | undefined;
/** One expert from the platform market; ids must be real to count. */
interface WorkBuddyMarketExpert {
  expertId: string;
  expertType: string;
  name: string;
  profession: string;
  version: string;
  category: string;
}
/** One growth task as the upstream returns it, progress already normalized. */
interface WorkBuddyTask {
  taskCode: string;
  title?: string;
  description?: string;
  taskDesc?: string;
  /** Reward in credits. */
  credit: number;
  /** Reward in energy. */
  energy: number;
  hasReward: boolean;
  taskType?: string;
  tag?: string;
  jumpUrl?: string;
  locked: boolean;
  target: number;
  current: number;
  acceptStatus?: string;
  status?: string;
  /** Progress reached and reward not taken (computed locally). */
  claimable: boolean;
  /** Reward already taken (accept_status == "claimed"). */
  claimed: boolean;
}
/** A reward the gateway paid out. */
interface WorkBuddyTaskReward {
  credit: number;
  energy: number;
  /** The gateway says this reward was taken before; no new credits. */
  alreadyClaimed: boolean;
}
/** A desktop-fingerprint event; the shared fingerprint is merged in on send. */
type WorkBuddyDesktopEvent = Record<string, unknown>;
/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 */
declare class WorkBuddyUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  chatStream(credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal): Promise<WorkBuddyChatResult>;
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome>;
  /**
   * Read the model directory for the credential's region. CN answers
   * `/v2/enterprises/personal/models`; the global gateway answers `/v3/config`
   * for the desktop channel (its personal-models path returns HTTP 500 and the
   * CLI channel omits chat-usable models).
   */
  fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]>;
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
  fetchModelsForCredentials(credentials: readonly WorkBuddyCredential[], signal?: AbortSignal): Promise<WorkBuddyUpstreamModel[]>;
  /** Query today's check-in status without changing account state. */
  fetchCheckinStatus(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinStatus>;
  /** Claim today's check-in reward. The browser route guards this mutation. */
  claimDailyCheckin(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinClaim>;
  /**
   * POST the billing endpoint for the remaining credit, keeping every package
   * separate: the card groups monthly-cycle packages itself and lists the
   * nearest-expiring one-off packages, so aggregation here would lose the
   * dates it needs.
   *
   * `expiringSoonMs` is the window that decides which credits count as "about to
   * expire" — the number the picker uses to prefer spending credits before they
   * lapse. It is a policy value rather than a constant because the right window
   * depends on how the account's packages are actually granted, and a hardcoded
   * one silently disagrees with the setting the operator can see and edit.
   */
  fetchCredits(credential: WorkBuddyCredential, expiringSoonMs?: number): Promise<WorkBuddyCredits>;
  /**
   * Read the growth task list. This is the whole task surface: accept, claim,
   * and every "did it score yet" read all key off it.
   */
  listTasks(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<WorkBuddyTask[]>;
  /** Register for tasks (idempotent: an already-accepted task is not an error). */
  acceptTasks(credential: WorkBuddyCredential, taskCodes: readonly string[]): Promise<void>;
  /**
   * Take one task's reward.
   *
   * The path matters and is NOT the CLI one: the reward endpoint lives on the
   * WEB origin (`workbuddy.cn/activity/growth/tasks/<code>/claim`, task code in
   * the path, `x-client-platform: web`). The CLI-shaped
   * `copilot.tencent.com/v2/activity/growth/tasks/reward/claim` does not exist
   * and answers "task not completed" for every task.
   */
  claimTaskReward(credential: WorkBuddyCredential, taskCode: string): Promise<WorkBuddyTaskReward>;
  /**
   * Report one conversation-activity event (chat_request_send). This is what
   * actually lights up most tasks — registering for a task produces no
   * progress; the gateway scores behavior events.
   */
  reportChatActivity(credential: WorkBuddyCredential, conversationId: string, requestId: string, model?: {
    id: string;
    name: string;
  }): Promise<void>;
  /** Report desktop-fingerprint events to the chat origin's /v2/report. */
  reportDesktopEvents(credential: WorkBuddyCredential, events: readonly WorkBuddyDesktopEvent[]): Promise<void>;
  /** Report web-fingerprint events to the product's own origin. */
  reportWebEvents(credential: WorkBuddyCredential, events: readonly WorkBuddyDesktopEvent[]): Promise<void>;
  /**
   * POST one batch of events. The three channels differ only in origin and
   * headers: the CLI/billing channel authenticates with the billing headers,
   * the desktop one mimics the app, and the web one mimics the growth centre.
   */
  private reportEvents;
  /**
   * Read the platform's real expert market. The ids must be REAL: an invented
   * expert id never counts toward the expert tasks, which is why the market is
   * listed instead of hard-coding names.
   */
  marketExpertList(credential: WorkBuddyCredential, expertType: 'agent' | 'team'): Promise<WorkBuddyMarketExpert[]>;
  /**
   * Send one real chat turn in the desktop app's shape and read the SERVER's
   * request id out of the SSE stream.
   *
   * The expert/skill tasks are scored on events that JOIN a real conversation,
   * and the join key must be the id the server minted — a locally generated
   * UUID does not count. So this streams (and drains) the answer just far
   * enough to capture `data.id`, then stops caring about the content.
   */
  desktopChatTurn(credential: WorkBuddyCredential, options?: {
    expertId?: string;
    model?: string;
    prompt?: string;
  }): Promise<{
    conversationId: string;
    requestId: string;
  }>;
  /** Claim the one-off newcomer gift. Re-claiming answers a business error. */
  claimGift(credential: WorkBuddyCredential): Promise<number>;
  /** Agree to the buddy programme terms. Idempotent. */
  buddyAgreement(credential: WorkBuddyCredential): Promise<void>;
  /**
   * Adopt the first buddy. Before the daily-activity threshold is met the
   * gateway answers HTTP 400 with `first_buddy task not completed yet`; that is
   * an expected "not yet", not a failure, so it is reported as such.
   */
  buddyFirst(credential: WorkBuddyCredential): Promise<{
    adopted: boolean;
    message: string;
  }>;
  /** One POST to the growth domain, envelope unwrapped. */
  private growthJson;
  /** One POST to the billing domain, envelope unwrapped. */
  private billingJson;
}
//#endregion
//#region src/pool-state.d.ts
/** Basename of the counter file inside the Harness home. */
declare const WORKBUDDY2API_POOL_STATE_FILENAME = ".workbuddy2api-pool-state.json";
/** Current on-disk format; readers reject others. */
declare const WORKBUDDY2API_POOL_STATE_VERSION = 1;
/**
 * One account's durable counters. Every field is optional on read so an older or
 * partial file still loads, and absent means "unknown" rather than zero.
 */
interface WorkBuddyPoolCounterRecord {
  accountId: string;
  /** Dispatches that completed successfully, lifetime. */
  successes?: number;
  /** Dispatches that failed, lifetime. */
  failures?: number;
  /** Monotonic per-account dispatch counter, the LRU tie-breaker. */
  usedSeq?: number;
  lastUsedAt?: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  /** Cached remaining credits and the allowance they are measured against. */
  credits?: number;
  creditsExpiringSoon?: number;
  creditsCapacity?: number;
  /** When the cached credits were read, so the card can show their age. */
  creditsAtMs?: number;
  /** Escalation state, so a backoff resumes instead of restarting. */
  softStreak?: number;
  breakerFails?: number;
  breakerTrips?: number;
  consecutiveFails?: number;
}
/** The whole file: counters per region, keyed by account id. */
interface WorkBuddyPoolStateDocument {
  version: typeof WORKBUDDY2API_POOL_STATE_VERSION;
  regions: Partial<Record<WorkBuddyRegion, WorkBuddyPoolCounterRecord[]>>;
}
/** Absolute path of the counter file. */
declare function workbuddyPoolStatePath(storeDir?: string): string;
/** Parse one counter record, keeping only fields that carry a real value. */
declare function parsePoolCounterRecord(value: unknown): WorkBuddyPoolCounterRecord | undefined;
/** Read the counter document; absent, unreadable, or malformed reads as empty. */
declare function readPoolState(storeDir?: string): Promise<WorkBuddyPoolStateDocument>;
/** Write the counter document atomically. */
declare function writePoolState(document: WorkBuddyPoolStateDocument, storeDir?: string): Promise<void>;
/** Remove the counter file; used when the user forgets stored credentials. */
declare function clearPoolState(storeDir?: string): Promise<void>;
//#endregion
//#region src/pool.d.ts
/** One account as the credential store sees it. */
interface WorkBuddyPoolAccount {
  id: string;
  accountName: string;
  region: WorkBuddyRegion;
  tokenExpiresAtMs: number;
}
/** Runtime health of one pool entry, as the card reports it. */
type WorkBuddyPoolState = 'ready' | 'cooldown' | 'degraded' | 'missing' | 'disabled';
/** One pool entry, as the settings card renders it. */
interface WorkBuddyPoolEntry {
  accountId: string;
  accountName: string;
  region: WorkBuddyRegion;
  /** The user's per-account switch; a disabled account is never picked. */
  enabled: boolean;
  /** Relative pick weight (integer 1..100). */
  weight: number;
  /** Lower number = preferred; orders the pool listing and breaks ties. */
  priority: number;
  /** Derived health, never stored. */
  state: WorkBuddyPoolState;
  /** Soft/hard cooldown deadline (epoch ms), when one is running. */
  cooldownUntil?: number;
  /** `hard` cooldowns come from out-of-credit or dead-session answers. */
  cooldownKind?: 'soft' | 'hard';
  /** Breaker deadline, when the breaker is open. */
  breakerUntil?: number;
  /** Degrade deadline, when the account is being deprioritized. */
  degradedUntil?: number;
  /** Requests currently dispatched to this account. */
  inFlight: number;
  successes: number;
  failures: number;
  /** Consecutive failures; drives the breaker and the degrade window. */
  consecutiveFailures: number;
  /** How many times the soft/credit cooldown has been extended. */
  cooldownCount: number;
  lastUsedAt?: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  /** Remaining credits, when the card or the CLI last queried them. */
  credits?: number;
  creditsAtMs?: number;
  /** Credits expiring inside the configured window (default 7 days). */
  creditsExpiringSoon?: number;
  /**
   * The allowance `credits` is measured against, for the card's
   * remaining-share ring. 0 means the upstream reported no sizes.
   */
  creditsCapacity?: number;
  /**
   * Per-model refusals currently in force for this account: a 6004 rate limit or
   * an 11102 "no such model here". Separate from the account's own health,
   * because the account is fine — only these models are unavailable on it.
   */
  modelCooldowns?: readonly {
    model: string;
    untilMs: number;
    reason: string;
    hits: number;
  }[];
  /** Whether the account still has a local credential file. */
  present: boolean;
  tokenExpiresAtMs: number;
}
/**
 * Pool policy as this module consumes it: the shared, node-free knobs plus the
 * weighting constants that only the host needs.
 */
interface WorkBuddyPoolTuning extends WorkBuddyPoolPolicy {
  /** Idle compensation: weight gained per hour of not being used. */
  idleWeightPerHour: number;
  /** Idle compensation ceiling. */
  idleWeightMax: number;
  /** Weight multiplier for the share of credits expiring inside the window. */
  expiringWeight: number;
  /** The "expiring soon" window used both for weighting and credit bucketing. */
  expiringSoonMs: number;
  /** Two picks inside this gap never choose the same account. */
  minPickGapMs: number;
}
/** The workbuddy2api-derived default policy. */
declare const DEFAULT_WORKBUDDY_POOL_POLICY: WorkBuddyPoolTuning;
/** Outcome of one dispatch, reported back by the shim. */
interface WorkBuddyDispatchOutcome {
  ok: boolean;
  /** Upstream failure class; `transport` covers a failed connection. */
  kind?: UpstreamErrorKind;
  /** Redacted, human-readable reason stored on the entry. */
  message?: string;
  /**
   * The model this dispatch used, when the caller knows it. A model-level
   * cooldown is recorded against this name, so a 6004 for one model does not
   * park the account for the others.
   */
  model?: string;
  /**
   * The wall-clock moment the upstream promised the limit lifts, from the 429
   * body's own wording. Preferred over any computed backoff: it is what actually
   * happens, and guessing longer only idles a healthy account.
   */
  resetAtMs?: number;
  /**
   * A wait the upstream stated in its response headers. Honoured when there is
   * no body wording; ignored when there is, since the body is the narrower
   * statement.
   */
  retryAfterMs?: number;
}
/** Why the pool could not pick any account at all. */
type WorkBuddyPoolMissReason = 'no-accounts' | 'all-disabled' | 'pool-saturated';
/** What {@link WorkBuddyAccountPool.pick} answers. */
type WorkBuddyPickResult = {
  ok: true;
  entry: WorkBuddyPoolEntry;
  /**
   * True when every account was cooling down and the picker fell back to the
   * one whose cooldown expires first. The request is still worth attempting:
   * a cooldown is a local guess, not an upstream verdict.
   */
  fallback: boolean;
} | {
  ok: false;
  reason: WorkBuddyPoolMissReason;
};
/** Constructor dependencies. */
interface WorkBuddyAccountPoolOptions {
  /** Re-read the locally discoverable accounts. */
  list: () => Promise<readonly WorkBuddyPoolAccount[]>;
  /** The persisted per-account state, keyed by account id. */
  state?: readonly WorkBuddyPoolStateRecord[];
  policy?: Partial<WorkBuddyPoolTuning>;
  /** Injected clock, for deterministic tests. */
  now?: () => number;
  /** Injected randomness in [0, 1), for deterministic tests. */
  random?: () => number;
}
/**
 * Session-stickiness key for one chat request.
 *
 * DSH identifies a conversation by its system prompt plus its first user
 * message; hashing both keeps one conversation on one account while different
 * conversations spread across the pool, which is what makes pooled use look
 * like a single account to the upstream's own conversation memory.
 */
declare function stickyKeyOf(bodyJson: string): string | undefined;
/** The local 04:00 following `now`, the hard-credit cooldown deadline. */
declare function nextDay4Am(now: number): number;
/**
 * A weighted account pool over locally discovered WorkBuddy sign-ins.
 *
 * The pool owns no credentials: it decides *which* account id should serve a
 * request, and the shim resolves that account's credential from the store.
 * That split keeps token material out of the scheduling layer and makes the
 * whole pick deterministic under an injected clock and RNG.
 */
declare class WorkBuddyAccountPool {
  private readonly list;
  private readonly now;
  private readonly random;
  private readonly entries;
  private readonly sticky;
  private policy;
  private totalInFlight;
  private seq;
  private gcTimer;
  constructor(options: WorkBuddyAccountPoolOptions);
  /** Replace the health policy; the next pick uses the new numbers. */
  setPolicy(policy: Partial<WorkBuddyPoolTuning>): void;
  /** The policy in force. */
  currentPolicy(): WorkBuddyPoolTuning;
  private blankEntry;
  /**
   * Re-read the local accounts and merge them into the pool. Accounts that
   * vanished keep their entry (so their counters and the user's switch survive
   * a temporarily unreadable auth file) but are marked `present: false` and
   * become unpickable. Accounts that reappear are un-marked.
   */
  refresh(): Promise<void>;
  /** Drop every entry whose account no longer exists locally. */
  prune(): void;
  /** Every entry, in card order: by priority, then by account name. */
  snapshot(): WorkBuddyPoolEntry[];
  /** One entry's card view, or undefined when the account is unknown. */
  entryView(accountId: string): WorkBuddyPoolEntry | undefined;
  private view;
  private stateOf;
  /** The per-account concurrency ceiling for this account's region. */
  private inFlightLimit;
  /** Whether the account is below its concurrency ceiling. */
  private inFlightFull;
  /**
   * The four-dimension health gate: present, enabled, out of every cooldown,
   * and below the concurrency ceiling.
   */
  private healthy;
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
  private healthyForModel;
  /** Drop per-model cooldowns that have expired, so the map cannot grow forever. */
  private pruneModelCooldowns;
  /** The earliest still-running deadline of an entry, or 0 when it is clear. */
  private expiryOf;
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
  private boundAccountIds;
  /** The sticky binding for a session key, when it is alive. */
  private stickyBinding;
  /** Weight of one candidate, per the reference's three-factor formula. */
  private weightOf;
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
  pick(options?: {
    exclude?: ReadonlySet<string>;
    stickyKey?: string;
    /** The model this request asks for; enables model-level gates and tiers. */
    model?: string;
  }): WorkBuddyPickResult;
  /** Why nothing could be picked, in the most specific available terms. */
  private missReason;
  /**
   * The all-cooling fallback: the account whose earliest running deadline is
   * closest. Hard-credit cooldowns are excluded — the account is out of
   * credits, so retrying it only burns a request.
   */
  private pickEarliestExpiry;
  /** Fixed-point weighted draw over the candidates. */
  private pickWeighted;
  /** Reserve one concurrency slot on an entry and record the dispatch. */
  private dispatch;
  /**
   * Return a reserved slot. Safe to call once per successful {@link pick};
   * a double release would corrupt the ceilings, so the caller must pair them.
   */
  release(accountId: string): void;
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
  report(accountId: string, outcome: WorkBuddyDispatchOutcome, stickyKey?: string): void;
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
  private applySoftRate;
  /**
   * Record what one request actually cost on one model.
   *
   * The upstream reports the real charge in the stream's final `usage.credit`,
   * so this is measurement rather than configuration: a model advertised at
   * x0.00 that starts billing shows up here, and the cost tier follows the
   * observation instead of the catalogue. Tokens are needed to normalise the
   * charge; without them the observation is skipped rather than invented.
   */
  noteModelCost(accountId: string, model: string, credit: number, totalTokens: number): void;
  /** Cache the credits the card or the CLI read for one account. */
  setCredits(accountId: string, credits: {
    total: number;
    expiringSoon: number;
    capacity?: number;
  }): void;
  /** Apply the card's per-account switches and weights. */
  configure(updates: readonly {
    accountId: string;
    enabled?: boolean;
    weight?: number;
    priority?: number;
  }[]): void;
  /** Forget one account's cooldown, breaker, and degrade marks. */
  reset(accountId: string): void;
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
  reenableIfCredits(accountId: string, credits: {
    total: number;
    expiringSoon?: number;
    capacity?: number;
  }): boolean;
  /** Live per-model cooldowns for one account, for the card and the CLI. */
  modelCooldownsOf(accountId: string): {
    model: string;
    untilMs: number;
    reason: string;
    hits: number;
  }[];
  /**
   * The durable counters for every entry, keyed by account id.
   *
   * `inFlight` is NOT included on purpose: after a restart nothing is in flight,
   * so restoring a count that no `release()` will ever decrement would consume
   * that account's concurrency allowance for the life of the process.
   */
  toCounters(): Map<string, WorkBuddyPoolCounterRecord>;
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
  restoreCounters(records: Iterable<WorkBuddyPoolCounterRecord>): void;
  /** The pool slice to persist into settings. */
  toPersisted(): WorkBuddyPoolStateRecord[];
  /** Live sticky-binding count, for diagnostics. */
  stickySize(): number;
  /** Stop the sticky GC timer; called when the plugin is disposed. */
  dispose(): void;
  private startGc;
}
//#endregion
//#region src/tasks.d.ts
/** The subset of the upstream client the task engine uses. */
type WorkBuddyTaskClient = Pick<WorkBuddyUpstreamClient, 'listTasks' | 'acceptTasks' | 'claimTaskReward' | 'reportChatActivity' | 'reportDesktopEvents' | 'reportWebEvents' | 'marketExpertList' | 'desktopChatTurn' | 'claimGift' | 'buddyAgreement' | 'buddyFirst'>;
/** How one action finished. */
type WorkBuddyTaskOutcome = 'done' | 'skipped' | 'error' | 'unsupported';
/** One action's result, as the card renders it. */
interface WorkBuddyTaskResult {
  taskCode: string;
  /** What the action does, in the card's language. */
  desc: string;
  outcome: WorkBuddyTaskOutcome;
  message: string;
  /** Progress before and after, e.g. `0/5` → `5/5`. */
  progressBefore?: string;
  progressAfter?: string;
  /** The reward this run collected, when it claimed one. */
  credit?: number;
  energy?: number;
}
/** What a run did, per account. */
interface WorkBuddyTaskRunReport {
  accountId: string;
  accountName: string;
  results: WorkBuddyTaskResult[];
  /** Credits collected by this run. */
  credit: number;
  energy: number;
  startedAtMs: number;
  finishedAtMs: number;
}
/** One task plus what the engine can do about it. */
interface WorkBuddyTaskView {
  task: WorkBuddyTask;
  /** Whether an automated action exists for this task code. */
  automated: boolean;
  /** Why it is not automated, when it is not. */
  unsupportedReason?: string;
}
/** Replace the sleep implementation (tests only). */
declare function setWorkBuddyTaskDelay(delay: (ms: number) => Promise<void>): void;
/** Every task code this plugin can finish on its own. */
declare function automatedTaskCodes(): readonly string[];
/** Why a task cannot be automated, or undefined when it can. */
declare function unsupportedReasonFor(taskCode: string): string | undefined;
/** The engine's dependencies. */
interface WorkBuddyTaskEngineOptions {
  client: WorkBuddyTaskClient;
  /** Live tasks for one account, annotated with what can be automated. */
  list(credential: WorkBuddyCredential): Promise<WorkBuddyTask[]>;
  /** Log one line; the host passes its own logger. */
  log?(message: string): void;
}
/**
 * The task engine: one run per account, actions in a fixed order, every action
 * idempotent (an already-claimed or already-complete task is skipped before its
 * behavior is reported, so a second run never burns a second request).
 */
declare class WorkBuddyTaskEngine {
  private readonly options;
  constructor(options: WorkBuddyTaskEngineOptions);
  /** The task list, each entry annotated with whether it can be automated. */
  view(credential: WorkBuddyCredential): Promise<WorkBuddyTaskView[]>;
  /**
   * Finish every automatable task for one account.
   *
   * Registration happens first and in one batch (the gateway has no documented
   * limit on the array, so it is sent whole); it is not what produces progress,
   * but it keeps the state machine regular. Then each action runs in order,
   * re-reading the task list before and after so the report says what actually
   * changed rather than what was merely requested.
   */
  run(credential: WorkBuddyCredential, options?: {
    taskCodes?: readonly string[];
    signal?: AbortSignal;
  }): Promise<WorkBuddyTaskRunReport>;
  /**
   * Re-read one task until it is settled (claimable or claimed) or the bounded
   * budget runs out. The gateway's scoring is asynchronous — a re-read right
   * after a report still shows the old progress for several seconds.
   */
  private settled;
}
/** A task's progress as text, for the report and the card. */
declare function progressText(task: WorkBuddyTask): string;
/** The persisted daily-task configuration. */
interface WorkBuddyTaskSchedule {
  /** Run the daily sweep automatically. */
  enabled: boolean;
  /** Local hour (0–23) the daily sweep starts at. */
  hour: number;
  /** Local minute (0–59) the daily sweep starts at. */
  minute: number;
  /** Run one sweep shortly after the plugin starts. */
  runOnStart: boolean;
  /** Run only for accounts whose region matches. */
  regions?: readonly WorkBuddyRegion[];
}
/** What the scheduler did last, for the card. */
interface WorkBuddyTaskScheduleStatus {
  /** Epoch ms of the next planned sweep. */
  nextRunAtMs?: number;
  /** Epoch ms of the last sweep that actually ran. */
  lastRunAtMs?: number;
  /** Reports of the last sweep, one per account. */
  lastReports: readonly WorkBuddyTaskRunReport[];
  /** Accounts the last sweep skipped, with why. */
  lastSkipped: readonly {
    accountName: string;
    reason: string;
  }[];
  /** Whether a sweep is running right now. */
  running: boolean;
  /** Whether the plugin runs a startup sweep. */
  runOnStart: boolean;
  /** Whether the daily sweep is armed. */
  enabled: boolean;
  /**
   * The configured daily time, as numbers `hour`/`minute` — the card edits
   * these, so it must receive them. `dailyAt` is only their display form.
   */
  hour: number;
  minute: number;
  /** The configured daily time, as `HH:MM`. */
  dailyAt: string;
}
/** The next occurrence of a local wall-clock time, strictly after `from`. */
declare function nextDailyRunAt(hour: number, minute: number, from?: number): number;
/** Constructor dependencies of the scheduler. */
interface WorkBuddyTaskSchedulerOptions {
  engine: WorkBuddyTaskEngine;
  /** The accounts to sweep, with the region each belongs to. */
  accounts(): Promise<readonly {
    credential: WorkBuddyCredential;
    region: WorkBuddyRegion;
  }[]>;
  /** Current configuration (re-read before every sweep). */
  schedule(): WorkBuddyTaskSchedule;
  /** Delay between two accounts' sweeps. */
  accountGapMs?: number;
  log?(message: string): void;
  now?(): number;
}
/**
 * Runs the task sweep on a daily wall-clock time and, optionally, once shortly
 * after startup. Both triggers call the same serialized sweep, so a startup run
 * that happens to land next to the daily one cannot run twice at once.
 */
declare class WorkBuddyTaskScheduler {
  private readonly options;
  private readonly now;
  private timer;
  private nextRunAtMs;
  private lastRunAtMs;
  private lastReports;
  private lastSkipped;
  /** Whether a sweep is running right now (reported to the card). */
  private running;
  /** The sweep in flight, so a second caller joins it instead of racing it. */
  private inflight;
  private disposed;
  private startupTimer;
  constructor(options: WorkBuddyTaskSchedulerOptions);
  /** Arm the timers; safe to call again after a configuration change. */
  start(): void;
  /** Stop every timer; the scheduler cannot be restarted afterwards. */
  dispose(): void;
  /** What the card shows about the schedule. */
  status(): WorkBuddyTaskScheduleStatus;
  /** Run one sweep now (the card's button and the timers share this path). */
  runNow(): Promise<WorkBuddyTaskRunReport[]>;
  private armDaily;
  /**
   * One sweep over every eligible account. Accounts run one at a time: the
   * upstream throttles behavior reports, and the sweep's own pacing (a gap
   * between accounts) is what keeps a multi-account install from tripping it.
   */
  private sweep;
  private runSweep;
  private clearTimers;
}
/** The schedule in force when the user configured nothing. */
declare const DEFAULT_WORKBUDDY_TASK_SCHEDULE: WorkBuddyTaskSchedule;
//#endregion
//#region src/catalog.d.ts
/** One model entry the adapter exposes. */
type WorkBuddyModelInfo = WorkBuddyUpstreamModel;
/** Local DSH context budget for one model id. */
type WorkBuddyContextBudget = number;
/**
 * Static CLI models captured from the CN endpoint (2026-08-30). The upstream
 * refresh replaces this list at startup; it exists so the provider registers
 * with a usable catalog even while the first fetch is in flight or offline.
 */
declare const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[];
/**
 * Static CLI models captured from the INTERNATIONAL gateway's desktop-channel
 * product config (`www.workbuddy.ai/v3/config`, 2026-09-11). The two regions
 * expose different rosters, so a global account must never be seeded with the
 * CN list.
 */
declare const FALLBACK_WORKBUDDY_MODELS_GLOBAL: readonly WorkBuddyModelInfo[];
/**
 * Static fallback directory for one region. Each region's provider must never be
 * seeded with the other region's roster: the two gateways can bill the same id
 * differently, so a shared list would misreport rates before the first refresh.
 */
declare function fallbackModelsFor(region: WorkBuddyRegion): readonly WorkBuddyModelInfo[];
/** Apply the saved local DSH budget; models above 200K default to 200K. */
declare function applyContextBudgets(catalog: readonly WorkBuddyModelInfo[], budgets?: Readonly<Record<string, WorkBuddyContextBudget | undefined>>): WorkBuddyModelInfo[];
/**
 * Derive one region's runtime catalog from its last-refreshed directory plus the
 * user's selection within that region. An empty selection falls back to the
 * whole directory: a plugin that has never been configured must still serve
 * models rather than nothing.
 */
declare function deriveCatalog(catalog: readonly WorkBuddyModelInfo[], enabled: ReadonlySet<string>, budgets?: Readonly<Record<string, WorkBuddyContextBudget | undefined>>): WorkBuddyModelInfo[];
/** Mutable catalog shared by one region's shim `/v1/models` and its adapter. */
declare class WorkBuddyCatalog {
  private models;
  /**
   * @param region Seeds the static fallback for THIS region, so the provider has
   * a usable roster from the first moment without borrowing the other side's.
   */
  constructor(region?: WorkBuddyRegion);
  /** Current entries; the fallback list until the upstream answer lands. */
  current(): readonly WorkBuddyModelInfo[];
  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly WorkBuddyModelInfo[]): void;
}
//#endregion
//#region src/shim.d.ts
/** Minimal logger surface the plugin context already provides. */
interface ShimLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** What the plugin needs from a running shim. */
interface WorkBuddyShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string;
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of any upstream token, because the shim resolves the
   * real credential itself via the store and the pool.
   */
  token(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
/** Constructor dependencies. */
interface WorkBuddyShimOptions {
  store: WorkBuddyCredentialStore;
  pool: WorkBuddyAccountPool;
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>;
  catalog: WorkBuddyCatalog;
  logger?: ShimLogger;
  /** Maximum upstream attempts for one chat request (account switches included). */
  maxAttempts?: number;
  /**
   * Called after every dispatch is reported to the pool, so the host can persist
   * the counters that just changed. The shim itself knows nothing about files:
   * it only says "the pool state moved".
   */
  onDispatch?(): void;
}
/**
 * Start the loopback endpoint. Requests must carry the shim's shared secret;
 * the loopback bind alone is not a trust boundary.
 */
declare function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim;
//#endregion
//#region src/adapter.d.ts
/** Provider route the domestic account pool registers as. */
declare const WORKBUDDY2API_PROVIDER = "workbuddy2api";
/** Provider route the international account pool registers as. */
declare const WORKBUDDY2API_GLOBAL_PROVIDER = "workbuddy2api-global";
/** The provider id each region registers as. */
declare const WORKBUDDY2API_PROVIDERS: Readonly<Record<WorkBuddyRegion, string>>;
/** Region a provider route id belongs to. */
declare function regionOfProvider(provider: string): WorkBuddyRegion | undefined;
/** Human-readable provider names, shown in the DSH model picker. */
declare const WORKBUDDY2API_PROVIDER_DISPLAY_NAMES: Readonly<Record<WorkBuddyRegion, string>>;
/** Default display name, kept for callers that do not name a region. */
declare const WORKBUDDY2API_PROVIDER_DISPLAY_NAME: string;
/** Provider idle ceiling while one stream read is outstanding. */
declare const WORKBUDDY2API_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Constructor dependencies. */
interface WorkBuddyAdapterOptions {
  shim: WorkBuddyShim;
  catalog: WorkBuddyCatalog;
  /** The pool this adapter fronts; selects the provider id and display name. */
  region: WorkBuddyRegion;
  /** Overrides the provider route id; defaults to the region's route. */
  provider?: string;
  /** Overrides the provider display name; defaults to the region's name. */
  displayName?: string;
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined;
}
/** What {@link createWorkBuddyAdapter} hands back. */
interface WorkBuddyAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
}
declare const THINKING_LEVELS: readonly ["minimal", "low", "medium", "high", "xhigh", "max"];
type WorkBuddyThinkingLevel = typeof THINKING_LEVELS[number];
type WorkBuddyThinkingLevelMap = Partial<Record<'off' | WorkBuddyThinkingLevel, string | null>>;
/** pi-ai input modalities: images only when the user opted the model in. */
declare function workBuddyModelInput(info: WorkBuddyModelInfo): ('text' | 'image')[];
/**
 * DSH-facing display name: the model name plus the upstream credit multiplier,
 * spelled the way WorkBuddy's own selector does (`GLM-5.3 · x0.79`).
 *
 * Display-only by construction: every DSH-side join keys on the model id.
 */
declare function workBuddyDisplayName(info: WorkBuddyModelInfo): string;
/** Map only levels advertised by WorkBuddy; undeclared DSH levels stay unavailable. */
declare function workBuddyThinkingLevelMap(info: WorkBuddyModelInfo): WorkBuddyThinkingLevelMap | undefined;
/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog, and
 * every model's `baseUrl` is re-resolved per read so the shim's ephemeral port
 * applies from the first snapshot after startup.
 */
declare function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter;
//#endregion
//#region src/startup-checkin.d.ts
/**
 * Whether a failure means today's check-in was already done.
 *
 * Two conditions, both required:
 *   - the gateway ANSWERED with a business envelope, so a dropped connection —
 *     which also throws — can never be mistaken for a completed check-in;
 *   - the message names the redundant check-in.
 */
declare function isAlreadyCheckedIn(error: unknown): boolean;
/** One account's outcome. */
interface WorkBuddyCheckinResult {
  accountId: string;
  accountName: string;
  outcome: 'claimed' | 'already' | 'inactive' | 'error';
  message: string;
  /** Credits granted by this run, when it claimed the reward. */
  credit?: number;
  /** Whether the balance refresh actually unfroze the account. */
  unfrozen?: boolean;
}
/**
 * Check in every configured account once.
 *
 * Never throws: a startup step that can take the whole plugin down would turn a
 * nice-to-have into a liability, so every failure is reported in the results.
 */
declare function checkinAllAccounts(options: {
  client: Pick<WorkBuddyUpstreamClient, 'fetchCheckinStatus' | 'claimDailyCheckin' | 'fetchCredits'>;
  /** Region-scoped pools, so an account is unfrozen in the pool that owns it. */
  pool(region: WorkBuddyRegion): WorkBuddyAccountPool;
  /**
   * The accounts to visit, each with the region that owns it.
   *
   * `accountId` is the POOL's key (derived from `uin`), which is deliberately
   * not the same string as `credential.uid` (the upstream's own id). Passing the
   * wrong one silently misses the entry, so the caller supplies it explicitly.
   */
  accounts(): Promise<readonly {
    credential: WorkBuddyCredential;
    accountId: string;
    region: WorkBuddyRegion;
  }[]>;
  log(message: string): void;
}): Promise<readonly WorkBuddyCheckinResult[]>;
//#endregion
//#region src/login.d.ts
/** How long an unfinished authorization URL stays pollable. */
declare const WORKBUDDY_LOGIN_TTL_MS: number;
/** The three sign-in endpoints of one realm, plus the Origin/Referer to send. */
interface WorkBuddyLoginEndpoints {
  state: string;
  token: string;
  account: string;
  origin: string;
}
/**
 * Endpoints for one region. The international product answers on the same
 * workbuddy.ai origin it signs in on; the domestic one signs in through
 * codebuddy.cn but issues tokens from copilot.tencent.com.
 */
declare function loginEndpointsFor(region: WorkBuddyRegion): WorkBuddyLoginEndpoints;
/** Answer of WorkBuddyLoginManager.start. */
interface WorkBuddyLoginStart {
  state: string;
  url: string;
  region: WorkBuddyRegion;
}
/** One account the sign-in produced, token-free. */
interface WorkBuddyLoginAccount {
  accountId: string;
  accountName: string;
  uid: string;
  nickname?: string;
  domain: string;
  region: WorkBuddyRegion;
}
/** Answer of WorkBuddyLoginManager.poll. */
type WorkBuddyLoginPoll = {
  done: false;
  message?: string;
} | {
  done: true;
  account: WorkBuddyLoginAccount;
  /** Credits read right after signing in, when the host could read them. */
  credits?: {
    total: number;
    expiringSoon: number;
  };
  /** Non-fatal follow-up result (check-in, credit or catalog refresh). */
  note?: string;
};
/** A poll for a state this manager never issued, or one that expired. */
declare class WorkBuddyLoginUnknownStateError extends Error {
  constructor();
}
/** Constructor dependencies. */
interface WorkBuddyLoginManagerOptions {
  /** Region-scoped credential store that owns the resulting copy. */
  store(region: WorkBuddyRegion): WorkBuddyCredentialStore;
  /** Region-scoped pool, so a new account is usable without a restart. */
  pool(region: WorkBuddyRegion): WorkBuddyAccountPool;
  /** Run after the credential is persisted; failures are reported, not thrown. */
  onSignedIn?(region: WorkBuddyRegion, credential: WorkBuddyCredential): Promise<string | undefined>;
  /** Injected for tests. */
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}
/**
 * In-process device-authorization manager. One instance serves both regions;
 * every session remembers the region it was started for, so a poll can only
 * ever write into that region's store and pool.
 */
declare class WorkBuddyLoginManager {
  private readonly options;
  private readonly fetchImpl;
  private readonly now;
  private readonly ttlMs;
  private readonly sessions;
  constructor(options: WorkBuddyLoginManagerOptions);
  /** Unfinished sessions, for diagnostics. */
  pendingCount(): number;
  /** Forget every unfinished session; called when the plugin is disposed. */
  dispose(): void;
  /**
   * Begin a sign-in for one region: ask the gateway for a state and an
   * authorization URL, remember which region asked, and hand the URL back.
   * The caller opens it in the user's browser.
   */
  start(region: WorkBuddyRegion): Promise<WorkBuddyLoginStart>;
  /**
   * Poll one sign-in. Unfinished sign-ins answer `{done:false}`; a completed
   * one yields the credential, which is persisted into the region's own
   * per-account copy and written back into that region's pool.
   */
  poll(state: string): Promise<WorkBuddyLoginPoll>;
  /** One gateway round trip for a sign-in this manager is already tracking. */
  private pollOnce;
  /** Write the freshly signed-in account into its region's pool and revive it. */
  private adoptIntoPool;
  /** Read the signed-in account's identity; a failure is not fatal by itself. */
  private readAccount;
  /** Drop sessions whose authorization URL has gone stale. */
  private collect;
  /** One JSON request against a sign-in endpoint, envelope already unwrapped. */
  private request;
}
//#endregion
//#region src/host-heartbeat.d.ts
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
/** Basename of the host heartbeat file inside the Harness home. */
declare const WORKBUDDY2API_HOST_HEARTBEAT_FILENAME = ".workbuddy2api-host-heartbeat.json";
/** Current on-disk heartbeat format; readers reject others. */
declare const HEARTBEAT_FORMAT_VERSION = 1;
/** The package name recorded in the heartbeat, checked by the reader. */
declare const PACKAGE_NAME = "dsh-workbuddy2api";
/** On-disk shape of the heartbeat. */
interface WorkBuddyHostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION;
  package: typeof PACKAGE_NAME;
  pluginVersion: string;
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number;
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number;
  /** Accounts the pool held when the heartbeat was written. */
  accounts?: number;
}
/** Absolute path of the host heartbeat file. */
declare function workbuddyHostHeartbeatPath(): string;
/**
 * Process start time in epoch milliseconds; undefined when unavailable.
 *
 * POSIX reads `ps -o lstart=`; Windows has no such command, so the creation
 * time is taken from PowerShell's `Get-Process` StartTime, emitted as UTC ISO
 * 8601 so `Date.parse` understands it without locale assumptions.
 */
declare function processStartTimeMs(pid: number): number | undefined;
/**
 * Whether the recorded host process still matches the heartbeat's PID.
 *
 * A PID can be reused after a crash, so the recorded start time is compared
 * against the live process: a different start time means a different process.
 */
declare function isHeartbeatProcessAlive(heartbeat: WorkBuddyHostHeartbeat): boolean;
/** Read the heartbeat; absent or unparsable files report undefined. */
declare function readHostHeartbeat(): Promise<WorkBuddyHostHeartbeat | undefined>;
/** Write the heartbeat for the current process. */
declare function writeHostHeartbeat(accounts?: number): Promise<void>;
/** Remove the heartbeat; called when the plugin is disposed. */
declare function clearHostHeartbeat(): Promise<void>;
//#endregion
//#region src/version.d.ts
/**
 * Package version, injected at build time by `tsdown.config.ts`.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT）— 版本由构建期 define 注入，
 *   而非运行时读 package.json（发布包只含 lib/）。
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 同样的 define 注入形态，本插件沿用。
 * 改动：常量名改为本插件的 `WORKBUDDY2API_VERSION`。
 *
 * @module dsh-workbuddy2api/version
 */
/** The npm package version this build was produced from. */
declare const WORKBUDDY2API_VERSION: string;
//#endregion
//#region src/web-status.d.ts
/** Constructor dependencies. Every region-scoped accessor takes the region. */
interface WorkBuddyStatusRouteOptions {
  /** The region-scoped credential store backing that region's requests. */
  store(region: WorkBuddyRegion): WorkBuddyCredentialStore;
  /** The region's own account pool. */
  pool(region: WorkBuddyRegion): WorkBuddyAccountPool;
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits' | 'fetchCheckinStatus' | 'claimDailyCheckin'>;
  /**
   * The requested region's last-refreshed model directory (unfiltered) for card
   * display. Region-scoped because the two gateways expose different rosters
   * AND can bill the same id differently; showing one region's directory on the
   * other is the bug the two-pool split exists to prevent.
   */
  displayModels(region: WorkBuddyRegion): readonly WorkBuddyModelInfo[];
  /** The requested region's selection, stored as model ids. */
  enabledModelIds(region: WorkBuddyRegion): readonly string[];
  /** Model ids the user opted into image input, for the requested region. */
  imageModelIds(region: WorkBuddyRegion): readonly string[];
  /** Saved local DSH context budgets by model id, for the requested region. */
  contextBudgets(region: WorkBuddyRegion): Readonly<Record<string, number | undefined>>;
  /** Persisted per-account pool state, mirrored to the card for saving. */
  poolState(region: WorkBuddyRegion): readonly WorkBuddyWebPoolState[];
  /** The requested region's pool policy in force. */
  policy(region: WorkBuddyRegion): WorkBuddyPoolTuning;
  /** Re-read one region's live catalog from that region's own accounts. */
  discoverModels?(region: WorkBuddyRegion, signal?: AbortSignal): Promise<readonly WorkBuddyModelInfo[]>;
  /** Fetch and cache one account's credits inside its own region's pool. */
  refreshCredits?(region: WorkBuddyRegion, accountId: string): Promise<WorkBuddyCredits>;
  /**
   * The in-process web sign-in. Absent when the host did not wire it, in which
   * case the two sign-in routes answer 503 instead of failing obscurely.
   */
  login?: WorkBuddyLoginManager;
  /**
   * The growth-task engine. Absent when the host did not wire it, in which case
   * the two task routes answer 503.
   */
  tasks?: WorkBuddyTaskEngine;
  /** The task schedule in force and what it last did. */
  taskSchedule?(): WorkBuddyTaskScheduleStatus;
  /** Run one task sweep right now, over every eligible account. */
  runTaskSweep?(): Promise<void>;
  /**
   * The plugin's own configuration, for the card.
   *
   * Exists because DSH 0.1.7-rc.2 removed the browser-side settings scope: the
   * card reads and edits its settings over this route instead, so ONE code path
   * serves both DSH lines. Absent means the card keeps using the framework's own
   * scope, which is what the older line ships.
   */
  configDocument?(): WorkBuddyWebConfig;
  /**
   * Merge one top-level field of the plugin's own configuration.
   *
   * A merge, not a whole-section replace: the wire never carries secret-marked
   * fields, so a replace rebuilt from what the browser holds would silently
   * delete them.
   */
  writeConfigField?(field: string, value: unknown): Promise<void>;
}
/**
 * Assemble one region's card document: that region's locally discovered
 * accounts, its pool's live health per account, its cached credits, and its
 * model directory with the user's selection within it. Credit queries never run
 * here — the pool's cache is read instead, so a 60-second card poll does not
 * hammer N upstream billing endpoints.
 */
declare function workBuddyWebStatus(deps: WorkBuddyStatusRouteOptions, region: WorkBuddyRegion): Promise<WorkBuddyWebUsage>;
/**
 * Mount the routes on a context where `webServer` is available. The caller uses
 * `ctx.inject(['webServer'], ...)`, so Desktop startup order cannot make this
 * registration disappear.
 */
declare function registerWorkBuddy2ApiStatusRoute(ctx: Context, deps: WorkBuddyStatusRouteOptions): void;
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "dsh-workbuddy2api";
/** The model registry and settings service required before providers can register. */
declare const inject: string[];
/** Settings namespace for the plugin configuration card. */
declare const WORKBUDDY2API_SETTINGS_NS: SettingsNamespace;
/**
 * The profile entry id, which is ALSO the settings key on DSH 0.1.7 and later.
 *
 * That line keys a plugin's settings by its entry id (see `cordis.patch.yml`),
 * not by a name the plugin invents — it is the same string the Loader shows — so
 * the entry id has to be known here to read the current values back.
 */
declare const WORKBUDDY2API_ENTRY_ID = "dsh-workbuddy2api";
/** One persisted model entry; the settings codec rejects unknown keys. */
interface WorkBuddyPersistedModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  creditMultiplier?: number;
  reasoning?: {
    supportedEfforts?: readonly string[];
    defaultEffort?: string;
    canDisableThinking?: boolean;
  };
  descriptionZh?: string;
  descriptionEn?: string;
  supportsToolCall?: boolean;
}
/** One region's model directory and the user's selection within it. */
interface WorkBuddyRegionState {
  /** The last-refreshed directory for this region; what the card displays. */
  lastCatalog?: WorkBuddyPersistedModel[];
  /** The user's selection in this region, as model ids. */
  enabledModelIds?: string[];
  /** Model ids the user explicitly opted into image input. */
  imageModelIds?: string[];
  /** Local DSH context budget per model id, for this region. */
  contextBudgets?: Record<string, number>;
  /** Per-account pool switches, weights, and running cooldowns. */
  poolState?: WorkBuddyPoolStateRecord[];
  /** Health-policy overrides for this region's pool. */
  pool?: Partial<WorkBuddyPoolTuning>;
}
/** Plugin configuration. */
interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile?: string;
  /**
   * The automatic growth-task sweep: finish every task this plugin can finish
   * without the official client, once a day and (optionally) shortly after
   * startup.
   */
  tasks?: WorkBuddyTaskSchedule;
  /**
   * Per-region state, keyed `cn` | `global`. Each region's provider, pool,
   * catalog, and card tab read and write ONLY their own slot, so changing
   * anything on one side never touches the other.
   */
  regions?: Partial<Record<WorkBuddyRegion, WorkBuddyRegionState>>;
  /** @deprecated 0.1.x merged directory. Accepted so old settings still load; never read. */
  lastCatalog?: WorkBuddyPersistedModel[];
  /** @deprecated See {@link Config.lastCatalog}. */
  enabledModelIds?: string[];
  /** @deprecated See {@link Config.lastCatalog}. */
  imageModelIds?: string[];
  /** @deprecated See {@link Config.lastCatalog}. */
  contextBudgets?: Record<string, number>;
  /** @deprecated See {@link Config.lastCatalog}. */
  poolState?: WorkBuddyPoolStateRecord[];
  /** @deprecated See {@link Config.lastCatalog}. */
  pool?: Partial<WorkBuddyPoolTuning>;
}
declare const Config: z<Config>;
/** Every region, in card tab order. */
declare const REGION_KEYS: readonly WorkBuddyRegion[];
/** One region's saved state, or an empty state when it was never configured. */
declare function regionStateOf(config: Config, region: WorkBuddyRegion): WorkBuddyRegionState;
/** One region's persisted policy over the defaults, dropping unknown values. */
declare function resolvePolicy(configured: Partial<WorkBuddyPoolTuning> | undefined): WorkBuddyPoolTuning;
/**
 * Start both regions' loopback endpoints, register the `workbuddy2api` (CN) and
 * `workbuddy2api-global` (international) providers, and refresh each region's
 * model catalog from its own accounts. Each region's static fallback catalog
 * serves from the first moment, so an offline upstream never leaves a provider
 * empty.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, DEFAULT_WORKBUDDY_POOL_POLICY, DEFAULT_WORKBUDDY_TASK_SCHEDULE, FALLBACK_WORKBUDDY_MODELS, FALLBACK_WORKBUDDY_MODELS_GLOBAL, REGION_KEYS, type UpstreamErrorKind, WORKBUDDY2API_ACCOUNTS_REFRESH_PATH, WORKBUDDY2API_ACCOUNT_PARAM, WORKBUDDY2API_CHECKIN_PATH, WORKBUDDY2API_CREDITS_REFRESH_PATH, WORKBUDDY2API_ENTRY_ID, WORKBUDDY2API_GLOBAL_PROVIDER, WORKBUDDY2API_HOST_HEARTBEAT_FILENAME, WORKBUDDY2API_LOGIN_POLL_PATH, WORKBUDDY2API_LOGIN_START_PATH, WORKBUDDY2API_MODELS_REFRESH_PATH, WORKBUDDY2API_POOL_ACTION_PATH, WORKBUDDY2API_POOL_STATE_FILENAME, WORKBUDDY2API_POOL_STATE_VERSION, WORKBUDDY2API_PROVIDER, WORKBUDDY2API_PROVIDERS, WORKBUDDY2API_PROVIDER_DISPLAY_NAME, WORKBUDDY2API_PROVIDER_DISPLAY_NAMES, WORKBUDDY2API_REGIONS, WORKBUDDY2API_REGION_PARAM, WORKBUDDY2API_SETTINGS_NS, WORKBUDDY2API_STATE_PARAM, WORKBUDDY2API_STREAM_IDLE_TIMEOUT_MS, WORKBUDDY2API_USAGE_PATH, WORKBUDDY2API_VERSION, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_LOGIN_TTL_MS, type WorkBuddyAccountChoice, WorkBuddyAccountPool, type WorkBuddyAdapter, type WorkBuddyAuthStatus, WorkBuddyCatalog, type WorkBuddyChatResult, type WorkBuddyCheckinClaim, type WorkBuddyCheckinResult, type WorkBuddyCheckinStatus, type WorkBuddyContextBudget, type WorkBuddyCredential, WorkBuddyCredentialStore, type WorkBuddyCredentialStoreOptions, type WorkBuddyCreditPackage, type WorkBuddyCredits, type WorkBuddyDesktopEvent, type WorkBuddyDispatchOutcome, type WorkBuddyHostHeartbeat, type WorkBuddyLoginAccount, type WorkBuddyLoginEndpoints, WorkBuddyLoginManager, type WorkBuddyLoginManagerOptions, type WorkBuddyLoginPoll, type WorkBuddyLoginStart, WorkBuddyLoginUnknownStateError, type WorkBuddyModelInfo, WorkBuddyPersistedModel, type WorkBuddyPickResult, type WorkBuddyPoolAccount, type WorkBuddyPoolCounterRecord, type WorkBuddyPoolEntry, type WorkBuddyPoolMissReason, type WorkBuddyPoolPolicy, type WorkBuddyPoolState, type WorkBuddyPoolStateDocument, type WorkBuddyPoolStateRecord, type WorkBuddyPoolTuning, type WorkBuddyReasoning, type WorkBuddyRefreshOutcome, type WorkBuddyRegion, WorkBuddyRegionState, type WorkBuddyShim, type WorkBuddyStatusRouteOptions, type WorkBuddyTask, type WorkBuddyTaskClient, WorkBuddyTaskEngine, type WorkBuddyTaskOutcome, type WorkBuddyTaskResult, type WorkBuddyTaskReward, type WorkBuddyTaskRunReport, type WorkBuddyTaskSchedule, type WorkBuddyTaskScheduleStatus, WorkBuddyTaskScheduler, type WorkBuddyTaskView, WorkBuddyUpstreamClient, type WorkBuddyUpstreamModel, type WorkBuddyWebAccount, type WorkBuddyWebAccountCredits, type WorkBuddyWebCheckin, type WorkBuddyWebCredits, type WorkBuddyWebLogin, type WorkBuddyWebModel, type WorkBuddyWebPackage, type WorkBuddyWebPoolEntry, type WorkBuddyWebPoolPolicy, type WorkBuddyWebPoolState, type WorkBuddyWebRegion, type WorkBuddyWebUsage, apply, applyContextBudgets, authFileName, automatedTaskCodes, checkinAllAccounts, classifyUpstreamError, clearHostHeartbeat, clearPoolState, createWorkBuddyAdapter, createWorkBuddyShim, defaultDesktopAuthCandidates, defaultDesktopAuthDirs, defaultDesktopAuthPath, deriveCatalog, expiryToMs, fallbackModelsFor, inject, isAlreadyCheckedIn, isFresher, isHeartbeatProcessAlive, loginEndpointsFor, name, nextDailyRunAt, nextDay4Am, parseCreditMultiplier, parsePoolCounterRecord, parseReasoning, parseUpstreamModel, parseUpstreamTask, parseWorkBuddyAuth, prepareChatBody, processStartTimeMs, progressText, readHostHeartbeat, readPoolState, regionOf, regionOfProvider, regionOfStatusUrl, regionStateOf, registerWorkBuddy2ApiStatusRoute, resolvePolicy, selectCliModels, setWorkBuddyTaskDelay, stickyKeyOf, toPersistedWorkBuddyModel, unsupportedReasonFor, withWorkBuddyRegion, workBuddyDisplayName, workBuddyModelInput, workBuddyThinkingLevelMap, workBuddyWebStatus, workbuddyAccountId, workbuddyHostHeartbeatPath, workbuddyOwnAuthPath, workbuddyPoolStatePath, writeHostHeartbeat, writePoolState };