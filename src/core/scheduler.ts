import { GLOBAL_CONCURRENCY } from "./config.js"
import { abortReason } from "./transport.js"

/** 执行层的两类约束。
 *
 *  - **全局并发闸**：同时在飞的 HTTP 请求数，跨所有 MCP 调用共享。每个任务内部的分页扇出 /
 *    分片 / 逐只按 GANGTISE_PAGE_CONCURRENCY 并发，几个调用同时进来时总量由这里封顶。
 *    默认与连接池同大（见 config.ts 的 GLOBAL_CONCURRENCY），所以不改变单个调用的行为。
 *  - **每次调用的上限**：一次调用最多发多少页 / 多少片。它们原先散在分页与分片代码里，集中到
 *    这里是为了新的拆分策略（多证券合批、别的品种的序列）沿用同一组数。 */

/** 每次调用的既有上限。 */
export const CALL_LIMITS = {
  /** 一次分页拉取最多发的页数（含首页）。1000 页 × 每页 50 行 = 5 万行。 */
  maxPages: 1000,
  /** 一次全市场拉取最多切的片数。约 180 个单日片≈半年多的 A 股全市场行，再多合并结果会逼近
   *  V8 字符串上限——每一片都成功、最后序列化时整体失败；请求数也会压着当日额度。 */
  maxShards: 180,
} as const

interface Waiter {
  resolve: () => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/** 先进先出的计数闸。排队中的请求可被取消：取消即出队并以取消原因拒绝，不占名额。 */
export class ConcurrencyGate {
  private active = 0
  private readonly waiting: Waiter[] = []

  constructor(readonly limit: number) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  stats(): { active: number; queued: number; limit: number } {
    return { active: this.active, queued: this.waiting.length, limit: this.limit }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      if (signal) {
        waiter.onAbort = () => {
          const i = this.waiting.indexOf(waiter)
          if (i >= 0) this.waiting.splice(i, 1)
          reject(abortReason(signal))
        }
        signal.addEventListener("abort", waiter.onAbort, { once: true })
      }
      this.waiting.push(waiter)
    })
  }

  /** 名额直接交给队首，`active` 不变；没人排队才归还。 */
  private release(): void {
    const next = this.waiting.shift()
    if (!next) {
      this.active--
      return
    }
    if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort)
    next.resolve()
  }
}

const globalGate = new ConcurrencyGate(GLOBAL_CONCURRENCY)

/** 占一个全局名额执行 `fn`。登录请求不要走这里：在飞的请求可能正等着 token 刷新，
 *  刷新自己再去排队，名额满时就互相卡死。 */
export function withGlobalSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return globalGate.run(fn, signal)
}

export function globalGateStats(): { active: number; queued: number; limit: number } {
  return globalGate.stats()
}
