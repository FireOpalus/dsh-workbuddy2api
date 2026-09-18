/**
 * Runtime catalog derivation, per region.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 用例对应其 catalog 测试：空选择等于全选、预算只压缩长上下文模型、
 *     目录不允许为空。
 * 改动：区域拆分后，重点用例变成「一个区域的目录里绝不会出现另一个区域的
 *   名单」——这正是 0.1.x 合并目录造成 `deepseek-v4.1-flash` 倍率被覆盖的
 *   那个 bug 的回归防线。
 */

import { describe, expect, it } from 'vitest'
import {
  applyContextBudgets,
  deriveCatalog,
  fallbackModelsFor,
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_WORKBUDDY_MODELS_GLOBAL,
  WorkBuddyCatalog,
} from '../src/catalog.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

const models: WorkBuddyModelInfo[] = [
  { id: 'small', name: 'Small', contextWindow: 128_000, maxTokens: 8_000 },
  { id: 'large', name: 'Large', contextWindow: 1_000_000, maxTokens: 32_000 },
]

describe('per-region fallback directories', () => {
  it('returns each region its own roster and never the other one\'s', () => {
    expect(fallbackModelsFor('cn')).toBe(FALLBACK_WORKBUDDY_MODELS)
    expect(fallbackModelsFor('global')).toBe(FALLBACK_WORKBUDDY_MODELS_GLOBAL)
    const cnIds = new Set(fallbackModelsFor('cn').map(model => model.id))
    const globalIds = new Set(fallbackModelsFor('global').map(model => model.id))
    // A model only the CN roster carries.
    expect(cnIds.has('deepseek-v4-pro')).toBe(true)
    expect(globalIds.has('deepseek-v4-pro')).toBe(false)
    // A model only the international roster carries.
    expect(globalIds.has('gpt-6-astra')).toBe(true)
    expect(cnIds.has('gpt-6-astra')).toBe(false)
  })

  it('rates the shared deepseek-v4.1-flash id per region instead of picking one', () => {
    // THE regression this split exists for: both gateways carry the same id at
    // different rates, so each region's own list has to keep its own number.
    const cn = fallbackModelsFor('cn').find(model => model.id === 'deepseek-v4.1-flash')
    const global = fallbackModelsFor('global').find(model => model.id === 'deepseek-v4.1-flash')
    expect(cn?.creditMultiplier).toBe(0.03)
    expect(global?.creditMultiplier).toBe(0)
    // And the international side additionally carries the Singapore variant.
    expect(fallbackModelsFor('global').some(model => model.id === 'deepseek-v4.1-flash-sg')).toBe(true)
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
  it('seeds from ITS OWN region and refuses to become empty', () => {
    const global = new WorkBuddyCatalog('global')
    expect(global.current().some(model => model.id === 'gpt-6-astra')).toBe(true)
    expect(global.current().some(model => model.id === 'deepseek-v4-pro')).toBe(false)
    const cn = new WorkBuddyCatalog('cn')
    expect(cn.current().some(model => model.id === 'deepseek-v4-pro')).toBe(true)
    expect(cn.current().some(model => model.id === 'gpt-6-astra')).toBe(false)
    cn.set(models)
    expect(cn.current().map(model => model.id)).toEqual(['small', 'large'])
    expect(() => cn.set([])).toThrow(/cannot be empty/)
  })

  it('copies the entries it is given', () => {
    const catalog = new WorkBuddyCatalog()
    const source: WorkBuddyModelInfo[] = [{ id: 'a', name: 'A', contextWindow: 1, maxTokens: 1 }]
    catalog.set(source)
    source[0]!.name = 'changed'
    expect(catalog.current()[0]?.name).toBe('A')
  })
})
