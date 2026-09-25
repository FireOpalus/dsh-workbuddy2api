/**
 * The route-backed settings scope.
 *
 * This module exists because 0.1.7-rc.2 removed the browser-side settings
 * service, so it carries the whole burden of the card's settings access. Three
 * properties matter and none of them are obvious from the code:
 *   - `getSnapshot()` is called DURING RENDER, so it must be synchronous;
 *   - a change therefore has to arrive through `subscribe()`;
 *   - a host that cannot answer must leave the card readable, not crash it.
 */

import { describe, expect, it } from 'vitest'
import { createRouteSettingsScope } from '../src/client/scope.ts'

/** A fetch stub recording every call, answering from a scripted host. */
function fakeFetch(options: {
  body?: unknown
  ok?: boolean
  status?: number
  /** Fail every call, to reproduce an unreachable host. */
  fail?: boolean
} = {}): { fetch: typeof globalThis.fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), ...init === undefined ? {} : { init } })
    if (options.fail === true) throw new Error('network down')
    const ok = options.ok ?? true
    const status = options.status ?? (ok ? 200 : 500)
    return {
      ok,
      status,
      json: async () => options.body ?? { writable: true, value: { regions: {} } },
    } as unknown as Response
  }
  return { fetch: impl as unknown as typeof globalThis.fetch, calls }
}

/** Let the adapter's fire-and-forget initial read settle. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('createRouteSettingsScope', () => {
  it('answers synchronously from a cache, before the first read lands', () => {
    // It is called during render, so it cannot be async — that is the entire
    // reason this adapter caches instead of fetching on demand.
    const { fetch } = fakeFetch()
    const scope = createRouteSettingsScope({ url: '/config', fetch })
    expect(scope.getSnapshot()).toEqual({ status: 'loading', writable: false })
  })

  it('publishes the host document once the read lands', async () => {
    const { fetch, calls } = fakeFetch({ body: { writable: true, value: { regions: { cn: {} } } } })
    const scope = createRouteSettingsScope({ url: '/config', fetch })
    await settle()
    expect(scope.getSnapshot().status).toBe('ready')
    expect(scope.getSnapshot().writable).toBe(true)
    expect(scope.getSnapshot().value).toEqual({ regions: { cn: {} } })
    expect(calls[0]?.url).toBe('/config')
  })

  it('notifies subscribers on every refresh, since that is the only signal', async () => {
    const { fetch } = fakeFetch()
    const scope = createRouteSettingsScope({ url: '/config', fetch })
    const seen: number[] = []
    scope.subscribe(() => seen.push(1))
    await settle()
    expect(seen.length).toBeGreaterThan(0)
  })

  it('stops notifying after unsubscribe', async () => {
    const { fetch } = fakeFetch()
    const scope = createRouteSettingsScope({ url: '/config', fetch })
    let count = 0
    const off = scope.subscribe(() => { count += 1 })
    await settle()
    const before = count
    off()
    await scope.set('tasks', { enabled: false })
    expect(count).toBe(before)
  })

  it('merges ONE field on the host and re-reads what was stored', async () => {
    const { fetch, calls } = fakeFetch({ body: { writable: true, value: { tasks: { enabled: false } } } })
    const scope = createRouteSettingsScope({ url: '/config', fetch })
    await settle()
    await scope.set('tasks', { enabled: false })
    const post = calls.find(call => call.init?.method === 'POST')
    expect(post).toBeDefined()
    expect(JSON.parse(String(post?.init?.body))).toEqual({ field: 'tasks', value: { enabled: false } })
    // A GET after the POST: the form must render the host's truth, not the echo.
    expect(calls.filter(call => call.init?.method !== 'POST').length).toBeGreaterThanOrEqual(2)
    expect(scope.getSnapshot().value).toEqual({ tasks: { enabled: false } })
  })

  it('surfaces the host refusal instead of failing silently', async () => {
    const { fetch } = fakeFetch({ ok: false, status: 403, body: { error: 'settings are read-only here' } })
    const scope = createRouteSettingsScope({ url: '/config', fetch })
    await settle()
    await expect(scope.set('tasks', {})).rejects.toThrow('settings are read-only here')
  })

  it('degrades to read-only when the host cannot be reached', async () => {
    // The card must stay readable: losing the settings form is acceptable,
    // losing the entry (a boot-level failure) is not.
    const { fetch } = fakeFetch({ fail: true })
    const scope = createRouteSettingsScope({ url: '/config', fetch })
    await settle()
    expect(scope.getSnapshot()).toEqual({ status: 'error', writable: false })
  })

  it('keeps telling the other subscribers when one throws', async () => {
    const { fetch } = fakeFetch()
    const scope = createRouteSettingsScope({ url: '/config', fetch })
    let reached = 0
    scope.subscribe(() => { throw new Error('bad subscriber') })
    scope.subscribe(() => { reached += 1 })
    await settle()
    expect(reached).toBeGreaterThan(0)
  })
})
