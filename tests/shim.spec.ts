/**
 * Loopback shim behaviour: inbound hardening plus multi-account dispatch.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 入站加固的用例（Host/Origin/bearer/Content-Type 四重校验）来自该项目
 *     （其源自 corrinehu/dsh-workbuddy-connect (MIT)）。
 * 改动：新增多账号调度的端到端用例 —— 换号重试、会话粘性、
 *   额度不足后不再选中该账号、池耗尽时的错误分类。
 */

import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { WorkBuddyAccountPool } from '../src/pool.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'

let dir: string
let authDir: string
let storeDir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb2api-shim-'))
  authDir = join(dir, 'auth')
  storeDir = join(dir, 'home')
  await mkdir(authDir, { recursive: true })
  await mkdir(storeDir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Write one desktop auth document for `uin`. */
async function writeAuth(name: string, uin: string): Promise<void> {
  await writeFile(join(authDir, name), JSON.stringify({
    auth: {
      accessToken: `token-${uin}`,
      refreshToken: `refresh-${uin}`,
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
      lastRefreshTime: 1_700_000_000,
      domain: 'codebuddy.cn',
    },
    account: { uin, uid: `uid-${uin}`, nickname: `user-${uin}` },
  }), 'utf8')
}

/** One recorded upstream attempt. */
interface Attempt {
  accountId: string
  accessToken: string
}

/** A shim plus the attempts its fake upstream observed. */
async function makeShim(
  uins: readonly string[],
  chat: (credential: WorkBuddyCredential, attempt: number, bodyJson: string) => Promise<WorkBuddyChatResult>,
  options: { maxAttempts?: number; policy?: Record<string, unknown>; random?: () => number } = {},
): Promise<{ shim: WorkBuddyShim; attempts: Attempt[]; pool: WorkBuddyAccountPool }> {
  for (const [index, uin] of uins.entries()) {
    await writeAuth(index === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.2026-08-0${index}T00.info`, uin)
  }
  // Region-scoped like the real host: the shim in front of ONE region's pool
  // must never reach around it to the other region's accounts.
  const store = new WorkBuddyCredentialStore({
    region: 'cn',
    desktopPath: join(authDir, 'workbuddy-desktop.info'),
    storeDir,
    refresh: async () => { throw new Error('refresh must not be needed') },
  })
  const pool = new WorkBuddyAccountPool({
    list: () => store.accounts(),
    ...options.policy === undefined ? {} : { policy: options.policy },
    ...options.random === undefined ? {} : { random: options.random },
  })
  await pool.refresh()
  const attempts: Attempt[] = []
  const shim = createWorkBuddyShim({
    store,
    pool,
    catalog: new WorkBuddyCatalog('cn'),
    ...options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts },
    client: {
      async chatStream(credential, bodyJson): Promise<WorkBuddyChatResult> {
        attempts.push({
          accountId: credential.uin as string,
          accessToken: credential.accessToken,
        })
        return chat(credential, attempts.length, bodyJson)
      },
    },
  })
  await shim.ready
  return { shim, attempts, pool }
}

/** POST one chat request at the shim. */
async function chat(
  shim: WorkBuddyShim,
  body: unknown,
  options: { token?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${options.token ?? shim.token()}`,
      ...options.headers,
    },
    body: JSON.stringify(body),
  })
}

const SSE_OK = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'

/** POST through a raw HTTP client, where the Host header is settable. */
function rawPostStatus(
  origin: URL,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: origin.hostname,
      port: origin.port,
      path,
      method: 'POST',
      setHost: false,
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
    }, response => {
      response.resume()
      response.once('end', () => { resolve(response.statusCode ?? 0) })
    })
    request.once('error', reject)
    request.end(body)
  })
}

describe('shim inbound hardening', () => {
  it('rejects a request without the shared bearer', async () => {
    const { shim } = await makeShim(['A'], async () => ({
      ok: true, response: new Response(SSE_OK, { status: 200 }),
    }))
    const response = await chat(shim, { messages: [] }, { token: 'wrong' })
    expect(response.status).toBe(401)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('unauthorized')
    await shim.close()
  })

  it('rejects a non-loopback Origin', async () => {
    const { shim } = await makeShim(['A'], async () => ({
      ok: true, response: new Response(SSE_OK, { status: 200 }),
    }))
    const response = await chat(shim, { messages: [] }, { headers: { origin: 'https://evil.example' } })
    expect(response.status).toBe(403)
    await shim.close()
  })

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const { shim } = await makeShim(['A'], async () => ({
      ok: true, response: new Response(SSE_OK, { status: 200 }),
    }))
    // `fetch` treats Host as a forbidden header and would send the real one, so
    // the rebinding case has to go through a raw HTTP client.
    const status = await rawPostStatus(new URL(shim.baseUrl()), '/v1/chat/completions', {
      host: 'evil.example',
      'content-type': 'application/json',
      authorization: `Bearer ${shim.token()}`,
    }, '{"messages":[]}')
    expect(status).toBe(403)
    await shim.close()
  })

  it('rejects a chat POST that is not JSON', async () => {
    const { shim } = await makeShim(['A'], async () => ({
      ok: true, response: new Response(SSE_OK, { status: 200 }),
    }))
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${shim.token()}` },
      body: 'hello',
    })
    expect(response.status).toBe(415)
    await shim.close()
  })

  it('serves /v1/models and /healthz behind the bearer', async () => {
    const { shim } = await makeShim(['A'], async () => ({
      ok: true, response: new Response(SSE_OK, { status: 200 }),
    }))
    const models = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    expect(models.status).toBe(200)
    expect((await models.json() as { data: unknown[] }).data.length).toBeGreaterThan(0)
    const health = await fetch(`${shim.baseUrl()}/healthz`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    expect(await health.json()).toMatchObject({ ok: true, accounts: 1 })
    await shim.close()
  })

  it('answers 404 for an unknown route', async () => {
    const { shim } = await makeShim(['A'], async () => ({
      ok: true, response: new Response(SSE_OK, { status: 200 }),
    }))
    const response = await fetch(`${shim.baseUrl()}/v1/nope`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    expect(response.status).toBe(404)
    await shim.close()
  })
})

describe('shim multi-account dispatch', () => {
  it('streams from one account and reports the success', async () => {
    const { shim, attempts, pool } = await makeShim(['A'], async () => ({
      ok: true, response: new Response(SSE_OK, { status: 200 }),
    }))
    const response = await chat(shim, { messages: [{ role: 'user', content: 'hello' }] })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')
    expect(attempts).toEqual([{ accountId: 'A', accessToken: 'token-A' }])
    expect(pool.snapshot()[0]?.successes).toBe(1)
    await shim.close()
  })

  it('retries on another account when the first is out of credits', async () => {
    const { shim, attempts, pool } = await makeShim(['A', 'B'], async credential => credential.uin === 'A'
      ? { ok: false, status: 402, kind: 'hard_credit', message: 'insufficient credit' }
      : { ok: true, response: new Response(SSE_OK, { status: 200 }) }, { random: () => 0 })
    const response = await chat(shim, { messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(200)
    expect(attempts.map(attempt => attempt.accountId)).toEqual(['A', 'B'])
    const entries = pool.snapshot()
    expect(entries.find(entry => entry.accountName === 'user-A')?.state).toBe('cooldown')
    expect(entries.find(entry => entry.accountName === 'user-A')?.cooldownKind).toBe('hard')
    expect(entries.find(entry => entry.accountName === 'user-B')?.successes).toBe(1)
    await shim.close()
  })

  it('does not retry a malformed request: a client error is the caller\'s fault', async () => {
    const { shim, attempts } = await makeShim(['A', 'B'], async () => ({
      ok: false, status: 400, kind: 'client', message: 'bad request',
    }))
    const response = await chat(shim, { messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(400)
    expect(attempts).toHaveLength(1)
    await shim.close()
  })

  it('reports the last upstream failure once every account has been tried', async () => {
    const { shim, attempts } = await makeShim(['A', 'B'], async () => ({
      ok: false, status: 429, kind: 'soft_rate', message: 'too many requests',
    }))
    const response = await chat(shim, { messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(429)
    expect(attempts.map(attempt => attempt.accountId).sort()).toEqual(['A', 'B'])
    await shim.close()
  })

  it('stops after maxAttempts even when more accounts remain', async () => {
    const { shim, attempts } = await makeShim(['A', 'B', 'C'], async () => ({
      ok: false, status: 500, kind: 'server', message: 'boom',
    }), { maxAttempts: 2 })
    const response = await chat(shim, { messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(502)
    expect(attempts).toHaveLength(2)
    await shim.close()
  })

  it('keeps a conversation on one account across requests', async () => {
    const { shim, attempts } = await makeShim(['A', 'B'], async () => ({
      ok: true, response: new Response(SSE_OK, { status: 200 }),
    }))
    const body = { messages: [
      { role: 'system', content: 'you are dsh' },
      { role: 'user', content: 'first question' },
    ] }
    for (let turn = 0; turn < 3; turn += 1) {
      const response = await chat(shim, body)
      expect(response.status).toBe(200)
      await response.text()
    }
    expect(new Set(attempts.map(attempt => attempt.accountId)).size).toBe(1)
    await shim.close()
  })

  it('answers a clear pool error when no account is signed in', async () => {
    const store = new WorkBuddyCredentialStore({
      region: 'cn',
      desktopPath: join(authDir, 'missing.info'),
      storeDir,
      refresh: async () => { throw new Error('not used') },
    })
    const pool = new WorkBuddyAccountPool({ list: () => store.accounts() })
    const shim = createWorkBuddyShim({
      store,
      pool,
      catalog: new WorkBuddyCatalog('cn'),
      client: { async chatStream() { throw new Error('must not be called') } },
    })
    await shim.ready
    const response = await chat(shim, { messages: [] })
    expect(response.status).toBe(401)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('no-accounts')
    await shim.close()
  })

  it('refuses with a pool error when every account is switched off', async () => {
    const { shim, pool, attempts } = await makeShim(['A'], async () => ({
      ok: true, response: new Response(SSE_OK, { status: 200 }),
    }))
    pool.configure([{ accountId: pool.snapshot()[0]?.accountId as string, enabled: false }])
    const response = await chat(shim, { messages: [] })
    expect(response.status).toBe(503)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('all-disabled')
    expect(attempts).toHaveLength(0)
    await shim.close()
  })

  it('rewrites the request body for the upstream before forwarding', async () => {
    let seen = ''
    const { shim } = await makeShim(['A'], async (_credential, _attempt, bodyJson) => {
      seen = bodyJson
      return { ok: true, response: new Response(SSE_OK, { status: 200 }) }
    })
    await chat(shim, {
      messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }],
      stream: false,
      tool_choice: { type: 'function', function: { name: 'read' } },
    })
    const forwarded = JSON.parse(seen) as { stream: boolean; tool_choice: unknown; messages: { role: string }[] }
    expect(forwarded.stream).toBe(true)
    expect(forwarded.tool_choice).toBe('read')
    expect(forwarded.messages[0]?.role).toBe('system')
    await shim.close()
  })
})
