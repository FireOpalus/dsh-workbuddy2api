/**
 * WorkBuddy models for DeepSeek Harness, backed by TWO independent account
 * pools — one per region.
 *
 * Registers two provider routes: `workbuddy2api` (domestic accounts) and
 * `workbuddy2api-global` (international accounts). Each route owns its own
 * credential store view, account pool, model catalog, and loopback shim, so the
 * two sides serve simultaneously and neither can see or disturb the other.
 *
 * Why two providers rather than one merged pool: the upstream reuses model ids
 * across regions for models billed DIFFERENTLY — `deepseek-v4.1-flash` is the
 * free x0.00 promotional model on the international gateway and a paid x0.03
 * model on the domestic one. A single merged catalog therefore reported one
 * region's rate and hid the other's, and the routed account (hence the real
 * charge) depended on the pick rather than on what the user selected. Separate
 * pools make the selected provider the authoritative answer for both rate and
 * routing.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 宿主的装配顺序（先起 shim，拿到端口后才构造 provider，再注册 adapter
 *     与可配置 provider，最后异步刷新目录）、`installSettingsSection` 的用法、
 *     webServer 为可选服务（无头 profile 下宿主仍工作）的处理，以及
 *     「每区域一套 store / catalog / shim」的双 provider 结构均来自该项目
 *     （其又源自 corrinehu/dsh-workbuddy-connect (MIT) 与
 *     dingminhua/dsh-connect-trae (MIT)）。
 * 参考：Sliverkiss/workbuddy2api（MIT）— 账号池的调度语义与默认值。
 * 改动：账号池化。原项目每区域只有一个「当前选中的账号」，本插件在
 *   每个区域内部维护一个多账号池（加权轮换、会话粘性、冷却熔断降权、
 *   换号重试），区域之间则完全隔离。
 *
 * @module dsh-workbuddy2api
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WorkBuddyCredentialStore } from './auth.ts'
import { deriveCatalog, fallbackModelsFor, WorkBuddyCatalog } from './catalog.ts'
import type { WorkBuddyContextBudget, WorkBuddyModelInfo } from './catalog.ts'
import {
  createWorkBuddyAdapter,
  regionOfProvider,
  workBuddyDisplayName,
  workBuddyModelInput,
  WORKBUDDY2API_PROVIDER,
  WORKBUDDY2API_PROVIDER_DISPLAY_NAMES,
  WORKBUDDY2API_PROVIDERS,
} from './adapter.ts'
import type { WorkBuddyAdapter } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import type { WorkBuddyShim } from './shim.ts'
import { DEFAULT_WORKBUDDY_POOL_POLICY, WorkBuddyAccountPool } from './pool.ts'
import type { WorkBuddyPoolPolicy, WorkBuddyPoolStateRecord, WorkBuddyPoolTuning } from './pool.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import { registerWorkBuddy2ApiStatusRoute } from './web-status.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'

export {
  createWorkBuddyAdapter,
  regionOfProvider,
  workBuddyDisplayName,
  workBuddyModelInput,
  workBuddyThinkingLevelMap,
  WORKBUDDY2API_GLOBAL_PROVIDER,
  WORKBUDDY2API_PROVIDER,
  WORKBUDDY2API_PROVIDER_DISPLAY_NAME,
  WORKBUDDY2API_PROVIDER_DISPLAY_NAMES,
  WORKBUDDY2API_PROVIDERS,
  WORKBUDDY2API_STREAM_IDLE_TIMEOUT_MS,
  type WorkBuddyAdapter,
} from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
export {
  applyContextBudgets,
  deriveCatalog,
  fallbackModelsFor,
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_WORKBUDDY_MODELS_GLOBAL,
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
  type WorkBuddyPoolTuning,
  type WorkBuddyPoolState,
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
  regionOfStatusUrl,
  toPersistedWorkBuddyModel,
  withWorkBuddyRegion,
  WORKBUDDY2API_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY2API_ACCOUNT_PARAM,
  WORKBUDDY2API_CHECKIN_PATH,
  WORKBUDDY2API_CREDITS_REFRESH_PATH,
  WORKBUDDY2API_MODELS_REFRESH_PATH,
  WORKBUDDY2API_POOL_ACTION_PATH,
  WORKBUDDY2API_REGION_PARAM,
  WORKBUDDY2API_REGIONS,
  WORKBUDDY2API_USAGE_PATH,
  type WorkBuddyPoolPolicy,
  type WorkBuddyPoolStateRecord,
  type WorkBuddyWebAccount,
  type WorkBuddyWebAccountCredits,
  type WorkBuddyWebCheckin,
  type WorkBuddyWebCredits,
  type WorkBuddyWebModel,
  type WorkBuddyWebPackage,
  type WorkBuddyWebPoolEntry,
  type WorkBuddyWebPoolPolicy,
  type WorkBuddyWebPoolState,
  type WorkBuddyWebRegion,
  type WorkBuddyWebUsage,
} from './status-paths.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-workbuddy2api'

/** The model registry and settings service required before providers can register. */
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

/** One region's model directory and the user's selection within it. */
export interface WorkBuddyRegionState {
  /** The last-refreshed directory for this region; what the card displays. */
  lastCatalog?: WorkBuddyPersistedModel[]
  /** The user's selection in this region, as model ids. */
  enabledModelIds?: string[]
  /** Model ids the user explicitly opted into image input. */
  imageModelIds?: string[]
  /** Local DSH context budget per model id, for this region. */
  contextBudgets?: Record<string, number>
  /** Per-account pool switches, weights, and running cooldowns. */
  poolState?: WorkBuddyPoolStateRecord[]
  /** Health-policy overrides for this region's pool. */
  pool?: Partial<WorkBuddyPoolTuning>
}

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
  /**
   * Per-region state, keyed `cn` | `global`. Each region's provider, pool,
   * catalog, and card tab read and write ONLY their own slot, so changing
   * anything on one side never touches the other.
   */
  regions?: Partial<Record<WorkBuddyRegion, WorkBuddyRegionState>>
  /** @deprecated 0.1.x merged directory. Accepted so old settings still load; never read. */
  lastCatalog?: WorkBuddyPersistedModel[]
  /** @deprecated See {@link Config.lastCatalog}. */
  enabledModelIds?: string[]
  /** @deprecated See {@link Config.lastCatalog}. */
  imageModelIds?: string[]
  /** @deprecated See {@link Config.lastCatalog}. */
  contextBudgets?: Record<string, number>
  /** @deprecated See {@link Config.lastCatalog}. */
  poolState?: WorkBuddyPoolStateRecord[]
  /** @deprecated See {@link Config.lastCatalog}. */
  pool?: Partial<WorkBuddyPoolTuning>
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

const regionStateConfig = z.object({
  lastCatalog: z.array(modelConfig).default([]),
  enabledModelIds: z.array(z.string()).default([]),
  imageModelIds: z.array(z.string()).default([]),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}),
  poolState: z.array(poolStateConfig).default([]),
  pool: poolPolicyConfig.description('Account-pool health policy overrides for this region'),
})

/**
 * The plugin configuration schema.
 *
 * The shape is asserted once at the export boundary rather than per field: a
 * cast inside an object literal cannot carry a nested generic such as
 * `z<Partial<Record<Region, State>>>` — the parser loses the expression context
 * at the closing brackets — so the single outer assertion is both the portable
 * form and the one place a reader has to check.
 */
export const Config: z<Config> = z.object({
  authFile: z.string().description(`WorkBuddy desktop auth file (defaults to the app's own location)`),
  regions: z.dict(regionStateConfig).default({})
    .description('Per-region model directory, selection, and pool state, keyed cn | global'),
  // 0.1.x wrote these at the TOP level, when both regions shared one pool and one
  // merged directory. They stay DECLARED so an existing settings file keeps
  // loading instead of failing validation, but nothing reads them: a merged
  // directory cannot be split back into per-region rosters (it recorded whichever
  // region happened to write a shared model id first), so trusting a stale
  // selection would be worse than starting empty. Re-refresh each tab instead.
  lastCatalog: z.array(modelConfig).default([]).description('Deprecated 0.1.x: merged model directory (ignored)'),
  enabledModelIds: z.array(z.string()).default([]).description('Deprecated 0.1.x: merged selection (ignored)'),
  imageModelIds: z.array(z.string()).default([]).description('Deprecated 0.1.x: merged image opt-in (ignored)'),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description('Deprecated 0.1.x: merged budgets (ignored)'),
  poolState: z.array(poolStateConfig).default([]).description('Deprecated 0.1.x: single-pool state (ignored)'),
  pool: poolPolicyConfig.description('Deprecated 0.1.x: single-pool policy (ignored)'),
}) as unknown as z<Config>

/** Every region, in card tab order. */
export const REGION_KEYS: readonly WorkBuddyRegion[] = ['cn', 'global']

/** One region's saved state, or an empty state when it was never configured. */
export function regionStateOf(config: Config, region: WorkBuddyRegion): WorkBuddyRegionState {
  return config.regions?.[region] ?? {}
}

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

/** One region's persisted policy over the defaults, dropping unknown values. */
export function resolvePolicy(configured: Partial<WorkBuddyPoolTuning> | undefined): WorkBuddyPoolTuning {
  const policy: WorkBuddyPoolTuning = { ...DEFAULT_WORKBUDDY_POOL_POLICY }
  if (configured !== undefined) {
    for (const [key, value] of Object.entries(configured) as [keyof WorkBuddyPoolTuning, unknown][]) {
      if (value === undefined || value === null) continue
      if (typeof policy[key] === 'boolean') {
        if (typeof value === 'boolean') (policy[key] as boolean) = value
        continue
      }
      if (typeof value === 'number' && Number.isFinite(value)) (policy[key] as number) = value
    }
  }
  // A ceiling below its base would collapse every cooldown to the ceiling.
  if (policy.softRateCooldownMaxMs > 0 && policy.softRateCooldownMs > policy.softRateCooldownMaxMs) {
    policy.softRateCooldownMs = policy.softRateCooldownMaxMs
  }
  if (policy.breakerCooldownMaxMs > 0 && policy.breakerCooldownMs > policy.breakerCooldownMaxMs) {
    policy.breakerCooldownMs = policy.breakerCooldownMaxMs
  }
  if (policy.degradeCooldownMaxMs > 0 && policy.degradeCooldownMs > policy.degradeCooldownMaxMs) {
    policy.degradeCooldownMs = policy.degradeCooldownMaxMs
  }
  // The international gateway enforces a visibly tighter WAF, so its pool keeps
  // the stricter per-account ceiling unless the user overrode it explicitly.
  return policy
}

/**
 * One region's complete runtime stack. The two regions are fully parallel
 * provider stacks — separate credential views, account pools, catalogs, and
 * loopback shims — so the domestic and international sides serve simultaneously
 * and a change on one side never touches the other.
 */
interface WorkBuddyRegionStack {
  store: WorkBuddyCredentialStore
  pool: WorkBuddyAccountPool
  catalog: WorkBuddyCatalog
  shim: WorkBuddyShim
}

/**
 * Start both regions' loopback endpoints, register the `workbuddy2api` (CN) and
 * `workbuddy2api-global` (international) providers, and refresh each region's
 * model catalog from its own accounts. Each region's static fallback catalog
 * serves from the first moment, so an offline upstream never leaves a provider
 * empty.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyUpstreamClient()

  const stacks = {} as Record<WorkBuddyRegion, WorkBuddyRegionStack>
  for (const region of REGION_KEYS) {
    const store = new WorkBuddyCredentialStore({
      region,
      ...config.authFile === undefined ? {} : { desktopPath: config.authFile },
      refresh: credential => client.refreshToken(credential),
    })
    const catalog = new WorkBuddyCatalog(region)
    const pool = new WorkBuddyAccountPool({
      list: () => store.accounts(),
      ...regionStateOf(config, region).poolState === undefined ? {} : { state: regionStateOf(config, region).poolState },
      policy: resolvePolicy(regionStateOf(config, region).pool),
    })
    const shim = createWorkBuddyShim({ store, pool, client, catalog, logger: ctx.logger })
    stacks[region] = { store, pool, catalog, shim }
  }

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

  /**
   * The runtime catalog for one region: that region's last-refreshed directory,
   * filtered by that region's selection. A region that was never refreshed falls
   * back to ITS OWN static roster — never the other region's.
   */
  const configuredModels = (value: Config, region: WorkBuddyRegion): readonly WorkBuddyModelInfo[] => {
    const state = regionStateOf(value, region)
    return withImageSelection(
      deriveCatalog(
        state.lastCatalog?.length ? state.lastCatalog.map(toModelInfo) : fallbackModelsFor(region),
        new Set(state.enabledModelIds ?? []),
        state.contextBudgets ?? {},
      ),
      new Set(state.imageModelIds ?? []),
    )
  }

  /** What one region's card displays: its last-refreshed directory, unfiltered. */
  const displayModels = (value: Config, region: WorkBuddyRegion): readonly WorkBuddyModelInfo[] => {
    const state = regionStateOf(value, region)
    return state.lastCatalog?.length ? state.lastCatalog.map(toModelInfo) : fallbackModelsFor(region)
  }

  let current = () => config
  let invalidateCatalog = (): void => {}

  /** Read one region's live directory from that region's own accounts. */
  const discoverModels = async (
    region: WorkBuddyRegion,
    signal?: AbortSignal,
  ): Promise<readonly WorkBuddyModelInfo[]> => {
    const stack = stacks[region]
    await stack.pool.refresh()
    const ids = stack.pool.snapshot().filter(entry => entry.present).map(entry => entry.accountId)
    const credentials = await stack.store.byIds(ids)
    return client.fetchModelsForCredentials(credentials, signal)
  }

  /** Push the current config into every region's pool selection and catalog. */
  const applySelection = (value: Config): void => {
    for (const region of REGION_KEYS) {
      const stack = stacks[region]
      const state = regionStateOf(value, region)
      stack.store.setDesktopPath(value.authFile)
      stack.pool.configure((state.poolState ?? []).map(record => ({
        accountId: record.accountId,
        enabled: record.enabled,
        weight: record.weight,
        priority: record.priority,
      })))
      stack.pool.setPolicy(resolvePolicy(state.pool))
      try {
        stack.catalog.set(configuredModels(value, region))
      } catch (error: unknown) {
        ctx.logger.warn(`dsh-workbuddy2api: ${region} runtime catalog rejected; keeping the previous directory`, error)
      }
    }
    invalidateCatalog()
  }

  // Same-origin routes backing the Plugin-configuration card. `webServer` can
  // mount after this row, so wait reactively for it instead of sampling
  // ctx.get() once during apply (which silently loses all routes on Desktop).
  // Every route is region-parameterized, so one tab can only ever read and write
  // that region's pool, credits, and model slot.
  ctx.inject(['webServer'], (webCtx) => registerWorkBuddy2ApiStatusRoute(webCtx, {
    store: region => stacks[region].store,
    pool: region => stacks[region].pool,
    client,
    displayModels: region => displayModels(current(), region),
    enabledModelIds: region => regionStateOf(current(), region).enabledModelIds ?? [],
    imageModelIds: region => regionStateOf(current(), region).imageModelIds ?? [],
    contextBudgets: region => regionStateOf(current(), region).contextBudgets ?? {},
    poolState: region => stacks[region].pool.toPersisted(),
    policy: region => stacks[region].pool.currentPolicy(),
    discoverModels,
    refreshCredits: async (region, accountId) => {
      const credential = await stacks[region].store.resolve(accountId)
      const credits = await client.fetchCredits(credential)
      stacks[region].pool.setCredits(accountId, { total: credits.total, expiringSoon: credits.expiringSoon })
      return credits
    },
  }))

  ctx.settings.installSection(ctx, WORKBUDDY2API_SETTINGS_NS, Config, config, {
    setSource(source: () => Config) { current = source },
    onChange() { applySelection(current()) },
  })

  // Initial wiring: selections and each region's catalog from its saved state.
  applySelection(config)

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    for (const region of REGION_KEYS) {
      stacks[region].pool.dispose()
      void stacks[region].shim.close()
    }
    void clearHostHeartbeat()
  })

  void Promise.all(REGION_KEYS.map(region => stacks[region].shim.ready))
    .then(async () => {
      if (stopped) return

      const adapters = {} as Record<WorkBuddyRegion, WorkBuddyAdapter>
      const releases: (() => void)[] = []
      try {
        // Constructed only once the listeners hold their ports: a provider's
        // models read the shim origin at construction time.
        for (const region of REGION_KEYS) {
          adapters[region] = createWorkBuddyAdapter({
            shim: stacks[region].shim,
            catalog: stacks[region].catalog,
            region,
            resolveAttachments: () => ctx.get('attachments'),
          })
        }
        invalidateCatalog = () => {
          for (const region of REGION_KEYS) adapters[region].invalidate()
        }
        try {
          for (const region of REGION_KEYS) {
            releases.push(ctx.llm.registerAdapter([WORKBUDDY2API_PROVIDERS[region]], adapters[region].adapter))
          }
          releases.push(ctx.llm.registerConfigurableProviders(REGION_KEYS.map(region => ({
            provider: WORKBUDDY2API_PROVIDERS[region],
            displayName: WORKBUDDY2API_PROVIDER_DISPLAY_NAMES[region],
            settingsNs: WORKBUDDY2API_SETTINGS_NS,
            settingsPath: [],
            declared: false,
          }))))
        } catch (error: unknown) {
          // Registration threw part-way; release whatever landed so no provider
          // is left half-registered.
          for (const release of releases.splice(0)) release()
          throw error
        }
        const landed = [...releases]
        try {
          ctx.effect(() => () => {
            for (const release of landed) release()
          })
        } catch {
          // The plugin was disposed during registration; release immediately —
          // the plugin-level disposer already closed the shims.
          for (const release of landed) release()
        }

        ctx.llm.registerModelDiscovery(WORKBUDDY2API_SETTINGS_NS, async (request, signal) => {
          const region = regionOfProvider(request.provider ?? WORKBUDDY2API_PROVIDER)
          if (region === undefined) return []
          const discovered = await discoverModels(region, signal)
          const value = current()
          const state = regionStateOf(value, region)
          return withImageSelection(
            deriveCatalog(discovered, new Set(state.enabledModelIds ?? []), state.contextBudgets ?? {}),
            new Set(state.imageModelIds ?? []),
          ).map(model => ({
            id: model.id,
            name: workBuddyDisplayName(model),
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            inputModalities: workBuddyModelInput(model),
          }))
        })
      } catch (error: unknown) {
        for (const release of releases) release()
        ctx.logger.error('dsh-workbuddy2api: provider registration failed', error)
        return
      }

      // The host bundle is live: write a heartbeat so the status CLI can report
      // host health without a browser. Cleared on disposal; a stale heartbeat
      // after a crash is detected by PID in the reader.
      void (async () => {
        let accounts = 0
        for (const region of REGION_KEYS) {
          try {
            await stacks[region].pool.refresh()
            accounts += stacks[region].pool.snapshot().length
          } catch (error: unknown) {
            ctx.logger.warn(`dsh-workbuddy2api: ${region} account scan failed at startup`, error)
          }
        }
        void writeHostHeartbeat(accounts)
      })()

      // Seed each region's catalog from that region's own accounts.
      // `lastCatalog` is deliberately NOT written here: it belongs to the user's
      // saved selection, written only by the card's explicit save.
      for (const region of REGION_KEYS) {
        void (async () => {
          try {
            const models = await discoverModels(region)
            if (stopped) return
            const state = regionStateOf(current(), region)
            stacks[region].catalog.set(withImageSelection(
              deriveCatalog(models, new Set(state.enabledModelIds ?? []), state.contextBudgets ?? {}),
              new Set(state.imageModelIds ?? []),
            ))
            adapters[region].invalidate()
          } catch (error: unknown) {
            ctx.logger.warn(
              `dsh-workbuddy2api: dynamic ${region} model catalog unavailable; serving the static fallback list`,
              error,
            )
          }
        })()
      }
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-workbuddy2api: loopback endpoint failed to start; providers not registered', error)
    })
}
