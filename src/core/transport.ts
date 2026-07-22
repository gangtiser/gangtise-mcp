import { Agent, type Dispatcher } from "undici"

import { ApiError } from "./errors.js"

let cachedDispatcher: Dispatcher | null = null

export function getDispatcher(): Dispatcher {
  if (!cachedDispatcher) {
    cachedDispatcher = new Agent({
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
      connections: 16,
      pipelining: 1,
    })
  }
  return cachedDispatcher
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results: R[] = new Array(items.length)
  let next = 0
  let firstError: unknown = null

  async function worker(): Promise<void> {
    // Stop pulling new work once any worker has failed, so we don't waste
    // requests after the batch is already doomed.
    while (firstError === null) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        // Capture the first failure and resolve quietly — re-throwing here would
        // surface as an unhandled rejection once Promise.all has already settled.
        if (firstError === null) firstError = err
        return
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()))
  if (firstError !== null) throw firstError
  return results
}

const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504])
const RETRYABLE_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])
const RETRYABLE_API_CODES = new Set(["999999"])
// Never replayed on any HTTP status:
// - 999011 CREDENTIAL_INVALID (bad AK/SK): a 5xx would otherwise be replayed twice
//   by the status rule, and a credential error never fixes itself.
// - 140002 PROCESSING_FAILED (the 2026-07-17 renumbering of 410111): the async
//   *_check endpoints declare no retry policy, so a 140002@500 would be retried 2×
//   by the default policy BEFORE asyncContent's terminal check sees it — that guard
//   sits above client.call's withRetry and cannot observe the retries. 140002 means
//   "generation failed" (terminal by definition) and only those async endpoints can
//   return it, so a blanket rule is safe and skips the wasted retries. The server
//   still emits 410111 today (410111@400 isn't retryable anyway); this is a forward
//   guard for the documented 140002@500.
// - 410111 / 410106 / 410001: terminal or deterministic by definition — a generation
//   that already failed, and two EDE parameter errors (missing indicator/security,
//   missing a required indicatorParamList entry). Replaying them with identical
//   arguments cannot change the answer. We have NOT observed the server return these
//   with a 5xx; the guard is for the shape, not a sighting — should any of them
//   arrive wrapped in a retryable status, the status rule would replay it 2× for a
//   verdict that cannot move, and on the per-cell-billed indicator endpoints those
//   replays may also cost credits. Gating by API code takes the question off the table.
const NON_RETRYABLE_API_CODES = new Set(["999011", "140002", "410111", "410106", "410001"])
// Rate limiting in envelope form: the 429 rule above only catches the HTTP form, so
// a 999006 arriving inside a 2xx/4xx envelope used to fail on the first attempt with
// the server's Retry-After parsed but never acted on. Checked AFTER the no-replay
// return on purpose — for per-call billed endpoints we cannot prove the throttle
// fired before the handler executed, and a wrong guess double-bills.
const RATE_LIMIT_API_CODES = new Set(["999006"])
// Connect-phase / DNS failures: the request provably never reached the server, so a
// replay cannot double-execute (or double-bill) anything even under "no-replay".
const NO_REPLAY_NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"])

/** "no-replay" (per-call billed endpoints — billing probed non-idempotent, no
 * cache-hit exemption): never resend a request the server may have executed.
 * Only connect-phase errors, 429 (rejected before processing) and the explicit
 * token-self-heal mark retry; 5xx / response timeouts / 999999 fail fast.
 * "no-999999" (EDE indicator endpoints): the server answers a no-data query with
 * HTTP 500 + 999999 (probed 2026-07-11) — retrying that is pure waste; everything
 * else follows the default policy. */
export type RetryPolicy = "default" | "no-replay" | "no-999999"

export function isRetryableError(error: unknown, policy: RetryPolicy = "default"): boolean {
  if (error && typeof error === "object" && (error as { __retryable?: boolean }).__retryable === true) {
    return true
  }
  if (error instanceof ApiError) {
    if (error.code && NON_RETRYABLE_API_CODES.has(error.code)) return false
    if (error.statusCode === 429) return true
    if (policy === "no-replay") return false
    if (error.code && RATE_LIMIT_API_CODES.has(error.code)) return true
    if (error.code && RETRYABLE_API_CODES.has(error.code)) return policy !== "no-999999"
    if (error.statusCode != null && RETRYABLE_HTTP_STATUS.has(error.statusCode)) return true
    return false
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code)
    if ((policy === "no-replay" ? NO_REPLAY_NETWORK_CODES : RETRYABLE_NETWORK_CODES).has(code)) return true
  }
  if (policy === "no-replay") return false
  if (error instanceof Error && /timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(error.message)) {
    return true
  }
  return false
}

export function markRetryable<E extends object>(error: E): E {
  return Object.assign(error, { __retryable: true })
}

/** Errors worth waiting out (anything the default policy would retry): transient
 * 5xx / network / timeout / 429 / 999999 / 999006. Used by async polling to survive
 * a blip without abandoning a multi-minute wait — a throttle mid-poll must not void
 * a generation that was already billed. */
export function isTransientError(error: unknown): boolean {
  return isRetryableError(error, "default")
}

export interface RetryOptions {
  retries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  policy?: RetryPolicy
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void
}

/** Rate limits (HTTP 429) and any response carrying a Retry-After header get a
 * patient, capped backoff — hammering a throttled API only extends the throttle.
 * 5xx and network errors keep the fast generic backoff unchanged. */
const RATE_LIMIT_BASE_DELAY = 2_000
const RATE_LIMIT_MAX_DELAY = 15_000

export function computeRetryDelay(error: unknown, attempt: number, baseDelay: number, maxDelay: number): number {
  const retryAfterMs = error instanceof ApiError ? error.retryAfterMs : undefined
  // A throttle deserves the patient backoff however it arrived — HTTP 429 or the
  // 999006 envelope form. Without the code check the envelope form would fall back
  // to the fast generic schedule and hammer an already-throttled API.
  const isRateLimit = error instanceof ApiError && (error.statusCode === 429 || (error.code !== undefined && RATE_LIMIT_API_CODES.has(error.code)))
  const base = isRateLimit ? RATE_LIMIT_BASE_DELAY : baseDelay
  const ceil = isRateLimit || retryAfterMs !== undefined ? RATE_LIMIT_MAX_DELAY : maxDelay
  const jitter = Math.random() * base
  let delay = Math.min(ceil, base * 2 ** attempt + jitter)
  // Honor Retry-After when the server asks for longer, capped so a huge or
  // hostile value can't stall the request past the ceiling.
  if (retryAfterMs !== undefined) delay = Math.min(ceil, Math.max(delay, retryAfterMs))
  return delay
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2
  const baseDelay = options.baseDelayMs ?? 400
  const maxDelay = options.maxDelayMs ?? 4_000
  const policy = options.policy ?? "default"
  let attempt = 0

  while (true) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= retries || !isRetryableError(error, policy)) throw error
      const delay = computeRetryDelay(error, attempt, baseDelay, maxDelay)
      options.onRetry?.(attempt + 1, error, delay)
      await new Promise(resolve => setTimeout(resolve, delay))
      attempt++
    }
  }
}

let verboseEnabled = process.env.GANGTISE_VERBOSE === "1" || process.env.GANGTISE_VERBOSE === "true"

export function setVerbose(value: boolean): void {
  verboseEnabled = value
}

export function isVerbose(): boolean {
  return verboseEnabled
}

export function logTiming(label: string, durationMs: number, extra?: string): void {
  if (!verboseEnabled) return
  const ms = durationMs.toFixed(0).padStart(5, " ")
  process.stderr.write(`[gangtise] ${ms}ms ${label}${extra ? ` (${extra})` : ""}\n`)
}
