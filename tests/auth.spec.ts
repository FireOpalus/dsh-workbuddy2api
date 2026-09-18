/**
 * Multi-account credential discovery.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT）— 用例覆盖其 auth 测试的
 * 关键不变量：两种文档形态、秒/毫秒到期、live 文件优先于备份、
 * 目录扫描按 uin 去重。改动：新增「每个账号一个插件自有副本」的持久化
 * 与按 id 解析。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  authFileName,
  defaultDesktopAuthDirs,
  expiryToMs,
  isFresher,
  parseWorkBuddyAuth,
  WorkBuddyCredentialStore,
  workbuddyAccountId,
  workbuddyOwnAuthPath,
} from '../src/auth.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyRefreshOutcome } from '../src/upstream.ts'

let dir: string
let authDir: string
let storeDir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb2api-auth-'))
  authDir = join(dir, 'auth')
  storeDir = join(dir, 'home')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(authDir, { recursive: true })
  await mkdir(storeDir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Write one auth document in the nested desktop shape. */
async function writeAuth(
  name: string,
  identity: { uin: string; uid?: string; nickname?: string; domain?: string; expiresAt?: number; lastRefreshTime?: number },
): Promise<string> {
  const path = join(authDir, name)
  await writeFile(path, JSON.stringify({
    auth: {
      accessToken: `token-${identity.uin}`,
      refreshToken: `refresh-${identity.uin}`,
      expiresAt: identity.expiresAt ?? 2_000_000_000,
      lastRefreshTime: identity.lastRefreshTime ?? 1_700_000_000,
      domain: identity.domain ?? 'codebuddy.cn',
    },
    account: {
      uin: identity.uin,
      uid: identity.uid ?? `uid-${identity.uin}`,
      nickname: identity.nickname ?? `user-${identity.uin}`,
    },
  }), 'utf8')
  return path
}

describe('parseWorkBuddyAuth', () => {
  it('reads the nested desktop shape', () => {
    const credential = parseWorkBuddyAuth(JSON.stringify({
      auth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1_700_000_000, domain: 'workbuddy.ai' },
      account: { uin: 'u1', uid: 'id1', nickname: 'nick' },
    }), '/tmp/x.info')
    expect(credential).toMatchObject({
      accessToken: 'a', refreshToken: 'r', domain: 'workbuddy.ai', uin: 'u1', uid: 'id1', nickname: 'nick', source: 'desktop',
    })
    // Seconds are widened to milliseconds.
    expect(credential?.expiresAtMs).toBe(1_700_000_000_000)
  })

  it('reads the flat panel shape', () => {
    const credential = parseWorkBuddyAuth(JSON.stringify({
      accessToken: 'a', refreshToken: 'r', expiresAt: 1_700_000_000_000, domain: 'codebuddy.cn', uin: 'u2', uid: 'id2',
    }), '/tmp/y.info')
    expect(credential?.uin).toBe('u2')
    expect(credential?.expiresAtMs).toBe(1_700_000_000_000)
  })

  it('rejects documents without an access token and unparsable text', () => {
    expect(parseWorkBuddyAuth('{}', '/tmp/z.info')).toBeUndefined()
    expect(parseWorkBuddyAuth('not json', '/tmp/z.info')).toBeUndefined()
    expect(parseWorkBuddyAuth('[]', '/tmp/z.info')).toBeUndefined()
  })
})

describe('expiryToMs / authFileName', () => {
  it('normalizes seconds and milliseconds and rejects non-positive input', () => {
    expect(expiryToMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(expiryToMs(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(expiryToMs(0)).toBe(0)
    expect(expiryToMs(-5)).toBe(0)
  })

  it('splits Windows and POSIX separators alike', () => {
    expect(authFileName('C:\\\\a\\\\b\\\\workbuddy-desktop.info')).toBe('workbuddy-desktop.info')
    expect(authFileName('/a/b/workbuddy-desktop.info')).toBe('workbuddy-desktop.info')
    expect(authFileName('bare.info')).toBe('bare.info')
  })
})

describe('platform default directories', () => {
  it('probes both Windows locations and honours the env overrides', () => {
    const dirs = defaultDesktopAuthDirs('win32', 'C:\\Users\\me', {
      LOCALAPPDATA: 'D:\\Local',
      APPDATA: 'D:\\Roaming',
    })
    expect(dirs).toEqual([
      join('D:\\Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join('D:\\Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ])
  })

  it('falls back to the home-derived convention when the env is blank', () => {
    const dirs = defaultDesktopAuthDirs('win32', 'C:\\Users\\me', { LOCALAPPDATA: '   ' })
    expect(dirs[0]).toBe(join('C:\\Users\\me', 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  })

  it('uses the single Application Support path on macOS', () => {
    const dirs = defaultDesktopAuthDirs('darwin', '/Users/me', {})
    expect(dirs).toEqual([join('/Users/me', 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')])
  })

  it('uses XDG_CONFIG_HOME on Linux', () => {
    expect(defaultDesktopAuthDirs('linux', '/home/me', { XDG_CONFIG_HOME: '/cfg' })[0])
      .toBe(join('/cfg', 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
    expect(defaultDesktopAuthDirs('linux', '/home/me', {})[0])
      .toBe(join('/home/me', '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  })
})

describe('isFresher', () => {
  const credential = (overrides: Partial<WorkBuddyCredential>): WorkBuddyCredential => ({
    accessToken: 'a', refreshToken: 'r', expiresAtMs: 0, domain: '', uid: '', source: 'desktop', filePath: '/x.info',
    ...overrides,
  })

  it('always prefers the live file over a backup', () => {
    const live = credential({ filePath: '/auth/workbuddy-desktop.info', expiresAtMs: 1 })
    const backup = credential({ filePath: '/auth/workbuddy-desktop.2026-01-01T00.info', expiresAtMs: 9_999_999_999_999 })
    expect(isFresher(live, backup)).toBe(true)
    expect(isFresher(backup, live)).toBe(false)
  })

  it('ranks two backups by issuance time before expiry', () => {
    const older = credential({
      filePath: '/auth/b.info', lastRefreshAtMs: 1_000, expiresAtMs: 9_999_999_999_999,
    })
    const newer = credential({ filePath: '/auth/a.info', lastRefreshAtMs: 2_000, expiresAtMs: 1 })
    expect(isFresher(newer, older)).toBe(true)
  })

  it('falls back to expiry when neither records an issuance time', () => {
    const short = credential({ filePath: '/auth/a.info', expiresAtMs: 1 })
    const long = credential({ filePath: '/auth/b.info', expiresAtMs: 2 })
    expect(isFresher(long, short)).toBe(true)
  })
})

describe('WorkBuddyCredentialStore', () => {
  it('discovers every account in the auth directory, deduplicated by uin', async () => {
    await writeAuth('workbuddy-desktop.info', { uin: 'A', nickname: 'Alice' })
    await writeAuth('workbuddy-desktop.2026-08-01T00.info', { uin: 'B', nickname: 'Bob' })
    await writeAuth('workbuddy-desktop.2026-08-02T00.info', { uin: 'A', nickname: 'Alice-old' })
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(authDir, 'workbuddy-desktop.info'),
      storeDir,
      refresh: async () => { throw new Error('not used') },
    })
    const accounts = await store.accounts()
    expect(accounts.map(account => account.id).sort()).toEqual([
      workbuddyAccountId({ uin: 'A', uid: '', nickname: '' }),
      workbuddyAccountId({ uin: 'B', uid: '', nickname: '' }),
    ].sort())
    // The live file wins for account A even though a newer backup exists.
    const alice = accounts.find(account => account.accountName === 'Alice')
    expect(alice).toBeDefined()
    expect(alice?.filePath.endsWith('workbuddy-desktop.info')).toBe(true)
  })

  it('resolves one account by id and ignores the others', async () => {
    await writeAuth('workbuddy-desktop.info', { uin: 'A' })
    await writeAuth('workbuddy-desktop.2026-08-01T00.info', { uin: 'B' })
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(authDir, 'workbuddy-desktop.info'),
      storeDir,
      refresh: async () => { throw new Error('not used') },
    })
    const accounts = await store.accounts()
    const b = accounts.find(account => account.uin === 'B')
    const credential = await store.resolve(b?.id as string)
    expect(credential.uin).toBe('B')
    expect(credential.accessToken).toBe('token-B')
  })

  it('throws a sign-in hint when the requested account is unknown', async () => {
    await writeAuth('workbuddy-desktop.info', { uin: 'A' })
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(authDir, 'workbuddy-desktop.info'),
      storeDir,
      refresh: async () => { throw new Error('not used') },
    })
    await expect(store.resolve('nope')).rejects.toThrow(/no signed-in WorkBuddy account/)
  })

  it('refreshes inside the margin and writes a per-account copy', async () => {
    await writeAuth('workbuddy-desktop.info', { uin: 'A', expiresAt: Math.floor(Date.now() / 1000) + 60 })
    const refreshed: WorkBuddyRefreshOutcome = { accessToken: 'fresh', expiresInSec: 3_600 }
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(authDir, 'workbuddy-desktop.info'),
      storeDir,
      refresh: async () => refreshed,
    })
    const accounts = await store.accounts()
    const credential = await store.resolve(accounts[0]?.id as string)
    expect(credential.accessToken).toBe('fresh')
    expect(credential.source).toBe('dsh')
    // A second, independent store must see the refreshed copy.
    const second = new WorkBuddyCredentialStore({
      desktopPath: join(authDir, 'workbuddy-desktop.info'),
      storeDir,
      refresh: async () => { throw new Error('must not refresh') },
    })
    const again = await second.resolve(accounts[0]?.id as string)
    expect(again.accessToken).toBe('fresh')
    expect(workbuddyOwnAuthPath(accounts[0]?.id as string, storeDir)).toContain(accounts[0]?.id as string)
  })

  it('keeps a still-valid token when the refresh endpoint fails', async () => {
    await writeAuth('workbuddy-desktop.info', { uin: 'A', expiresAt: Math.floor(Date.now() / 1000) + 60 })
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(authDir, 'workbuddy-desktop.info'),
      storeDir,
      refresh: async () => { throw new Error('network down') },
    })
    const accounts = await store.accounts()
    const credential = await store.resolve(accounts[0]?.id as string)
    expect(credential.accessToken).toBe('token-A')
  })

  it('shares one in-flight refresh between concurrent callers', async () => {
    await writeAuth('workbuddy-desktop.info', { uin: 'A', expiresAt: Math.floor(Date.now() / 1000) + 60 })
    let calls = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(authDir, 'workbuddy-desktop.info'),
      storeDir,
      refresh: async () => {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, 20))
        return { accessToken: 'fresh', expiresInSec: 3_600 }
      },
    })
    const accounts = await store.accounts()
    const id = accounts[0]?.id as string
    const [first, second] = await Promise.all([store.resolve(id), store.resolve(id)])
    expect(calls).toBe(1)
    expect(first.accessToken).toBe('fresh')
    expect(second.accessToken).toBe('fresh')
  })

  it('logout removes every plugin-owned copy and leaves the desktop file alone', async () => {
    const desktop = await writeAuth('workbuddy-desktop.info', { uin: 'A', expiresAt: Math.floor(Date.now() / 1000) + 60 })
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      storeDir,
      refresh: async () => ({ accessToken: 'fresh', expiresInSec: 3_600 }),
    })
    const accounts = await store.accounts()
    await store.resolve(accounts[0]?.id as string)
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(storeDir)).length).toBe(1)
    await store.logout()
    expect((await readdir(storeDir)).length).toBe(0)
    expect(await store.desktopFilePresent()).toBe(true)
  })

  it('scopes discovery to one region when the store is region-bound', async () => {
    await writeAuth('workbuddy-desktop.info', { uin: 'CN1', domain: 'www.codebuddy.cn' })
    await writeAuth('workbuddy-desktop.2026-08-01T00.info', { uin: 'GL1', domain: 'www.workbuddy.ai' })
    const base = {
      desktopPath: join(authDir, 'workbuddy-desktop.info'),
      storeDir,
      refresh: async () => { throw new Error('not used') },
    }
    const cn = new WorkBuddyCredentialStore({ ...base, region: 'cn' as const })
    const global = new WorkBuddyCredentialStore({ ...base, region: 'global' as const })
    const unscoped = new WorkBuddyCredentialStore(base)
    expect((await cn.accounts()).map(account => account.uin)).toEqual(['CN1'])
    expect((await global.accounts()).map(account => account.uin)).toEqual(['GL1'])
    expect((await unscoped.accounts()).map(account => account.uin).sort()).toEqual(['CN1', 'GL1'])
    // A region-scoped store cannot resolve the other region's account at all.
    const foreign = (await global.accounts())[0]?.id as string
    await expect(cn.resolve(foreign)).rejects.toThrow(/no signed-in WorkBuddy account/)
  })

  it('reports signed-out for an unknown account instead of throwing', async () => {
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(authDir, 'missing.info'),
      storeDir,
      refresh: async () => { throw new Error('not used') },
    })
    expect(await store.status('nope')).toEqual({ state: 'signed-out' })
    expect(await store.accounts()).toEqual([])
  })
})
