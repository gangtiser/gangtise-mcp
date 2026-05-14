import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { normalizeRows } from "../core/normalize.js"
import { callKlineWithSharding, type KlineBody } from "../core/quoteSharding.js"
import { errorMessage } from "../core/errors.js"

const commonKlineSchema = {
  security: z.union([z.string(), z.array(z.string())]).optional().describe("证券代码，如 '600519.SH' 或 ['600519.SH','000858.SZ']；传 'all' 拉取全市场"),
  startDate: z.string().optional().describe("YYYY-MM-DD"),
  endDate: z.string().optional().describe("YYYY-MM-DD"),
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
  return async (args: Record<string, unknown>) => {
    try {
      const body = buildKlineBody(args)
      const isAllMarket = body.securityList?.[0] === "all"
      let result: unknown

      if (isAllMarket && body.startDate && body.endDate) {
        result = await callKlineWithSharding(client, endpointKey, body, { shardDays })
      } else {
        result = await client.call(endpointKey, body)
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(normalizeRows(result), null, 2) }] }
    } catch (err) {
      return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true }
    }
  }
}

export function registerQuoteTools(server: McpServer, client: GangtiseClient): void {
  server.registerTool(
    "gangtise_day_kline",
    {
      description: "查询 A 股日 K 线数据（沪深北市场）。security='all' 配合 startDate/endDate 可拉取全市场行情（自动分片）。",
      inputSchema: commonKlineSchema,
    },
    async (args) => klineHandler(client, "quote.day-kline", 2)(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_day_kline_hk",
    {
      description: "查询港股日 K 线数据。",
      inputSchema: commonKlineSchema,
    },
    async (args) => klineHandler(client, "quote.day-kline-hk", 3)(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_index_day_kline",
    {
      description: "查询指数日 K 线数据（沪深北指数）。",
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
        startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
        endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
        limit: z.number().int().optional().describe("最大返回行数（默认 5000，最大 10000）"),
        field: z.array(z.string()).optional(),
      },
    },
    async ({ security, startTime, endTime, limit, field }) => {
      try {
        const body: Record<string, unknown> = { securityList: [security] }
        if (startTime) body.startTime = startTime
        if (endTime) body.endTime = endTime
        if (limit) body.limit = limit
        if (field) body.fieldList = field
        const result = await client.call("quote.minute-kline", body)
        return { content: [{ type: "text" as const, text: JSON.stringify(normalizeRows(result), null, 2) }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true }
      }
    },
  )
}
