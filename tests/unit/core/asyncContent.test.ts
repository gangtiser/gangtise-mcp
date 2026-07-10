import { describe, it, expect, vi, afterEach } from "vitest"
import { pollAsyncContent } from "../../../src/core/asyncContent.js"
import { ApiError, AsyncTimeoutError } from "../../../src/core/errors.js"

function pendingError() {
  return new ApiError("processing", "410110")
}

describe("pollAsyncContent", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns content from the first successful poll", async () => {
    const client = { call: vi.fn().mockResolvedValue({ content: "# 报告" }) }
    await expect(pollAsyncContent(client, "ai.earnings-review.get-content", "d1", 1_000))
      .resolves.toEqual({ content: "# 报告" })
    expect(client.call).toHaveBeenCalledTimes(1)
    expect(client.call).toHaveBeenCalledWith("ai.earnings-review.get-content", { dataId: "d1" })
  })

  it("keeps polling through 410110 pending errors until content is ready", async () => {
    vi.useFakeTimers()
    const client = {
      call: vi.fn()
        .mockRejectedValueOnce(pendingError())
        .mockRejectedValueOnce(pendingError())
        .mockResolvedValueOnce({ content: "ready" }),
    }
    const result = pollAsyncContent(client, "ep", "d1", 60_000)
    await vi.advanceTimersByTimeAsync(5_000) // first backoff delay
    await vi.advanceTimersByTimeAsync(8_000) // second backoff delay (5s * 1.6)
    await expect(result).resolves.toEqual({ content: "ready" })
    expect(client.call).toHaveBeenCalledTimes(3)
  })

  it("fails fast on 410111 without retrying", async () => {
    const client = { call: vi.fn().mockRejectedValue(new ApiError("generation failed", "410111")) }
    await expect(pollAsyncContent(client, "ep", "d1", 60_000)).rejects.toMatchObject({ code: "410111" })
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it("rethrows non-pending errors immediately", async () => {
    const client = { call: vi.fn().mockRejectedValue(new Error("network down")) }
    await expect(pollAsyncContent(client, "ep", "d1", 60_000)).rejects.toThrow("network down")
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it("throws AsyncTimeoutError carrying the dataId once the deadline passes", async () => {
    vi.useFakeTimers()
    const client = { call: vi.fn().mockRejectedValue(pendingError()) }
    const result = pollAsyncContent(client, "ep", "d-timeout", 7_000)
    const assertion = expect(result).rejects.toBeInstanceOf(AsyncTimeoutError)
    await vi.advanceTimersByTimeAsync(7_001)
    await assertion
    await expect(result).rejects.toMatchObject({ dataId: "d-timeout" })
  })

  it("times out at the deadline even when a single poll call stalls past it", async () => {
    vi.useFakeTimers()
    // Models a poll whose HTTP request stalls near the request timeout: it only
    // settles at 30s, but the wait budget is 5s. The loop bounds its *sleep* by
    // the deadline; it must also bound the *call*, or a poll fired with a sliver
    // of budget left blocks until the stalled call returns — overshooting the
    // deadline (and the client's ~60s cutoff) and losing the billed dataId.
    const client = {
      call: vi.fn(
        () => new Promise<{ content: string }>(resolve => setTimeout(() => resolve({ content: "too late" }), 30_000)),
      ),
    }
    const result = pollAsyncContent(client, "ep", "d-stall", 5_000)
    const assertion = expect(result).rejects.toBeInstanceOf(AsyncTimeoutError)
    await vi.advanceTimersByTimeAsync(5_001)
    await assertion
    await expect(result).rejects.toMatchObject({ dataId: "d-stall" })
    expect(client.call).toHaveBeenCalledTimes(1)
  }, 1_500)
})
