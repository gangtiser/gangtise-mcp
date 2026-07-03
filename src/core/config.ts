import os from "node:os"
import path from "node:path"

export const DEFAULT_BASE_URL = "https://open.gangtise.com"
export const DEFAULT_TIMEOUT_MS = 30_000
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

export interface CliConfig {
  baseUrl: string
  timeoutMs: number
  accessKey?: string
  secretKey?: string
  token?: string
  tokenCachePath: string
  asyncTimeoutMs: number
}

export function loadConfig(): CliConfig {
  const timeoutValue = process.env.GANGTISE_TIMEOUT_MS
  const timeoutMs = timeoutValue ? Number(timeoutValue) : DEFAULT_TIMEOUT_MS

  const asyncTimeoutValue = process.env.GANGTISE_MCP_ASYNC_TIMEOUT_MS
  const asyncTimeoutMs = asyncTimeoutValue ? Number(asyncTimeoutValue) : DEFAULT_ASYNC_TIMEOUT_MS

  return {
    baseUrl: process.env.GANGTISE_BASE_URL ?? DEFAULT_BASE_URL,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    accessKey: process.env.GANGTISE_ACCESS_KEY,
    secretKey: process.env.GANGTISE_SECRET_KEY,
    token: process.env.GANGTISE_TOKEN,
    tokenCachePath: process.env.GANGTISE_TOKEN_CACHE_PATH ?? DEFAULT_TOKEN_CACHE_PATH,
    asyncTimeoutMs: Number.isFinite(asyncTimeoutMs) && asyncTimeoutMs > 0 ? asyncTimeoutMs : DEFAULT_ASYNC_TIMEOUT_MS,
  }
}
