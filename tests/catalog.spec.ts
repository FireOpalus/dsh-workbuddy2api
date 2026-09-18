/**
 * Runtime catalog derivation.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 用例对应其 catalog 测试：空选择等于全选、预算只压缩长上下文模型、
 *     目录不允许为空。
 * 改动：fallback 是双区域并集（本插件一个 provider 服务两个区域的账号）。
 */

import { describe, expect, it } from 'vitest'
import {
  applyContextBudgets,
  deriveCatalog,
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_WORKBUDDY_MODELS_GLOBAL,
  FALLBACK_WORKBUDDY_MODELS_UNION,
  WorkBuddyCatalog,
} from '../src/catalog.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

const models: WorkBuddyModelInfo[] = [
  { id: 'small', name: 'Small', contextWindow: 128_000, maxTokens: 8_000 },
  { id: 'large', name: 'Large', contextWindow: 1_000_000, maxTokens: 32_000 },
]

describe('fallback directory', () => {
  it('is the union of both regions, CN spellings first, without duplicates', () => {
    const ids = FALLBACK_WORKBUDDY_MODELS_UNION.map(model => model.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(FALLBACK_WORKBUDDY_MODELS_UNION.length)
      .toBeGreaterThanOrEqual(Math.max(FALLBACK_WORKBUDDY_MODELS.length, FALLBACK_WORKBUDDY_MODELS_GLOBAL.length))
    // A model only the CN roster carries, and one only the global roster does.
    expect(ids).toContain('deepseek-v4-pro')
    expect(ids).toContain('gpt-6-astra')
  })
})

describe('deriveCatalog', () => {
  it('serves the whole directory when nothing is selected', () => {
    expect(deriveCatalog(models, new Set()).map(model => model.id)).toEqual(['small', 'large'])
  })

  it('keeps only the selected ids', () => {
    expect(deriveCatalog(models, new Set(['large'])).map(model => model.id)).toEqual(['large'])
  })

  it('compresses only the models above the 200K default budget', () => {
    const applied = applyContextBudgets(models)
    expect(applied.find(model => model.id === 'small')?.contextWindow).toBe(128_000)
    expect(applied.find(model => model.id === 'large')?.contextWindow).toBe(200_000)
  })

  it('honours an explicit per-model budget and never widens a native window', () => {
    const applied = applyContextBudgets(models, { large: 500_000 })
    expect(applied.find(model => model.id === 'large')?.contextWindow).toBe(500_000)
    const wider = applyContextBudgets(models, { small: 900_000 })
    expect(wider.find(model => model.id === 'small')?.contextWindow).toBe(128_000)
  })
})

describe('WorkBuddyCatalog', () => {
  it('starts from the fallback and refuses to become empty', () => {
    const catalog = new WorkBuddyCatalog()
    expect(catalog.current().length).toBeGreaterThan(0)
    catalog.set(models)
    expect(catalog.current().map(model => model.id)).toEqual(['small', 'large'])
    expect(() => catalog.set([])).toThrow(/cannot be empty/)
  })

  it('copies the entries it is given', () => {
    const catalog = new WorkBuddyCatalog()
    const source: WorkBuddyModelInfo[] = [{ id: 'a', name: 'A', contextWindow: 1, maxTokens: 1 }]
    catalog.set(source)
    source[0]!.name = 'changed'
    expect(catalog.current()[0]?.name).toBe('A')
  })
})
