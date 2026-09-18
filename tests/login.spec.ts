/**
 * Browser sign-in behaviour: the device-authorization flow the card drives.
 *
 * 参考：Sliverkiss/workbuddy2api（MIT）— 用例对应其面板登录的关键不变量
 *   （auth/state 取 state+authUrl、auth/token 是权威登录态端点、
 *   login/account 带 Bearer 取 uid/nickname、完成后落盘并热加载进池）。
 * 改动：新增「区域绑定」与「不覆盖桌面端文件」两条不变量 ——
 *   一次登录只能落进它自己那一侧的账号池，且只写插件自有副本。
 */

import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCredentialStore, workbuddyAccountId } from '../src/auth.ts'
import { WorkBuddyAccountPool } from '../src/pool.ts'
import {
  loginEndpointsFor,
  WorkBuddyLoginManager,
  WorkBuddyLoginUnknownStateError,
} from '../src/login.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyRegion } from '../src/upstream.ts'

let dir: string
let authDir: string
let storeDir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb2api-login-'))
  authDir = join(dir, 'auth')
  storeDir = join(dir, 'home')
  await mkdir(authDir, { recursive: true })
  await mkdir(storeDir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** One canned answer for a sign-in endpoint. */
interface Canned {
  status?: number
  /** The JSON body; absent when {@link Canned.text} supplies the raw answer. */
  body?: unknown
  /** Raw text, used for the non-JSON cases. */
  text?: string
}

/** A fake gateway that answers the three sign-in endpoints. */
function fakeGateway(answers: {
  state?: Canned
  token: Canned | Canned[]
  account?: Canned
}): { fetch: typeof fetch; calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] } {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []
  let tokenIndex = 0
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      ...typeof init?.body === 'string' ? { body: init.body } : {},
    })
    let canned: Canned
    if (url.includes('/v2/plugin/auth/state')) {
      canned = answers.state ?? { body: { code: 0, msg: 'OK', data: { state: 'st-1', authUrl: 'https://example.test/login?state=st-1' } } }
    } else if (url.includes('/v2/plugin/auth/token')) {
      const list = Array.isArray(answers.token) ? answers.token : [answers.token]
      canned = list[Math.min(tokenIndex, list.length - 1)] ?? list[0] ?? { body: {} }
      tokenIndex += 1
    } else {
      canned = answers.account ?? { body: { code: 0, msg: 'OK', data: { uid: 'uid-1', nickname: 'tester' } } }
    }
    if (canned.text !== undefined) {
      return new Response(canned.text, { status: canned.status ?? 200 })
    }
    return new Response(JSON.stringify(canned.body), {
      status: canned.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

/** A region-scoped store over a throwaway auth directory. */
function makeStore(region: WorkBuddyRegion): WorkBuddyCredentialStore {
  return new WorkBuddyCredentialStore({
    region,
    desktopPath: join(authDir, 'workbuddy-desktop.info'),
    storeDir,
    refresh: async () => { throw new Error('refresh must not be needed') },
  })
}

/** A manager over one region's store and pool. */
function makeManager(options: {
  region?: WorkBuddyRegion
  fetch: typeof fetch
  onSignedIn?: (region: WorkBuddyRegion, credential: WorkBuddyCredential) => Promise<string | undefined>
}): { manager: WorkBuddyLoginManager; store: WorkBuddyCredentialStore; pool: WorkBuddyAccountPool } {
  const region = options.region ?? 'cn'
  const store = makeStore(region)
  const pool = new WorkBuddyAccountPool({ list: () => store.accounts() })
  const manager = new WorkBuddyLoginManager({
    store: () => store,
    pool: () => pool,
    fetch: options.fetch,
    ...options.onSignedIn === undefined ? {} : { onSignedIn: options.onSignedIn },
  })
  return { manager, store, pool }
}

/** The token bundle a finished sign-in hands over. */
function tokenBundle(overrides: Record<string, unknown> = {}): Canned {
  return {
    body: {
      code: 0,
      msg: 'OK',
      data: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresIn: 3600,
        refreshExpiresIn: 7200,
        domain: 'www.workbuddy.cn',
        ...overrides,
      },
    },
  }
}

describe('loginEndpointsFor', () => {
  it('routes each region to its own gateway and origin', () => {
    const cn = loginEndpointsFor('cn')
    expect(cn.state).toBe('https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI')
    expect(cn.token).toBe('https://copilot.tencent.com/v2/plugin/auth/token?state=')
    expect(cn.account).toBe('https://copilot.tencent.com/v2/plugin/login/account?state=')
    expect(cn.origin).toBe('https://www.codebuddy.cn')
    const global = loginEndpointsFor('global')
    expect(global.state).toBe('https://www.workbuddy.ai/v2/plugin/auth/state?platform=CLI')
    expect(global.origin).toBe('https://www.workbuddy.ai')
  })
})

describe('WorkBuddyLoginManager', () => {
  it('starts a sign-in and reports the authorization URL', async () => {
    const gateway = fakeGateway({ token: tokenBundle() })
    const { manager } = makeManager({ fetch: gateway.fetch })
    const started = await manager.start('cn')
    expect(started).toEqual({ state: 'st-1', url: 'https://example.test/login?state=st-1', region: 'cn' })
    expect(manager.pendingCount()).toBe(1)
    expect(gateway.calls[0]?.method).toBe('POST')
    expect(gateway.calls[0]?.body).toBe('{}')
    // The CLI-shaped headers the device flow expects.
    expect(gateway.calls[0]?.headers['X-Requested-With']).toBe('XMLHttpRequest')
    expect(gateway.calls[0]?.headers['Origin']).toBe('https://www.codebuddy.cn')
    expect(gateway.calls[0]?.headers['User-Agent']).toContain('CLI/')
  })

  it('reports a pending sign-in without touching the store', async () => {
    const gateway = fakeGateway({
      token: { body: { code: 11217, msg: '11217:login ing...' } },
    })
    const { manager, store } = makeManager({ fetch: gateway.fetch })
    await manager.start('cn')
    const poll = await manager.poll('st-1')
    expect(poll.done).toBe(false)
    expect(poll.done === false ? poll.message : '').toContain('login ing')
    expect(await store.accounts()).toEqual([])
    // Still pollable: the user may simply not be done yet.
    expect(manager.pendingCount()).toBe(1)
  })

  it('finishes a sign-in, persists the copy, and adds the account to the pool', async () => {
    const gateway = fakeGateway({ token: tokenBundle() })
    const seen: string[] = []
    const { manager, store, pool } = makeManager({
      fetch: gateway.fetch,
      onSignedIn: async (region, credential) => {
        seen.push(region + ':' + credential.accessToken)
        return undefined
      },
    })
    await manager.start('cn')
    const poll = await manager.poll('st-1')
    expect(poll.done).toBe(true)
    if (!poll.done) throw new Error('unreachable')
    expect(poll.account.region).toBe('cn')
    expect(poll.account.nickname).toBe('tester')
    expect(poll.account.domain).toBe('www.workbuddy.cn')
    expect(seen).toEqual(['cn:access-1'])
    expect(manager.pendingCount()).toBe(0)

    // The credential is on disk as the plugin's OWN copy, never as a desktop
    // file, and the pool sees it right away.
    const names = await readdir(storeDir)
    const copy = names.find(name => name.startsWith('.workbuddy2api-auth.'))
    expect(copy).toBeDefined()
    expect(names).not.toContain('workbuddy-desktop.info')
    const credential = await store.resolve(poll.account.accountId)
    expect(credential.accessToken).toBe('access-1')
    expect(credential.refreshToken).toBe('refresh-1')
    expect(credential.source).toBe('dsh')
    expect(pool.snapshot().map(entry => entry.accountId)).toEqual([poll.account.accountId])
    expect(pool.entryView(poll.account.accountId)?.present).toBe(true)

    // The bearer token was sent to the account endpoint and nowhere else.
    const accountCall = gateway.calls.find(call => call.url.includes('/v2/plugin/login/account'))
    expect(accountCall?.headers['Authorization']).toBe('Bearer access-1')
    expect(gateway.calls.find(call => call.url.includes('/v2/plugin/auth/state'))?.headers['Authorization'])
      .toBeUndefined()
  })

  it('refuses a sign-in that completes in the other region', async () => {
    const gateway = fakeGateway({ token: tokenBundle({ domain: 'www.workbuddy.ai' }) })
    const { manager, store } = makeManager({ fetch: gateway.fetch })
    await manager.start('cn')
    await expect(manager.poll('st-1')).rejects.toThrow(/belongs to the global pool/)
    expect(await store.accounts()).toEqual([])
    // The session survives, so the user can finish the right flow instead.
    expect(manager.pendingCount()).toBe(1)
  })

  it('adopts the local identity when the sign-in omits uin', async () => {
    // The desktop app knows this human as uin 330120281752.
    await mkdir(authDir, { recursive: true })
    await import('node:fs/promises').then(fs => fs.writeFile(join(authDir, 'workbuddy-desktop.info'), JSON.stringify({
      auth: { accessToken: 'old', refreshToken: 'old-r', expiresAt: Date.now() + 86_400_000, domain: 'www.workbuddy.cn' },
      account: { uin: '330120281752', uid: 'uid-1', nickname: 'tester' },
    }), 'utf8'))
    const gateway = fakeGateway({ token: tokenBundle() })
    const { manager, store } = makeManager({ fetch: gateway.fetch })
    await manager.start('cn')
    const poll = await manager.poll('st-1')
    if (!poll.done) throw new Error('unreachable')
    // ONE pool entry, keyed by the billing identity both paths agree on.
    expect(poll.account.accountId).toBe(workbuddyAccountId({ uin: '330120281752', uid: 'uid-1', nickname: 'tester' }))
    expect(await store.accounts()).toHaveLength(1)
    expect((await store.resolve(poll.account.accountId)).uin).toBe('330120281752')
  })

  it('rejects an unknown or expired state', async () => {
    const gateway = fakeGateway({ token: tokenBundle() })
    const { manager } = makeManager({ fetch: gateway.fetch })
    await expect(manager.poll('never-issued')).rejects.toBeInstanceOf(WorkBuddyLoginUnknownStateError)
  })

  it('drops a session once its authorization URL expires', async () => {
    const gateway = fakeGateway({ token: tokenBundle() })
    let now = 1_000
    const store = makeStore('cn')
    const manager = new WorkBuddyLoginManager({
      store: () => store,
      pool: () => new WorkBuddyAccountPool({ list: () => store.accounts() }),
      fetch: gateway.fetch,
      now: () => now,
      ttlMs: 1_000,
    })
    await manager.start('cn')
    now += 5_000
    await expect(manager.poll('st-1')).rejects.toBeInstanceOf(WorkBuddyLoginUnknownStateError)
  })

  it('fails loudly when the gateway issues a token but no identity', async () => {
    const gateway = fakeGateway({
      token: tokenBundle(),
      account: { body: { code: 0, msg: 'OK', data: {} } },
    })
    const { manager, store } = makeManager({ fetch: gateway.fetch })
    await manager.start('cn')
    await expect(manager.poll('st-1')).rejects.toThrow(/no account identity/)
    expect(await store.accounts()).toEqual([])
  })

  it('refuses a state endpoint without a state or URL', async () => {
    const gateway = fakeGateway({ token: tokenBundle(), state: { body: { code: 0, msg: 'OK', data: {} } } })
    const { manager } = makeManager({ fetch: gateway.fetch })
    await expect(manager.start('cn')).rejects.toThrow(/without a state or an authorization URL/)
  })

  it('reports a non-JSON gateway answer instead of storing a broken token', async () => {
    const gateway = fakeGateway({
      token: { status: 502, text: '<html>bad gateway</html>' },
    })
    const { manager } = makeManager({ fetch: gateway.fetch })
    await manager.start('cn')
    await expect(manager.poll('st-1')).rejects.toThrow(/http 502/)
  })

  it('surfaces a failing follow-up as a note rather than failing the sign-in', async () => {
    const gateway = fakeGateway({ token: tokenBundle() })
    const { manager } = makeManager({
      fetch: gateway.fetch,
      onSignedIn: async () => { throw new Error('catalog offline') },
    })
    await manager.start('cn')
    const poll = await manager.poll('st-1')
    if (!poll.done) throw new Error('unreachable')
    expect(poll.note).toBe('catalog offline')
    expect(poll.account.nickname).toBe('tester')
  })

  it('writes the credential into the store region it was started for', async () => {
    const gateway = fakeGateway({
      token: tokenBundle({ domain: 'www.workbuddy.ai' }),
    })
    const store = makeStore('global')
    const pool = new WorkBuddyAccountPool({ list: () => store.accounts() })
    const manager = new WorkBuddyLoginManager({
      store: () => store,
      pool: () => pool,
      fetch: gateway.fetch,
    })
    await manager.start('global')
    const poll = await manager.poll('st-1')
    expect(poll.done).toBe(true)
    expect(gateway.calls[0]?.headers['Origin']).toBe('https://www.workbuddy.ai')
    expect(await store.accounts()).toHaveLength(1)
    expect(pool.snapshot()[0]?.region).toBe('global')
  })
})

describe('WorkBuddyCredentialStore.save', () => {
  it('refuses a credential belonging to the other region', async () => {
    const store = makeStore('cn')
    const foreign: WorkBuddyCredential = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAtMs: Date.now() + 3_600_000,
      domain: 'www.workbuddy.ai',
      uid: 'uid-1',
      source: 'dsh',
      filePath: '',
    }
    await expect(store.save(foreign)).rejects.toThrow(/refusing to store a global credential in the cn store/)
    expect(await store.accounts()).toEqual([])
  })

  it('stores a same-region credential and reads it back', async () => {
    const store = makeStore('cn')
    const saved = await store.save({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAtMs: Date.now() + 3_600_000,
      domain: 'www.workbuddy.cn',
      uid: 'uid-9',
      nickname: 'niner',
      source: 'desktop',
      filePath: '',
    })
    expect(saved.source).toBe('dsh')
    expect(await store.accounts()).toHaveLength(1)
    expect((await store.current(workbuddyAccountId(saved)))?.accessToken).toBe('a')
  })
})
