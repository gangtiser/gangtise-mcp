import { runWithConcurrency, isVerbose } from "./transport.js"
import { ApiError, ResponseShapeError, errorMessage, ValidationError } from "./errors.js"
import { PAGE_CONCURRENCY } from "./config.js"
import { currentSignal } from "./requestContext.js"
import { clearPartial, markPartial, partialReasonsOf, type PartialReason } from "./partial.js"
import { CALL_LIMITS } from "./scheduler.js"

export interface KlineBody {
  securityList?: string[]
  startDate?: string
  endDate?: string
  limit?: number
  fieldList?: string[]
  [key: string]: unknown
}

/** 拆分策略：由调用族给出，本模块按它拆分、并发执行、按列名合并。 */
export interface BatchStrategy {
  /** 全市场关键字 → 每片天数（按单日行数定，保证单片不超 `cap`）。空表 = 没有全市场关键字。 */
  fullMarketKeywords: Record<string, number>
  /** 哪些日子会有数据。"workday"：周六日休市，单日片落在周末直接跳过；多日片整片保留（边界上
   *  可能多一个空请求，但不会丢交易日）。"natural"：每天都可能有数据，一天都不跳。 */
  calendar: "workday" | "natural"
  /** 全市场请求把 limit 抬到的单请求行数上限。 */
  cap: number
}

/** 请求的是不是某个全市场关键字，是的话每片几天。只认按策略写法拼写的关键字（调用方先归一大小写）。 */
export function fullMarketOf(securityList: string[] | undefined, strategy: BatchStrategy): { keyword: string; shardDays: number } | undefined {
  if (!securityList || securityList.length !== 1) return undefined
  const keyword = Object.keys(strategy.fullMarketKeywords).find((k) => securityList[0] === k)
  return keyword ? { keyword, shardDays: strategy.fullMarketKeywords[keyword] } : undefined
}

interface ShardConfig {
  /** Days per shard. Picked so each request stays under the 10K-row API cap. */
  shardDays: number
  /** 缺省 "workday"（见 BatchStrategy）。 */
  calendar?: BatchStrategy["calendar"]
  /** 缺省 10000。 */
  cap?: number
  concurrency?: number
  /** 报错文案里的工具名。单请求路径要靠它给出与 quote.ts 各端点一致的提示。 */
  tool?: string
  /** securityList sentinel that means "whole market" and triggers day-sharding.
   * `aShares` / `hkStocks` / `usStocks` on the unified day K-line (each with its own
   * shardDays — the caller resolves which one was asked for) and `aShares` on
   * fund-flow; the market-specific day K-line tools still use the historical `all`,
   * which is the default here. */
  fullMarketValue?: string
}

interface KlineClient {
  call(endpointKey: string, body?: unknown): Promise<unknown>
}

const DAY_MS = 86_400_000
/** API-side row cap (per docs). Lifts the default 6000-row cap on whole-market
 * queries so a single shard (~5-6K rows/day per market) isn't silently truncated.
 * Single-security queries are untouched. */
const ALL_MARKET_LIMIT = 10_000
/** 一次全市场拉取最多切的片数（见 scheduler.ts 的 CALL_LIMITS）。 */
const MAX_SHARDS = CALL_LIMITS.maxShards

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
      return markPartial(result as Record<string, unknown>, "limit_truncated")
    }
  }
  return result
}

function isWeekend(epochMs: number): boolean {
  const day = new Date(epochMs).getUTCDay()
  return day === 0 || day === 6
}

/** 区间内的工作日数（周一至周五，含两端）。缺起始日按一年（262 个交易日）估；
 *  缺结束日按今天。只用来判断「显式多证券要不要逐只拉」，估高不估低——
 *  估高的代价是多拆几次请求，估低的代价是撞上限截断。 */
export function estimateTradingDays(startDate?: string, endDate?: string): number {
  if (!startDate) return 262
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = endDate ? Date.parse(`${endDate}T00:00:00Z`) : Date.now() + DAY_MS
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 262
  let days = 0
  for (let t = start; t <= end; t += DAY_MS) {
    if (!isWeekend(t)) days++
  }
  return days
}

function buildShards(start: Date, end: Date, shardDays: number, calendar: BatchStrategy["calendar"]): Array<{ startDate: string; endDate: string }> {
  const shards: Array<{ startDate: string; endDate: string }> = []
  let cursor = start.getTime()
  const endTime = end.getTime()
  while (cursor <= endTime) {
    const shardEnd = Math.min(cursor + (shardDays - 1) * DAY_MS, endTime)
    // A/HK/US markets close Sat/Sun, so a 1-day weekend shard is a
    // guaranteed-empty request — skip it (~28% of a long range, and daily
    // quota). Multi-day shards (hkStocks=2, index=15) are kept whole: this is a
    // deliberate simplification, not a claim that they always contain a weekday —
    // a 2-day shard starting on a Saturday is Sat+Sun and returns nothing. That
    // costs one wasted request at a range boundary and never drops a trading day,
    // whereas filtering multi-day windows correctly means walking each window.
    if (!(calendar === "workday" && shardDays === 1 && isWeekend(cursor))) {
      shards.push({
        startDate: formatDate(new Date(cursor)),
        endDate: formatDate(new Date(shardEnd)),
      })
    }
    cursor = shardEnd + DAY_MS
  }
  return shards
}

type PartOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string; cause: unknown }

/** 逐个发出，取消即停：取消的请求结果到不了调用方，剩下的分片 / 证券不再派发。 */
async function fetchParts<P>(parts: P[], concurrency: number, fetch: (part: P) => Promise<unknown>): Promise<PartOutcome[]> {
  const signal = currentSignal()
  return runWithConcurrency(parts, concurrency, async (part): Promise<PartOutcome> => {
    try {
      return { ok: true, value: await fetch(part) }
    } catch (err) {
      if (signal?.aborted) throw err
      // 形状不符是「这一份载荷并不进来」，不是请求失败：交给合并去记 malformed，其余照常合并。
      if (err instanceof ResponseShapeError) return { ok: true, value: err.payload }
      return { ok: false, error: errorMessage(err), cause: err }
    }
  }, signal)
}

/** 把一片的列顺序对回首片。
 *
 *  - `map: null` —— 与首片逐位相同，行不用动。
 *  - `map: number[]` —— 按列名重排的下标映射。
 *  - `undefined` —— 首片有的列这一片没有，对不齐，这一片不能并进来。
 *
 *  🔴 `extra` 是这一片**比首片多出来的列**。合并结果的 `fieldList` 是首片的，多出来的列
 *  没有位置可放，只能丢——但**不能静默丢**：那意味着某几天/某几只确实返回了这一列，而
 *  调用方从结果里完全看不出来。调用方按列名报出来，才有机会缩小范围重拉。 */
function columnRemap(header: string[], part: string[]): { map: number[] | null; extra: string[] } | undefined {
  const headerSet = new Set(header)
  const extra = part.filter((field) => !headerSet.has(field))
  if (extra.length === 0 && header.length === part.length && header.every((field, i) => field === part[i])) {
    return { map: null, extra }
  }
  const index = new Map(part.map((field, i) => [field, i]))
  const map: number[] = []
  for (const field of header) {
    const i = index.get(field)
    if (i === undefined) return undefined
    map.push(i)
  }
  return { map, extra }
}

function partRows(value: unknown): { rec: Record<string, unknown>; rows: unknown[] } | undefined {
  const rec = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  if (!rec) return undefined
  // `{total: 0, list: null}` 是部分端点编码空结果的写法（见 client.isPaginatedListResponse），
  // 是合法的零行、不是坏形状；除此之外没有数组 `list` 就是形状漂移。
  const rows = Array.isArray(rec.list)
    ? (rec.list as unknown[])
    : rec.total === 0 && (rec.list === null || rec.list === undefined)
      ? []
      : undefined
  return rows === undefined ? undefined : { rec, rows }
}

interface MergedParts {
  header: Record<string, unknown> | null
  fieldList: string[] | undefined
  merged: unknown[]
  /** 行数撞到单请求上限的部件下标：那一段本身被截断了。 */
  truncated: number[]
  /** HTTP 没报错、载荷却并不进来的部件下标：没有可合并的 `list`，或数组行没有一份
   *  自洽的 fieldList（缺失 / 重名 / 行长对不上），或列集合与首片对不上。 */
  malformed: number[]
  /** 各部件自己带来的 `_partial_reason`。合并结果只展开首片的元数据、且随后会覆写
   *  `_partial_reason`，不单独收集的话：非首片的标记整个消失，首片的原因被覆盖掉。 */
  partReasons: PartialReason[]
  /** 某些部件返回了首片没有的列。合并结果的 `fieldList` 是首片的，这些列没有位置可放，
   *  只能丢；按列名报出来，调用方才知道有一列在部分范围里其实是有值的。 */
  droppedColumns: string[]
}

/** 合并多段同构响应（按日分片、逐只证券）。
 *
 * 🔴 数组行**按列名对齐**，不按位置：合并采用首片的 fieldList 解释全部部件，而各部件的
 * 列顺序并没有谁保证一致——第二片把 open/close 调个位置，按位置并进来就是开盘价与收盘价
 * 互换，列数相同、长度校验抓不到、也不标 _partial。对不上列名集合的部件按坏形状记名。 */
function mergeParts(results: PartOutcome[], perLimit: number): MergedParts {
  let header: Record<string, unknown> | null = null
  let fieldList: string[] | undefined
  const merged: unknown[] = []
  const truncated: number[] = []
  const malformed: number[] = []
  const partReasons = new Set<PartialReason>()
  const droppedColumns = new Set<string>()
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (!r.ok) continue
    const part = partRows(r.value)
    if (!part) {
      malformed.push(i)
      continue
    }
    if (part.rec._partial === true) {
      const reasons = partialReasonsOf(part.rec) as PartialReason[]
      for (const one of reasons.length > 0 ? reasons : ["part_partial" as const]) partReasons.add(one)
    }
    let rows = part.rows
    const partFields = Array.isArray(part.rec.fieldList) && part.rec.fieldList.length > 0 ? part.rec.fieldList.map(String) : undefined
    const columnar = rows.some(Array.isArray)
    if (
      columnar &&
      (!partFields || new Set(partFields).size !== partFields.length || rows.some((row) => Array.isArray(row) && row.length !== partFields.length))
    ) {
      malformed.push(i)
      continue
    }
    if (!fieldList && partFields) fieldList = partFields
    if (columnar && fieldList && partFields) {
      const remap = columnRemap(fieldList, partFields)
      if (remap === undefined) {
        malformed.push(i)
        continue
      }
      for (const field of remap.extra) droppedColumns.add(field)
      const map = remap.map
      if (map) rows = rows.map((row) => (Array.isArray(row) ? map.map((k) => row[k]) : row))
    }
    if (!header) header = part.rec
    // A part whose row count reaches the per-request limit was itself capped, so
    // its slice is incomplete — record it so a consumer can re-pull exactly that
    // window / security with a narrower range.
    if (rows.length >= perLimit) truncated.push(i)
    merged.push(...rows)
  }
  return { header, fieldList, merged, truncated, malformed, partReasons: [...partReasons], droppedColumns: [...droppedColumns] }
}

/** 合并结果里多出来的列被丢掉时，按列名记名并标 `_partial`。分片与逐只两条路共用。 */
/** 合并结果的元数据取自第一份。第一份自带的原因已经收进 partReasons，这里先清空原因串再整组写入，
 *  原因顺序才是「本层原因在前、各部件原因在后」；`_partial` 键若已存在则保留原位。 */
function clearPartialReason(out: Record<string, unknown>): Record<string, unknown> {
  return "_partial_reason" in out ? { ...out, _partial_reason: "" } : out
}

function flagDroppedColumns(reasons: PartialReason[], details: Record<string, unknown>, droppedColumns: string[]): void {
  if (droppedColumns.length === 0) return
  reasons.push("dropped_columns")
  details._dropped_columns = droppedColumns
  details._dropped_columns_note = "这些列只在部分分片/证券的响应里出现，而合并结果的 fieldList 取自第一份，放不下它们；需要这些列请缩小日期区间或按证券单独重拉"
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
  const cap = config.cap ?? ALL_MARKET_LIMIT
  const calendar = config.calendar ?? "workday"
  const allMarketBody: KlineBody = { ...body, limit: body.limit ?? cap }
  const perShardLimit = allMarketBody.limit ?? cap

  // A single full-market request (missing/unparseable dates, or a range that fits
  // one shard) skips the merge loop below, so it needs the same limit-truncation
  // check inline — else a low limit or an oversized single window slips through as a
  // silently truncated "complete" result (e.g. index 'all' over a 30-day window).
  // 「没有可读 list」的载荷由端点的 `expects` 在 client 里拦下（带 traceId），不会走到这里。
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
    if (calendar === "workday" && config.shardDays === 1 && isWeekend(start.getTime())) {
      return { list: [] }
    }
    return callSingle()
  }

  const shards = buildShards(start, end, config.shardDays, calendar)
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

  const results = await fetchParts(shards, config.concurrency ?? PAGE_CONCURRENCY, (shard) =>
    client.call(endpointKey, { ...allMarketBody, startDate: shard.startDate, endDate: shard.endDate }),
  )

  const failed = results
    .map((r, i) => ({ r, i }))
    .filter((x): x is { r: Extract<PartOutcome, { ok: false }>; i: number } => !x.r.ok)
  // Every shard failed → surface the original error instead of masking it as empty data.
  if (failed.length === shards.length) {
    throw failed[0].r.cause
  }

  const { header, fieldList, merged, truncated, malformed, partReasons, droppedColumns } = mergeParts(results, perShardLimit)

  // 没有任何一个分片给出可用形状（全失败已在上面抛过，这里是「全部坏形状」以及
  // 「失败 + 坏形状」的混合）——没有 header 就没有可信的载体，标 _partial 也只是把一份
  // 无中生有的空表递出去。响亮失败。
  if (!header) {
    if (malformed.length > 0) {
      const alsoFailed = failed.length > 0 ? `，另有 ${failed.length} 个分片请求失败（${failed[0].r.error}）` : ""
      throw new ApiError(
        `全市场分片查询：${malformed.length} 个分片返回的载荷里没有可合并的 list 或列结构对不上（形状可能已变更）${alsoFailed}，没有任何分片给出可用数据——请重试；持续出现请带上工具名与日期区间报障。`,
      )
    }
    return { list: [] }
  }
  const out: Record<string, unknown> = { ...header, list: merged }
  if (fieldList) out.fieldList = fieldList
  // The header's `total` describes the first shard only — recompute it for the
  // merged result so downstream completeness checks aren't misled.
  if ("total" in out) out.total = merged.length
  // Loud partial: a dropped shard (failure), a shard whose rows hit the per-request
  // limit (truncated slice) or a shard whose payload could not be merged all leave
  // the merged market data incomplete.
  const reasons: PartialReason[] = []
  const details: Record<string, unknown> = {}
  if (failed.length > 0) {
    reasons.push("failed_shards")
    details._failed_shards = failed.map(({ r, i }) => ({ startDate: shards[i].startDate, endDate: shards[i].endDate, error: r.error }))
  }
  if (truncated.length > 0) {
    reasons.push("limit_truncated")
    details._truncated_shards = truncated.map((i) => shards[i])
  }
  if (malformed.length > 0) {
    reasons.push("malformed_shards")
    details._malformed_shards = malformed.map((i) => shards[i])
  }
  flagDroppedColumns(reasons, details, droppedColumns)
  for (const reason of partReasons) if (!reasons.includes(reason)) reasons.push(reason)
  return reasons.length > 0 ? markPartial(clearPartialReason(out), reasons, details, "details-first") : clearPartial(out)
}

/**
 * 显式多证券、单请求装不下时逐只请求再按传入顺序合并。每只各自受 `perLimit` 约束，
 * 撞上限的证券记进 `_truncated_securities`；请求失败 / 载荷并不进来的分别记进
 * `_failed_securities` / `_malformed_securities`，与全市场分片的标记对称。
 */
export async function callKlinePerSecurity(
  client: KlineClient,
  endpointKey: string,
  securities: string[],
  makeBody: (security: string) => Record<string, unknown>,
  perLimit: number,
): Promise<unknown> {
  if (isVerbose()) {
    process.stderr.write(`[gangtise] splitting ${endpointKey} into ${securities.length} per-security requests\n`)
  }
  const results = await fetchParts(securities, PAGE_CONCURRENCY, (code) => client.call(endpointKey, makeBody(code)))

  const failed = results
    .map((r, i) => ({ r, i }))
    .filter((x): x is { r: Extract<PartOutcome, { ok: false }>; i: number } => !x.r.ok)
  if (failed.length === securities.length) {
    throw failed[0].r.cause
  }

  const { header, fieldList, merged, truncated, malformed, partReasons, droppedColumns } = mergeParts(results, perLimit)
  if (!header) {
    if (malformed.length > 0) {
      const alsoFailed = failed.length > 0 ? `，另有 ${failed.length} 只请求失败（${failed[0].r.error}）` : ""
      throw new ApiError(
        `逐只查询：${malformed.length} 只证券返回的载荷里没有可合并的 list 或列结构对不上（形状可能已变更）${alsoFailed}，没有任何一只给出可用数据——请重试；持续出现请带上工具名与证券代码报障。`,
      )
    }
    return { list: [] }
  }
  const out: Record<string, unknown> = { ...header, list: merged }
  if (fieldList) out.fieldList = fieldList
  if ("total" in out) out.total = merged.length
  const reasons: PartialReason[] = []
  const details: Record<string, unknown> = {}
  if (failed.length > 0) {
    reasons.push("failed_securities")
    details._failed_securities = failed.map(({ r, i }) => ({ security: securities[i], error: r.error }))
  }
  if (truncated.length > 0) {
    reasons.push("limit_truncated")
    details._truncated_securities = truncated.map((i) => securities[i])
  }
  if (malformed.length > 0) {
    reasons.push("malformed_securities")
    details._malformed_securities = malformed.map((i) => securities[i])
  }
  flagDroppedColumns(reasons, details, droppedColumns)
  for (const reason of partReasons) if (!reasons.includes(reason)) reasons.push(reason)
  return reasons.length > 0 ? markPartial(clearPartialReason(out), reasons, details, "details-first") : clearPartial(out)
}
