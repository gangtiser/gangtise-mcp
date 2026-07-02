import { runWithConcurrency, isVerbose } from "./transport.js"
import { errorMessage, ValidationError } from "./errors.js"

export interface KlineBody {
  securityList?: string[]
  startDate?: string
  endDate?: string
  limit?: number
  fieldList?: string[]
  [key: string]: unknown
}

interface ShardConfig {
  /** Days per shard. Picked so each request stays under the 10K-row API cap. */
  shardDays: number
  concurrency?: number
}

interface KlineClient {
  call(endpointKey: string, body?: unknown): Promise<unknown>
}

const DAY_MS = 86_400_000
/** API-side row cap (per docs). Lifts the default 6000-row cap on
 * `--security all` queries so a single shard (~5-6K rows/day per market)
 * isn't silently truncated. Single-security queries are untouched. */
const ALL_MARKET_LIMIT = 10_000
/** Shard fan-out concurrency. Shares the GANGTISE_PAGE_CONCURRENCY knob with
 * pagination (see client.ts) so one env var tunes all request fan-out. */
const SHARD_CONCURRENCY = Number(process.env.GANGTISE_PAGE_CONCURRENCY ?? 5) || 5
/** Hard cap on shard fan-out. ~180 one-day shards ≈ 6+ months of A-share
 * full-market rows; beyond that the merged rows approach the V8 string limit in
 * the JSON sink — every shard would succeed and then stringify would throw,
 * discarding all of them — and the request count hammers the daily quota. */
const MAX_SHARDS = 180

function parseDate(value: string): Date | null {
  // Accept yyyy-MM-dd; reject anything else so we can fall back to a single request.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const d = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  return d
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function isAllMarket(body: KlineBody): boolean {
  const list = body.securityList
  if (!Array.isArray(list) || list.length !== 1) return false
  return list[0] === "all"
}

function buildShards(start: Date, end: Date, shardDays: number): Array<{ startDate: string; endDate: string }> {
  const shards: Array<{ startDate: string; endDate: string }> = []
  let cursor = start.getTime()
  const endTime = end.getTime()
  while (cursor <= endTime) {
    const shardEnd = Math.min(cursor + (shardDays - 1) * DAY_MS, endTime)
    shards.push({
      startDate: formatDate(new Date(cursor)),
      endDate: formatDate(new Date(shardEnd)),
    })
    cursor = shardEnd + DAY_MS
  }
  return shards
}

/**
 * For full-market (`--security all`) K-line queries that span more than `shardDays`,
 * split the date range and run shards in parallel. Each shard is sized so the
 * combined row count stays under the 10K-row API limit. For small ranges or
 * single-security queries this is a no-op.
 */
export async function callKlineWithSharding(client: KlineClient, endpointKey: string, body: KlineBody, config: ShardConfig): Promise<unknown> {
  if (!isAllMarket(body)) {
    return client.call(endpointKey, body)
  }

  // `security: all` returns thousands of rows per day; lift the default 6000-row
  // cap to the API max so single-shard requests aren't silently truncated. This
  // must apply even when a date is missing (no sharding possible then, but the
  // single request still needs the lifted cap).
  const allMarketBody: KlineBody = { ...body, limit: body.limit ?? ALL_MARKET_LIMIT }

  if (!body.startDate || !body.endDate) {
    return client.call(endpointKey, allMarketBody)
  }

  const start = parseDate(body.startDate)
  const end = parseDate(body.endDate)
  if (!start || !end || end < start) {
    return client.call(endpointKey, allMarketBody)
  }

  const totalDays = Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1
  if (totalDays <= config.shardDays) {
    return client.call(endpointKey, allMarketBody)
  }

  const shards = buildShards(start, end, config.shardDays)
  if (shards.length > MAX_SHARDS) {
    throw new ValidationError(`全市场查询区间过大（${shards.length} 个分片 > ${MAX_SHARDS}）：合并结果将超出单次响应安全上限，请缩小日期区间分批拉取`)
  }
  if (isVerbose()) {
    process.stderr.write(`[gangtise] sharding ${endpointKey} into ${shards.length} requests (${config.shardDays} day(s) each)\n`)
  }

  type ShardOutcome =
    | { ok: true; value: unknown }
    | { ok: false; startDate: string; endDate: string; error: string; cause: unknown }

  const results = await runWithConcurrency(shards, config.concurrency ?? SHARD_CONCURRENCY, async (shard): Promise<ShardOutcome> => {
    try {
      const value = await client.call(endpointKey, { ...allMarketBody, startDate: shard.startDate, endDate: shard.endDate })
      return { ok: true, value }
    } catch (err) {
      return { ok: false, startDate: shard.startDate, endDate: shard.endDate, error: errorMessage(err), cause: err }
    }
  })

  const failed = results.filter((r): r is Extract<ShardOutcome, { ok: false }> => !r.ok)
  // Every shard failed → surface the original error instead of masking it as empty data.
  if (failed.length === shards.length) {
    throw failed[0].cause
  }

  let fieldList: unknown[] | undefined
  let header: Record<string, unknown> | null = null
  const merged: unknown[] = []
  for (const r of results) {
    if (!r.ok || !(r.value && typeof r.value === "object")) continue
    const rec = r.value as Record<string, unknown>
    if (!header) header = rec
    if (!fieldList && Array.isArray(rec.fieldList)) fieldList = rec.fieldList
    if (Array.isArray(rec.list)) merged.push(...(rec.list as unknown[]))
  }

  if (!header) return { list: [] }
  const out: Record<string, unknown> = { ...header, list: merged }
  if (fieldList) out.fieldList = fieldList
  // Loud partial: surface which date shards were dropped so the caller never
  // mistakes incomplete market data for a complete result.
  if (failed.length > 0) {
    out._partial = true
    out._failed_shards = failed.map((f) => ({ startDate: f.startDate, endDate: f.endDate, error: f.error }))
  }
  return out
}
