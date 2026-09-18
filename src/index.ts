/**
 * WorkBuddy models for DeepSeek Harness, backed by a multi-account pool.
 *
 * Registers ONE provider route — `workbuddy2api` — in front of a pool of
 * locally signed-in WorkBuddy accounts (domestic and international alike).
 * Every chat request is routed to a pooled account by the same scheduling
 * rules workbuddy2api uses server-side: session stickiness, weighted random
 * selection, per-account concurrency ceilings, and cooldown/breaker/degrade
 * health that reacts to what the upstream actually answered. Streaming, tool
 * calls, compaction, and permissions stay Harness-owned.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 宿主的装配顺序（先起 shim，拿到端口后才构造 provider，再注册 adapter
 *     与可配置 provider，最后异步刷新目录）、`installSettingsSection` 的用法、
 *     webServer 为可选服务（无头 profile 下宿主仍工作）的处理，
 *     以及配置 schema 的字段划分（lastCatalog 目录 + enabledModelIds 勾选
 *     分离）均来自该项目；其又源自 corrinehu/dsh-workbuddy-connect (MIT)
 *     与 dingminhua/dsh-connect-trae (MIT)。
 * 参考：Sliverkiss/workbuddy2api（MIT）— 账号池的调度语义与默认值。
 * 改动：单 provider + 账号池。原项目是「每个区域一个 provider、一个账号」，
 *   本插件把区域降级为账号属性，由 pool 在全部账号之间调度，
 *   因此多账号（含跨区域）可以同时被一个会话选中的模型使用。
 *
 * @module dsh-workbuddy2api
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WorkBuddyCredentialStore } from './auth.ts'
import { deriveCatalog, FALLBACK_WORKBUDDY_MODELS_UNION, WorkBuddyCatalog } from './catalog.ts'
import type { WorkBuddyContextBudget, WorkBuddyModelInfo } from './catalog.ts'
import {
  createWorkBuddyAdapter,
  workBuddyDisplayName,
  workBuddyModelInput,
  WORKBUDDY2API_PROVIDER,
  WORKBUDDY2API_PROVIDER_DISPLAY_NAME,
} from './adapter.ts'
import type { WorkBuddyAdapter } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import type { WorkBuddyShim } from './shim.ts'
import { DEFAULT_WORKBUDDY_POOL_POLICY, WorkBuddyAccountPool } from './pool.ts'
import type { WorkBuddyPoolPolicy, WorkBuddyPoolStateRecord } from './pool.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { registerWorkBuddy2ApiStatusRoute } from './web-status.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'

export {
  WORKBUDDY2API_PROVIDER,
  WORKBUDDY2API_PROVIDER_DISPLAY_NAME,
  WORKBUDDY2API_STREAM_IDLE_TIMEOUT_MS,
  createWorkBuddyAdapter,
  workBuddyDisplayName,
  workBuddyModelInput,
  workBuddyThinkingLevelMap,
  type WorkBuddyAdapter,
} from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
export {
  applyContextBudgets,
  deriveCatalog,
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_WORKBUDDY_MODELS_GLOBAL,
  FALLBACK_WORKBUDDY_MODELS_UNION,
  WorkBuddyCatalog,
  type WorkBuddyContextBudget,
  type WorkBuddyModelInfo,
} from './catalog.ts'
export {
  authFileName,
  defaultDesktopAuthCandidates,
  defaultDesktopAuthDirs,
  defaultDesktopAuthPath,
  expiryToMs,
  isFresher,
  parseWorkBuddyAuth,
  WORKBUDDY_AUTH_FILE_ENV,
  workbuddyAccountId,
  WorkBuddyCredentialStore,
  workbuddyOwnAuthPath,
  type WorkBuddyAccountChoice,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
  type WorkBuddyCredentialStoreOptions,
} from './auth.ts'
export {
  DEFAULT_WORKBUDDY_POOL_POLICY,
  nextDay4Am,
  stickyKeyOf,
  WorkBuddyAccountPool,
  type WorkBuddyDispatchOutcome,
  type WorkBuddyPickResult,
  type WorkBuddyPoolAccount,
  type WorkBuddyPoolEntry,
  type WorkBuddyPoolMissReason,
  type WorkBuddyPoolPolicy,
  type WorkBuddyPoolState,
  type WorkBuddyPoolStateRecord,
} from './pool.ts'
export {
  classifyUpstreamError,
  parseCreditMultiplier,
  parseReasoning,
  parseUpstreamModel,
  prepareChatBody,
  regionOf,
  selectCliModels,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
  type WorkBuddyCheckinClaim,
  type WorkBuddyCheckinStatus,
  type WorkBuddyCreditPackage,
  type WorkBuddyCredits,
  type WorkBuddyReasoning,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyRegion,
  type WorkBuddyUpstreamModel,
} from './upstream.ts'
export {
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  WORKBUDDY2API_HOST_HEARTBEAT_FILENAME,
  workbuddyHostHeartbeatPath,
  writeHostHeartbeat,
  type WorkBuddyHostHeartbeat,
} from './host-heartbeat.ts'
export { WORKBUDDY2API_VERSION } from './version.ts'
export {
  registerWorkBuddy2ApiStatusRoute,
  workBuddyWebStatus,
  type WorkBuddyStatusRouteOptions,
} from './web-status.ts'
export {
  toPersistedWorkBuddyModel,
  WORKBUDDY2API_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY2API_ACCOUNT_PARAM,
  WORKBUDDY2API_CHECKIN_PATH,
  WORKBUDDY2API_CREDITS_REFRESH_PATH,
  WORKBUDDY2API_MODELS_REFRESH_PATH,
  WORKBUDDY2API_POOL_ACTION_PATH,
  WORKBUDDY2API_USAGE_PATH,
  type WorkBuddyWebAccount,
  type WorkBuddyWebAccountCredits,
  type WorkBuddyWebCheckin,
  type WorkBuddyWebCredits,
  type WorkBuddyWebModel,
  type WorkBuddyWebPackage,
  type WorkBuddyWebPoolEntry,
  type WorkBuddyWebPoolPolicy,
  type WorkBuddyWebPoolState,
  type WorkBuddyWebUsage,
} from './status-paths.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-workbuddy2api'

/** The model registry and settings service required before the provider can register. */
export const inject = ['llm', 'settings']

/** Settings namespace for the plugin configuration card. */
export const WORKBUDDY2API_SETTINGS_NS = 'workbuddy2api' as SettingsNamespace

/** One persisted model entry; the settings codec rejects unknown keys. */
export interface WorkBuddyPersistedModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  creditMultiplier?: number
  reasoning?: {
    supportedEfforts?: readonly string[]
    defaultEffort?: string
    canDisableThinking?: boolean
  }
  descriptionZh?: string
  descriptionEn?: string
  supportsToolCall?: boolean
}

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
  /** The last-refreshed model directory; what the card displays. */
  lastCatalog?: WorkBuddyPersistedModel[]
  /** The user's model selection, as model ids. */
  enabledModelIds?: string[]
  /** Model ids the user explicitly opted into image input. */
  imageModelIds?: string[]
  /** Local DSH context budget per model id. */
  contextBudgets?: Record<string, number>
  /** Per-account pool switches, weights, and running cooldowns. */
  poolState?: WorkBuddyPoolStateRecord[]
  /** Health-policy overrides; absent fields take the plugin defaults. */
  pool?: Partial<WorkBuddyPoolPolicy>
}

const modelConfig = z.object({
  id: z.string().required(),
  name: z.string().required(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  creditMultiplier: z.number(),
  reasoning: z.object({
    supportedEfforts: z.array(z.string()).default([]),
    defaultEffort: z.string(),
    canDisableThinking: z.boolean(),
  }),
  descriptionZh: z.string(),
  descriptionEn: z.string(),
  supportsToolCall: z.boolean(),
})

const poolStateConfig = z.object({
  accountId: z.string().required(),
  enabled: z.boolean().default(true),
  weight: z.number().step(1).min(1).max(100).default(10),
  priority: z.number().step(1).default(100),
  cooldownUntil: z.number(),
  cooldownKind: z.union([z.const('soft'), z.const('hard')]),
  cooldownCount: z.number().step(1).min(0),
  breakerUntil: z.number(),
  degradedUntil: z.number(),
})

const poolPolicyConfig = z.object({
  maxInFlightPerAccount: z.number().step(1).min(0),
  maxInFlightGlobalPerAccount: z.number().step(1).min(0),
  maxInFlightTotal: z.number().step(1).min(0),
  softRateCooldownMs: z.number().step(1).min(0),
  softRateCooldownMaxMs: z.number().step(1).min(0),
  notFoundCooldownMs: z.number().step(1).min(0),
  breakerThreshold: z.number().step(1).min(1),
  breakerCooldownMs: z.number().step(1).min(0),
  breakerCooldownMaxMs: z.number().step(1).min(0),
  degradeThreshold: z.number().step(1).min(1),
  degradeCooldownMs: z.number().step(1).min(0),
  degradeCooldownMaxMs: z.number().step(1).min(0),
  stickyTtlMs: z.number().step(1).min(0),
  stickyGcIntervalMs: z.number().step(1).min(0),
  balanceAware: z.boolean(),
  idleWeightPerHour: z.number().min(0),
  idleWeightMax: z.number().min(0),
  expiringWeight: z.number().min(0),
  expiringSoonMs: z.number().step(1).min(0),
  minPickGapMs: z.number().step(1).min(0),
})

export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
  lastCatalog: z.array(modelConfig).default([]).description('Last-refreshed WorkBuddy model directory') as z<WorkBuddyPersistedModel[]>,
  enabledModelIds: z.array(z.string()).default([]).description('Enabled model ids; empty serves the whole directory'),
  imageModelIds: z.array(z.string()).default([]).description('Model ids opted into image input'),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description('Local DSH context budget by model id'),
  poolState: z.array(poolStateConfig).default([]).description('Per-account pool switches, weights, and cooldowns') as z<WorkBuddyPoolStateRecord[]>,
  pool: poolPolicyConfig.description('Account-pool health policy overrides'),
})

/** The persisted model directory in the shape the runtime catalog needs. */
function toModelInfo(model: WorkBuddyPersistedModel): WorkBuddyModelInfo {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...model.creditMultiplier === undefined ? {} : { creditMultiplier: model.creditMultiplier },
    ...model.reasoning === undefined ? {} : {
      reasoning: {
        ...model.reasoning.supportedEfforts === undefined || model.reasoning.supportedEfforts.length === 0
          ? {}
          : { supportedEfforts: [...model.reasoning.supportedEfforts] },
        ...model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
        ...model.reasoning.canDisableThinking === undefined ? {} : { canDisableThinking: model.reasoning.canDisableThinking },
      },
    },
    ...model.descriptionZh === undefined ? {} : { descriptionZh: model.descriptionZh },
    ...model.descriptionEn === undefined ? {} : { descriptionEn: model.descriptionEn },
    ...model.supportsToolCall === undefined ? {} : { supportsToolCall: model.supportsToolCall },
  }
}

/** The persisted pool policy over the defaults, dropping unknown values. */
export function resolvePolicy(configured: Partial<WorkBuddyPoolPolicy> | undefined): WorkBuddyPoolPolicy {
  const policy = { ...DEFAULT_WORKBUDDY_POOL_POLICY }
  if (configured === undefined) return policy
  for (const [key, value] of Object.entries(configured) as [keyof WorkBuddyPoolPolicy, unknown][]) {
    if (value === undefined || value === null) continue
    if (typeof policy[key] === 'boolean') {
      if (typeof value === 'boolean') (policy[key] as boolean) = value
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) (policy[key] as number) = value
  }
  // A ceiling below its base would make every cooldown collapse to the ceiling.
  if (policy.softRateCooldownMaxMs > 0 && policy.softRateCooldownMs > policy.softRateCooldownMaxMs) {
    policy.softRateCooldownMs = policy.softRateCooldownMaxMs
  }
  if (policy.breakerCooldownMaxMs > 0 && policy.breakerCooldownMs > policy.breakerCooldownMaxMs) {
    policy.breakerCooldownMs = policy.breakerCooldownMaxMs
  }
  if (policy.degradeCooldownMaxMs > 0 && policy.degradeCooldownMs > policy.degradeCooldownMaxMs) {
    policy.degradeCooldownMs = policy.degradeCooldownMaxMs
  }
  return policy
}

/**
 * Wire the pool, the loopback shim, and the single provider route.
 *
 * Ordering is load-bearing: the shim must hold its ephemeral port before the
 * provider is constructed, because every model's `baseUrl` is read from the
 * shim origin at construction time.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyUpstreamClient()

  const store = new WorkBuddyCredentialStore({
    ...config.authFile === undefined ? {} : { desktopPath: config.authFile },
    refresh: credential => client.refreshToken(credential),
  })
  const catalog = new WorkBuddyCatalog()
  const pool = new WorkBuddyAccountPool({
    list: () => store.accounts(),
    ...config.poolState === undefined ? {} : { state: config.poolState },
    policy: resolvePolicy(config.pool),
  })
  const shim = createWorkBuddyShim({ store, pool, client, catalog, logger: ctx.logger })

  // Stamp the user's explicit image opt-in onto a model list. This is the ONLY
  // source of `multimodal`; upstream capability flags are never trusted.
  const withImageSelection = (
    models: readonly WorkBuddyModelInfo[],
    images: ReadonlySet<string>,
  ): readonly WorkBuddyModelInfo[] =>
    models.map(model => ({
      ...model,
      ...images.has(model.id) ? { multimodal: true } : { multimodal: false },
    }))

  /** The runtime catalog: last-refreshed directory filtered by the selection. */
  const configuredModels = (value: Config): readonly WorkBuddyModelInfo[] => {
    const directory = value.lastCatalog?.length
      ? value.lastCatalog.map(toModelInfo)
      : FALLBACK_WORKBUDDY_MODELS_UNION
    return withImageSelection(
      deriveCatalog(directory, new Set(value.enabledModelIds ?? []), value.contextBudgets ?? {}),
      new Set(value.imageModelIds ?? []),
    )
  }
  /** What the card displays: the last-refreshed directory, unfiltered. */
  const displayModels = (value: Config): readonly WorkBuddyModelInfo[] =>
    value.lastCatalog?.length ? value.lastCatalog.map(toModelInfo) : FALLBACK_WORKBUDDY_MODELS_UNION

  let current = () => config
  let invalidateCatalog = (): void => {}

  const discoverModels = async (signal?: AbortSignal): Promise<readonly WorkBuddyModelInfo[]> => {
    await pool.refresh()
    const ids = pool.snapshot().filter(entry => entry.present).map(entry => entry.accountId)
    const credentials = await store.byIds(ids)
    return client.fetchModelsForCredentials(credentials, signal)
  }

  /** Push the current config into the pool selection and the runtime catalog. */
  const applySelection = (value: Config): void => {
    store.setDesktopPath(value.authFile)
    pool.configure((value.poolState ?? []).map(record => ({
      accountId: record.accountId,
      enabled: record.enabled,
      weight: record.weight,
      priority: record.priority,
    })))
    pool.setPolicy(resolvePolicy(value.pool))
    try {
      catalog.set(configuredModels(value))
    } catch (error: unknown) {
      ctx.logger.warn('dsh-workbuddy2api: runtime catalog rejected; keeping the previous directory', error)
    }
    invalidateCatalog()
  }

  // Same-origin routes backing the Plugin-configuration card. `webServer` can
  // mount after this row, so wait reactively for it instead of sampling
  // ctx.get() once during apply (which silently loses all routes on Desktop).
  ctx.inject(['webServer'], (webCtx) => registerWorkBuddy2ApiStatusRoute(webCtx, {
    store,
    pool,
    client,
    displayModels: () => displayModels(current()),
    enabledModelIds: () => current().enabledModelIds ?? [],
    imageModelIds: () => current().imageModelIds ?? [],
    contextBudgets: () => current().contextBudgets ?? {},
    poolState: () => pool.toPersisted(),
    policy: () => pool.currentPolicy(),
    discoverModels,
    refreshCredits: async accountId => {
      const credential = await store.resolve(accountId)
      const credits = await client.fetchCredits(credential)
      pool.setCredits(accountId, { total: credits.total, expiringSoon: credits.expiringSoon })
      return credits
    },
  }))

  ctx.settings.installSection(ctx, WORKBUDDY2API_SETTINGS_NS, Config, config, {
    setSource(source: () => Config) { current = source },
    onChange() { applySelection(current()) },
  })

  // Initial wiring: selections and the runtime catalog from the saved state.
  applySelection(config)

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    pool.dispose()
    void shim.close()
    void clearHostHeartbeat()
  })

  void shim.ready
    .then(async () => {
      if (stopped) return
      let adapter: WorkBuddyAdapter
      let releaseAdapter: (() => void) | undefined
      let releaseDirectory: (() => void) | undefined
      try {
        // Constructed only once the listener holds its port: a provider's
        // models read the shim origin at construction time.
        adapter = createWorkBuddyAdapter({
          shim,
          catalog,
          resolveAttachments: () => ctx.get('attachments'),
        })
        invalidateCatalog = () => { adapter.invalidate() }
        try {
          releaseAdapter = ctx.llm.registerAdapter([WORKBUDDY2API_PROVIDER], adapter.adapter)
          releaseDirectory = ctx.llm.registerConfigurableProviders([{
            provider: WORKBUDDY2API_PROVIDER,
            displayName: WORKBUDDY2API_PROVIDER_DISPLAY_NAME,
            settingsNs: WORKBUDDY2API_SETTINGS_NS,
            settingsPath: [],
            declared: false,
          }])
        } finally {
          if (releaseAdapter === undefined || releaseDirectory === undefined) {
            // Registration threw; release whichever half landed.
            releaseAdapter?.()
            releaseDirectory?.()
          }
        }
        try {
          ctx.effect(() => () => {
            releaseAdapter?.()
            releaseDirectory?.()
          })
        } catch {
          // The plugin was disposed during registration; release immediately —
          // the plugin-level disposer already closed the shim.
          releaseAdapter?.()
          releaseDirectory?.()
        }

        ctx.llm.registerModelDiscovery(WORKBUDDY2API_SETTINGS_NS, async (request, signal) => {
          if (request.provider !== undefined && request.provider !== WORKBUDDY2API_PROVIDER) return []
          const discovered = await discoverModels(signal)
          const value = current()
          return withImageSelection(
            deriveCatalog(discovered, new Set(value.enabledModelIds ?? []), value.contextBudgets ?? {}),
            new Set(value.imageModelIds ?? []),
          ).map(model => ({
            id: model.id,
            name: workBuddyDisplayName(model),
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            inputModalities: workBuddyModelInput(model),
          }))
        })
      } catch (error: unknown) {
        ctx.logger.error('dsh-workbuddy2api: provider registration failed', error)
        return
      }

      // The host bundle is live: write a heartbeat so the status CLI can report
      // host health without a browser. Cleared on disposal; a stale heartbeat
      // after a crash is detected by PID in the reader.
      void (async () => {
        try {
          await pool.refresh()
        } catch (error: unknown) {
          ctx.logger.warn('dsh-workbuddy2api: account scan failed at startup', error)
        }
        void writeHostHeartbeat(pool.snapshot().length)
      })()

      // Seed the catalog from every pooled account. `lastCatalog` is
      // deliberately NOT written here: it belongs to the user's saved
      // selection, written only by the card's explicit save.
      if (stopped) return
      void (async () => {
        try {
          const models = await discoverModels()
          if (stopped) return
          const value = current()
          catalog.set(withImageSelection(
            deriveCatalog(models, new Set(value.enabledModelIds ?? []), value.contextBudgets ?? {}),
            new Set(value.imageModelIds ?? []),
          ))
          adapter.invalidate()
        } catch (error: unknown) {
          ctx.logger.warn(
            'dsh-workbuddy2api: dynamic model catalog unavailable; serving the static fallback list',
            error,
          )
        }
      })()
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-workbuddy2api: loopback endpoint failed to start; provider not registered', error)
    })
}
