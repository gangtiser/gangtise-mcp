import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  loadConfig,
  resolveInlineMaxBytes,
  resolvePageConcurrency,
  resolveTimeoutMs,
  MAX_PAGE_CONCURRENCY,
  MAX_TIMEOUT_MS,
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

  it("clamps page concurrency to the ceiling so a huge value can't exhaust sockets / hammer the API", () => {
    expect(resolvePageConcurrency("32")).toBe(32) // ceiling accepted as-is
    expect(resolvePageConcurrency("33")).toBe(MAX_PAGE_CONCURRENCY) // just over → clamped
    expect(resolvePageConcurrency("100000")).toBe(MAX_PAGE_CONCURRENCY)
    expect(MAX_PAGE_CONCURRENCY).toBe(32)
  })

  it("GANGTISE_TIMEOUT_MS 只收整数毫秒：小数、科学计数、带单位回退默认，不足 1 秒回退，超过 1 小时夹到上限", () => {
    expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS)
    expect(resolveTimeoutMs("45000")).toBe(45_000)
    expect(resolveTimeoutMs(" 45000 ")).toBe(45_000)
    expect(resolveTimeoutMs("1000")).toBe(1_000)
    for (const bad of ["0.5", "1e4", "30s", "5000.0", "0x10", "-1000"]) expect(resolveTimeoutMs(bad), bad).toBe(DEFAULT_TIMEOUT_MS)
    // 把秒当毫秒写（30）会让每个请求都超时，按无效处理而不是照用。
    expect(resolveTimeoutMs("30")).toBe(DEFAULT_TIMEOUT_MS)
    expect(resolveTimeoutMs("999")).toBe(DEFAULT_TIMEOUT_MS)
    expect(resolveTimeoutMs("3600001")).toBe(MAX_TIMEOUT_MS)
    expect(resolveTimeoutMs("99999999999")).toBe(MAX_TIMEOUT_MS)
  })

  it("GANGTISE_TIMEOUT_MS 未按原值生效时在 stderr 提示一次，按原值生效时不提示", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      process.env.GANGTISE_TIMEOUT_MS = "60000"
      loadConfig()
      expect(write).not.toHaveBeenCalled()
      process.env.GANGTISE_TIMEOUT_MS = "30"
      expect(loadConfig().timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
      loadConfig()
      const warnings = write.mock.calls.map((call) => String(call[0])).filter((text) => text.includes("GANGTISE_TIMEOUT_MS"))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("GANGTISE_TIMEOUT_MS=30 is not in effect")
    } finally {
      write.mockRestore()
    }
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
