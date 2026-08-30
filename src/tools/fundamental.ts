import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { registerJsonTool, buildToolContent, type JsonToolSpec } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"
import { assertDateOrder } from "./registry.js"
import { normalizeRows } from "../core/normalize.js"
import { dateString } from "../core/dateContext.js"
import { nonEmptyString, uniqueFieldList, enumList } from "./schemas.js"

const periodEnum = enumList(z.enum(["q1", "interim", "q3", "annual", "latest"])).optional().describe("q1=一季报 | interim=中报 | q3=三季报 | annual=年报 | latest=最新")
const quarterlyPeriodEnum = enumList(z.enum(["q1", "q2", "q3", "q4", "latest"])).optional().describe("q1 | q2 | q3 | q4 | latest")
const hkPeriodEnum = enumList(z.enum(["q1", "h1", "q3", "h2", "nsd", "annual", "latest"])).optional().describe("q1 | h1=中报 | q3 | h2=下半年报 | nsd=不规则跨度 | annual=年报 | latest")
const usPeriodEnum = enumList(z.enum(["q1", "h1", "q3", "nsd", "annual", "latest"])).optional().describe("q1 | h1=中报 | q3 | nsd=不规则跨度 | annual=年报 | latest")
// 口径表由 server.instructions 的「通用参数」行统一声明（11 处共用）。别在这里加回描述。
const reportTypeEnum = enumList(z.enum(["consolidated", "consolidatedRestated", "standalone", "standaloneRestated"])).optional()
const securityCode = nonEmptyString.describe("证券代码，如 '600519.SH'")
const securityCodeHk = nonEmptyString.describe("证券代码，如 '00700.HK'（5 位数字前补零）")
const securityCodeUs = nonEmptyString.describe("证券代码，如 'TSLA.O'（.O=NASDAQ / .N=NYSE / .A=AMEX）")
const dateRange = {
  startDate: dateString.optional(),
  endDate: dateString.optional(),
}
const fiscalYear = enumList(z.number().int()).optional().describe("财年列表，如 [2023, 2024]")
const fieldList = uniqueFieldList("指定返回字段")
// 实测 2026-07-26：valuation-analysis 全表就 7 列，且**没有 securityCode**。
// 两个坑，都只能在 schema 层挡：
//  1. 传不存在的字段名（如 securityCode），上游把相邻列的值复制进该槽位、**字段数与
//     行长仍然相等**——请求 ['securityCode','tradeDate','value'] 实到
//     ['2026-07-20','2026-07-20',20.06]，securityCode 拿到的是日期。等长错列
//     normalize 的长度校验发现不了，静默返错值。
//  2. tradeDate **总是自动前置**到每一行：显式请求它会让值多一个而字段名不多
//     （请求 ['tradeDate','value'] → 2 名 3 值），反而把长度校验撞红。
// 所以可选字段是**除 tradeDate 外的 6 个**；tradeDate 无论传不传都会返回。
// 收 z.enum 而不是只写进 describe：描述只是建议，schema 才会拒（同 0.1.38 对
// categoryList 收 z.enum 的理由，且这里后果更重——那边静默返全量，这边静默返错值）。
const VALUATION_FIELD_NAMES = ["value", "percentileRank", "average", "median", "upper1Std", "lower1Std"] as const
const valuationFieldList = z
  .array(z.enum(VALUATION_FIELD_NAMES))
  .min(1, "fieldList 不能为空数组：要投影字段就至少给一个，要全量就省略该参数")
  .refine((v) => new Set(v).size === v.length, "fieldList 不能重复：同名字段在按位置拍平时会相互覆盖，导致静默少一列")
  .optional()
  .describe(`指定返回字段，只认这 6 个：${VALUATION_FIELD_NAMES.join(" / ")}。tradeDate 总是自动返回、**不要传**（传了会让响应长度对不上而报错）；本接口也没有 securityCode。不确定就不传（=返回全部 7 列，最稳）`)
// 实测 2026-07-26：主营接口固定前置 periodName/periodEndDate，传错字段名会导致
// 字段数比行长多 1（回显 5 个名、只给 4 个值），normalize 会直接报错拒绝 —— 不会
// 静默错列，但错的字段名等于白跑一次，同样收成闭集在本地就拒。
const MAIN_BUSINESS_FIELD_NAMES = [
  "periodName", "periodEndDate", "categoryName",
  "opRevenue", "opRevenueYoy", "opRevenueRatio",
  "opCost", "opCostYoy", "opCostRatio",
  "grossProfit", "grossProfitYoy", "grossProfitRatio",
  "grossMargin", "grossMarginYoy", "grossMarginRatio",
] as const
const mainBusinessFieldList = z
  .array(z.enum(MAIN_BUSINESS_FIELD_NAMES))
  .min(1, "fieldList 不能为空数组：要投影字段就至少给一个，要全量就省略该参数")
  .refine((v) => new Set(v).size === v.length, "fieldList 不能重复：同名字段在按位置拍平时会相互覆盖，导致静默少一列")
  .optional()
  .describe(`指定返回字段，只认这 15 个主营字段：${MAIN_BUSINESS_FIELD_NAMES.join(" / ")}。不确定就不传`)
// 报表里有两个披露日字段，取值可能不同，而选错的后果是 point-in-time 校验得出相反结论
// （拿一个晚得多的日期去回溯，等于把未来信息当成当时可见）。这不是普遍现象、是个股级的，
// 所以只能靠字段选择规避，没法靠「换只票验一下」发现——茅台两个字段一致，用它当探针
// 什么也测不出来。
const PIT_NOTE = "做 point-in-time / 时点对齐请用 earliestAnncDate（首次公告日）：announcementDate 在部分个股上会把同一财年各期都填成最后一期的披露日，用它回溯会把本来早已可得的数据算成尚不可见（一/中/三季要等到年报日才「出现」），据此做的回测会漏掉整段区间。⚠️ 另一个方向也要留意：category 为「补充更正」「其他财务报告」的行，其数字来自那次更正公告，此时 earliestAnncDate 早于数字真正可得的时点——这类行两个字段都不是安全的时点，需按 category 单独判断。"

export const specs: JsonToolSpec[] = [
  {
    name: "gangtise_income_statement",
    description: `查询A股利润表（累计口径），支持期间、财年、报告类型筛选。${PIT_NOTE}`,
    endpointKey: "fundamental.income-statement",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: periodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
  },
  {
    name: "gangtise_income_statement_quarterly",
    description: `查询A股单季利润表。${PIT_NOTE}本工具的 companyType 返回的是未映射的数字码，要读公司类型请取累计口径报表的同名字段。`,
    endpointKey: "fundamental.income-statement-quarterly",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: quarterlyPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
  },
  {
    name: "gangtise_balance_sheet",
    description: `查询A股资产负债表，支持期间、财年、报告类型筛选。${PIT_NOTE}`,
    endpointKey: "fundamental.balance-sheet",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: periodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
  },
  {
    name: "gangtise_cash_flow",
    description: `查询A股现金流量表（累计口径），支持期间、财年、报告类型筛选。${PIT_NOTE}`,
    endpointKey: "fundamental.cash-flow",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: periodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
  },
  {
    name: "gangtise_cash_flow_quarterly",
    description: `查询A股单季现金流量表。${PIT_NOTE}本工具的 companyType 返回的是未映射的数字码，要读公司类型请取累计口径报表的同名字段。`,
    endpointKey: "fundamental.cash-flow-quarterly",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: quarterlyPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
  },
  {
    name: "gangtise_main_business",
    description: "查询主营业务构成（按产品、行业或地区拆分）。",
    endpointKey: "fundamental.main-business",
    paginated: false,
    inputSchema: {
      securityCode,
      breakdown: z.enum(["product", "industry", "region"]).describe("product=产品 | industry=行业 | region=地区（必填）"),
      ...dateRange,
      periodList: enumList(z.enum(["interim", "annual"])).optional().describe("interim=中报 | annual=年报"),
      fieldList: mainBusinessFieldList,
    },
  },
  {
    name: "gangtise_top_holders",
    description: "查询前十大股东或前十大流通股东。",
    endpointKey: "fundamental.top-holders",
    paginated: false,
    inputSchema: {
      securityCode,
      holderType: z.enum(["top10", "top10Float"]).describe("top10=前十大股东 | top10Float=前十大流通股东（必填）"),
      ...dateRange,
      fiscalYear,
      period: periodEnum,
    },
  },
  {
    name: "gangtise_earning_forecast",
    description: "查询盈利预测一致预期（EPS、PE、净利润、ROE 等）。",
    endpointKey: "fundamental.earning-forecast",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      consensusList: enumList(z.enum(["netIncome", "netIncomeYoy", "eps", "pe", "bps", "pb", "peg", "roe", "ps"])).optional().describe("netIncome=净利润 | netIncomeYoy=净利润增速 | eps | pe | bps | pb | peg | roe | ps"),
    },
  },
  {
    name: "gangtise_income_statement_hk",
    description: "查询港股利润表（中国会计准则），支持期间、财年、报告类型筛选。",
    endpointKey: "fundamental.income-statement-hk",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeHk,
      ...dateRange,
      fiscalYear,
      period: hkPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
  },
  {
    name: "gangtise_balance_sheet_hk",
    description: "查询港股资产负债表（中国会计准则），支持期间、财年、报告类型筛选。",
    endpointKey: "fundamental.balance-sheet-hk",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeHk,
      ...dateRange,
      fiscalYear,
      period: hkPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
  },
  {
    name: "gangtise_cash_flow_hk",
    description: "查询港股现金流量表（中国会计准则），支持期间、财年、报告类型筛选。",
    endpointKey: "fundamental.cash-flow-hk",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeHk,
      ...dateRange,
      fiscalYear,
      period: hkPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
  },
  {
    name: "gangtise_income_statement_us",
    description: "查询美股利润表，支持期间、财年、报告类型筛选。证券代码如 'TSLA.O'。",
    endpointKey: "fundamental.income-statement-us",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeUs,
      ...dateRange,
      fiscalYear,
      period: usPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
  },
  {
    name: "gangtise_balance_sheet_us",
    description: "查询美股资产负债表，支持期间、财年、报告类型筛选。证券代码如 'TSLA.O'。",
    endpointKey: "fundamental.balance-sheet-us",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeUs,
      ...dateRange,
      fiscalYear,
      period: usPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
  },
  {
    name: "gangtise_cash_flow_us",
    description: "查询美股现金流量表，支持期间、财年、报告类型筛选。证券代码如 'TSLA.O'。",
    endpointKey: "fundamental.cash-flow-us",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeUs,
      ...dateRange,
      fiscalYear,
      period: usPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
  },
]

export function registerFundamentalTools(server: McpServer, client: GangtiseClient): void {
  for (const spec of specs) {
    registerJsonTool(server, client, spec)
  }

  server.registerTool(
    "gangtise_valuation_analysis",
    {
      description: "查询估值指标及历史分位数，支持 PE、PB、PEG、PS、PCF、EM。",
      inputSchema: {
        securityCode,
        indicator: z.enum(["peTtm", "pbMrq", "peg", "psTtm", "pcfTtm", "em"]).describe("peTtm | pbMrq | peg | psTtm | pcfTtm | em（必填）"),
        ...dateRange,
        limit: z.number().int().min(1).optional().describe("最大返回行数（默认 2000）"),
        skipNull: z.boolean().optional().describe("过滤掉 value 或 percentileRank 为空的行（客户端后处理）"),
        fieldList: valuationFieldList,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      assertDateOrder(args)
      const { skipNull, ...body } = args
      const raw = await client.call("fundamental.valuation-analysis", body)
      const normalized = normalizeRows(raw)
      let result: unknown = normalized
      if (skipNull && normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
        const rec = normalized as Record<string, unknown>
        if (Array.isArray(rec.list)) {
          const filtered = rec.list.filter((row): row is Record<string, unknown> => {
            if (!row || typeof row !== "object") return false
            const r = row as Record<string, unknown>
            return r.value != null && r.percentileRank != null
          })
          result = { ...rec, list: filtered, total: filtered.length }
        }
      }
      return contentResult(await buildToolContent(result))
    }),
  )
}
