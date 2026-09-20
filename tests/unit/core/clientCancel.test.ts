import { describe, expect, it, vi } from "vitest"

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici")
  return { ...actual, request: requestMock }
})

import { GangtiseClient } from "../../../src/core/client.js"
import { runWithRequestContext } from "../../../src/core/requestContext.js"
import { pollAsyncContent } from "../../../src/core/asyncContent.js"
import { AsyncTimeoutError } from "../../../src/core/errors.js"

/** 单独成文件，不并进 client.test.ts：那里的共享 mock 生命周期（每例 mockReset + 令牌缓存
 *  文件的 afterEach 清理）与「在 mock 里 abort」这种写法互相干扰，把一次正常的拒绝报成
 *  用例失败。取消路径的判据是「还发不发请求」，需要一个干净的计数器。 */
function jsonResponse(data: unknown) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: { text: vi.fn().mockResolvedValue(JSON.stringify({ code: "000000", msg: "ok", data })) },
  }
}

function client() {
  return new GangtiseClient({
    baseUrl: "https://open.gangtise.com",
    timeoutMs: 30_000,
    token: "test-token",
    tokenCachePath: "/dev/null",
    asyncTimeoutMs: 60_000,
    maxDownloadBytes: 1024 * 1024,
  })
}

// 客户端超时 / 主动取消之后，服务端不该继续把剩余分页发出去：那些结果到不了调用方，
// 每一页都是白花的请求，在按行计费的端点上还是钱。
describe("pagination honours the request cancel signal", () => {
  it("stops dispatching pages once the signal aborts", async () => {
    requestMock.mockReset()
    const controller = new AbortController()
    let pageCalls = 0
    requestMock.mockImplementation(async (_url: unknown, opts?: { body?: string }) => {
      const body = JSON.parse(opts?.body ?? "{}")
      pageCalls += 1
      // 第一页返回后立刻取消：后续 9 页一个都不该再发出去。
      if (body.from === 0) controller.abort(new Error("client gave up"))
      return jsonResponse({ total: 500, list: Array.from({ length: 50 }, (_, i) => ({ id: body.from + i })) })
    })

    let failed = false
    try {
      await runWithRequestContext(controller.signal, () =>
        client().call("insight.foreign-opinion.list", { fetchAll: true }),
      )
    } catch {
      failed = true
    }
    expect(failed, "取消后整次调用应当失败，而不是交回一份「部分成功」的结果").toBe(true)
    expect(pageCalls, "取消之后仍在继续翻页").toBe(1)
  })

  it("does not report a cancelled in-flight page as a failed page", async () => {
    requestMock.mockReset()
    const controller = new AbortController()
    requestMock.mockImplementation(async (_url: unknown, opts?: { body?: string }) => {
      const body = JSON.parse(opts?.body ?? "{}")
      if (body.from === 0) return jsonResponse({ total: 100, list: Array.from({ length: 50 }, (_, i) => ({ id: i })) })
      // 扇出开始之后才取消，让在飞的那一页以 abort 结束。
      controller.abort(new Error("client gave up"))
      throw new Error("The operation was aborted")
    })

    let outcome: unknown = "resolved"
    try {
      await runWithRequestContext(controller.signal, () =>
        client().call("insight.foreign-opinion.list", { fetchAll: true }),
      )
    } catch (err) {
      outcome = err
    }
    // 判据：整次调用**失败**。把取消记进 _failed_pages 会返回一份「成功」的 _partial
    // 结果，调用方读成「取到了大部分、少数页失败」，而真相是它自己取消了这次调用。
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome).not.toHaveProperty("_partial")
  })

  it("issues every page when nothing cancels", async () => {
    requestMock.mockReset()
    let pageCalls = 0
    requestMock.mockImplementation(async (_url: unknown, opts?: { body?: string }) => {
      const body = JSON.parse(opts?.body ?? "{}")
      pageCalls += 1
      return jsonResponse({ total: 200, list: Array.from({ length: 50 }, (_, i) => ({ id: body.from + i })) })
    })
    const r = await client().call("insight.foreign-opinion.list", { fetchAll: true }) as Record<string, unknown>
    expect((r.list as unknown[]).length).toBe(200)
    expect(pageCalls).toBeGreaterThanOrEqual(4)
  })
})

// 🔴 异步轮询的截止时间此前只是**不再等**那次调用：`Promise.race` 输掉的一侧仍在跑，
// 底层的 HTTP 与 transport 的重试退避继续按节奏重发。调用方早已拿到 AsyncTimeoutError，
// 后台还在空烧请求 —— 按次计费的端点上是实打实的消耗，也绕过了「客户端取消后不再发后续
// 请求」这条约定。判据是：截止之后不再有新的请求时刻。
describe("async polling aborts its in-flight request at the deadline", () => {
  /** 一直抛连接重置：默认重试策略会一路退避重发，把「截止后还在发」放大到可观测。 */
  function alwaysReset(at: number[]) {
    return async () => {
      at.push(Date.now())
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
    }
  }

  it("stops issuing requests once the poll deadline passes", async () => {
    requestMock.mockReset()
    vi.useFakeTimers()
    try {
      const at: number[] = []
      requestMock.mockImplementation(alwaysReset(at))

      const promise = pollAsyncContent(client(), "ai.earnings-review.get-content", "d-billed", 30)
      const assertion = expect(promise).rejects.toBeInstanceOf(AsyncTimeoutError)
      await vi.advanceTimersByTimeAsync(31)
      await assertion

      const atDeadline = at.length
      expect(atDeadline, "截止前一次都没发，用例前提不成立").toBeGreaterThan(0)
      // 退避是 400ms 起步、指数增长；再放 10s 足够让此前那两次重发落进来。
      await vi.advanceTimersByTimeAsync(10_000)
      expect(at.length, `截止之后仍在重发：${at.join("ms / ")}ms`).toBe(atDeadline)
    } finally {
      vi.useRealTimers()
    }
  })

  // 子信号是**额外**叠一个截止时间，不是替代父信号。少了这条转发，整次 MCP 请求被取消时
  // 在飞的那次轮询调用不再收到中止，会一路退避重发到自己的截止时间为止。
  it("still forwards the caller's own cancellation into the poll", async () => {
    requestMock.mockReset()
    const controller = new AbortController()
    const at: number[] = []
    requestMock.mockImplementation(async () => {
      controller.abort(new Error("client gave up"))
      return alwaysReset(at)()
    })

    await expect(
      runWithRequestContext(controller.signal, () =>
        pollAsyncContent(client(), "ai.earnings-review.get-content", "d-cancelled", 60_000),
      ),
    ).rejects.toThrow()
    expect(at.length, "调用方取消后仍在重试").toBe(1)
  })
})
