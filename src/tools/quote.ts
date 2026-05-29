import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { normalizeRows } from "../core/normalize.js"
import { callKlineWithSharding, type KlineBody } from "../core/quoteSharding.js"
import { dateDesc, dateTimeDesc } from "../core/dateContext.js"
import { buildToolContent } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"

/** Safe default field set for quote.day-kline-us. Backend's full default
 * field set currently triggers 999999, so we inject these when caller
 * doesn't pass field. Mirror of fields shown in CLI docs. */
const US_KLINE_DEFAULT_FIELDS = ["tradeDate", "open", "high", "low", "close", "pctChange", "volume", "amount"]

const commonKlineSchema = {
  security: z.union([z.string(), z.array(z.string())]).optional().describe("证券代码，如 '600519.SH' 或 ['600519.SH','000858.SZ']；传 'all' 拉取全市场"),
  startDate: z.string().optional().describe(dateDesc()),
  endDate: z.string().optional().describe(dateDesc()),
  limit: z.number().int().optional().describe("最大返回行数（默认 6000，最大 10000）"),
  field: z.array(z.string()).optional().describe("指定返回字段，如 ['open','close','pctChange']"),
}

function buildKlineBody(args: Record<string, unknown>): KlineBody {
  const body: KlineBody = {}
  if (args.security) {
    body.securityList = Array.isArray(args.security) ? args.security : [args.security as string]
  }
  if (args.startDate) body.startDate = args.startDate as string
  if (args.endDate) body.endDate = args.endDate as string
  if (args.limit) body.limit = args.limit as number
  if (args.field) body.fieldList = args.field as string[]
  return body
}

function klineHandler(client: GangtiseClient, endpointKey: string, shardDays: number) {
  return toolHandler(async (args: Record<string, unknown>) => {
    const body = buildKlineBody(args)
    const isAllMarket = body.securityList?.[0] === "all"
    const result = isAllMarket && body.startDate && body.endDate
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
    },
    async (args) => klineHandler(client, "quote.day-kline", 1)(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_day_kline_hk",
    {
      description: "查询港股历史日 K 线数据（仅历史；盘中实时请用 gangtise_realtime）。",
      inputSchema: commonKlineSchema,
    },
    async (args) => klineHandler(client, "quote.day-kline-hk", 2)(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_day_kline_us",
    {
      description: "查询美股历史日 K 线数据（NYSE/NASDAQ/AMEX，代码格式如 AAPL.O/.N/.A；仅历史，盘中实时请用 gangtise_realtime）。security='all' 配合 startDate/endDate 可拉取全市场（自动按 1 天/片分片）。",
      inputSchema: commonKlineSchema,
    },
    async (args) => {
      // Backend workaround: day-kline-us 不传 field 时后端默认字段集中有坏字段，
      // 返回 999999 系统错误。显式指定字段可绕开。等后端修复后可移除此 fallback。
      const patched = args.field ? args : { ...args, field: US_KLINE_DEFAULT_FIELDS }
      return klineHandler(client, "quote.day-kline-us", 1)(patched as Record<string, unknown>)
    },
  )

  server.registerTool(
    "gangtise_index_day_kline",
    {
      description: "查询指数日 K 线数据（沪深北指数）。返回字段含指数名称 securityName（如\"上证指数\"）。",
      inputSchema: commonKlineSchema,
    },
    async (args) => klineHandler(client, "quote.index-day-kline", 30)(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_minute_kline",
    {
      description: "查询 A 股分钟级 K 线数据，需指定单只证券代码。",
      inputSchema: {
        security: z.string().describe("单只证券代码，如 '600519.SH'"),
        startTime: z.string().optional().describe(dateTimeDesc()),
        endTime: z.string().optional().describe(dateTimeDesc()),
        limit: z.number().int().optional().describe("最大返回行数（默认 5000，最大 10000）"),
        field: z.array(z.string()).optional(),
      },
    },
    toolHandler(async ({ security, startTime, endTime, limit, field }: Record<string, unknown>) => {
      const body: Record<string, unknown> = { securityCode: security }
      if (startTime) body.startTime = startTime
      if (endTime) body.endTime = endTime
      if (limit) body.limit = limit
      if (field) body.fieldList = field
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
        field: z.array(z.string()).optional().describe("【默认不传 = 返回全量字段，最稳】仅当用户明确要精简、或查全市场（aShares/hkStocks/usStocks）想省 token 时才传。一旦传入必须显式包含识别字段 securityCode/tradeDate/tradeTime（exchange 可省略），否则多只查询无法对齐行与代码。示例：['securityCode','tradeDate','tradeTime','latestPrice','pctChange','volume']"),
      },
    },
    toolHandler(async ({ security, field }: Record<string, unknown>) => {
      const body: Record<string, unknown> = {}
      if (security) body.securityList = Array.isArray(security) ? security : [security]
      if (field) body.fieldList = field
      const result = await client.call("quote.realtime", body)
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )
}
