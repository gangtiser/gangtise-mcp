import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { registerJsonTool, type JsonToolSpec } from "./registry.js"

const periodEnum = z.array(z.string()).optional().describe("q1=一季报 | interim=中报 | q3=三季报 | annual=年报 | latest=最新")
const quarterlyPeriodEnum = z.array(z.string()).optional().describe("q1 | q2 | q3 | q4 | latest")
const reportTypeEnum = z.array(z.string()).optional().describe("consolidated=合并 | consolidatedRestated=合并调整 | standalone=母公司 | standaloneRestated=母公司调整")
const securityCode = z.string().describe("证券代码，如 '600519.SH'")
const dateRange = {
  startDate: z.string().optional().describe("YYYY-MM-DD"),
  endDate: z.string().optional().describe("YYYY-MM-DD"),
}
const fiscalYear = z.array(z.number().int()).optional().describe("财年列表，如 [2023, 2024]")
const field = z.array(z.string()).optional().describe("指定返回字段")

const specs: JsonToolSpec[] = [
  {
    name: "gangtise_income_statement",
    description: "查询利润表（累计口径），支持期间、财年、报告类型筛选。",
    endpointKey: "fundamental.income-statement",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: periodEnum,
      reportType: reportTypeEnum,
      field,
    },
  },
  {
    name: "gangtise_income_statement_quarterly",
    description: "查询单季利润表。",
    endpointKey: "fundamental.income-statement-quarterly",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: quarterlyPeriodEnum,
      reportType: reportTypeEnum,
      field,
    },
  },
  {
    name: "gangtise_balance_sheet",
    description: "查询资产负债表，支持期间、财年、报告类型筛选。",
    endpointKey: "fundamental.balance-sheet",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: periodEnum,
      reportType: reportTypeEnum,
      field,
    },
  },
  {
    name: "gangtise_cash_flow",
    description: "查询现金流量表（累计口径），支持期间、财年、报告类型筛选。",
    endpointKey: "fundamental.cash-flow",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: periodEnum,
      reportType: reportTypeEnum,
      field,
    },
  },
  {
    name: "gangtise_cash_flow_quarterly",
    description: "查询单季现金流量表。",
    endpointKey: "fundamental.cash-flow-quarterly",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: quarterlyPeriodEnum,
      reportType: reportTypeEnum,
      field,
    },
  },
  {
    name: "gangtise_main_business",
    description: "查询主营业务构成（按产品、行业或地区拆分）。",
    endpointKey: "fundamental.main-business",
    paginated: false,
    inputSchema: {
      securityCode,
      breakdown: z.string().describe("product=产品 | industry=行业 | region=地区（必填）"),
      ...dateRange,
      periodList: z.array(z.string()).optional().describe("interim=中报 | annual=年报"),
      field,
    },
  },
  {
    name: "gangtise_valuation_analysis",
    description: "查询估值指标及历史分位数，支持 PE、PB、PEG、PS、PCF、EM。",
    endpointKey: "fundamental.valuation-analysis",
    paginated: false,
    inputSchema: {
      securityCode,
      indicator: z.string().describe("peTtm | pbMrq | peg | psTtm | pcfTtm | em（必填）"),
      ...dateRange,
      limit: z.number().int().optional().describe("最大返回行数（默认 2000）"),
      skipNull: z.boolean().optional().describe("过滤掉 value 或 percentileRank 为空的行"),
      field,
    },
  },
  {
    name: "gangtise_top_holders",
    description: "查询前十大股东或前十大流通股东。",
    endpointKey: "fundamental.top-holders",
    paginated: false,
    inputSchema: {
      securityCode,
      holderType: z.string().describe("top10=前十大股东 | top10Float=前十大流通股东（必填）"),
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
      consensus: z.array(z.string()).optional().describe("netIncome=净利润 | netIncomeYoy=净利润增速 | eps | pe | bps | pb | peg | roe | ps"),
    },
  },
]

export function registerFundamentalTools(server: McpServer, client: GangtiseClient): void {
  for (const spec of specs) {
    registerJsonTool(server, client, spec)
  }
}
