import os from "node:os"
import path from "node:path"

export const DEFAULT_BASE_URL = "https://openapi.gangtise.com"
export const DEFAULT_TIMEOUT_MS = 30_000
/** GANGTISE_TIMEOUT_MS 的取值范围：低于 1 秒时服务端来不及应答，每个请求都会超时；超过 1 小时，
 *  挂住的请求与没发出的请求已经分不出来。 */
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 3_600_000
export const DEFAULT_TOKEN_CACHE_PATH = path.join(os.homedir(), ".config", "gangtise", "token.json")
// Default async-AI wait. Kept under the MCP client's default request timeout
// (~60s, DEFAULT_REQUEST_TIMEOUT_MSEC) so the {dataId, status:"timeout"} response
// reaches the model before the client cuts the connection — otherwise the billed
// task's dataId is lost and *_check can't recover it. Callers wanting a longer
// wait pass waitSeconds (max 180) or raise GANGTISE_MCP_ASYNC_TIMEOUT_MS.
export const DEFAULT_ASYNC_TIMEOUT_MS = 55_000

// Inline byte budget: a tool result at or under this is returned inline; a larger
// one spills to a temp file with a pageable preview pointer. Default 64KB (~15-20K
// tokens) keeps a single result within a typical client's display budget and —
// unlike a large inline blob — always leaves a spill file the model can page.
// Raise it for bulk-export sessions via GANGTISE_INLINE_MAX_BYTES.
export const DEFAULT_INLINE_MAX_BYTES = 65_536

export function resolveInlineMaxBytes(raw: string | undefined): number {
  const n = raw ? Number(raw) : DEFAULT_INLINE_MAX_BYTES
  // Floor at 8KB so a hostile/typo tiny value can't force every response to spill.
  return Number.isFinite(n) && n >= 8_192 ? Math.floor(n) : DEFAULT_INLINE_MAX_BYTES
}

// Read once at load (a static threshold, mirroring the previous module consts in
// registry.ts / response.ts that this replaces).
export const INLINE_MAX_BYTES = resolveInlineMaxBytes(process.env.GANGTISE_INLINE_MAX_BYTES)

// Request fan-out concurrency: how many paginated page requests (paginate.ts) or
// full-market day shards (batch.ts) run at once. One knob tunes all fan-out.
export const DEFAULT_PAGE_CONCURRENCY = 5
// Hard ceiling: a huge override (typo or misguided "go faster") would open that
// many sockets per origin and hammer the upstream API — well past any real
// throughput gain. 32 is far above the default yet stays polite.
export const MAX_PAGE_CONCURRENCY = 32

export function resolvePageConcurrency(raw: string | undefined): number {
  const n = raw ? Number(raw) : DEFAULT_PAGE_CONCURRENCY
  // Floor fractional values to an int; fall back to the default on NaN or n < 1 so a
  // typo can't stall fan-out (0 / negative) or starve the pool. Clamp the top end so
  // an oversized value can't exhaust sockets / overrun the API.
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_CONCURRENCY
  return Math.min(Math.floor(n), MAX_PAGE_CONCURRENCY)
}

// Read once at load, same static-const pattern as INLINE_MAX_BYTES above.
export const PAGE_CONCURRENCY = resolvePageConcurrency(process.env.GANGTISE_PAGE_CONCURRENCY)

/** 全局同时在飞的 HTTP 请求上限（跨所有 MCP 调用）。默认与连接池同大：max(16, 分页并发)。
 *  上限 64——再大连接池也跟着变大，对服务端就不礼貌了。 */
export const MAX_GLOBAL_CONCURRENCY = 64

export function resolveGlobalConcurrency(raw: string | undefined, pageConcurrency: number): number {
  const fallback = Math.max(16, pageConcurrency)
  const n = raw ? Number(raw) : fallback
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.floor(n), MAX_GLOBAL_CONCURRENCY)
}

export const GLOBAL_CONCURRENCY = resolveGlobalConcurrency(process.env.GANGTISE_MCP_GLOBAL_CONCURRENCY, PAGE_CONCURRENCY)

// 单个下载文件的字节上限。总配额（tempCleanup 的 2 GiB）管「多份加起来」，这一条管
// 「一份自己就把盘写满」——后者是总配额的 LRU 淘汰救不了的，因为淘汰只能删**别的**目录。
// 1 GiB：研报 PDF / 原始音频再大也很少接近它；/tmp 很小的部署可以调低。
export const DEFAULT_MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024

export function resolveMaxDownloadBytes(raw: string | undefined): number {
  const n = raw ? Number(raw) : DEFAULT_MAX_DOWNLOAD_BYTES
  // 下限 1MB：调到比一份普通 PDF 还小没有意义，多半是单位写错了。
  return Number.isFinite(n) && n >= 1024 * 1024 ? Math.floor(n) : DEFAULT_MAX_DOWNLOAD_BYTES
}

/** GANGTISE_TIMEOUT_MS 只收十进制整数毫秒。`0.5`、`1e4`、`30s` 这类回退默认值；低于 1 秒的
 *  多半是把秒当毫秒写了（`30`），同样回退——否则每个请求都会超时；超过上限的夹到上限。 */
export function resolveTimeoutMs(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return DEFAULT_TIMEOUT_MS
  const ms = Number(raw)
  return ms < MIN_TIMEOUT_MS ? DEFAULT_TIMEOUT_MS : Math.min(MAX_TIMEOUT_MS, ms)
}

let timeoutWarned = false

export interface CliConfig {
  baseUrl: string
  timeoutMs: number
  accessKey?: string
  secretKey?: string
  token?: string
  tokenCachePath: string
  asyncTimeoutMs: number
  /** 单个下载文件的字节上限；测试注入小值以免每次跑测试都真写 1 GiB。 */
  maxDownloadBytes: number
  /** GANGTISE_MCP_TOOLS 原值：列出与启用哪些工具，由 profile.ts 解析。 */
  tools?: string
}

export function loadConfig(): CliConfig {
  const timeoutValue = process.env.GANGTISE_TIMEOUT_MS
  const timeoutMs = resolveTimeoutMs(timeoutValue)
  // 设了却没按原值生效时在 stderr 说一次：调大它通常是为了等慢的 AI 生成，悄悄退回 30 秒会让
  // 那次调用超时、而超时的生成可能已经计费。
  if (timeoutValue && Number(timeoutValue) !== timeoutMs && !timeoutWarned) {
    timeoutWarned = true
    process.stderr.write(`[gangtise] warning: GANGTISE_TIMEOUT_MS=${timeoutValue} is not in effect, using ${timeoutMs} ms: expected whole milliseconds from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}\n`)
  }

  const asyncTimeoutValue = process.env.GANGTISE_MCP_ASYNC_TIMEOUT_MS
  const asyncTimeoutMs = asyncTimeoutValue ? Number(asyncTimeoutValue) : DEFAULT_ASYNC_TIMEOUT_MS

  return {
    baseUrl: process.env.GANGTISE_BASE_URL ?? DEFAULT_BASE_URL,
    timeoutMs,
    accessKey: process.env.GANGTISE_ACCESS_KEY,
    secretKey: process.env.GANGTISE_SECRET_KEY,
    token: process.env.GANGTISE_TOKEN,
    tokenCachePath: process.env.GANGTISE_TOKEN_CACHE_PATH ?? DEFAULT_TOKEN_CACHE_PATH,
    asyncTimeoutMs: Number.isFinite(asyncTimeoutMs) && asyncTimeoutMs > 0 ? asyncTimeoutMs : DEFAULT_ASYNC_TIMEOUT_MS,
    maxDownloadBytes: resolveMaxDownloadBytes(process.env.GANGTISE_MAX_DOWNLOAD_BYTES),
    tools: process.env.GANGTISE_MCP_TOOLS,
  }
}
