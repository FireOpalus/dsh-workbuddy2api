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
  chatCompletionPaths,
  conversationIdOf,
  classifyUpstreamError,
  ensureSystemFirst,
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
    // Both international domains take the console route: the /v2 path there answers
    // 400 code 11128 for every request, so "the brand differs" and "the chat route
    // moved" are two separate facts and this pins both.
    await client.chatStream(credential({ domain: 'codebuddy.ai' }), '{}')
    expect(urls[0]).toContain('https://www.codebuddy.ai/console/chat/completions')
    urls.length = 0
    await client.chatStream(credential({ domain: 'www.workbuddy.ai' }), '{}')
    expect(urls[0]).toContain('https://www.workbuddy.ai/console/chat/completions')
    urls.length = 0
    // The domestic gateway keeps its established path (its chat host differs from
    // its brand domain, so only the path is asserted here).
    await client.chatStream(credential({ domain: 'www.workbuddy.cn' }), '{}')
    expect(urls[0]?.endsWith('/v2/chat/completions')).toBe(true)
    expect(urls[0]).not.toContain('/console/')
    vi.unstubAllGlobals()
  })

  it('reports a transport failure as a classified result instead of throwing', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const client = new WorkBuddyUpstreamClient()
    const result = await client.chatStream(credential(), '{}')
    expect(result).toMatchObject({ ok: false, status: 0, kind: 'server' })
    vi.unstubAllGlobals()
  })

  it('merges the accounts of ONE region and keeps that region\'s rate for a shared id', async () => {
    const client = new WorkBuddyUpstreamClient()
    const first: WorkBuddyUpstreamModel[] = [
      { id: 'shared', name: 'Shared', contextWindow: 10, maxTokens: 1, creditMultiplier: 0 },
      { id: 'first-only', name: 'First Only', contextWindow: 10, maxTokens: 1 },
    ]
    const second: WorkBuddyUpstreamModel[] = [
      { id: 'shared', name: 'Shared', contextWindow: 10, maxTokens: 1 },
      { id: 'second-only', name: 'Second Only', contextWindow: 10, maxTokens: 1 },
    ]
    vi.spyOn(client, 'fetchModels').mockImplementation(async target => {
      if (target.uid === 'dead') throw new Error('account is dead')
      return target.uid === 'second' ? second : first
    })
    const merged = await client.fetchModelsForCredentials([
      credential({ uid: 'first' }),
      credential({ uid: 'second' }),
      credential({ uid: 'dead' }),
    ])
    expect(merged.map(model => model.id)).toEqual(['shared', 'first-only', 'second-only'])
    // Within a region a repeated id is the same model; the first account's copy
    // wins so the listing stays stable as the pool is reordered.
    expect(merged[0]?.creditMultiplier).toBe(0)
    vi.restoreAllMocks()
  })

  it('REFUSES to merge across regions, because one id can mean two rates', async () => {
    const client = new WorkBuddyUpstreamClient()
    const fetchModels = vi.spyOn(client, 'fetchModels').mockResolvedValue([
      { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1, maxTokens: 1, creditMultiplier: 0 },
    ])
    await expect(client.fetchModelsForCredentials([
      credential({ domain: 'codebuddy.cn' }),
      credential({ domain: 'codebuddy.ai' }),
    ])).rejects.toThrow(/refusing to merge model catalogs across regions/)
    // The guard runs before any network work, so nothing was fetched.
    expect(fetchModels).not.toHaveBeenCalled()
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
    // 日期一律相对「现在」推算，不写死字面量。fetchCredits 会把 ExpiredTime 已过的
    // 一次性赠包丢掉，所以一个写死的「未来」日期就是一颗定时炸弹：它在写下的那一刻
    // 是对的，过期那天起断言就会失败，而代码一行没改（2026-09-20 那颗在写下两天后
    // 就爆了：Gift 被正确判为过期，total 从 491 掉成 451）。
    const DAY_MS = 24 * 60 * 60 * 1000
    // 本地时区格式，与 fetchCredits 解析的形态一致（Date.parse 会按本地时间解释它）。
    const local = (ms: number): string => {
      const date = new Date(ms)
      const pad = (value: number): string => value.toString().padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }
    const cycleEnd = local(Date.now() + 10 * DAY_MS)
    const giftExpiry = local(Date.now() + 3 * DAY_MS)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      code: 0,
      msg: '',
      data: { Response: { Data: { Accounts: [
        { PackageName: 'Monthly', CapacityType: 4, CycleCapacitySize: 500, CycleCapacityRemain: 451, CycleEndTime: cycleEnd },
        { PackageName: 'Gift', CapacityType: 1, CapacitySize: 100, CapacityRemain: 40, ExpiredTime: giftExpiry },
        { PackageName: 'Spent gift', CapacityType: 1, CapacitySize: 100, CapacityRemain: 0, ExpiredTime: giftExpiry },
        { PackageName: 'Expired gift', CapacityType: 1, CapacitySize: 100, CapacityRemain: 10, ExpiredTime: local(Date.now() - 3 * DAY_MS) },
      ] } } },
    }), { status: 200 }))
    const credits = await client.fetchCredits(credential())
    expect(credits.total).toBe(491)
    expect(credits.packages.map(pack => pack.packageName)).toEqual(['Monthly', 'Gift'])
    expect(credits.packages[0]?.monthly).toBe(true)
    expect(credits.packages[0]?.refreshAtMs).toBe(Date.parse(cycleEnd) + 1_000)
    expect(credits.packages[1]?.monthly).toBe(false)
    vi.unstubAllGlobals()
  })
})


describe('chatCompletionPaths (the international route move)', () => {
  const cred = (domain: string): WorkBuddyCredential => ({
    accessToken: 'token', refreshToken: '', expiresAtMs: 0, domain,
    uid: 'u', nickname: 'n', source: 'desktop', filePath: '/x.info',
  } as WorkBuddyCredential)

  it('uses the console route for the international gateway', () => {
    // The retired /v2 route on www.workbuddy.ai answers 400 code 11128 for every
    // request ("channel verification"), which looks like a fingerprint problem and
    // is really just the wrong path. Verified live: console → 200, /v2 → 400.
    expect(chatCompletionPaths(cred('www.workbuddy.ai'))).toEqual([
      '/console/chat/completions',
      '/v2/chat/completions',
    ])
  })

  it('leaves the domestic gateway exactly as it was', () => {
    expect(chatCompletionPaths(cred('www.workbuddy.cn'))).toEqual(['/v2/chat/completions'])
  })
})

describe('ensureSystemFirst', () => {
  it('prepends a system prompt when the body opens with a user message', () => {
    // The console route rejects a user-first body with the SAME code 11128 and the
    // same "channel verification" tip, so this guarantee is not cosmetic.
    const out = JSON.parse(ensureSystemFirst(JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }))) as { messages: { role: string }[] }
    expect(out.messages[0]?.role).toBe('system')
    expect(out.messages[1]?.role).toBe('user')
    expect(out.messages).toHaveLength(2)
  })

  it('leaves a body that already opens with a system prompt untouched', () => {
    const source = JSON.stringify({
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
    })
    expect(ensureSystemFirst(source)).toBe(source)
  })

  it('passes through anything it cannot read, so the caller sees the real error', () => {
    expect(ensureSystemFirst('not json')).toBe('not json')
    expect(ensureSystemFirst('[]')).toBe('[]')
    expect(ensureSystemFirst(JSON.stringify({ model: 'm' }))).toBe(JSON.stringify({ model: 'm' }))
    expect(ensureSystemFirst(JSON.stringify({ messages: [] }))).toBe(JSON.stringify({ messages: [] }))
  })
})


describe('the international channel gates', () => {
  const cred = (domain: string): WorkBuddyCredential => ({
    accessToken: 'token', refreshToken: '', expiresAtMs: 0, domain,
    uid: 'u', nickname: 'n', source: 'desktop', filePath: '/x.info',
  } as WorkBuddyCredential)

  /** Send one chat and hand back the headers of the first attempt. */
  const capture = async (domain: string): Promise<Record<string, string>> => {
    const inits: RequestInit[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      inits.push(init ?? {})
      return new Response('data: [DONE]\n\n', { status: 200 })
    })
    const client = new WorkBuddyUpstreamClient()
    await client.chatStream(cred(domain), JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    }))
    vi.unstubAllGlobals()
    return (inits[0]?.headers ?? {}) as Record<string, string>
  }

  it('sends all three conversation headers to the international gateway', async () => {
    // Verified live: without them this gateway answers 400 code 11128 "request
    // illegal"; with them, 200. Omitting ANY one of the three still fails, and the
    // check is presence-only, so these are non-empty rather than well-formed ids.
    const headers = await capture('www.workbuddy.ai')
    for (const name of ['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID']) {
      expect(headers[name], name).toBeTruthy()
    }
  })

  it('adds a system prompt when the international body arrives without one', async () => {
    // Second gate on the same route: "first message is not system prompt", again as
    // code 11128. The captured body is what actually goes on the wire.
    const inits: RequestInit[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      inits.push(init ?? {})
      return new Response('data: [DONE]\n\n', { status: 200 })
    })
    const client = new WorkBuddyUpstreamClient()
    await client.chatStream(cred('www.workbuddy.ai'), JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }))
    vi.unstubAllGlobals()
    const sent = JSON.parse(String(inits[0]?.body)) as { messages: { role: string }[] }
    expect(sent.messages[0]?.role).toBe('system')
    expect(sent.messages[1]?.role).toBe('user')
  })

  it('leaves the domestic request exactly as it was', async () => {
    const headers = await capture('www.workbuddy.cn')
    expect(headers['X-Conversation-ID']).toBeUndefined()
    expect(headers['X-Conversation-Request-ID']).toBeUndefined()
    expect(headers['X-Conversation-Message-ID']).toBeUndefined()
  })

  it('keeps the conversation id stable for one conversation', async () => {
    // Presence-only means a random id would pass, but the upstream groups by this
    // value: a stable id keeps that grouping truthful instead of fragmenting.
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'same opening' }, { role: 'assistant', content: 'x' }],
    })
    expect(conversationIdOf(body)).toBe(conversationIdOf(body))
    expect(conversationIdOf(body)).not.toBe(conversationIdOf(JSON.stringify({ messages: [{ role: 'user', content: 'other' }] })))
    expect(conversationIdOf('not json')).not.toBe('')
  })
})
