/**
 * Upstream wire behaviour: request shaping, catalog parsing, error
 * classification, and multi-account catalog merging.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 用例对应其 upstream 测试的关键不变量（tool_choice 压平、
 *     强制 stream、developer→system、credits/reasoning 解析、
 *     错误分类词表）。改动：新增「多账号目录合并」的用例。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  classifyUpstreamError,
  parseCreditMultiplier,
  parseReasoning,
  parseUpstreamModel,
  prepareChatBody,
  regionOf,
  selectCliModels,
  WorkBuddyUpstreamClient,
} from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyUpstreamModel } from '../src/upstream.ts'

function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAtMs: 0,
    domain: 'codebuddy.cn',
    uid: 'uid',
    source: 'desktop',
    filePath: '/x.info',
    ...overrides,
  }
}

describe('prepareChatBody', () => {
  it('forces streaming and flattens every tool_choice spelling', () => {
    const parsed = (body: unknown): Record<string, unknown> =>
      JSON.parse(prepareChatBody(JSON.stringify(body))) as Record<string, unknown>
    expect(parsed({ stream: false }).stream).toBe(true)
    expect(parsed({ tool_choice: { type: 'auto' } }).tool_choice).toBe('auto')
    expect(parsed({ tool_choice: { type: 'required' } }).tool_choice).toBe('required')
    expect(parsed({ tool_choice: { type: 'function', function: { name: 'read' } } }).tool_choice).toBe('read')
    expect(parsed({ tool_choice: { type: 'function', name: 'read' } }).tool_choice).toBe('read')
    // A nameless function choice degrades to auto rather than to a bad name.
    expect(parsed({ tool_choice: { type: 'function' } }).tool_choice).toBe('auto')
    const none = parsed({ tool_choice: { type: 'none' }, tools: [{ type: 'function' }] })
    expect(none.tool_choice).toBeUndefined()
    expect(none.tools).toBeUndefined()
    const stringNone = parsed({ tool_choice: 'none', functions: [] })
    expect(stringNone.tool_choice).toBeUndefined()
    expect(stringNone.functions).toBeUndefined()
    expect(parsed({ tool_choice: 'auto' }).tool_choice).toBe('auto')
    expect(parsed({ tool_choice: 42 }).tool_choice).toBeUndefined()
  })

  it('rewrites the developer role to system', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'developer', content: 'x' }, { role: 'user', content: 'y' }],
    }))) as { messages: { role: string }[] }
    expect(body.messages.map(message => message.role)).toEqual(['system', 'user'])
  })

  it('passes unparsable input through untouched', () => {
    expect(prepareChatBody('not json')).toBe('not json')
    expect(prepareChatBody('[]')).toBe('[]')
  })
})

describe('classifyUpstreamError', () => {
  it('maps statuses and bodies onto the failure classes', () => {
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
    expect(classifyUpstreamError(400, '积分不足')).toBe('hard_credit')
    expect(classifyUpstreamError(400, 'insufficient credit')).toBe('hard_credit')
    expect(classifyUpstreamError(401, 'Offline user session not found')).toBe('session_dead')
    expect(classifyUpstreamError(401, '{"code":12153}')).toBe('session_dead')
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyUpstreamError(404, '')).toBe('not_found')
    expect(classifyUpstreamError(503, '')).toBe('server')
    expect(classifyUpstreamError(400, 'bad params')).toBe('client')
  })
})

describe('regionOf', () => {
  it('classifies both international brand domains and defaults to CN', () => {
    expect(regionOf('workbuddy.ai')).toBe('global')
    expect(regionOf('www.workbuddy.ai')).toBe('global')
    expect(regionOf('codebuddy.ai')).toBe('global')
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('')).toBe('cn')
  })
})

describe('catalog parsing', () => {
  it('parses the credit multiplier from every observed spelling', () => {
    expect(parseCreditMultiplier('x0.79 credits')).toBe(0.79)
    expect(parseCreditMultiplier('x0.05')).toBe(0.05)
    expect(parseCreditMultiplier('x0.00 credits')).toBe(0)
    expect(parseCreditMultiplier(undefined)).toBeUndefined()
    expect(parseCreditMultiplier('free')).toBeUndefined()
  })

  it('folds the singular reasoning form into the plural shape', () => {
    expect(parseReasoning({ effort: 'high' })).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
    expect(parseReasoning({ supportedEfforts: ['low', 'high'], defaultEffort: 'high' })).toEqual({
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
    })
    expect(parseReasoning(undefined)).toBeUndefined()
    expect(parseReasoning({})).toBeUndefined()
  })

  it('drops disabled and limit-less entries', () => {
    expect(parseUpstreamModel({ id: 'a', maxInputTokens: 1, maxOutputTokens: 1 })).toMatchObject({ id: 'a', name: 'a' })
    expect(parseUpstreamModel({ id: 'a', maxInputTokens: 1, maxOutputTokens: 1, disabled: true })).toBeUndefined()
    expect(parseUpstreamModel({ id: 'a', maxOutputTokens: 1 })).toBeUndefined()
    expect(parseUpstreamModel({ maxInputTokens: 1, maxOutputTokens: 1 })).toBeUndefined()
    expect(parseUpstreamModel(null)).toBeUndefined()
  })

  it('keeps the cli agent roster order and falls back to the whole catalog', () => {
    const rawModels = [
      { id: 'a', name: 'A', maxInputTokens: 1, maxOutputTokens: 1 },
      { id: 'b', name: 'B', maxInputTokens: 1, maxOutputTokens: 1 },
      { id: 'c', name: 'C', maxInputTokens: 1, maxOutputTokens: 1 },
    ]
    expect(selectCliModels(rawModels, [{ name: 'cli', models: ['c', 'a'] }]).map(model => model.id)).toEqual(['c', 'a'])
    expect(selectCliModels(rawModels, []).map(model => model.id)).toEqual(['a', 'b', 'c'])
    expect(() => selectCliModels([], [])).toThrow(/empty list/)
  })
})

describe('WorkBuddyUpstreamClient', () => {
  it('sends the CLI-shaped chat headers and never the refresh token', async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = []
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, headers: init.headers, body: init.body })
      return new Response('data: [DONE]\n\n', { status: 200 })
    })
    const client = new WorkBuddyUpstreamClient()
    await client.chatStream(credential(), '{"messages":[]}')
    expect(seen[0]?.url).toBe('https://copilot.tencent.com/v2/chat/completions')
    expect(seen[0]?.headers['X-User-Id']).toBe('uid')
    expect(seen[0]?.headers['X-Product']).toBe('SaaS')
    expect(JSON.stringify(seen[0]?.headers)).not.toContain('refresh')
    vi.unstubAllGlobals()
  })

  it('routes a global credential to its own brand gateway', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return new Response('data: [DONE]\n\n', { status: 200 })
    })
    const client = new WorkBuddyUpstreamClient()
    await client.chatStream(credential({ domain: 'codebuddy.ai' }), '{}')
    expect(urls[0]).toContain('https://www.codebuddy.ai/v2/chat/completions')
    urls.length = 0
    await client.chatStream(credential({ domain: 'www.workbuddy.ai' }), '{}')
    expect(urls[0]).toContain('https://www.workbuddy.ai/v2/chat/completions')
    vi.unstubAllGlobals()
  })

  it('reports a transport failure as a classified result instead of throwing', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const client = new WorkBuddyUpstreamClient()
    const result = await client.chatStream(credential(), '{}')
    expect(result).toMatchObject({ ok: false, status: 0, kind: 'server' })
    vi.unstubAllGlobals()
  })

  it('merges every account\'s directory into one catalog', async () => {
    const client = new WorkBuddyUpstreamClient()
    const cnModels: WorkBuddyUpstreamModel[] = [
      { id: 'shared', name: 'CN Shared', contextWindow: 10, maxTokens: 1 },
      { id: 'cn-only', name: 'CN Only', contextWindow: 10, maxTokens: 1 },
    ]
    const globalModels: WorkBuddyUpstreamModel[] = [
      { id: 'shared', name: 'Global Shared', contextWindow: 20, maxTokens: 2 },
      { id: 'global-only', name: 'Global Only', contextWindow: 20, maxTokens: 2 },
    ]
    vi.spyOn(client, 'fetchModels').mockImplementation(async target => {
      if (target.domain === 'codebuddy.ai') return globalModels
      if (target.domain === 'broken.cn') throw new Error('account is dead')
      return cnModels
    })
    const merged = await client.fetchModelsForCredentials([
      credential({ domain: 'codebuddy.cn' }),
      credential({ domain: 'codebuddy.ai' }),
      credential({ domain: 'broken.cn' }),
    ])
    expect(merged.map(model => model.id)).toEqual(['shared', 'cn-only', 'global-only'])
    // First writer wins, so the pool's preference order decides the spelling.
    expect(merged[0]?.name).toBe('CN Shared')
    vi.restoreAllMocks()
  })

  it('throws the real cause when every account fails', async () => {
    const client = new WorkBuddyUpstreamClient()
    vi.spyOn(client, 'fetchModels').mockRejectedValue(new Error('everything is down'))
    await expect(client.fetchModelsForCredentials([credential()])).rejects.toThrow('everything is down')
    vi.restoreAllMocks()
  })

  it('refuses to merge an empty account list', async () => {
    const client = new WorkBuddyUpstreamClient()
    await expect(client.fetchModelsForCredentials([])).rejects.toThrow(/no signed-in account/)
  })

  it('aggregates credit packages and skips exhausted one-off gifts', async () => {
    const client = new WorkBuddyUpstreamClient()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      msg: '',
      data: { Response: { Data: { Accounts: [
        { PackageName: 'Monthly', CapacityType: 4, CycleCapacitySize: 500, CycleCapacityRemain: 451, CycleEndTime: '2026-10-01 00:00:00' },
        { PackageName: 'Gift', CapacityType: 1, CapacitySize: 100, CapacityRemain: 40, ExpiredTime: '2026-09-20 00:00:00' },
        { PackageName: 'Spent gift', CapacityType: 1, CapacitySize: 100, CapacityRemain: 0, ExpiredTime: '2026-09-20 00:00:00' },
        { PackageName: 'Expired gift', CapacityType: 1, CapacitySize: 100, CapacityRemain: 10, ExpiredTime: '2000-01-01 00:00:00' },
      ] } } },
    }), { status: 200 }))
    const credits = await client.fetchCredits(credential())
    expect(credits.total).toBe(491)
    expect(credits.packages.map(pack => pack.packageName)).toEqual(['Monthly', 'Gift'])
    expect(credits.packages[0]?.monthly).toBe(true)
    expect(credits.packages[0]?.refreshAtMs).toBe(Date.parse('2026-10-01 00:00:00') + 1_000)
    expect(credits.packages[1]?.monthly).toBe(false)
    vi.unstubAllGlobals()
  })
})
