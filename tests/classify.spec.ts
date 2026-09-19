/**
 * Upstream error classification: the layer that decides WHICH thing gets
 * punished — the account, a single model, or nothing at all.
 *
 * Getting this wrong is expensive in a specific way: a model-level limit read as
 * an account-level one parks a healthy credential for hours, a WAF page read as
 * a client error rotates forever without cooling anything, and a reset instant
 * read as a generic backoff waits longer than the upstream ever asked for.
 */

import { describe, expect, it } from 'vitest'
import {
  classifyUpstreamError,
  isModelBlocked,
  isModelRateLimit,
  isWafBlocked,
  parseRateReset,
  parseRetryAfter,
} from '../src/upstream.ts'

describe('isModelRateLimit', () => {
  it('recognises code 6004 in every spacing the upstream emits', () => {
    expect(isModelRateLimit('{"code":6004,"msg":"x"}')).toBe(true)
    expect(isModelRateLimit('{"code": 6004,"msg":"x"}')).toBe(true)
    expect(isModelRateLimit('{"code":"6004","msg":"x"}')).toBe(true)
  })

  it('does not fire on other codes that merely contain 6004', () => {
    expect(isModelRateLimit('{"code":16004}')).toBe(false)
    expect(isModelRateLimit('{"code":600}')).toBe(false)
    expect(isModelRateLimit('rate limited')).toBe(false)
  })
})

describe('isModelBlocked', () => {
  it('reads the code as a field, not as a substring of the document', () => {
    // A requestId containing "11102" must not make a working model look absent.
    expect(isModelBlocked(400, '{"code":0,"requestId":"req-11102-abc"}')).toBe(false)
    expect(isModelBlocked(400, '{"code":11102,"msg":"service info not found"}')).toBe(true)
  })

  it('accepts the documented phrase in a nested error object', () => {
    expect(isModelBlocked(404, '{"error":{"code":11102,"message":"service info not found"}}')).toBe(true)
    expect(isModelBlocked(400, '{"message":"Service Info Not Found"}')).toBe(true)
  })

  it('only trusts 400 and 404, so a 429 stays a rate limit', () => {
    // 429 + 11102 is throttling semantics, not "the model does not exist".
    expect(isModelBlocked(429, '{"code":11102}')).toBe(false)
    expect(isModelBlocked(500, '{"code":11102}')).toBe(false)
  })

  it('does not mistake an unrelated not-found for a missing model', () => {
    expect(isModelBlocked(404, '{"code":0,"msg":"document not found"}')).toBe(false)
    expect(isModelBlocked(400, 'not json at all')).toBe(false)
  })
})

describe('isWafBlocked', () => {
  it('treats an envelope-free 403 as the gateway, not the API', () => {
    expect(isWafBlocked(403, '<html>403 Forbidden</html>')).toBe(true)
    expect(isWafBlocked(403, '')).toBe(true)
    expect(isWafBlocked(403, 'Forbidden')).toBe(true)
  })

  it('leaves a business 403 to its own classification', () => {
    expect(isWafBlocked(403, '{"code":11140,"msg":"request illegal"}')).toBe(false)
    expect(isWafBlocked(403, '{"msg":"quota exceeded"}')).toBe(false)
  })

  it('only applies to 403', () => {
    expect(isWafBlocked(401, '<html>unauthorized</html>')).toBe(false)
    expect(isWafBlocked(200, 'ok')).toBe(false)
  })
})

describe('parseRateReset', () => {
  it('reads the wall clock as UTC+8 regardless of the host timezone', () => {
    // 2026-09-11 18:33:27 UTC+8 is 10:33:27 UTC.
    const parsed = parseRateReset('{"code":6004,"msg":"将在 2026-09-11 18:33:27 UTC+8 重置"}')
    expect(parsed).toBe(Date.UTC(2026, 8, 11, 10, 33, 27))
  })

  it('accepts the wording without the timezone suffix', () => {
    const parsed = parseRateReset('将在 2026-09-11 18:33:27 重置')
    expect(parsed).toBe(Date.UTC(2026, 8, 11, 10, 33, 27))
  })

  it('returns nothing for prose it cannot read as a time', () => {
    // Better no answer than an invented one: the caller falls back to backoff.
    expect(parseRateReset('{"code":6004,"msg":"model usage limit exceeded"}')).toBeUndefined()
    expect(parseRateReset('将在 明天 重置')).toBeUndefined()
    expect(parseRateReset('')).toBeUndefined()
  })
})

describe('parseRetryAfter', () => {
  it('reads seconds, milliseconds, and an epoch instant', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '30' }))).toBe(30_000)
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '1500' }))).toBe(1_500)
    const epochSeconds = Math.floor((Date.now() + 20_000) / 1000)
    const parsed = parseRetryAfter(new Headers({ 'x-ratelimit-reset': String(epochSeconds) }))
    expect(parsed).toBeGreaterThan(15_000)
    expect(parsed).toBeLessThanOrEqual(20_000)
  })

  it('ignores anything it cannot trust', () => {
    // An HTTP date is a valid RFC 7231 form; rather than parse a format the
    // upstream family never sends, the value is dropped.
    expect(parseRetryAfter(new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).toBeUndefined()
    expect(parseRetryAfter(new Headers({ 'retry-after': '0' }))).toBeUndefined()
    expect(parseRetryAfter(new Headers({ 'retry-after': '-5' }))).toBeUndefined()
    // Absurd values are treated as nonsense rather than honoured.
    expect(parseRetryAfter(new Headers({ 'retry-after': '99999999' }))).toBeUndefined()
    expect(parseRetryAfter(new Headers())).toBeUndefined()
  })
})

describe('classifyUpstreamError ordering', () => {
  it('reads a model-level 429 as model_rate, not soft_rate', () => {
    expect(classifyUpstreamError(429, '{"code":6004,"msg":"将在 2026-09-11 18:33:27 重置"}')).toBe('model_rate')
    expect(classifyUpstreamError(429, '{"code":0,"msg":"rate limit"}')).toBe('soft_rate')
  })

  it('reads 11102 before the generic 4xx fallback', () => {
    expect(classifyUpstreamError(400, '{"code":11102,"msg":"service info not found"}')).toBe('model_blocked')
  })

  it('reads an envelope-free 403 as the gateway', () => {
    expect(classifyUpstreamError(403, '<html>Forbidden</html>')).toBe('waf_block')
    expect(classifyUpstreamError(403, '{"code":11140,"msg":"request illegal"}')).toBe('client')
  })

  it('keeps the status authoritative over keywords for 429', () => {
    // Rate-limit bodies routinely say "quota exceeded"; reading that as billing
    // exhaustion would park the account until 04:00 instead of a short cooldown.
    expect(classifyUpstreamError(429, '{"msg":"quota exceeded"}')).toBe('soft_rate')
    // Outside 429 the credit wording still means out of credit.
    expect(classifyUpstreamError(400, '{"msg":"quota exceeded"}')).toBe('hard_credit')
  })

  it('keeps session death ahead of rate-limit wording', () => {
    expect(classifyUpstreamError(401, 'Offline user session not found, rate limit')).toBe('session_dead')
  })

  it('reads a rate-limit phrase carried on a non-429 status', () => {
    // Without this a "usage limit reached" on 200 would look like a client error
    // and the account would keep being picked for a wall it cannot pass.
    expect(classifyUpstreamError(200, '{"msg":"usage limit reached"}')).toBe('soft_rate')
    expect(classifyUpstreamError(400, '{"msg":"请求过于频繁"}')).toBe('soft_rate')
  })

  it('still reads the ordinary cases the old chain handled', () => {
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
    expect(classifyUpstreamError(401, '{"code":12153}')).toBe('session_dead')
    expect(classifyUpstreamError(404, '')).toBe('not_found')
    expect(classifyUpstreamError(503, '')).toBe('server')
    expect(classifyUpstreamError(400, 'bad params')).toBe('client')
  })
})
