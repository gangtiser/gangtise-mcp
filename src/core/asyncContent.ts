import { ApiError } from "./errors.js"
import { AsyncTimeoutError } from "./errors.js"
import { currentSignal, runWithRequestContext } from "./requestContext.js"
import { isTransientError, sleep } from "./transport.js"

export const POLL_INITIAL_DELAY_MS = 5_000
export const POLL_MAX_DELAY_MS = 30_000

function nextDelayMs(attempt: number): number {
  // 5s, 8s, 13s, 20s, 30s, 30s, ...
  const grown = POLL_INITIAL_DELAY_MS * 1.6 ** (attempt - 1)
  return Math.min(POLL_MAX_DELAY_MS, Math.round(grown))
}

interface AsyncContentClient {
  call(endpointKey: string, body?: unknown, query?: Record<string, string | number>): Promise<unknown>
}

// The async endpoints are still entirely on the legacy codes today — 410110
// "正在生成中" and 410111 "生成失败", both string-typed, both HTTP 400. The
// 2026-07-17 spec renumbers them to 140001 RESULT_GENERATING (409) and 140002
// PROCESSING_FAILED (500); both generations are listed ahead of the switchover
// because the failure mode is expensive and silent — a poll that doesn't
// recognize the pending code aborts on a job already billed 50 credits.
const PENDING_CODES = new Set(["410110", "140001"])
const FAILED_CODES = new Set(["410111", "140002"])

export function isAsyncPending(error: unknown): boolean {
  return error instanceof ApiError && error.code !== undefined && PENDING_CODES.has(error.code)
}

export function isAsyncFailed(error: unknown): boolean {
  return error instanceof ApiError && error.code !== undefined && FAILED_CODES.has(error.code)
}

/** Rejects with AsyncTimeoutError if `run()` hasn't settled within `budgetMs`.
 * The poll loop bounds its sleep by the deadline, but a single client.call() can
 * itself stall up to the request timeout (~30s). Without this, a poll fired with
 * a sliver of budget left blocks until that call returns — overshooting the
 * deadline and the client's ~60s cutoff, losing the billed dataId the deadline
 * exists to protect. The caller still gets the dataId back to recover via *_check.
 *
 * 🔴 截止时间必须**真的中止**那次调用，不能只是不再等它：`Promise.race` 输掉的那一侧
 * 仍在跑，底层的 HTTP 请求和 transport 的重试退避会继续按节奏重发 —— 调用方早已拿到
 * `AsyncTimeoutError`，后台还在空烧请求，按次计费的端点上是实打实的消耗，也绕过了
 * 「客户端取消后不再发后续请求」这条约定。所以这里派生一个子信号：`run()` 在该信号的
 * 上下文里执行（`client` 经 `currentSignal()` 取到它，传给 undici 与 `withRetry`），
 * 截止时 abort 掉，在飞的请求与还没睡完的退避一并结束。
 *
 * `parent` 是整次 MCP 请求的取消信号，要继续向下传 —— 子信号只是**额外**叠一个截止
 * 时间，不是替代。监听器用完即摘：一次轮询要跑很多轮，留着会在父信号上越挂越多。 */
function withPollDeadline<T>(run: () => Promise<T>, budgetMs: number, dataId: string, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(parent!.reason)
  if (parent?.aborted) controller.abort(parent.reason)
  else parent?.addEventListener("abort", onParentAbort, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const expired = new AsyncTimeoutError(dataId)
      // 🔴 先 reject 再 abort。两者在同一个同步 tick 里，但 `Promise.race` 的胜者由**谁先
      // settle** 决定：反过来写时 abort 会让底层链路以同一个错误先拒绝，赢家取决于微任务
      // 层数。结果碰巧一样（两边都是这个 dataId 的 AsyncTimeoutError），但那是巧合不是约定。
      // abort 仍在同一 tick 内执行，在飞的请求照样当场中止。
      reject(expired)
      controller.abort(expired)
    }, budgetMs)
  })

  // 🔴 `run()` 同步抛时 `.finally` 永远不会建立，而 timer 已经在上面建好了 —— budgetMs
  // 之后那次 `reject(expired)` 落在一个没有 handler 的 promise 上，Node 默认对 unhandled
  // rejection 是**直接退进程**，而 MCP server 是常驻的。旧签名收的是已经求值的 promise，
  // 同步抛发生在本函数之外，没有这条路径；把求值搬进来就得自己收尾。
  // 生产路径上 `client.call` 是 async 方法、不会同步抛，但代价与概率不对称。
  let promise: Promise<T>
  try {
    promise = runWithRequestContext(controller.signal, run)
  } catch (error) {
    clearTimeout(timer)
    parent?.removeEventListener("abort", onParentAbort)
    return Promise.reject(error)
  }
  return Promise.race([promise, deadline]).finally(() => {
    clearTimeout(timer)
    parent?.removeEventListener("abort", onParentAbort)
    // 中止后迟到的那次 rejection 已经没人接了。
    promise.catch(() => {})
  })
}

export async function pollAsyncContent(
  client: AsyncContentClient,
  getContentEndpoint: string,
  dataId: string,
  timeoutMs: number,
): Promise<{ content: string }> {
  const deadline = Date.now() + timeoutMs
  // 客户端取消后不再轮询也不再等待。已提交的任务不受影响——dataId 在服务端仍然有效，
  // 但客户端既已放弃本次调用，任何返回都到不了它手上，继续轮询只是空烧请求。
  const signal = currentSignal()
  let attempt = 0

  while (true) {
    attempt++
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new AsyncTimeoutError(dataId)
    try {
      const result = await withPollDeadline(() => client.call(getContentEndpoint, { dataId }), remaining, dataId, signal) as { content?: string }
      if (result?.content != null) {
        return { content: result.content }
      }
    } catch (error) {
      // A deadline abort is never "transient" — its message contains "timeout",
      // which the transient classifier would otherwise match.
      if (error instanceof AsyncTimeoutError) throw error
      if (signal?.aborted) throw error
      if (isAsyncFailed(error)) {
        throw error
      }
      // A transient blip (5xx / network reset / timeout) after the transport's
      // own retries are exhausted consumes this attempt but keeps the wait
      // alive — the billed generation is still running server-side. Anything
      // neither pending nor transient is a real failure.
      if (!isAsyncPending(error) && !isTransientError(error)) throw error
    }

    const now = Date.now()
    if (now >= deadline) {
      throw new AsyncTimeoutError(dataId)
    }

    const delay = Math.min(nextDelayMs(attempt), deadline - now)
    await sleep(delay, signal)

    if (Date.now() >= deadline) {
      throw new AsyncTimeoutError(dataId)
    }
  }
}
