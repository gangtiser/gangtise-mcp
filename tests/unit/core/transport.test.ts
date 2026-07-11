import { describe, expect, it, vi } from "vitest"
import { runWithConcurrency, withRetry, markRetryable, computeRetryDelay, isRetryableError } from "../../../src/core/transport.js"
import { ApiError } from "../../../src/core/errors.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fast = { baseDelayMs: 1, maxDelayMs: 4 }

describe("runWithConcurrency", () => {
  it("returns results in input order", async () => {
    const res = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => x * 10)
    expect(res).toEqual([10, 20, 30, 40, 50])
  })

  it("never exceeds the concurrency limit", async () => {
    let active = 0
    let peak = 0
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (x) => {
      active++
      peak = Math.max(peak, active)
      await sleep(5)
      active--
      return x
    })
    expect(peak).toBeLessThanOrEqual(3)
  })

  it("returns [] for an empty input", async () => {
    expect(await runWithConcurrency([], 4, async (x) => x)).toEqual([])
  })

  it("rejects with the first error and stops pulling remaining items", async () => {
    const seen: number[] = []
    await expect(
      runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (x) => {
        seen.push(x)
        if (x === 2) throw new Error("boom")
        await sleep(2)
        return x
      }),
    ).rejects.toThrow("boom")
    expect(seen).not.toContain(6)
  })
})

describe("withRetry", () => {
  it("returns immediately on success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok")
    expect(await withRetry(fn, fast)).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("retries a retryable error then succeeds", async () => {
    let attempts = 0
    const result = await withRetry(async () => {
      attempts++
      if (attempts < 3) throw new ApiError("server", undefined, 503)
      return "recovered"
    }, fast)
    expect(result).toBe("recovered")
    expect(attempts).toBe(3)
  })

  it("does not retry a non-retryable ApiError (HTTP 400)", async () => {
    const fn = vi.fn().mockRejectedValue(new ApiError("bad request", undefined, 400))
    await expect(withRetry(fn, fast)).rejects.toThrow("bad request")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("gives up after exhausting the retry budget", async () => {
    const fn = vi.fn().mockRejectedValue(new ApiError("flaky", undefined, 500))
    await expect(withRetry(fn, { ...fast, retries: 2 })).rejects.toThrow("flaky")
    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it("retries errors explicitly marked retryable", async () => {
    let attempts = 0
    const result = await withRetry(async () => {
      attempts++
      if (attempts < 2) throw markRetryable(new Error("transient"))
      return "ok"
    }, fast)
    expect(result).toBe("ok")
    expect(attempts).toBe(2)
  })

  it("retries on network error codes", async () => {
    let attempts = 0
    const result = await withRetry(async () => {
      attempts++
      if (attempts < 2) throw Object.assign(new Error("reset"), { code: "ECONNRESET" })
      return "ok"
    }, fast)
    expect(result).toBe("ok")
    expect(attempts).toBe(2)
  })

  it("invokes onRetry for each retry", async () => {
    const onRetry = vi.fn()
    let attempts = 0
    await withRetry(async () => {
      attempts++
      if (attempts < 3) throw new ApiError("x", undefined, 502)
      return "ok"
    }, { ...fast, onRetry })
    expect(onRetry).toHaveBeenCalledTimes(2)
  })
})

describe("isRetryableError policies", () => {
  const netErr = (code: string) => Object.assign(new Error(code), { code })

  describe("default policy", () => {
    it("retries connect-phase errors (request never sent)", () => {
      expect(isRetryableError(netErr("ECONNREFUSED"), "default")).toBe(true)
      expect(isRetryableError(netErr("UND_ERR_CONNECT_TIMEOUT"), "default")).toBe(true)
    })

    it("keeps 5xx / 999999 / response-phase errors retryable", () => {
      expect(isRetryableError(new ApiError("s", undefined, 502), "default")).toBe(true)
      expect(isRetryableError(new ApiError("sys", "999999", 500), "default")).toBe(true)
      expect(isRetryableError(netErr("UND_ERR_HEADERS_TIMEOUT"), "default")).toBe(true)
    })

    it("still refuses non-transient errors", () => {
      expect(isRetryableError(new ApiError("bad", undefined, 400), "default")).toBe(false)
    })
  })

  describe("no-replay policy (per-call billed endpoints)", () => {
    it("never replays a request the server may have executed", () => {
      expect(isRetryableError(new ApiError("s", undefined, 502), "no-replay")).toBe(false)
      expect(isRetryableError(new ApiError("sys", "999999", 500), "no-replay")).toBe(false)
      expect(isRetryableError(netErr("UND_ERR_HEADERS_TIMEOUT"), "no-replay")).toBe(false)
      expect(isRetryableError(netErr("ECONNRESET"), "no-replay")).toBe(false)
      expect(isRetryableError(new Error("Headers Timeout Error"), "no-replay")).toBe(false)
    })

    it("retries connect-phase errors — the request provably never reached the server", () => {
      for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) {
        expect(isRetryableError(netErr(code), "no-replay")).toBe(true)
      }
    })

    it("retries 429 (rejected before processing) and explicit token-self-heal marks", () => {
      expect(isRetryableError(new ApiError("rate", undefined, 429), "no-replay")).toBe(true)
      expect(isRetryableError(markRetryable(new Error("auth refreshed")), "no-replay")).toBe(true)
    })
  })

  describe("no-999999 policy (EDE no-data sentinel)", () => {
    it("does not retry 999999 even with a retryable HTTP status", () => {
      expect(isRetryableError(new ApiError("no data", "999999", 500), "no-999999")).toBe(false)
    })

    it("keeps everything else on the default policy", () => {
      expect(isRetryableError(new ApiError("s", undefined, 503), "no-999999")).toBe(true)
      expect(isRetryableError(netErr("ECONNRESET"), "no-999999")).toBe(true)
    })
  })
})

describe("withRetry policy plumbing", () => {
  it("fails fast on a 5xx under no-replay", async () => {
    const fn = vi.fn().mockRejectedValue(new ApiError("server", undefined, 500))
    await expect(withRetry(fn, { ...fast, policy: "no-replay" })).rejects.toThrow("server")
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe("computeRetryDelay", () => {
  // 5th ApiError arg is retryAfterMs (parsed from the Retry-After header).
  const rateLimited = (ms: number) => new ApiError("rate limited", undefined, 429, undefined, ms)

  it("backs off harder for HTTP 429 than a generic 5xx at the same attempt", () => {
    const rate = computeRetryDelay(new ApiError("x", undefined, 429), 0, 400, 4_000)
    const generic = computeRetryDelay(new ApiError("x", undefined, 500), 0, 400, 4_000)
    expect(rate).toBeGreaterThanOrEqual(2_000)
    expect(rate).toBeLessThan(4_000)
    expect(rate).toBeGreaterThan(generic)
  })

  it("leaves the 5xx / network backoff unchanged (400ms base, 4s ceil)", () => {
    const low = computeRetryDelay(new ApiError("x", undefined, 503), 0, 400, 4_000)
    expect(low).toBeGreaterThanOrEqual(400)
    expect(low).toBeLessThan(800)
    // caps at maxDelay on a high attempt
    expect(computeRetryDelay(new ApiError("x", undefined, 500), 6, 400, 4_000)).toBe(4_000)
    // a non-ApiError (network) error also takes the generic path
    expect(computeRetryDelay(new Error("reset"), 0, 400, 4_000)).toBeLessThan(800)
  })

  it("honors Retry-After when the server asks for longer than the computed backoff", () => {
    expect(computeRetryDelay(rateLimited(10_000), 0, 400, 4_000)).toBe(10_000)
  })

  it("caps a huge or hostile Retry-After at the 15s ceiling", () => {
    expect(computeRetryDelay(rateLimited(600_000), 0, 400, 4_000)).toBe(15_000)
  })

  it("honors Retry-After on a non-429 status too (e.g. 503)", () => {
    const e = new ApiError("unavailable", undefined, 503, undefined, 5_000)
    expect(computeRetryDelay(e, 0, 400, 4_000)).toBe(5_000)
  })
})
