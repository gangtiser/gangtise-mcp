import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  loadConfig,
  resolveInlineMaxBytes,
  resolvePageConcurrency,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_ASYNC_TIMEOUT_MS,
  DEFAULT_INLINE_MAX_BYTES,
  DEFAULT_PAGE_CONCURRENCY,
  DEFAULT_TOKEN_CACHE_PATH,
} from "../../../src/core/config.js"

const KEYS = [
  "GANGTISE_BASE_URL",
  "GANGTISE_TIMEOUT_MS",
  "GANGTISE_MCP_ASYNC_TIMEOUT_MS",
  "GANGTISE_ACCESS_KEY",
  "GANGTISE_SECRET_KEY",
  "GANGTISE_TOKEN",
  "GANGTISE_TOKEN_CACHE_PATH",
] as const

describe("loadConfig", () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it("falls back to documented defaults when no env is set", () => {
    const c = loadConfig()
    expect(c.baseUrl).toBe(DEFAULT_BASE_URL)
    expect(c.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(c.asyncTimeoutMs).toBe(DEFAULT_ASYNC_TIMEOUT_MS)
    expect(c.tokenCachePath).toBe(DEFAULT_TOKEN_CACHE_PATH)
    expect(c.accessKey).toBeUndefined()
    expect(c.secretKey).toBeUndefined()
    expect(c.token).toBeUndefined()
  })

  it("keeps the async wait default under the MCP client's ~60s request timeout", () => {
    // The default wait must return {dataId, status:"timeout"} before the client
    // (DEFAULT_REQUEST_TIMEOUT_MSEC = 60s) cuts the connection, or the billed task's
    // dataId is lost and *_check can't recover it. Don't raise past ~59s without a
    // per-call waitSeconds or progress-notification timeout resets.
    expect(DEFAULT_ASYNC_TIMEOUT_MS).toBeLessThan(60_000)
  })

  it("reads overrides from env", () => {
    process.env.GANGTISE_BASE_URL = "https://example.test"
    process.env.GANGTISE_TIMEOUT_MS = "5000"
    process.env.GANGTISE_MCP_ASYNC_TIMEOUT_MS = "90000"
    process.env.GANGTISE_ACCESS_KEY = "ak"
    process.env.GANGTISE_SECRET_KEY = "sk"
    process.env.GANGTISE_TOKEN = "tok"
    process.env.GANGTISE_TOKEN_CACHE_PATH = "/tmp/custom-token.json"

    const c = loadConfig()
    expect(c.baseUrl).toBe("https://example.test")
    expect(c.timeoutMs).toBe(5000)
    expect(c.asyncTimeoutMs).toBe(90000)
    expect(c.accessKey).toBe("ak")
    expect(c.secretKey).toBe("sk")
    expect(c.token).toBe("tok")
    expect(c.tokenCachePath).toBe("/tmp/custom-token.json")
  })

  it("resolves the inline byte budget: default, valid override, 8KB floor, bad input", () => {
    expect(resolveInlineMaxBytes(undefined)).toBe(DEFAULT_INLINE_MAX_BYTES)
    expect(resolveInlineMaxBytes("131072")).toBe(131_072)
    expect(resolveInlineMaxBytes("65536.9")).toBe(65_536) // floored to int
    expect(resolveInlineMaxBytes("bad")).toBe(DEFAULT_INLINE_MAX_BYTES)
    expect(resolveInlineMaxBytes("")).toBe(DEFAULT_INLINE_MAX_BYTES)
    expect(resolveInlineMaxBytes("1024")).toBe(DEFAULT_INLINE_MAX_BYTES) // below the 8KB floor
  })

  it("resolves page concurrency: default, valid override, int floor, rejects zero/negative/bad", () => {
    expect(resolvePageConcurrency(undefined)).toBe(DEFAULT_PAGE_CONCURRENCY)
    expect(resolvePageConcurrency("10")).toBe(10)
    expect(resolvePageConcurrency("3.9")).toBe(3) // floored to int
    expect(resolvePageConcurrency("0")).toBe(DEFAULT_PAGE_CONCURRENCY) // 0 would stall all fan-out
    expect(resolvePageConcurrency("-2")).toBe(DEFAULT_PAGE_CONCURRENCY)
    expect(resolvePageConcurrency("bad")).toBe(DEFAULT_PAGE_CONCURRENCY)
    expect(resolvePageConcurrency("")).toBe(DEFAULT_PAGE_CONCURRENCY)
  })

  it("ignores empty, non-numeric, zero, and negative timeouts", () => {
    for (const bad of ["", "abc", "0", "-5"]) {
      process.env.GANGTISE_TIMEOUT_MS = bad
      process.env.GANGTISE_MCP_ASYNC_TIMEOUT_MS = bad
      const c = loadConfig()
      expect(c.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
      expect(c.asyncTimeoutMs).toBe(DEFAULT_ASYNC_TIMEOUT_MS)
    }
  })
})
