/**
 * WorkBuddy credential discovery, parsing, and the multi-account credential
 * registry.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 本文件在「账号发现」这一层沿用其全部已验证做法：桌面端 auth 文件
 *     只读、刷新结果写入 $DSH_HOME 自有副本、按 uin 去重的多账号目录扫描、
 *     「live 文件 > lastRefreshTime > expiresAt」的三级择新排序、
 *     按需刷新（5 分钟余量）与单飞去重、刷新失败但 token 未过期则沿用旧
 *     token、平台路径候选（macOS / Windows Local+Roaming / Linux XDG）
 *     与环境变量覆盖。其又源自 corrinehu/dsh-workbuddy-connect（MIT）。
 * 改动：
 *   1. 不再按区域拆成两个 store —— 本插件把区域当成「账号的属性」，
 *      一个 store 管理全部账号，pool 负责在它们之间调度；
 *   2. 新增「多账号各自持有独立 token 副本」的持久化：每个账号一个
 *      `$DSH_HOME/.workbuddy2api-auth.<accountId>.json` 文件，因此 N 个账号
 *      同时在线互不覆盖（原实现每区域只能存一个刷新结果）；
 *   3. 新增 `refreshCredential(accountId)` 与 `byIds()`：账号池需要
 *      按 id 定位并刷新任意一个账号，而不是只解析「当前选中的那个」。
 *
 * @module dsh-workbuddy2api/auth
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { regionOf, type WorkBuddyRefreshOutcome, type WorkBuddyRegion } from './upstream.ts'

/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  uin?: string
  /** Which auth file this came from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh'
  /** Absolute path of the auth file this credential was read from. */
  filePath: string
  /**
   * Epoch ms the upstream last issued this token (`auth.lastRefreshTime`).
   *
   * This is the ONLY trustworthy freshness signal. `expiresAtMs` cannot be
   * used for ranking: when the upstream revokes a token it leaves the stored
   * `expiresAt` untouched, so a long-dead backup can claim a LATER expiry than
   * the live sign-in (observed on a real machine — a 2026-07-08 backup claimed
   * 2027-07-06 while the live file expired 2026-11-14).
   */
  lastRefreshAtMs?: number
}

/** Read-only sign-in summary for status and doctor output. */
export interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out'
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  nickname?: string
  domain?: string
  source?: 'desktop' | 'dsh'
}

/** One selectable local account, token-free. */
export interface WorkBuddyAccountChoice {
  /** Stable id derived from `uin` (or `uid` when uin is absent). */
  id: string
  accountName: string
  uin?: string
  domain: string
  /** Region derived from `domain`; the pool reports it per account. */
  region: WorkBuddyRegion
  source: 'desktop' | 'dsh'
  tokenExpiresAtMs: number
  /** The auth file this account was read from; newest is preferred. */
  filePath: string
}

/** Constructor options; only {@link WorkBuddyCredentialStoreOptions.refresh} is required. */
export interface WorkBuddyCredentialStoreOptions {
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string
  /**
   * Auth directories to scan, overriding the platform defaults. Injectable so
   * the multi-account scan is testable without touching a real machine.
   */
  authDirs?: readonly string[]
  /** Directory for the per-account refreshed copies; defaults to $DSH_HOME. */
  storeDir?: string
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
}

/** Basename of the live WorkBuddy desktop auth file. */
const WORKBUDDY_LIVE_FILENAME = 'workbuddy-desktop.info'

/** Prefix of the per-account plugin-owned credential copies. */
const OWN_PREFIX = '.workbuddy2api-auth'

/** Current on-disk format of a plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

interface OwnDocument {
  version: typeof OWN_FORMAT_VERSION
  accountId: string
  credential: WorkBuddyCredential
}

/**
 * Plugin-owned copy path for one account inside the Harness home. One file per
 * account id means N simultaneously signed-in accounts never overwrite each
 * other's refreshed token — the property the pool depends on.
 */
export function workbuddyOwnAuthPath(accountId: string, storeDir: string = resolveDshHome()): string {
  return join(storeDir, `${OWN_PREFIX}.${accountId}.json`)
}

/**
 * Platform-default directories holding the WorkBuddy desktop app's auth file.
 *
 * Windows and Linux prefer the OS-issued env location and fall back to the
 * home-derived convention when it is unset, so a redirected profile (OneDrive
 * folder backup, enterprise policy) still resolves. macOS has no equivalent
 * env variable; the single Application Support path is used as-is.
 */
export function defaultDesktopAuthDirs(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (platform === 'win32') {
    const local = nonEmptyEnv(env['LOCALAPPDATA']) ?? join(home, 'AppData', 'Local')
    const roaming = nonEmptyEnv(env['APPDATA']) ?? join(home, 'AppData', 'Roaming')
    return [
      join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ]
  }
  if (platform === 'linux') {
    const config = nonEmptyEnv(env['XDG_CONFIG_HOME']) ?? join(home, '.config')
    return [join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  return []
}

/** A non-empty, trimmed env value, or undefined when unset/blank. */
function nonEmptyEnv(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The live auth file's platform candidates, in probe order. */
export function defaultDesktopAuthCandidates(): string[] {
  return defaultDesktopAuthDirs().map(dir => join(dir, WORKBUDDY_LIVE_FILENAME))
}

/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
export function defaultDesktopAuthPath(): string | undefined {
  return defaultDesktopAuthCandidates()[0]
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
export function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The first of two spellings that holds a number, in priority order. */
function numberField(source: Record<string, unknown>, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number') return value
  }
  return undefined
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
export function parseWorkBuddyAuth(text: string, filePath: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    // The plugin's OWN per-account copy is a bare credential under `auth` with
    // no separate `account` object, so identity falls back to the credential
    // itself. Reading it as `{}` would drop uin/uid and re-key the copy under
    // the "unknown" account, orphaning every refreshed token.
    identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : auth
  } else {
    auth = document
    identity = document
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  // Both spellings are accepted: the desktop app writes `expiresAt` /
  // `lastRefreshTime`, while the plugin's OWN per-account copy round-trips a
  // normalized credential whose fields are already `*Ms`. Reading only the
  // desktop spelling would parse every plugin-owned copy back with
  // `expiresAtMs: 0`, i.e. permanently "expired", which both defeats the
  // refreshed copy and makes every resolve re-refresh it.
  const expiresAtMs = expiryToMs(numberField(auth, 'expiresAt', 'expiresAtMs') ?? 0)
  const refreshExpiresAt = numberField(auth, 'refreshExpiresAt', 'refreshExpiresAtMs')
  const refreshExpiresAtMs = refreshExpiresAt === undefined ? undefined : expiryToMs(refreshExpiresAt)
  const lastRefresh = numberField(auth, 'lastRefreshTime', 'lastRefreshAtMs')
  const lastRefreshAtMs = lastRefresh === undefined ? undefined : expiryToMs(lastRefresh)
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  const uin = optionalString(identity['uin'])
  return {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth['domain']) ?? '',
    uid: optionalString(identity['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    ...uin === undefined ? {} : { uin },
    ...lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs },
    source: 'desktop',
    filePath,
  }
}

/**
 * Filename of a path regardless of the host separator: Windows paths use `\`
 * and this helper must keep working when a Windows path is compared on a
 * POSIX host (e.g. tests injecting a Windows-style auth dir).
 */
export function authFileName(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator === -1 ? path : path.slice(separator + 1)
}

/**
 * Rank two candidate files for the same account.
 *
 * The live `workbuddy-desktop.info` always wins: it is the app's current
 * sign-in, and the upstream revokes the tokens in the timestamped backups even
 * though their stored `expiresAt` is still in the future. Expiry is therefore
 * only a tie-breaker among backups, never the primary ordering.
 */
function fileRank(path: string): number {
  return authFileName(path) === WORKBUDDY_LIVE_FILENAME ? 0 : 1
}

/**
 * Whether `candidate` is a better pick than `incumbent` for the same account.
 * Ordering, strongest signal first: the live file; then the most recent
 * `lastRefreshAtMs` (the upstream's own issuance time); then `expiresAtMs`
 * as a fallback for documents that omit the field.
 */
export function isFresher(candidate: WorkBuddyCredential, incumbent: WorkBuddyCredential): boolean {
  const rankDiff = fileRank(candidate.filePath) - fileRank(incumbent.filePath)
  if (rankDiff !== 0) return rankDiff < 0
  const candidateRefresh = candidate.lastRefreshAtMs
  const incumbentRefresh = incumbent.lastRefreshAtMs
  if (candidateRefresh !== undefined && incumbentRefresh !== undefined) {
    if (candidateRefresh !== incumbentRefresh) return candidateRefresh > incumbentRefresh
  } else if (candidateRefresh !== undefined) {
    return true
  } else if (incumbentRefresh !== undefined) {
    return false
  }
  return candidate.expiresAtMs > incumbent.expiresAtMs
}

/**
 * Stable account id. `uin` is the billing identity the upstream keys on and
 * survives across re-login; `uid` is the fallback for documents without one.
 */
export function workbuddyAccountId(
  credential: Pick<WorkBuddyCredential, 'uin' | 'uid' | 'nickname'>,
): string {
  const stable = credential.uin ?? credential.uid ?? credential.nickname ?? 'unknown'
  return createHash('sha256').update(`workbuddy\0${stable}`).digest('hex').slice(0, 24)
}

/** Serialize the plugin-owned copy. */
function ownDocument(credential: WorkBuddyCredential, accountId: string): OwnDocument {
  return { version: OWN_FORMAT_VERSION, accountId, credential }
}

/** Parse the plugin-owned copy; other versions and shapes are rejected. */
function parseOwnDocument(text: string, filePath: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document['version'] !== OWN_FORMAT_VERSION) return undefined
  if (typeof document['credential'] !== 'object' || document['credential'] === null) return undefined
  const credential = parseWorkBuddyAuth(JSON.stringify({ auth: document['credential'] }), filePath)
  if (credential === undefined) return undefined
  return { ...credential, source: 'dsh' }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Read one auth file, tolerating absence and unparsable content. */
async function readAuthFile(path: string): Promise<WorkBuddyCredential | undefined> {
  try {
    return parseWorkBuddyAuth(await readFile(path, 'utf8'), path)
  } catch (error: unknown) {
    if (isENOENT(error)) return undefined
    return undefined
  }
}

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
export class WorkBuddyCredentialStore {
  private readonly refresh: WorkBuddyCredentialStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly authDirs: readonly string[] | undefined
  private readonly storeDir: string
  private desktopPathOverride: string | undefined
  /** In-flight refresh per account id; concurrent callers share one request. */
  private readonly inflight = new Map<string, Promise<WorkBuddyCredential>>()

  constructor(options: WorkBuddyCredentialStoreOptions) {
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.authDirs = options.authDirs
    this.storeDir = options.storeDir ?? resolveDshHome()
    this.desktopPathOverride = options.desktopPath
  }

  /** Repoint the desktop file or directory; applies on the next read. */
  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
    this.inflight.clear()
  }

  /** The auth-file path candidates, in probe order. */
  private resolveDesktopCandidates(): string[] {
    const fromEnv = process.env[WORKBUDDY_AUTH_FILE_ENV]
    const explicit = this.desktopPathOverride
      ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    return defaultDesktopAuthCandidates()
  }

  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined {
    return this.resolveDesktopCandidates()[0]
  }

  /**
   * Every auth file to scan: the live file plus the timestamped backups
   * WorkBuddy leaves beside it.
   *
   * An explicitly configured path pins the *directory*: its siblings are still
   * scanned, because a user who points the plugin at their auth file expects
   * account switching to work the same way it does on the default path. Only
   * the file ordering changes.
   */
  private async candidateFiles(): Promise<string[]> {
    const explicitPath = this.desktopPathOverride
      ?? ((process.env[WORKBUDDY_AUTH_FILE_ENV] ?? '').trim() !== ''
        ? (process.env[WORKBUDDY_AUTH_FILE_ENV] as string)
        : undefined)

    const files: string[] = []
    if (explicitPath !== undefined) {
      files.push(explicitPath)
      for (const backup of await this.backupsBeside(explicitPath)) files.push(backup)
      return files
    }

    const dirs = this.authDirs ?? defaultDesktopAuthDirs()
    for (const dir of dirs) {
      const live = join(dir, WORKBUDDY_LIVE_FILENAME)
      files.push(live)
      for (const backup of await this.backupsBeside(live)) files.push(backup)
    }
    return files
  }

  /** Timestamped siblings of one auth file, newest first by filename. */
  private async backupsBeside(path: string): Promise<string[]> {
    const dir = dirname(path)
    const base = path.slice(dir.length + 1)
    try {
      const entries = await readdir(dir)
      return entries
        .filter(name => name !== base && name.endsWith('.info'))
        .sort()
        .reverse()
        .map(name => join(dir, name))
    } catch {
      // Directory absent or unreadable: the live file alone is still probed.
      return []
    }
  }

  /** Every plugin-owned copy currently on disk, keyed by account id. */
  private async readOwns(): Promise<Map<string, WorkBuddyCredential>> {
    const copies = new Map<string, WorkBuddyCredential>()
    let entries: string[]
    try {
      entries = await readdir(this.storeDir)
    } catch {
      return copies
    }
    for (const name of entries) {
      if (!name.startsWith(`${OWN_PREFIX}.`) || !name.endsWith('.json')) continue
      const path = join(this.storeDir, name)
      try {
        const parsed = parseOwnDocument(await readFile(path, 'utf8'), path)
        if (parsed === undefined) continue
        copies.set(workbuddyAccountId(parsed), parsed)
      } catch {
        // absent or unreadable — skipped, never propagated
      }
    }
    return copies
  }

  /**
   * Read every local credential, deduplicated by account id. Files are probed
   * newest-first, so the first entry for an account is its freshest. Every
   * account — both regions — is returned: the pool decides which ones to use.
   */
  async readAll(): Promise<WorkBuddyCredential[]> {
    const files = await this.candidateFiles()
    const byId = new Map<string, WorkBuddyCredential>()
    for (const file of files) {
      const credential = await readAuthFile(file)
      if (credential === undefined) continue
      const id = workbuddyAccountId(credential)
      const existing = byId.get(id)
      if (existing === undefined) {
        byId.set(id, credential)
        continue
      }
      if (isFresher(credential, existing)) byId.set(id, credential)
    }
    const now = Date.now()
    for (const [id, own] of await this.readOwns()) {
      const existing = byId.get(id)
      if (existing === undefined) {
        byId.set(id, own)
        continue
      }
      // The plugin's refreshed copy carries no `lastRefreshTime` of its own, so
      // it cannot be ranked by issuance time; it is judged purely on how long it
      // lives. It supersedes a BACKUP whenever it lives longer, and it may also
      // supersede the LIVE file — but only while that live token is inside the
      // refresh margin anyway. That second rule is what makes a refresh stick:
      // without it every resolve within the margin re-refreshes the same
      // account, and a pool with N accounts would hammer the endpoint N times
      // per request. A fresh app sign-in always outlives the margin, so the
      // rule cannot shadow a token the user just obtained.
      if (own.expiresAtMs <= existing.expiresAtMs) continue
      const dueForRefresh = existing.expiresAtMs <= 0 || existing.expiresAtMs <= now + this.refreshMarginMs
      if (fileRank(existing.filePath) !== 0 || dueForRefresh) byId.set(id, own)
    }
    return [...byId.values()]
  }

  /** Token-free account list for the plugin card, in discovery order. */
  async accounts(): Promise<WorkBuddyAccountChoice[]> {
    const credentials = await this.readAll()
    return credentials.map(credential => ({
      id: workbuddyAccountId(credential),
      accountName: credential.nickname ?? credential.uin ?? credential.uid,
      ...credential.uin === undefined ? {} : { uin: credential.uin },
      domain: credential.domain,
      region: regionOf(credential.domain),
      source: credential.source,
      tokenExpiresAtMs: credential.expiresAtMs,
      filePath: credential.filePath,
    }))
  }

  /** The freshest stored credential for one account id, no refresh. */
  async current(accountId: string): Promise<WorkBuddyCredential | undefined> {
    const credentials = await this.readAll()
    return credentials.find(credential => workbuddyAccountId(credential) === accountId)
  }

  /**
   * Every requested credential that is present locally, in the order asked.
   * Ids with no local credential are dropped: the pool must be able to tell
   * "this account vanished" from "this account is unhealthy".
   */
  async byIds(accountIds: readonly string[]): Promise<WorkBuddyCredential[]> {
    const credentials = await this.readAll()
    const byId = new Map(credentials.map(credential => [workbuddyAccountId(credential), credential]))
    return accountIds.flatMap(id => {
      const credential = byId.get(id)
      return credential === undefined ? [] : [credential]
    })
  }

  /** The credential to send upstream for one account: {@link current}, refreshed on demand. */
  async resolve(accountId: string): Promise<WorkBuddyCredential> {
    const credential = await this.current(accountId)
    if (credential === undefined) {
      throw new Error(
        `workbuddy: no signed-in WorkBuddy account found for ${accountId}; sign in once in the WorkBuddy desktop app`
        + ` (expected ${this.resolveDesktopCandidates().join(' or ') || '(no desktop path on this platform)'}`
        + ` or ${WORKBUDDY_AUTH_FILE_ENV}), or refresh the account pool in the plugin card`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    const existing = this.inflight.get(accountId)
    if (existing !== undefined) return existing
    const pending = this.refreshNow(credential).finally(() => {
      this.inflight.delete(accountId)
    })
    this.inflight.set(accountId, pending)
    return pending
  }

  /** Read-only sign-in summary for one account; never refreshes and never throws. */
  async status(accountId: string): Promise<WorkBuddyAuthStatus> {
    try {
      const credential = await this.current(accountId)
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        source: credential.source,
      }
    } catch {
      return { state: 'signed-out' }
    }
  }

  /**
   * Remove every plugin-owned copy this store wrote; the desktop files are
   * untouched. `logout` is the user's "forget what the plugin stored" action,
   * not a per-account toggle, so every per-account copy is cleared.
   */
  async logout(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.storeDir)
    } catch {
      return
    }
    for (const name of entries) {
      if (!name.startsWith(`${OWN_PREFIX}.`) || !name.endsWith('.json')) continue
      const path = join(this.storeDir, name)
      await rm(path, { force: true })
      await rm(`${path}.lock`, { force: true })
    }
  }

  /** Whether any desktop candidate file exists as a regular file; diagnostics only. */
  async desktopFilePresent(): Promise<boolean> {
    for (const path of this.resolveDesktopCandidates()) {
      try {
        if ((await stat(path)).isFile()) return true
      } catch {
        // absent or not a regular file — try the next candidate
      }
    }
    return false
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app')
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
        source: 'dsh',
      }
      await this.saveOwn(refreshed)
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddy: token refresh failed and the access token is expired (${String(error)});`
        + ' open the WorkBuddy desktop app once to sign in again',
      )
    }
  }

  private async saveOwn(credential: WorkBuddyCredential): Promise<void> {
    const accountId = workbuddyAccountId(credential)
    const path = workbuddyOwnAuthPath(accountId, this.storeDir)
    await withFileLock(path, async () => {
      await writeFileAtomic(path, `${JSON.stringify(ownDocument(credential, accountId), null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }
}
