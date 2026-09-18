/**
 * WorkBuddy account-pool card contributed to Harness Plugin configuration.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 卡片结构（折叠外壳 / 账号状态行 / 积分区 / 模型表 / 操作按钮行）、
 *     加载时注入一次 `<style>`、草稿态与 dirty 标记的保存流程、
 *     60 秒轮询与 AbortController 清理、区域 tab 栏与按区域隔离的草稿，
 *     均来自该项目。
 * 改动：每个 tab 不再只是「换个账号看同一份目录」，而是一个**独立账号池**：
 *   该区域自己的 provider、账号、健康、权重、积分、策略与模型目录。
 *   切 tab 不会触碰另一个池的任何状态。
 *
 * @module dsh-workbuddy2api/client/WorkBuddyPoolCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  toPersistedWorkBuddyModel,
  withWorkBuddyRegion,
  WORKBUDDY2API_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY2API_ACCOUNT_PARAM,
  WORKBUDDY2API_CHECKIN_PATH,
  WORKBUDDY2API_CREDITS_REFRESH_PATH,
  WORKBUDDY2API_LOGIN_POLL_PATH,
  WORKBUDDY2API_LOGIN_START_PATH,
  WORKBUDDY2API_MODELS_REFRESH_PATH,
  WORKBUDDY2API_POOL_ACTION_PATH,
  WORKBUDDY2API_REGIONS,
  WORKBUDDY2API_STATE_PARAM,
  WORKBUDDY2API_TASKS_PATH,
  WORKBUDDY2API_TASKS_RUN_PATH,
  WORKBUDDY2API_USAGE_PATH,
} from '../status-paths.ts'
import type {
  WorkBuddyWebLogin,
  WorkBuddyWebModel,
  WorkBuddyWebPoolEntry,
  WorkBuddyWebPoolPolicy,
  WorkBuddyWebPoolState,
  WorkBuddyWebRegion,
  WorkBuddyWebTaskReport,
  WorkBuddyWebTaskSchedule,
  WorkBuddyWebTasks,
  WorkBuddyWebUsage,
} from '../status-paths.ts'
import { WORKBUDDY2API_PLUGIN_ICON } from './icon.ts'
import { WORKBUDDY2API_CARD_CSS } from './styles.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyPoolCardInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
  settingsScope: {
    getSnapshot(): { status: string; value?: unknown; writable: boolean }
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<void>
  }
}

/** Props delivered by the Plugin configuration item slot. */
export type WorkBuddyPoolCardProps =
  PropsRuntime<'settings.plugin.item'>
  & Partial<WorkBuddyPoolCardInjected>

const POLL_INTERVAL_MS = 60_000

/** How often a running browser sign-in is checked, while the card is open. */
const LOGIN_POLL_INTERVAL_MS = 3_000

/**
 * The authorization page, remembered across the redirect. The user finishes
 * the sign-in in a browser tab and comes back to the harness, which reloads
 * the page — a sign-in kept only in component state would be lost, leaving a
 * credential on the server that the card no longer knows about.
 */
const LOGIN_STORAGE_KEY = 'dsh-workbuddy2api/login'

/** One region's unsaved pool edits. */
interface WorkBuddyPoolDraft {
  accounts: Map<string, { enabled: boolean; weight: number }>
  policy: WorkBuddyWebPoolPolicy
}

/** One region's task document plus the sweep state that came with it. */
interface WorkBuddyTaskState {
  accounts: WorkBuddyWebTasks[]
  schedule?: WorkBuddyWebTaskSchedule
  reports: WorkBuddyWebTaskReport[]
}

/** One region's unsaved model edits. */
interface WorkBuddyModelDraft {
  models: WorkBuddyWebModel[]
  enabledIds: Set<string>
  imageIds: Set<string>
  contextBudgets: Record<string, number>
}

/** Inject or refresh the shared card CSS for the current client bundle. */
if (typeof document !== 'undefined') {
  const cssId = 'dsh-workbuddy2api/client.css'
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${cssId}"]`)
  if (existing !== null) {
    existing.textContent = WORKBUDDY2API_CARD_CSS
  } else {
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-workbuddy2api'
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = WORKBUDDY2API_CARD_CSS
    document.head.appendChild(styleTag)
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value)
}

function formatDateTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function formatCapacity(value: number | undefined, unknown: string): string {
  if (value === undefined) return unknown
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return formatNumber(value)
}

/** One in-flight browser sign-in, as the card tracks it. */
interface WorkBuddyLoginDraft {
  region: WorkBuddyWebRegion
  state: string
  url: string
  status: 'waiting' | 'error'
  message?: string
  /**
   * Whether polling this sign-in is pointless. A state the host no longer
   * knows (expired, or the plugin restarted) never becomes valid again, while
   * a network or gateway failure may.
   */
  fatal?: boolean
}

/** A completed sign-in's confirmation line, tied to the tab it belongs to. */
interface WorkBuddyLoginDone {
  region: WorkBuddyWebRegion
  text: string
}

/** Read the remembered sign-in, ignoring anything unreadable. */
function readStoredLogin(): WorkBuddyLoginDraft | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = window.localStorage.getItem(LOGIN_STORAGE_KEY)
    if (raw === null) return undefined
    const parsed = JSON.parse(raw) as Partial<WorkBuddyLoginDraft>
    if (typeof parsed.state !== 'string' || typeof parsed.url !== 'string') return undefined
    if (parsed.region !== 'cn' && parsed.region !== 'global') return undefined
    return {
      region: parsed.region,
      state: parsed.state,
      url: parsed.url,
      status: parsed.status === 'error' ? 'error' : 'waiting',
      ...typeof parsed.message === 'string' ? { message: parsed.message } : {},
      ...parsed.fatal === true ? { fatal: true } : {},
    }
  } catch {
    return undefined
  }
}

/** Remember or forget the running sign-in. */
function writeStoredLogin(draft: WorkBuddyLoginDraft | undefined): void {
  if (typeof window === 'undefined') return
  try {
    if (draft === undefined) window.localStorage.removeItem(LOGIN_STORAGE_KEY)
    else window.localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify(draft))
  } catch {
    // A browser with storage disabled still signs in; it just cannot resume
    // after a reload.
  }
}

/** Locale key for one pool state. */
function stateKeyOf(state: WorkBuddyWebPoolEntry['state']): WorkBuddySettingsKey {
  switch (state) {
    case 'ready': return 'row.stateReady'
    case 'cooldown': return 'row.stateCooldown'
    case 'degraded': return 'row.stateDegraded'
    case 'missing': return 'row.stateMissing'
    default: return 'row.stateDisabled'
  }
}

/**
 * A small ring showing how much of an account's granted credit allowance is
 * left. One stroked circle with a dash offset; the geometry is in viewBox units
 * so the icon scales with the surrounding text.
 */
function CreditRing({ ratio, title }: { ratio: number | undefined; title: string }): ReturnType<typeof h> {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const share = ratio === undefined ? 0 : Math.min(Math.max(ratio, 0), 1)
  return (
    <svg
      className="dsm-wb2api-ring"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--dsw-alias-border-l2,#3a3d45)" strokeWidth="3" />
      {ratio === undefined
        ? null
        : <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke={share >= 0.5 ? '#22a06b' : share >= 0.2 ? '#c98a2b' : '#d92d20'}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={String(circumference * share) + ' ' + String(circumference)}
            transform="rotate(-90 8 8)"
          />}
    </svg>
  )
}

/** The empty placeholder each tab starts from. */
function emptyUsage(region: WorkBuddyWebRegion): WorkBuddyWebUsage {
  return { status: 'empty', region, accounts: [], pool: [] }
}

/** Numeric policy fields the card edits; `seconds` fields are shown in seconds. */
const policyFields: readonly {
  key: keyof WorkBuddyWebPoolPolicy
  label: WorkBuddySettingsKey
  kind: 'count' | 'seconds' | 'boolean'
}[] = [
  { key: 'maxInFlightPerAccount', label: 'row.policyInFlight', kind: 'count' },
  { key: 'maxInFlightGlobalPerAccount', label: 'row.policyInFlightGlobal', kind: 'count' },
  { key: 'maxInFlightTotal', label: 'row.policyInFlightTotal', kind: 'count' },
  { key: 'breakerThreshold', label: 'row.policyBreaker', kind: 'count' },
  { key: 'breakerCooldownMs', label: 'row.policyBreakerCooldown', kind: 'seconds' },
  { key: 'breakerCooldownMaxMs', label: 'row.policyBreakerMax', kind: 'seconds' },
  { key: 'degradeThreshold', label: 'row.policyDegrade', kind: 'count' },
  { key: 'degradeCooldownMs', label: 'row.policyDegradeCooldown', kind: 'seconds' },
  { key: 'degradeCooldownMaxMs', label: 'row.policyDegradeMax', kind: 'seconds' },
  { key: 'softRateCooldownMs', label: 'row.policySoftRate', kind: 'seconds' },
  { key: 'softRateCooldownMaxMs', label: 'row.policySoftRateMax', kind: 'seconds' },
  { key: 'stickyTtlMs', label: 'row.policySticky', kind: 'seconds' },
  { key: 'balanceAware', label: 'row.policyBalanceAware', kind: 'boolean' },
]

/** Render the two account pools, their credits, policies, and model selection. */
export function WorkBuddyPoolCard({ t, settingsScope }: WorkBuddyPoolCardProps) {
  if (t === undefined) throw new Error('WorkBuddy pool card requires its translation function')
  const [open, setOpen] = useState(false)
  const [activeRegion, setActiveRegion] = useState<WorkBuddyWebRegion>('cn')
  /** Last-known usage per region, so tab dots survive tab switches. */
  const [statusByRegion, setStatusByRegion] = useState<Partial<Record<WorkBuddyWebRegion, WorkBuddyWebUsage>>>({})
  const [busy, setBusy] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  /** Per-region unsaved pool edits; a draft on one tab is never dropped by
   * switching to the other tab, only by that tab's discard/save. */
  const [poolDrafts, setPoolDrafts] = useState<Partial<Record<WorkBuddyWebRegion, WorkBuddyPoolDraft>>>({})
  const [modelDrafts, setModelDrafts] = useState<Partial<Record<WorkBuddyWebRegion, WorkBuddyModelDraft>>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [refreshingCredits, setRefreshingCredits] = useState(false)
  const [checkingIn, setCheckingIn] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  /** The running browser sign-in, if any; survives a page reload. */
  const [login, setLogin] = useState<WorkBuddyLoginDraft | undefined>(() => readStoredLogin())
  /** A finished sign-in's confirmation line, cleared by the next action. */
  const [loginDone, setLoginDone] = useState<WorkBuddyLoginDone | undefined>(undefined)
  /** Per-region growth tasks, loaded on demand (never on the 60s poll). */
  const [tasksByRegion, setTasksByRegion] = useState<Partial<Record<WorkBuddyWebRegion, WorkBuddyTaskState>>>({})
  const [tasksBusy, setTasksBusy] = useState(false)
  /**
   * Whether the task list is expanded, per region. Default COLLAPSED: a full
   * roster is ~18 rows, which would otherwise push the policy and model
   * sections off the screen every time the card is opened.
   */
  const [tasksOpen, setTasksOpen] = useState<Partial<Record<WorkBuddyWebRegion, boolean>>>({})
  /** The account a task run is currently sweeping, when it is one account. */
  const [tasksBusyAccount, setTasksBusyAccount] = useState<string | undefined>(undefined)
  const [taskDraft, setTaskDraft] = useState<Partial<Record<WorkBuddyWebRegion, WorkBuddyWebTaskSchedule>>>({})
  const mounted = useRef(true)
  /**
   * The authoritative "which sign-in is running" record. It is written
   * synchronously on every deliberate change, never derived from the rendered
   * state: a poll answer that lands after the sign-in it belongs to was
   * replaced or cancelled must not be able to touch the card, and comparing
   * against a value that only updates on the next render would leave a window
   * where a stale answer still looks current.
   */
  const loginRef = useRef<WorkBuddyLoginDraft | undefined>(login)

  const rememberLogin = useCallback((draft: WorkBuddyLoginDraft | undefined): void => {
    loginRef.current = draft
    writeStoredLogin(draft)
    if (mounted.current) setLogin(draft)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => settingsScope?.subscribe(() => { setSettingsRevision(value => value + 1) }), [settingsScope])

  const refreshUsage = useCallback(async (
    region: WorkBuddyWebRegion,
    signal?: AbortSignal,
  ): Promise<WorkBuddyWebUsage | undefined> => {
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_USAGE_PATH, region), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const document = value as WorkBuddyWebUsage
      if (mounted.current && signal?.aborted !== true) {
        setStatusByRegion(previous => ({ ...previous, [region]: document }))
      }
      return document
    } catch (error: unknown) {
      if (mounted.current && signal?.aborted !== true) {
        setStatusByRegion(previous => ({
          ...previous,
          [region]: { status: 'error', region, message: error instanceof Error ? error.message : t('row.requestFailed') },
        }))
      }
      return undefined
    }
  }, [t])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void refreshUsage(activeRegion, controller.signal)
    return () => { controller.abort() }
  }, [open, activeRegion, refreshUsage])

  // Each tab polls ITS OWN pool; both are live at once, so the dot on the
  // inactive tab keeps reflecting that region's real health.
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      for (const region of WORKBUDDY2API_REGIONS) void refreshUsage(region, controller.signal)
    }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, refreshUsage])

  /** Poll the running sign-in once and apply whatever it answered. */
  const pollLogin = useCallback(async (draft: WorkBuddyLoginDraft): Promise<void> => {
    const region = draft.region
    /**
     * Whether this answer still belongs to the sign-in the card is tracking.
     * The poller fires on a timer, so several requests are always in flight
     * around the moment a sign-in completes; the ones that lost the race must
     * be dropped rather than reported.
     */
    const stillCurrent = (): boolean => loginRef.current?.state === draft.state
    const path = withWorkBuddyRegion(WORKBUDDY2API_LOGIN_POLL_PATH, region)
    let response: Response
    try {
      response = await fetch(`${path}&${WORKBUDDY2API_STATE_PARAM}=${encodeURIComponent(draft.state)}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
    } catch (error: unknown) {
      if (mounted.current && stillCurrent()) {
        rememberLogin({
          ...draft,
          status: 'error',
          message: error instanceof Error ? error.message : t('row.requestFailed'),
        })
      }
      return
    }
    const body = await response.json().catch(() => undefined) as
      | (Partial<WorkBuddyWebLogin> & { error?: string })
      | undefined
    if (!response.ok) {
      if (!stillCurrent()) return
      // 400/404 mean the host has no such sign-in any more; retrying cannot
      // fix that, so the row becomes a terminal message plus a restart button.
      rememberLogin({
        ...draft,
        status: 'error',
        message: body?.error ?? `HTTP ${response.status}`,
        ...response.status === 400 || response.status === 404 ? { fatal: true } : {},
      })
      return
    }
    const document = body as WorkBuddyWebLogin
    // Every branch below reports on THIS sign-in; a stale answer would either
    // resurrect a finished sign-in or show an error for one that just worked.
    if (!stillCurrent()) return
    if (document.status === 'waiting') {
      rememberLogin({ ...draft, status: 'waiting', ...document.message === undefined ? {} : { message: document.message } })
      return
    }
    if (document.status === 'done') {
      rememberLogin(undefined)
      if (mounted.current) {
        setLoginDone({ region, text: t('row.signInDone', { account: document.account.accountName }) })
        if (document.note !== undefined) setActionError(document.note)
      }
      // The new account has to appear in its own tab's pool and credits.
      await refreshUsage(region)
      return
    }
    if (document.status === 'error') {
      rememberLogin({ ...draft, status: 'error', message: document.message })
    }
    // A finished sign-in is terminal: no branch of the poller may revive it.
  }, [rememberLogin, refreshUsage, t])

  // One poller per sign-in, alive whether or not the card is open, so a
  // sign-in finished while the user was in the browser is picked up as soon as
  // they come back. The effect re-runs whenever a sign-in is started or
  // replaced, which also retires the previous one's timer.
  useEffect(() => {
    if (login === undefined) return
    const controller = new AbortController()
    /**
     * Whether a request for this sign-in is still travelling. The poller is
     * what keeps a finished sign-in from being polled twice at once — the host
     * refuses the second request, but there is no reason to send it.
     */
    let inflight = false
    const tick = (): void => {
      const current = loginRef.current
      if (current === undefined || current.fatal === true || controller.signal.aborted) return
      if (inflight) return
      inflight = true
      void pollLogin(current).finally(() => { inflight = false })
    }
    tick()
    const timer = window.setInterval(tick, LOGIN_POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
    // Deliberately keyed on the identity of the sign-in, not on the draft
    // object: every poll replaces the draft, and depending on the object would
    // restart the timer (and re-poll) on each of its own answers.
  }, [login?.state, login?.region, pollLogin])

  /** Load one region's task document (list + schedule + last reports). */
  const loadTasks = useCallback(async (region: WorkBuddyWebRegion): Promise<void> => {
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_TASKS_PATH, region), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => undefined) as
        | { accounts?: WorkBuddyWebTasks[]; schedule?: WorkBuddyWebTaskSchedule | null; error?: string }
        | undefined
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      if (!mounted.current) return
      setTasksByRegion(previous => ({
        ...previous,
        [region]: {
          accounts: Array.isArray(body?.accounts) ? body.accounts : [],
          ...body?.schedule === undefined || body.schedule === null ? {} : { schedule: body.schedule },
          reports: body?.schedule?.lastReports ?? [],
        },
      }))
    } catch (error: unknown) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : t('row.requestFailed'))
    }
  }, [t])

  /** Run the tasks: this account's, or every account in the region. */
  const runTasks = async (accountId?: string): Promise<void> => {
    setTasksBusy(true)
    setTasksBusyAccount(accountId)
    setActionError(undefined)
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_TASKS_RUN_PATH, activeRegion), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(accountId === undefined ? {} : { accountId }),
      })
      const body = await response.json().catch(() => undefined) as
        | { reports?: WorkBuddyWebTaskReport[]; accounts?: WorkBuddyWebTasks[]; schedule?: WorkBuddyWebTaskSchedule; error?: string }
        | undefined
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      if (!mounted.current) return
      setTasksByRegion(previous => ({
        ...previous,
        [activeRegion]: {
          accounts: Array.isArray(body?.accounts) ? body.accounts : previous[activeRegion]?.accounts ?? [],
          ...body?.schedule === undefined ? {} : { schedule: body.schedule },
          reports: Array.isArray(body?.reports) ? body.reports : [],
        },
      }))
      // A finished sweep changes credits, so the pool view is refreshed too.
      await refreshUsage(activeRegion)
    } catch (error: unknown) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) {
        setTasksBusy(false)
        setTasksBusyAccount(undefined)
      }
    }
  }

  const startLogin = async (): Promise<void> => {
    setActionError(undefined)
    setLoginDone(undefined)
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_LOGIN_START_PATH, activeRegion), {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => undefined) as
        | { url?: string; state?: string; error?: string }
        | undefined
      if (!response.ok || typeof body?.url !== 'string' || typeof body.state !== 'string') {
        throw new Error(body?.error ?? `HTTP ${response.status}`)
      }
      rememberLogin({ region: activeRegion, state: body.state, url: body.url, status: 'waiting' })
      // The gateway round trip can outlive the browser's transient activation,
      // in which case the popup is refused; the row's own "open again" button
      // is a direct click, so it always works.
      if (window.open(body.url, '_blank', 'noopener,noreferrer') === null) {
        if (mounted.current) setActionError(t('row.signInBlocked'))
      }
    } catch (error: unknown) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : t('row.requestFailed'))
    }
  }

  const cancelLogin = (): void => {
    rememberLogin(undefined)
  }

  void settingsRevision

  const usage = statusByRegion[activeRegion] ?? emptyUsage(activeRegion)
  const writable = settingsScope?.getSnapshot().writable === true
  const entries: readonly WorkBuddyWebPoolEntry[] =
    usage.status === 'ready' || usage.status === 'empty' ? usage.pool : []
  const savedPoolState: readonly WorkBuddyWebPoolState[] = usage.status === 'ready' ? usage.poolState : []
  const savedPolicy: WorkBuddyWebPoolPolicy | undefined = usage.status === 'ready' ? usage.policy : undefined

  const poolDraft = poolDrafts[activeRegion]
  const modelDraft = modelDrafts[activeRegion]
  const activeAccounts = poolDraft?.accounts ?? new Map(entries.map(entry => [entry.accountId, {
    enabled: entry.enabled,
    weight: entry.weight,
  }]))
  const activePolicy = poolDraft?.policy ?? savedPolicy

  /** The context budgets saved in settings for the active region. */
  function savedContextBudgets(): Record<string, number> {
    const configured = settingsScope?.getSnapshot().value as
      | { regions?: Record<string, { contextBudgets?: unknown }> }
      | undefined
    const value = configured?.regions?.[activeRegion]?.contextBudgets
    return typeof value === 'object' && value !== null ? value as Record<string, number> : {}
  }

  const editPool = (edit: (current: WorkBuddyPoolDraft) => WorkBuddyPoolDraft): void => {
    setPoolDrafts(previous => ({
      ...previous,
      [activeRegion]: edit(previous[activeRegion] ?? {
        accounts: new Map(entries.map(entry => [entry.accountId, { enabled: entry.enabled, weight: entry.weight }])),
        policy: savedPolicy ?? FALLBACK_POLICY,
      }),
    }))
  }

  const toggleAccount = (accountId: string): void => {
    editPool(current => {
      const accounts = new Map(current.accounts)
      const existing = accounts.get(accountId) ?? { enabled: true, weight: 10 }
      accounts.set(accountId, { ...existing, enabled: !existing.enabled })
      return { ...current, accounts }
    })
  }

  const setAccountWeight = (accountId: string, weight: number): void => {
    editPool(current => {
      const accounts = new Map(current.accounts)
      const existing = accounts.get(accountId) ?? { enabled: true, weight: 10 }
      accounts.set(accountId, { ...existing, weight })
      return { ...current, accounts }
    })
  }

  const setPolicyField = <K extends keyof WorkBuddyWebPoolPolicy>(field: K, value: WorkBuddyWebPoolPolicy[K]): void => {
    editPool(current => ({ ...current, policy: { ...current.policy, [field]: value } }))
  }

  const editModels = (edit: (current: WorkBuddyModelDraft) => WorkBuddyModelDraft): void => {
    setModelDrafts(previous => ({
      ...previous,
      [activeRegion]: edit(previous[activeRegion] ?? {
        models: usage.status === 'ready' ? [...usage.models] : [],
        enabledIds: new Set(usage.status === 'ready' ? usage.enabledModelIds : []),
        imageIds: new Set(usage.status === 'ready' ? usage.imageModelIds : []),
        contextBudgets: savedContextBudgets(),
      }),
    }))
  }

  const toggleModel = (modelId: string): void => {
    editModels(current => {
      const enabledIds = new Set(current.enabledIds)
      if (!enabledIds.delete(modelId)) enabledIds.add(modelId)
      return { ...current, enabledIds }
    })
  }

  const toggleImage = (modelId: string): void => {
    editModels(current => {
      const imageIds = new Set(current.imageIds)
      if (!imageIds.delete(modelId)) imageIds.add(modelId)
      return { ...current, imageIds }
    })
  }

  const setContextBudget = (modelId: string, budget: number): void => {
    editModels(current => ({ ...current, contextBudgets: { ...current.contextBudgets, [modelId]: budget } }))
  }

  const discard = (): void => {
    setPoolDrafts(previous => {
      const next = { ...previous }
      delete next[activeRegion]
      return next
    })
    setModelDrafts(previous => {
      const next = { ...previous }
      delete next[activeRegion]
      return next
    })
  }

  const saveAll = async (): Promise<void> => {
    if (settingsScope === undefined) return
    setSaving(true)
    setSaveError(undefined)
    try {
      const configured = settingsScope.getSnapshot().value as { regions?: Record<string, unknown> } | undefined
      const configuredRegions = typeof configured?.regions === 'object' && configured.regions !== null
        ? configured.regions
        : {}
      const slot: Record<string, unknown> = {
        ...(configuredRegions[activeRegion] as Record<string, unknown> | undefined ?? {}),
      }
      if (poolDraft !== undefined) {
        const records: WorkBuddyWebPoolState[] = savedPoolState.map(record => {
          const edited = poolDraft.accounts.get(record.accountId)
          return edited === undefined
            ? record
            : { ...record, enabled: edited.enabled, weight: Math.min(Math.max(Math.round(edited.weight), 1), 100) }
        })
        for (const [accountId, edited] of poolDraft.accounts) {
          if (records.some(record => record.accountId === accountId)) continue
          records.push({
            accountId,
            enabled: edited.enabled,
            weight: Math.min(Math.max(Math.round(edited.weight), 1), 100),
            priority: 100,
          })
        }
        slot.poolState = records
        slot.pool = { ...poolDraft.policy }
      }
      if (modelDraft !== undefined) {
        // `toPersistedWorkBuddyModel` strips the card-only fields BY KEY:
        // explicit `undefined` values are rejected by the settings write's
        // strict JSON codec, which used to fail the whole save silently.
        slot.lastCatalog = modelDraft.models.map(toPersistedWorkBuddyModel)
        slot.enabledModelIds = [...modelDraft.enabledIds]
        slot.imageModelIds = [...modelDraft.imageIds]
        slot.contextBudgets = modelDraft.contextBudgets
      }
      // Write ONLY this region's slot: the other region's picks are untouched.
      await settingsScope.set('regions', { ...configuredRegions, [activeRegion]: slot })
      setPoolDrafts(previous => {
        const next = { ...previous }
        delete next[activeRegion]
        return next
      })
      setModelDrafts(previous => {
        const next = { ...previous }
        delete next[activeRegion]
        return next
      })
      await refreshUsage(activeRegion)
    } catch (error: unknown) {
      // Drafts stay dirty on failure, so the button remains pressable for a retry.
      if (mounted.current) setSaveError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const rescanAccounts = async (): Promise<void> => {
    setBusy(true)
    setActionError(undefined)
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_ACCOUNTS_REFRESH_PATH, activeRegion), {
        method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refreshUsage(activeRegion)
    } catch (error: unknown) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const refreshCredits = async (): Promise<void> => {
    setRefreshingCredits(true)
    setActionError(undefined)
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_CREDITS_REFRESH_PATH, activeRegion), {
        method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refreshUsage(activeRegion)
    } catch (error: unknown) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setRefreshingCredits(false)
    }
  }

  const resetAccount = async (accountId: string): Promise<void> => {
    setActionError(undefined)
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_POOL_ACTION_PATH, activeRegion), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'reset', accountId }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refreshUsage(activeRegion)
    } catch (error: unknown) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : t('row.requestFailed'))
    }
  }

  const claimCheckin = async (accountId: string): Promise<void> => {
    setCheckingIn(accountId)
    setActionError(undefined)
    try {
      const path = withWorkBuddyRegion(WORKBUDDY2API_CHECKIN_PATH, activeRegion)
      const response = await fetch(`${path}&${WORKBUDDY2API_ACCOUNT_PARAM}=${encodeURIComponent(accountId)}`, {
        method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
      })
      const body = await response.json().catch(() => undefined) as { error?: string } | undefined
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      await refreshUsage(activeRegion)
    } catch (error: unknown) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setCheckingIn(undefined)
    }
  }

  const refreshModels = async (): Promise<void> => {
    setBusy(true)
    setActionError(undefined)
    try {
      const response = await fetch(withWorkBuddyRegion(WORKBUDDY2API_MODELS_REFRESH_PATH, activeRegion), {
        method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
      })
      const body = await response.json() as { models?: WorkBuddyWebModel[]; error?: string }
      if (!response.ok || !Array.isArray(body.models)) throw new Error(body.error ?? `HTTP ${response.status}`)
      const fresh = body.models
      const freshIds = new Set(fresh.map(model => model.id))
      // Re-map the user's CURRENT selections (draft first, then saved) onto the
      // fresh catalog by model id, so renames and additions never silently lose
      // enabled choices, image opt-ins, or context budgets.
      const source = modelDraft ?? (usage.status === 'ready' ? {
        models: usage.models,
        enabledIds: new Set(usage.enabledModelIds),
        imageIds: new Set(usage.imageModelIds),
        contextBudgets: savedContextBudgets(),
      } : undefined)
      const stillBudgets: Record<string, number> = {}
      for (const id of freshIds) {
        const budget = source?.contextBudgets[id]
        if (typeof budget === 'number') stillBudgets[id] = budget
      }
      setModelDrafts(previous => ({
        ...previous,
        [activeRegion]: {
          models: fresh,
          enabledIds: new Set([...(source?.enabledIds ?? [])].filter(id => freshIds.has(id))),
          imageIds: new Set([...(source?.imageIds ?? [])].filter(id => freshIds.has(id))),
          contextBudgets: stillBudgets,
        },
      }))
    } catch (error: unknown) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : t('row.requestFailed'))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const taskState = tasksByRegion[activeRegion]
  const tasksExpanded = tasksOpen[activeRegion] === true

  // Tasks are fetched when the user actually expands the section (or presses
  // refresh), not on the 60s pool poll: the list costs one upstream call per
  // account, and a collapsed section should not make any. Expanding also
  // fetches, so this only covers the collapse→expand→collapse→expand path.
  useEffect(() => {
    if (!open || !tasksExpanded) return
    if (tasksByRegion[activeRegion] !== undefined) return
    void loadTasks(activeRegion)
  }, [open, activeRegion, tasksExpanded, tasksByRegion, loadTasks])
  /** Summary for the collapsed header: how far along this region's tasks are. */
  const taskSummary = (() => {
    const accounts = (taskState?.accounts ?? []).filter(account => account.supported)
    let done = 0
    let total = 0
    let claimable = 0
    for (const account of accounts) {
      for (const task of account.tasks) {
        total += 1
        if (task.claimed || (task.target > 0 && task.current >= task.target)) done += 1
        if (task.claimable) claimable += 1
      }
    }
    return { done, total, claimable, accounts: accounts.length }
  })()
  const schedule = taskDraft[activeRegion] ?? taskState?.schedule
  const reportsByAccount = new Map(
    (taskState?.reports ?? []).map(report => [report.accountId, report]),
  )

  /** Persist the schedule draft (and re-arm the host's timers). */
  const saveSchedule = async (next: WorkBuddyWebTaskSchedule): Promise<void> => {
    if (settingsScope === undefined) return
    setTaskDraft(previous => ({ ...previous, [activeRegion]: next }))
    try {
      const configured = settingsScope.getSnapshot().value as Record<string, unknown> | undefined
      await settingsScope.set('tasks', {
        ...typeof configured?.tasks === 'object' && configured.tasks !== null ? configured.tasks : {},
        enabled: next.enabled,
        hour: next.hour,
        minute: next.minute,
        runOnStart: next.runOnStart,
      })
    } catch (error: unknown) {
      if (mounted.current) setSaveError(error instanceof Error ? error.message : t('row.requestFailed'))
      return
    }
    setTaskDraft(previous => {
      const copy = { ...previous }
      delete copy[activeRegion]
      return copy
    })
    await loadTasks(activeRegion)
  }

  const title = t('row.title')
  const visibleModels = modelDraft?.models ?? (usage.status === 'ready' ? usage.models : [])
  const activeEnabledIds = modelDraft?.enabledIds ?? new Set(usage.status === 'ready' ? usage.enabledModelIds : [])
  const activeImageIds = modelDraft?.imageIds ?? new Set(usage.status === 'ready' ? usage.imageModelIds : [])
  const activeContextBudgets = modelDraft?.contextBudgets ?? savedContextBudgets()
  const creditsByAccount = new Map(
    (usage.status === 'ready' ? usage.credits : []).map(credit => [credit.accountId, credit]),
  )
  const dirty = poolDraft !== undefined || modelDraft !== undefined

  return (
    <li className={`dsm-plugin-card${open ? ' dsm-plugin-card-open' : ''}`}>
      <button
        type="button"
        className="dsm-plugin-card-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'row.collapse' : 'row.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <img className="dsm-plugin-card-icon" src={WORKBUDDY2API_PLUGIN_ICON} alt="" />
        <span className="dsm-plugin-card-head">
          <span className="dsm-plugin-card-title">{title}</span>
          <span className="dsm-plugin-card-description">{t('row.desc')}</span>
        </span>
        <span
          aria-hidden="true"
          className={`dsm-plugin-card-chevron${open ? ' dsm-plugin-card-chevron-open' : ''}`}
        >
          {h(IconChevronDownOutline14, { size: 14 })}
        </span>
      </button>
      <div className="dsm-plugin-card-body" hidden={!open}>
        {open
          ? <div className="dsm-wb2api-root">
              <div className="dsm-wb2api-tabs" role="tablist" aria-label={title}>
                {WORKBUDDY2API_REGIONS.map(region => {
                  const regionUsage = statusByRegion[region]
                  const dot = regionUsage === undefined
                    ? 'var(--dsw-alias-label-dimmed, #9aa0a6)'
                    : regionUsage.status === 'ready'
                      ? 'var(--dsw-alias-state-success-primary, #22a06b)'
                      : regionUsage.status === 'error'
                        ? 'var(--dsw-alias-state-error-primary, #d92d20)'
                        : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
                  return (
                    <button
                      key={region}
                      type="button"
                      role="tab"
                      aria-selected={region === activeRegion}
                      className={`dsm-wb2api-tab${region === activeRegion ? ' dsm-wb2api-tab-active' : ''}`}
                      onClick={() => { setActiveRegion(region) }}
                    >
                      <span aria-hidden="true" className="dsm-wb2api-tab-dot" style={{ background: dot }} />
                      {region === 'cn' ? t('row.tabCn') : t('row.tabGlobal')}
                    </button>
                  )
                })}
              </div>
              <p className="dsm-wb2api-section-sub">{t('row.tabHint')}</p>

              <section className="dsm-wb2api-section" aria-label={t('row.accountsTitle')}>
                <div className="dsm-wb2api-section-head">
                  <div>
                    <h3 className="dsm-wb2api-section-title">{t('row.accountsTitle')}</h3>
                    <p className="dsm-wb2api-section-sub">
                      {t('row.providerLabel', {
                        provider: activeRegion === 'global' ? 'workbuddy2api-global' : 'workbuddy2api',
                      })}
                    </p>
                  </div>
                  <div className="dsm-wb2api-actions-buttons">
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-outline"
                      disabled={busy || refreshingCredits}
                      onClick={() => { void refreshCredits() }}
                    >
                      {refreshingCredits ? t('row.refreshingCredits') : t('row.refreshCredits')}
                    </button>
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-outline"
                      disabled={busy}
                      onClick={() => { void rescanAccounts() }}
                    >
                      {busy ? t('row.accountsScanning') : t('row.accountsRescan')}
                    </button>
                  </div>
                </div>
                <div className="dsm-wb2api-signin">
                  {login === undefined || login.region !== activeRegion
                    ? <span className="dsm-wb2api-signin-text">
                        {t('row.signInHint', {
                          region: activeRegion === 'cn' ? t('row.tabCn') : t('row.tabGlobal'),
                        })}
                      </span>
                    : login.status === 'error'
                      ? <span className="dsm-wb2api-signin-status">
                          <span className="dsm-wb2api-error">{login.message}</span>
                        </span>
                      : <span className="dsm-wb2api-signin-status">
                          <span className="dsm-wb2api-spinner" aria-hidden="true" />
                          {t('row.signInWaiting')}
                        </span>}
                  {loginDone === undefined || loginDone.region !== activeRegion
                    ? null
                    : <span className="dsm-wb2api-signin-done">{loginDone.text}</span>}
                  <div className="dsm-wb2api-actions-buttons">
                    {login === undefined || login.region !== activeRegion
                      // Nothing running on this tab: the only action is to start
                      // one.
                      ? <button
                          type="button"
                          className="dsm-btn dsm-btn-primary"
                          disabled={busy}
                          onClick={() => { void startLogin() }}
                        >
                          {t('row.signIn')}
                        </button>
                      : login.fatal === true
                        // The host no longer knows this sign-in (it expired, or
                        // the plugin restarted), so its authorization URL is
                        // dead: reopening it would only burn the user's time.
                        // Offer a fresh sign-in instead.
                        ? <button
                            type="button"
                            className="dsm-btn dsm-btn-primary"
                            disabled={busy}
                            onClick={() => { void startLogin() }}
                          >
                            {t('row.signIn')}
                          </button>
                        : <>
                            <button
                              type="button"
                              className="dsm-btn dsm-btn-outline"
                              onClick={() => { window.open(login.url, '_blank', 'noopener,noreferrer') }}
                            >
                              {t('row.signInOpen')}
                            </button>
                            <button type="button" className="dsm-btn dsm-btn-outline" onClick={cancelLogin}>
                              {t('row.signInCancel')}
                            </button>
                          </>}
                  </div>
                </div>
                {entries.length === 0
                  ? <p className="dsm-wb2api-text">
                      {usage.status === 'empty' ? usage.message ?? t('row.emptyHint') : t('row.empty')}
                    </p>
                  : <div className="dsm-wb2api-account-list">
                      {entries.map(entry => {
                        const edited = activeAccounts.get(entry.accountId)
                        const enabled = edited?.enabled ?? entry.enabled
                        const weight = edited?.weight ?? entry.weight
                        const credit = creditsByAccount.get(entry.accountId)
                        // Remaining share of everything the account was granted.
                        // Unknown when the upstream reported no package sizes, or
                        // when the allowance itself cannot cover the total
                        // (a top-up the catalogue did not describe) — the ring
                        // must not claim a share it cannot compute.
                        const capacity = credit?.credits?.capacity ?? 0
                        const total = credit?.credits?.total
                        const ratio = total === undefined || capacity <= 0 || total > capacity
                          ? undefined
                          : total / capacity
                        const percent = ratio === undefined ? 0 : Math.round(ratio * 100)
                        const ringTitle = ratio === undefined
                          ? t('row.creditsRatioUnknown')
                          : t('row.creditsRatio', { percent })
                        return (
                          <div className="dsm-wb2api-account" key={entry.accountId}>
                            <div className="dsm-wb2api-account-head">
                              <span className="dsm-wb2api-account-name">{entry.accountName}</span>
                              <span className={`dsm-wb2api-badge dsm-wb2api-badge-${entry.state}`}>
                                {t(stateKeyOf(entry.state))}
                              </span>
                              <span className="dsm-wb2api-account-spacer" />
                              <label className="dsm-wb2api-switch">
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  disabled={!writable || saving}
                                  onChange={() => { toggleAccount(entry.accountId) }}
                                />
                                <span>{t('row.accountEnabled')}</span>
                              </label>
                              <label className="dsm-wb2api-weight">
                                <span>{t('row.accountWeight')}</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={100}
                                  value={weight}
                                  disabled={!writable || saving}
                                  onChange={event => {
                                    const next = Number(event.currentTarget.value)
                                    if (Number.isFinite(next)) setAccountWeight(entry.accountId, next)
                                  }}
                                />
                              </label>
                              <button
                                type="button"
                                className="dsm-btn dsm-btn-outline"
                                onClick={() => { void resetAccount(entry.accountId) }}
                              >
                                {t('row.accountReset')}
                              </button>
                            </div>
                            <div className="dsm-wb2api-account-meta">
                              <span>{t('row.accountInFlight', { count: entry.inFlight })}</span>
                              <span>{t('row.accountSuccess', { ok: entry.successes })}</span>
                              <span>{t('row.accountFailure', { failed: entry.failures })}</span>
                              <span>{t('row.accountExpires', { at: formatDateTime(entry.tokenExpiresAtMs) })}</span>
                              {entry.cooldownUntil === undefined
                                ? null
                                : <span>{t('row.accountCooldownUntil', { at: formatDateTime(entry.cooldownUntil) })}</span>}
                              {entry.breakerUntil === undefined
                                ? null
                                : <span>{t('row.accountBreakerUntil', { at: formatDateTime(entry.breakerUntil) })}</span>}
                              {entry.degradedUntil === undefined
                                ? null
                                : <span>{t('row.accountDegradedUntil', { at: formatDateTime(entry.degradedUntil) })}</span>}
                              <span className="dsm-wb2api-credits">
                                {credit?.credits === undefined
                                  ? t('row.accountCreditsUnknown')
                                  : <>
                                      <CreditRing ratio={ratio} title={ringTitle} />
                                      {credit.credits.expiringSoon > 0
                                        ? t('row.accountCreditsExpiring', {
                                          credits: formatNumber(credit.credits.total),
                                          soon: formatNumber(credit.credits.expiringSoon),
                                        })
                                        : t('row.accountCredits', { credits: formatNumber(credit.credits.total) })}
                                    </>}
                              </span>
                              <button
                                type="button"
                                className="dsm-btn dsm-btn-outline"
                                disabled={checkingIn !== undefined}
                                onClick={() => { void claimCheckin(entry.accountId) }}
                              >
                                {checkingIn === entry.accountId ? t('row.checkinClaiming') : t('row.checkinClaim')}
                              </button>
                              <button
                                type="button"
                                className="dsm-btn dsm-btn-outline"
                                disabled={tasksBusy}
                                onClick={() => { void runTasks(entry.accountId) }}
                              >
                                {tasksBusyAccount === entry.accountId
                                  ? t('row.taskRunAccountBusy')
                                  : t('row.taskRunAccount')}
                              </button>
                            </div>
                            {credit?.creditsError === undefined
                              ? null
                              : <span className="dsm-wb2api-account-hint">
                                  {t('row.creditsError', { message: credit.creditsError })}
                                </span>}
                            {entry.lastError === undefined
                              ? null
                              : <span className="dsm-wb2api-account-hint">
                                  {t('row.accountLastError', { message: entry.lastError })}
                                </span>}
                          </div>
                        )
                      })}
                    </div>}
              </section>

              {activePolicy === undefined
                ? null
                : <section className="dsm-wb2api-section" aria-label={t('row.policyTitle')}>
                    <div className="dsm-wb2api-section-head">
                      <div>
                        <h3 className="dsm-wb2api-section-title">{t('row.policyTitle')}</h3>
                        <p className="dsm-wb2api-section-sub">{t('row.policyHint')}</p>
                      </div>
                    </div>
                    <div className="dsm-wb2api-policy">
                      {policyFields.map(field => (
                        <label className="dsm-wb2api-policy-field" key={field.key}>
                          <span>{t(field.label)}</span>
                          {field.kind === 'boolean'
                            ? <input
                                type="checkbox"
                                checked={activePolicy[field.key] as boolean}
                                disabled={!writable || saving}
                                onChange={event => { setPolicyField(field.key, event.currentTarget.checked) }}
                              />
                            : <input
                                type="number"
                                min={0}
                                value={field.kind === 'seconds'
                                  ? Math.round((activePolicy[field.key] as number) / 1000)
                                  : activePolicy[field.key] as number}
                                disabled={!writable || saving}
                                onChange={event => {
                                  const next = Number(event.currentTarget.value)
                                  if (!Number.isFinite(next)) return
                                  setPolicyField(field.key, field.kind === 'seconds' ? next * 1000 : next)
                                }}
                              />}
                        </label>
                      ))}
                      <p className="dsm-wb2api-policy-note">{t('row.policyBalanceHint')}</p>
                    </div>
                  </section>}

              {usage.status === 'ready'
                ? <section className="dsm-wb2api-models" aria-label={t('row.modelsTitle')}>
                    <div className="dsm-wb2api-section-head">
                      <div>
                        <h3 className="dsm-wb2api-section-title">{t('row.modelsTitle')}</h3>
                        <p className="dsm-wb2api-section-sub">
                          {t('row.modelsSummary', { count: activeEnabledIds.size })}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="dsm-btn dsm-btn-outline"
                        disabled={busy}
                        onClick={() => { void refreshModels() }}
                      >
                        {busy ? t('row.modelsRefreshing') : t('row.modelsRefresh')}
                      </button>
                    </div>
                    <div className="dsm-wb2api-model-list">
                      {visibleModels.map(model => (
                        <div
                          className={`dsm-wb2api-model${activeEnabledIds.has(model.id) ? '' : ' dsm-wb2api-model-disabled'}`}
                          key={model.id}
                        >
                          <div className="dsm-wb2api-model-head">
                            <label className="dsm-wb2api-model-enabled">
                              <input
                                type="checkbox"
                                checked={activeEnabledIds.has(model.id)}
                                disabled={!writable || saving}
                                onChange={() => { toggleModel(model.id) }}
                              />
                              <span className="dsm-wb2api-model-name">
                                {model.name}
                                {model.creditMultiplier === undefined
                                  ? null
                                  : <span className="dsm-wb2api-model-name-rate">({model.creditMultiplier.toFixed(2)}x)</span>}
                              </span>
                            </label>
                            <label className="dsm-wb2api-model-image" title={t('row.modelImage')}>
                              <input
                                type="checkbox"
                                checked={activeImageIds.has(model.id)}
                                disabled={!writable || saving}
                                onChange={() => { toggleImage(model.id) }}
                              />
                              <span>{t('row.modelImage')}</span>
                            </label>
                            <fieldset className="dsm-wb2api-context-budget" aria-label={t('row.contextBudget')}>
                              {model.nativeContextWindow > 200_000
                                ? <label>
                                    <input
                                      type="radio"
                                      name={`context-${activeRegion}-${model.id}`}
                                      checked={(activeContextBudgets[model.id] ?? 200_000) === 200_000}
                                      disabled={!writable || saving}
                                      onChange={() => { setContextBudget(model.id, 200_000) }}
                                    />
                                    <span>200K</span>
                                  </label>
                                : null}
                              <label>
                                <input
                                  type="radio"
                                  name={`context-${activeRegion}-${model.id}`}
                                  checked={model.nativeContextWindow <= 200_000
                                    || activeContextBudgets[model.id] === model.nativeContextWindow}
                                  disabled={model.nativeContextWindow <= 200_000 || !writable || saving}
                                  onChange={() => { setContextBudget(model.id, model.nativeContextWindow) }}
                                />
                                <span>{formatCapacity(model.nativeContextWindow, t('row.modelUnknown'))}</span>
                              </label>
                            </fieldset>
                          </div>
                          <div className="dsm-wb2api-model-details">
                            <div className="dsm-wb2api-model-meta">
                              <span>{t('row.modelContext', { context: formatCapacity(model.nativeContextWindow, t('row.modelUnknown')) })}</span>
                              <span>{t('row.modelOutput', { output: formatCapacity(model.maxTokens, t('row.modelUnknown')) })}</span>
                              {model.reasoning?.supportedEfforts === undefined
                                ? null
                                : <span>{t('row.modelReasoning', { efforts: model.reasoning.supportedEfforts.join(' / ') })}</span>}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="dsm-wb2api-model-capability-note">{t('row.modelCapabilityPending')}</p>
                  </section>
                : null}

              <section className="dsm-wb2api-tasks" aria-label={t('row.tasksTitle')}>
                <div className="dsm-wb2api-section-head">
                  {/*
                    The whole section collapses behind this heading. The roster
                    is ~18 rows per account, so leaving it open would bury the
                    policy and model sections below it.
                  */}
                  <button
                    type="button"
                    className="dsm-wb2api-section-toggle"
                    aria-expanded={tasksExpanded}
                    onClick={() => {
                      const next = !tasksExpanded
                      setTasksOpen(previous => ({ ...previous, [activeRegion]: next }))
                      // Expanding is the moment the list is worth its cost, so
                      // the first expand of a session fetches it.
                      if (next && tasksByRegion[activeRegion] === undefined) void loadTasks(activeRegion)
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={`dsm-wb2api-section-chevron${tasksExpanded ? ' dsm-wb2api-section-chevron-open' : ''}`}
                    >
                      {h(IconChevronDownOutline14, { size: 14 })}
                    </span>
                    <span className="dsm-wb2api-section-toggle-text">
                      <span className="dsm-wb2api-section-title">
                        {t('row.tasksTitle')}
                        {taskSummary.total === 0
                          ? ''
                          : ' · ' + t('row.tasksSummary', { done: taskSummary.done, total: taskSummary.total })}
                        {taskSummary.claimable === 0
                          ? ''
                          : ' · ' + t('row.tasksClaimableCount', { count: taskSummary.claimable })}
                      </span>
                      <span className="dsm-wb2api-section-sub">
                        {tasksExpanded ? t('row.tasksHint') : t('row.tasksHintCollapsed')}
                      </span>
                    </span>
                  </button>
                  <div className="dsm-wb2api-actions-buttons">
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-outline"
                      disabled={tasksBusy}
                      onClick={() => { void loadTasks(activeRegion) }}
                    >
                      {tasksBusy ? t('row.tasksRefreshing') : t('row.tasksRefresh')}
                    </button>
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-primary"
                      disabled={tasksBusy}
                      onClick={() => { void runTasks() }}
                    >
                      {tasksBusy ? t('row.tasksRunning') : t('row.tasksRun')}
                    </button>
                  </div>
                </div>

                <div className="dsm-wb2api-tasks-body" hidden={!tasksExpanded}>
                {taskState === undefined
                  ? <p className="dsm-wb2api-text">{t('row.tasksRefreshing')}</p>
                  : taskState.accounts.length === 0
                    ? <p className="dsm-wb2api-text">{t('row.tasksEmpty')}</p>
                    : taskState.accounts.map(account => {
                      if (!account.supported) {
                        return <p className="dsm-wb2api-text" key={account.accountId}>{t('row.tasksIntl')}</p>
                      }
                      const report = reportsByAccount.get(account.accountId)
                      const resultsByCode = new Map(
                        (report?.results ?? []).map(result => [result.taskCode, result]),
                      )
                      const done = account.tasks.filter(task => task.claimed
                        || (task.target > 0 && task.current >= task.target)).length
                      return (
                        <div key={account.accountId}>
                          <div className="dsm-wb2api-section-head">
                            <div>
                              <h4 className="dsm-wb2api-section-title">{account.accountName}</h4>
                              <p className="dsm-wb2api-section-sub">
                                {t('row.tasksSummary', { done, total: account.tasks.length })}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="dsm-btn dsm-btn-outline"
                              disabled={tasksBusy}
                              onClick={() => { void runTasks(account.accountId) }}
                            >
                              {tasksBusy ? t('row.tasksRunning') : t('row.tasksRun')}
                            </button>
                          </div>
                          {account.error === undefined
                            ? null
                            : <p className="dsm-wb2api-error">{account.error}</p>}
                          <div className="dsm-wb2api-task-list">
                            {account.tasks.map(task => {
                              const settled = task.claimed || (task.target > 0 && task.current >= task.target)
                              const result = resultsByCode.get(task.taskCode)
                              return (
                                <div
                                  className={`dsm-wb2api-task${settled ? ' dsm-wb2api-task-done' : ''}`}
                                  key={task.taskCode}
                                >
                                  <div className="dsm-wb2api-task-head">
                                    <span className="dsm-wb2api-task-title">{task.title}</span>
                                    {task.claimed
                                      ? <span className="dsm-wb2api-badge dsm-wb2api-badge-ready">
                                          {t('row.tasksClaimed')}
                                        </span>
                                      : task.claimable
                                        ? <span className="dsm-wb2api-badge dsm-wb2api-badge-cooldown">
                                            {t('row.tasksClaimable')}
                                          </span>
                                        : null}
                                    {task.automated
                                      ? null
                                      : <span
                                          className="dsm-wb2api-badge dsm-wb2api-badge-disabled"
                                          title={t('row.tasksUnsupportedWhy', {
                                            reason: task.unsupportedReason ?? '',
                                          })}
                                        >
                                          {t('row.tasksUnsupported')}
                                        </span>}
                                    <span className="dsm-wb2api-task-spacer" />
                                    {task.target > 0
                                      ? <span className="dsm-wb2api-task-progress">
                                          {task.current}/{task.target}
                                        </span>
                                      : null}
                                    {task.credit > 0 || task.energy > 0
                                      ? <span className="dsm-wb2api-task-reward">
                                          {task.energy > 0
                                            ? t('row.tasksRewardEnergy', { credit: task.credit, energy: task.energy })
                                            : t('row.tasksReward', { credit: task.credit })}
                                        </span>
                                      : null}
                                  </div>
                                  {task.detail === ''
                                    ? null
                                    : <p className="dsm-wb2api-task-detail">{task.detail}</p>}
                                  {result === undefined
                                    ? null
                                    : <p className={`dsm-wb2api-task-report${result.outcome === 'error' ? ' dsm-wb2api-task-report-error' : ''}`}>
                                        {result.progressAfter === undefined
                                          ? result.message
                                          : `${result.progressBefore ?? '?'} → ${result.progressAfter} · ${result.message}`}
                                      </p>}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}

                {schedule === undefined
                  ? null
                  : <div className="dsm-wb2api-task-schedule">
                      <label>
                        <span>{t('row.tasksAutoEnabled')}</span>
                        <input
                          type="checkbox"
                          checked={schedule.enabled}
                          disabled={!writable}
                          onChange={event => { void saveSchedule({ ...schedule, enabled: event.currentTarget.checked }) }}
                        />
                      </label>
                      <label>
                        <span>{t('row.tasksAutoAt')}</span>
                        <span>
                          <input
                            type="number"
                            min={0}
                            max={23}
                            value={schedule.hour}
                            disabled={!writable}
                            onChange={event => {
                              const hour = Number(event.currentTarget.value)
                              if (Number.isFinite(hour)) void saveSchedule({ ...schedule, hour })
                            }}
                          />
                          {' : '}
                          <input
                            type="number"
                            min={0}
                            max={59}
                            value={schedule.minute}
                            disabled={!writable}
                            onChange={event => {
                              const minute = Number(event.currentTarget.value)
                              if (Number.isFinite(minute)) void saveSchedule({ ...schedule, minute })
                            }}
                          />
                        </span>
                      </label>
                      <label>
                        <span>{t('row.tasksAutoOnStart')}</span>
                        <input
                          type="checkbox"
                          checked={schedule.runOnStart}
                          disabled={!writable}
                          onChange={event => { void saveSchedule({ ...schedule, runOnStart: event.currentTarget.checked }) }}
                        />
                      </label>
                      <p className="dsm-wb2api-task-schedule-note">
                        {schedule.running ? t('row.tasksAutoRunning') + ' · ' : ''}
                        {schedule.nextRunAtMs === undefined
                          ? ''
                          : t('row.tasksAutoNext', { at: formatDateTime(schedule.nextRunAtMs) }) + ' · '}
                        {schedule.lastRunAtMs === undefined
                          ? t('row.tasksAutoLast', { at: t('row.tasksAutoNever') })
                          : t('row.tasksAutoLast', { at: formatDateTime(schedule.lastRunAtMs) })}
                      </p>
                      <p className="dsm-wb2api-task-schedule-note">
                        {schedule.lastSkipped.map(entry =>
                          t('row.tasksSkipped', { name: entry.accountName, reason: entry.reason })).join(' · ')}
                      </p>
                      <div className="dsm-wb2api-actions-buttons" style={{ gridColumn: '1/-1' }}>
                        <button
                          type="button"
                          className="dsm-btn dsm-btn-outline"
                          disabled={tasksBusy}
                          onClick={() => { void runTasks() }}
                        >
                          {t('row.tasksAutoRunNow')}
                        </button>
                      </div>
                    </div>}
                </div>
              </section>

              {usage.status === 'error' ? <p className="dsm-wb2api-error">{usage.message}</p> : null}
              {actionError === undefined ? null : <p className="dsm-wb2api-error">{actionError}</p>}

              <div className="dsm-wb2api-actions">
                {saveError === undefined
                  ? null
                  : <span className="dsm-wb2api-save-error">{t('row.saveError', { message: saveError })}</span>}
                <div className="dsm-wb2api-actions-buttons">
                  <button
                    type="button"
                    className="dsm-btn dsm-btn-outline"
                    disabled={!dirty || saving}
                    onClick={discard}
                  >
                    {t('row.discard')}
                  </button>
                  <button
                    type="button"
                    className="dsm-btn dsm-btn-primary"
                    disabled={!dirty || saving || !writable}
                    onClick={() => { void saveAll() }}
                  >
                    {saving ? t('row.saving') : t('row.save')}
                  </button>
                </div>
              </div>
            </div>
          : null}
      </div>
    </li>
  )
}

/** Policy values used before the first usage document arrives. */
const FALLBACK_POLICY: WorkBuddyWebPoolPolicy = {
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
}
