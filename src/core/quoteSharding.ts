import { runWithConcurrency, isVerbose } from "./transport.js"
import { errorMessage, ValidationError } from "./errors.js"
import { PAGE_CONCURRENCY } from "./config.js"

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
  /** securityList sentinel that means "whole market" and triggers day-sharding.
   * Defaults to "all" (day-kline); fund-flow uses "aShares". */
  fullMarketValue?: string
}

interface KlineClient {
  call(endpointKey: string, body?: unknown): Promise<unknown>
}

const DAY_MS = 86_400_000
/** API-side row cap (per docs). Lifts the default 6000-row cap on
 * `--security all` queries so a single shard (~5-6K rows/day per market)
 * isn't silently truncated. Single-security queries are untouched. */
const ALL_MARKET_LIMIT = 10_000
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

function isAllMarket(body: KlineBody, fullMarketValue = "all"): boolean {
  const list = body.securityList
  if (!Array.isArray(list) || list.length !== 1) return false
  return list[0] === fullMarketValue
}

/**
 * Loud-partial marker for non-sharded, limit-capped quote endpoints (fund-flow):
 * when the returned row count reaches the effective per-request `limit`, upstream
 * has truncated at the window head, so flag it rather than let it read as complete.
 * A no-op for anything that isn't a `{ list: [...] }` shape.
 */
export function flagLimitTruncated(result: unknown, effectiveLimit: number): unknown {
  if (result && typeof result === "object" && Array.isArray((result as { list?: unknown[] }).list)) {
    const list = (result as { list: unknown[] }).list
    if (list.length >= effectiveLimit) {
      return { ...(result as Record<string, unknown>), _partial: true, _partial_reason: "limit_truncated" }
    }
  }
  return result
}

function isWeekend(epochMs: number): boolean {
  const day = new Date(epochMs).getUTCDay()
  return day === 0 || day === 6
}

function buildShards(start: Date, end: Date, shardDays: number): Array<{ startDate: string; endDate: string }> {
  const shards: Array<{ startDate: string; endDate: string }> = []
  let cursor = start.getTime()
  const endTime = end.getTime()
  while (cursor <= endTime) {
    const shardEnd = Math.min(cursor + (shardDays - 1) * DAY_MS, endTime)
    // A/HK/US markets close Sat/Sun, so a 1-day weekend shard is a
    // guaranteed-empty request — skip it (~28% of a long range, and daily
    // quota). Multi-day shards may straddle a weekend and are kept whole.
    if (!(shardDays === 1 && isWeekend(cursor))) {
      shards.push({
        startDate: formatDate(new Date(cursor)),
        endDate: formatDate(new Date(shardEnd)),
      })
    }
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
  if (!isAllMarket(body, config.fullMarketValue)) {
    return client.call(endpointKey, body)
  }

  // `security: all` returns thousands of rows per day; lift the default 6000-row
  // cap to the API max so single-shard requests aren't silently truncated. This
  // must apply even when a date is missing (no sharding possible then, but the
  // single request still needs the lifted cap).
  const allMarketBody: KlineBody = { ...body, limit: body.limit ?? ALL_MARKET_LIMIT }
  const perShardLimit = allMarketBody.limit ?? ALL_MARKET_LIMIT

  // A single full-market request (missing/unparseable dates, or a range that fits
  // one shard) skips the merge loop below, so it needs the same limit-truncation
  // check inline — else a low limit or an oversized single window slips through as a
  // silently truncated "complete" result (e.g. index 'all' over a 30-day window).
  const callSingle = async () => flagLimitTruncated(await client.call(endpointKey, allMarketBody), perShardLimit)

  if (!body.startDate || !body.endDate) {
    return callSingle()
  }

  const start = parseDate(body.startDate)
  const end = parseDate(body.endDate)
  if (!start || !end || end < start) {
    return callSingle()
  }

  const totalDays = Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1
  if (totalDays <= config.shardDays) {
    // Same weekend rule as the sharded path below: with 1-day shards the window
    // is exactly one day here, and a Sat/Sun day is a guaranteed-empty request.
    if (config.shardDays === 1 && isWeekend(start.getTime())) {
      return { list: [] }
    }
    return callSingle()
  }

  const shards = buildShards(start, end, config.shardDays)
  // Every day in the range was a skipped weekend: markets closed, nothing to fetch.
  if (shards.length === 0) {
    return { list: [] }
  }
  if (shards.length > MAX_SHARDS) {
    throw new ValidationError(`全市场查询区间过大（${shards.length} 个分片 > ${MAX_SHARDS}）：合并结果将超出单次响应安全上限，请缩小日期区间分批拉取`)
  }
  if (isVerbose()) {
    process.stderr.write(`[gangtise] sharding ${endpointKey} into ${shards.length} requests (${config.shardDays} day(s) each)\n`)
  }

  type ShardOutcome =
    | { ok: true; value: unknown }
    | { ok: false; startDate: string; endDate: string; error: string; cause: unknown }

  const results = await runWithConcurrency(shards, config.concurrency ?? PAGE_CONCURRENCY, async (shard): Promise<ShardOutcome> => {
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
  const truncatedShards: Array<{ startDate: string; endDate: string }> = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (!r.ok || !(r.value && typeof r.value === "object")) continue
    const rec = r.value as Record<string, unknown>
    if (!header) header = rec
    if (!fieldList && Array.isArray(rec.fieldList)) fieldList = rec.fieldList
    // A shard whose row count reaches the per-request limit was itself capped, so
    // its slice of that day's market is incomplete — record its date window so a
    // consumer can re-pull exactly those days with a narrower range.
    if (Array.isArray(rec.list) && (rec.list as unknown[]).length >= perShardLimit) {
      truncatedShards.push({ startDate: shards[i].startDate, endDate: shards[i].endDate })
    }
    if (Array.isArray(rec.list)) merged.push(...(rec.list as unknown[]))
  }

  if (!header) return { list: [] }
  const out: Record<string, unknown> = { ...header, list: merged }
  if (fieldList) out.fieldList = fieldList
  // The header's `total` describes the first shard only — recompute it for the
  // merged result so downstream completeness checks aren't misled.
  if ("total" in out) out.total = merged.length
  // Loud partial: a dropped shard (failure) or a shard whose rows hit the per-request
  // limit (truncated slice) both leave the merged market data incomplete.
  const reasons: string[] = []
  if (failed.length > 0) {
    reasons.push("failed_shards")
    out._failed_shards = failed.map((f) => ({ startDate: f.startDate, endDate: f.endDate, error: f.error }))
  }
  if (truncatedShards.length > 0) {
    reasons.push("limit_truncated")
    out._truncated_shards = truncatedShards
  }
  if (reasons.length > 0) {
    out._partial = true
    out._partial_reason = reasons.join(",")
  }
  return out
}
