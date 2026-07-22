import { ApiError } from "./errors.js"
import { AsyncTimeoutError } from "./errors.js"
import { isTransientError } from "./transport.js"

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

/** Rejects with AsyncTimeoutError if `promise` hasn't settled within `budgetMs`.
 * The poll loop bounds its sleep by the deadline, but a single client.call() can
 * itself stall up to the request timeout (~30s). Without this, a poll fired with
 * a sliver of budget left blocks until that call returns — overshooting the
 * deadline and the client's ~60s cutoff, losing the billed dataId the deadline
 * exists to protect. The stalled call is abandoned (its .catch swallows a late
 * rejection); the caller still gets the dataId back to recover via *_check. */
function withPollDeadline<T>(promise: Promise<T>, budgetMs: number, dataId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AsyncTimeoutError(dataId)), budgetMs)
  })
  return Promise.race([promise, deadline]).finally(() => {
    clearTimeout(timer)
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
  let attempt = 0

  while (true) {
    attempt++
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new AsyncTimeoutError(dataId)
    try {
      const result = await withPollDeadline(client.call(getContentEndpoint, { dataId }), remaining, dataId) as { content?: string }
      if (result?.content != null) {
        return { content: result.content }
      }
    } catch (error) {
      // A deadline abort is never "transient" — its message contains "timeout",
      // which the transient classifier would otherwise match.
      if (error instanceof AsyncTimeoutError) throw error
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
    await new Promise(resolve => setTimeout(resolve, delay))

    if (Date.now() >= deadline) {
      throw new AsyncTimeoutError(dataId)
    }
  }
}
