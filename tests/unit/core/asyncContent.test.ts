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

  // A transient blip (5xx / network reset) after the transport's own retries are
  // exhausted must not abandon a multi-minute wait — the poll consumes one
  // attempt and keeps waiting. Terminal and non-transient errors still abort.
  it("keeps waiting through a transient 5xx and returns the late content", async () => {
    vi.useFakeTimers()
    const client = {
      call: vi.fn()
        .mockRejectedValueOnce(new ApiError("bad gateway", undefined, 502))
        .mockResolvedValueOnce({ content: "ready" }),
    }
    const result = pollAsyncContent(client, "ep", "d1", 60_000)
    await vi.advanceTimersByTimeAsync(5_000) // backoff after the tolerated blip
    await expect(result).resolves.toEqual({ content: "ready" })
    expect(client.call).toHaveBeenCalledTimes(2)
  })

  it("rethrows a non-transient ApiError (400) immediately", async () => {
    const client = { call: vi.fn().mockRejectedValue(new ApiError("bad request", undefined, 400)) }
    await expect(pollAsyncContent(client, "ep", "d1", 60_000)).rejects.toThrow("bad request")
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})

// 服务端把异步状态码从 410110/410111 重排为 140001/140002（RESULT_GENERATING /
// PROCESSING_FAILED）。切换那天若不认新的 pending 码，首次轮询就会把「生成中」当硬错
// 抛出，作废一个已扣 50 积分的任务——故两代并存识别。
describe("async status codes across the 2026-07-17 renumbering", () => {
  it("keeps polling through the new 140001 pending code", async () => {
    vi.useFakeTimers()
    const client = {
      call: vi.fn()
        .mockRejectedValueOnce(new ApiError("生成中", "140001", 409))
        .mockResolvedValueOnce({ content: "ready" }),
    }
    const result = pollAsyncContent(client, "ep", "d1", 60_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(result).resolves.toEqual({ content: "ready" })
    expect(client.call).toHaveBeenCalledTimes(2)
  })

  it("fails fast on the new 140002 terminal code without burning the wait budget", async () => {
    const client = { call: vi.fn().mockRejectedValue(new ApiError("生成失败", "140002", 500)) }
    await expect(pollAsyncContent(client, "ep", "d1", 60_000)).rejects.toMatchObject({ code: "140002" })
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})

// 🔴 截止时间的 timer 在 `run()` 求值**之前**就建好了。`run()` 同步抛时 `.finally` 永远
// 不会建立，于是 budgetMs 之后那次 reject 落在一个没有 handler 的 promise 上 —— Node 默认
// 对 unhandled rejection 是**直接退进程**，而 MCP server 是常驻的。
//
// 旧签名收的是已经求值的 promise，同步抛发生在 withPollDeadline 之外，没有这条路径；把求值
// 搬进来（为了能在它外面套取消上下文）就得自己收尾。生产上 `client.call` 是 async 方法、
// 不会同步抛，但代价与概率不对称：一条永不触发的清理不值几行代码，退进程值。
describe("a synchronously throwing client leaves no orphan deadline timer", () => {
  it("rethrows the original error and clears the deadline timer", async () => {
    vi.useFakeTimers()
    try {
      const client = { call: () => { throw new Error("boom: synchronous throw") } }
      await expect(pollAsyncContent(client, "ep", "d-sync", 30_000)).rejects.toThrow("boom: synchronous throw")
      expect(vi.getTimerCount(), "截止时间的 timer 泄漏了 —— 它到期时会引发 unhandledRejection").toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
