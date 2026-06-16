import { describe, expect, it, vi } from "vitest"
import { runWithConcurrency, withRetry, markRetryable } from "../../../src/core/transport.js"
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
