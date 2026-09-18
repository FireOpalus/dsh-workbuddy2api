/**
 * WorkBuddy model catalog: a static fallback list, replaced by the upstream's
 * dynamic catalog once it loads, and filtered by the user's explicit selection.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 「上次刷新的完整目录（lastCatalog）与用户勾选分离，运行时目录由两者
 *     推导」的模型来自该项目（其又源自 dsh-connect-trae）。
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — 静态 fallback 目录，上游不可用时 provider 不为空。
 * 改动：目录只有一份（本插件不做双区域 provider 拆分，区域只是账号属性），
 *   因此 fallback 取「国内版 + 国际版」的并集并按 id 去重：账号池里
 *   两个区域的账号会同时供模型，任何单一区域的 fallback 都会让另一区域
 *   的账号在首次刷新前看不到自己的模型。
 *
 * @module dsh-workbuddy2api/catalog
 */

import type { WorkBuddyUpstreamModel } from './upstream.ts'

/** One model entry the adapter exposes. */
export type WorkBuddyModelInfo = WorkBuddyUpstreamModel

/** Local DSH context budget for one model id. */
export type WorkBuddyContextBudget = number

/**
 * Static CLI models captured from the CN endpoint (2026-08-30). The upstream
 * refresh replaces this list at startup; it exists so the provider registers
 * with a usable catalog even while the first fetch is in flight or offline.
 */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'auto', name: 'Auto', contextWindow: 168_000, maxTokens: 32_000 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxTokens: 64_000 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 48_000 },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, maxTokens: 128_000 },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000 },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256_000, maxTokens: 32_000 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000 },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, maxTokens: 50_000 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 50_000 },
]

/**
 * Static CLI models captured from the INTERNATIONAL gateway's desktop-channel
 * product config (`www.workbuddy.ai/v3/config`, 2026-09-11).
 */
export const FALLBACK_WORKBUDDY_MODELS_GLOBAL: readonly WorkBuddyModelInfo[] = [
  { id: 'default-model', name: 'Auto', contextWindow: 176_000, maxTokens: 24_000, creditMultiplier: 0.79 },
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, maxTokens: 32_000, creditMultiplier: 0.34 },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, maxTokens: 32_000, creditMultiplier: 0.59 },
  { id: 'primary-model', name: 'Primary', contextWindow: 272_000, maxTokens: 72_000, creditMultiplier: 3.31 },
  { id: 'deep-model', name: 'Deep', contextWindow: 176_000, maxTokens: 24_000, creditMultiplier: 3.33 },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 0 },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 6.67 },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000, creditMultiplier: 0 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 3.47 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 1.39 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 0.14 },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 3.31 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, maxTokens: 72_000, creditMultiplier: 1.65 },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272_000, maxTokens: 72_000, creditMultiplier: 1.25 },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1_000_000, maxTokens: 65_536, creditMultiplier: 0.99 },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, creditMultiplier: 1.62 },
]

/**
 * The union of both regions' fallbacks, CN entries first and duplicates
 * resolved in favour of the CN spelling (its context/output numbers are the
 * ones the CN gateway serves). The union matters because ONE provider now
 * serves every pooled account: seeding it with a single region's roster would
 * hide the other region's models until the first live refresh lands.
 */
export const FALLBACK_WORKBUDDY_MODELS_UNION: readonly WorkBuddyModelInfo[] = (() => {
  const byId = new Map<string, WorkBuddyModelInfo>()
  for (const model of [...FALLBACK_WORKBUDDY_MODELS, ...FALLBACK_WORKBUDDY_MODELS_GLOBAL]) {
    if (!byId.has(model.id)) byId.set(model.id, model)
  }
  return [...byId.values()]
})()

/** Apply the saved local DSH budget; models above 200K default to 200K. */
export function applyContextBudgets(
  catalog: readonly WorkBuddyModelInfo[],
  budgets: Readonly<Record<string, WorkBuddyContextBudget | undefined>> = {},
): WorkBuddyModelInfo[] {
  return catalog.map(model => ({
    ...model,
    contextWindow: model.contextWindow > 200_000
      ? Math.min(model.contextWindow, budgets[model.id] ?? 200_000)
      : model.contextWindow,
  }))
}

/**
 * Derive the runtime catalog from the last-refreshed directory plus the user's
 * selection. An empty selection falls back to the whole directory: a plugin
 * that has never been configured must still serve models rather than nothing.
 */
export function deriveCatalog(
  catalog: readonly WorkBuddyModelInfo[],
  enabled: ReadonlySet<string>,
  budgets: Readonly<Record<string, WorkBuddyContextBudget | undefined>> = {},
): WorkBuddyModelInfo[] {
  const selected = enabled.size === 0 ? catalog : catalog.filter(model => enabled.has(model.id))
  return applyContextBudgets(selected, budgets)
}

/** Mutable catalog shared by the shim's `/v1/models` and the adapter. */
export class WorkBuddyCatalog {
  private models: readonly WorkBuddyModelInfo[]

  constructor(seed: readonly WorkBuddyModelInfo[] = FALLBACK_WORKBUDDY_MODELS_UNION) {
    this.models = seed
  }

  /** Current entries; the fallback list until the upstream answer lands. */
  current(): readonly WorkBuddyModelInfo[] {
    return this.models
  }

  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly WorkBuddyModelInfo[]): void {
    if (models.length === 0) throw new Error('workbuddy model catalog cannot be empty')
    this.models = models.map(model => ({ ...model }))
  }
}
