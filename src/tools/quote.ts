import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { normalizeRows } from "../core/normalize.js"
import { ValidationError } from "../core/errors.js"
import { callKlineWithSharding, type KlineBody } from "../core/quoteSharding.js"
import { dateDesc, dateString, dateTimeDesc, dateTimeString } from "../core/dateContext.js"
import { buildToolContent } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"

/** Safe default field set for quote.day-kline-us. Backend's full default
 * field set currently triggers 999999, so we inject these when caller
 * doesn't pass fieldList. Mirror of fields shown in CLI docs. */
const US_KLINE_DEFAULT_FIELDS = ["tradeDate", "open", "high", "low", "close", "pctChange", "volume", "amount"]

const commonKlineSchema = {
  security: z.union([z.string(), z.array(z.string())]).optional().describe("证券代码，如 '600519.SH' 或 ['600519.SH','000858.SZ']；传 'all' 拉取全市场（须同时提供 startDate 和 endDate——上游对开区间的全市场查询返回空数据或报「行情查询超出限制」）"),
  startDate: dateString.optional().describe(dateDesc()),
  endDate: dateString.optional().describe(dateDesc()),
  limit: z.number().int().min(1).max(10_000).optional().describe("单次请求最大返回行数（默认 6000，最大 10000）。上游从查询窗口开头截取——取「最近 N 条」须传日期区间而非只传 limit；全市场分片查询时该值作用于每个分片"),
  fieldList: z.array(z.string()).optional().describe("指定返回字段，如 ['open','close','pctChange']"),
}

function buildKlineBody(args: Record<string, unknown>): KlineBody {
  const body: KlineBody = {}
  if (args.security) {
    body.securityList = Array.isArray(args.security) ? args.security : [args.security as string]
  }
  if (args.startDate) body.startDate = args.startDate as string
  if (args.endDate) body.endDate = args.endDate as string
  if (args.limit !== undefined) body.limit = args.limit as number
  if (args.fieldList) body.fieldList = args.fieldList as string[]
  return body
}

const SUFFIX_MARKET: Record<string, "cn" | "hk" | "us"> = {
  SH: "cn", SZ: "cn", BJ: "cn", HK: "hk", O: "us", N: "us", A: "us",
}
const MARKET_LABEL: Record<"cn" | "hk" | "us", string> = { cn: "A股", hk: "港股", us: "美股" }
const MARKET_TOOL: Record<"cn" | "hk" | "us", string> = {
  cn: "gangtise_day_kline", hk: "gangtise_day_kline_hk", us: "gangtise_day_kline_us",
}

/** Reject an obvious market/tool mismatch (e.g. an .HK code sent to the A-share
 * tool) before it hits upstream and returns a silent empty list that reads as
 * "no data" — the costliest silent error here. Skips 'all' and unknown suffixes
 * so only a clear cross-market mismatch throws. */
function assertMarketMatch(securityList: readonly unknown[] | undefined, market: "cn" | "hk" | "us"): void {
  if (!securityList) return
  for (const code of securityList) {
    if (typeof code !== "string" || code === "all") continue
    const codeMarket = SUFFIX_MARKET[code.split(".").pop()?.toUpperCase() ?? ""]
    if (codeMarket && codeMarket !== market) {
      throw new ValidationError(`'${code}' 是${MARKET_LABEL[codeMarket]}代码，请改用 ${MARKET_TOOL[codeMarket]}。`)
    }
  }
}

function klineHandler(client: GangtiseClient, endpointKey: string, shardDays: number, market?: "cn" | "hk" | "us") {
  return toolHandler(async (args: Record<string, unknown>) => {
    const body = buildKlineBody(args)
    if (market) assertMarketMatch(body.securityList, market)
    const isAllMarket = body.securityList?.[0] === "all"
    // All-market always goes through the sharding helper: even when a date is
    // missing (no sharding possible) it must still get the 10K limit lift.
    const result = isAllMarket
      ? await callKlineWithSharding(client, endpointKey, body, { shardDays })
      : await client.call(endpointKey, body)
    return contentResult(await buildToolContent(normalizeRows(result)))
  })
}

export function registerQuoteTools(server: McpServer, client: GangtiseClient): void {
  server.registerTool(
    "gangtise_day_kline",
    {
      description: "查询 A 股历史日 K 线数据（沪深北市场，仅历史；盘中实时请用 gangtise_realtime）。security='all' 配合 startDate/endDate 可拉取全市场行情（自动分片）。",
      inputSchema: commonKlineSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => klineHandler(client, "quote.day-kline", 1, "cn")(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_day_kline_hk",
    {
      description: "查询港股历史日 K 线数据（港股代码如 00700.HK，5 位数字前补零；仅历史，盘中实时请用 gangtise_realtime）。security='all' 配合 startDate/endDate 可拉取全市场（自动分片）。",
      inputSchema: commonKlineSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => klineHandler(client, "quote.day-kline-hk", 2, "hk")(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_day_kline_us",
    {
      description: "查询美股历史日 K 线数据（NYSE/NASDAQ/AMEX，代码格式如 AAPL.O/.N/.A；仅历史，盘中实时请用 gangtise_realtime）。security='all' 配合 startDate/endDate 可拉取全市场（自动按 1 天/片分片）。",
      inputSchema: commonKlineSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      // Backend workaround: day-kline-us 不传 fieldList 时后端默认字段集中有坏字段，
      // 返回 999999 系统错误。显式指定字段可绕开。等后端修复后可移除此 fallback。
      const patched = args.fieldList ? args : { ...args, fieldList: US_KLINE_DEFAULT_FIELDS }
      return klineHandler(client, "quote.day-kline-us", 1, "us")(patched as Record<string, unknown>)
    },
  )

  server.registerTool(
    "gangtise_index_day_kline",
    {
      description: "查询指数日 K 线数据（沪深北指数，代码如 000001.SH 上证指数、399001.SZ 深成指）。security='all' 配合 startDate/endDate 可拉取全市场（自动分片）。返回字段含指数名称 securityName（如\"上证指数\"）。",
      inputSchema: commonKlineSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => klineHandler(client, "quote.index-day-kline", 30)(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_minute_kline",
    {
      description: "查询 A 股分钟级 K 线数据，需指定单只证券代码。",
      inputSchema: {
        security: z.string().describe("单只证券代码，如 '600519.SH'"),
        startTime: dateTimeString.optional().describe(dateTimeDesc()),
        endTime: dateTimeString.optional().describe(dateTimeDesc()),
        limit: z.number().int().min(1).max(10_000).optional().describe("最大返回行数（默认 5000，最大 10000）"),
        fieldList: commonKlineSchema.fieldList,
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(async ({ security, startTime, endTime, limit, fieldList }: Record<string, unknown>) => {
      const body: Record<string, unknown> = { securityCode: security }
      if (startTime) body.startTime = startTime
      if (endTime) body.endTime = endTime
      if (limit !== undefined) body.limit = limit
      if (fieldList) body.fieldList = fieldList
      const result = await client.call("quote.minute-kline", body)
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )

  server.registerTool(
    "gangtise_realtime",
    {
      description: "查询实时行情快照，单接口覆盖 A 股 / 港股 / 美股，可代码混合传入。非交易时间返回最近一个交易日的收盘快照；停牌证券返回停牌前最后一个有效快照。日 K 线接口（day-kline*）不含盘中数据，问\"现在/此刻\"请走本工具。",
      inputSchema: {
        security: z.union([z.string(), z.array(z.string())]).optional().describe("证券代码或全市场关键字：单/多只代码（'600519.SH' / ['600519.SH','00700.HK','AAPL.O']），或市场关键字 'aShares' / 'hkStocks' / 'usStocks' 拉取全市场。"),
        fieldList: z.array(z.string()).optional().describe("【默认不传 = 返回全量字段，最稳】仅当用户明确要精简、或查全市场（aShares/hkStocks/usStocks）想省 token 时才传。一旦传入必须显式包含识别字段 securityCode/tradeDate/tradeTime（exchange 可省略），否则多只查询无法对齐行与代码。示例：['securityCode','tradeDate','tradeTime','latestPrice','pctChange','volume']"),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(async ({ security, fieldList }: Record<string, unknown>) => {
      const body: Record<string, unknown> = {}
      if (security) body.securityList = Array.isArray(security) ? security : [security]
      if (fieldList) body.fieldList = fieldList
      const result = await client.call("quote.realtime", body)
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )
}
