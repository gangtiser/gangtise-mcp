import { z } from "zod"
import { assertDateOrder, defineJsonTool, defineTool, type FamilyModule, type JsonToolSpec } from "../mcp/define.js"
import { buildToolContent } from "../core/present.js"
import { contentResult } from "../mcp/handler.js"
import { normalizeRows } from "../core/normalize.js"
import { markPartial } from "../core/partial.js"
import { dateString, today } from "../core/dateContext.js"
import { estimateTradingDays } from "../core/batch.js"
import { ENDPOINTS, perRowBilling } from "../core/endpoints.js"
import { assertWithinCostLimit } from "../core/paginate.js"
import { CALL_LIMITS } from "../core/scheduler.js"
import { nonEmptyString, uniqueFieldList, enumList } from "../mcp/schemas.js"
import { parseSecurityCode } from "../core/securityCode.js"
import { ApiError, ValidationError } from "../core/errors.js"
import { fundamentalEndpoints } from "./fundamental.endpoints.js"
import type { GangtiseClient } from "../core/client.js"

const periodEnum = enumList(z.enum(["q1", "interim", "q3", "annual", "latest"])).optional().describe("q1=一季报 | interim=中报 | q3=三季报 | annual=年报 | latest=最新")
const quarterlyPeriodEnum = enumList(z.enum(["q1", "interim", "q3", "annual", "latest"])).optional().describe("q1 | interim=第二季度 | q3 | annual=第四季度 | latest")
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
const fiscalYearList = (desc: string) => enumList(z.number().int()).optional().describe(desc)
const ALL_HISTORY = "period、fiscalYear 与日期区间都不传时返回全部历史报告期"
const LATEST_ONLY = "只要最新一期传 period: ['latest']"
// 港股的 fiscalYear 按期末所在自然年（返回行的 fiscalYear 同此），period 标签却按公司财年：非 12 月财年的公司按标签年份取会错期。
const HK_FISCAL_YEAR = "港股按 endDate 所在自然年筛（返回行的 fiscalYear 同此），非 12 月财年的公司 period 标签按公司财年：3 月财年的「2027一季报」期末 2026-06-30，要用 fiscalYear 2026 取"
const fiscalYear = fiscalYearList(`财年列表，如 [2023, 2024]。${ALL_HISTORY}，${LATEST_ONLY}`)
const fiscalYearHk = fiscalYearList(`财年列表，如 [2023, 2024]；${HK_FISCAL_YEAR}。${ALL_HISTORY}，${LATEST_ONLY}`)
// 美股不给年份与日期时本地拒（A41）。
const fiscalYearWithUs = fiscalYearList(`财年列表，如 [2023, 2024]。${ALL_HISTORY}（美股须给 fiscalYear 或 startDate），${LATEST_ONLY}`)
const fiscalYearStatement = fiscalYearList(`财年列表，如 [2023, 2024]；美股按公司财年，${HK_FISCAL_YEAR}。${ALL_HISTORY}（美股须给 fiscalYear 或 startDate），${LATEST_ONLY}`)
const fieldList = uniqueFieldList("指定返回字段")
// valuation-analysis 全表就 7 列，且**没有 securityCode**；tradeDate 总是自动前置到每一行。
// 2026-10-17 复核：不存在的字段名（含 securityCode）整条报 100005 并点名，显式 tradeDate 与重复字段
// 都只回一次；只传 tradeDate 返回 0 行、不报错。2026-07-26 时这里曾静默错列（securityCode 拿到
// 相邻列的日期、字段数与行长仍相等），闭集就是为那时加的，留着挡 0 行与防回归。
// 所以可选字段是**除 tradeDate 外的 6 个**；tradeDate 无论传不传都会返回。
const VALUATION_FIELD_NAMES = ["value", "percentileRank", "average", "median", "upper1Std", "lower1Std"] as const
const valuationFieldList = z
  .array(z.enum(VALUATION_FIELD_NAMES))
  .min(1, "fieldList 不能为空数组：要投影字段就至少给一个，要全量就省略该参数")
  .refine((v) => new Set(v).size === v.length, "fieldList 不能重复：同名字段在按位置拍平时会相互覆盖，导致静默少一列")
  .optional()
  .describe(`指定返回字段，只认这 6 个：${VALUATION_FIELD_NAMES.join(" / ")}。tradeDate 总是自动返回、不在可选列内；本接口也没有 securityCode。不确定就不传（=返回全部 7 列，最稳）`)
// 主营接口固定前置 periodName/periodEndDate。错的字段名整条报 100005 并点名（2026-10-17 复核；
// 2026-07-26 时是回显多、值少，由 normalize 的长度校验拒），收成闭集在本地就拒、省一次请求。
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
/** 估值序列每个自然日一行（含周末）、升序。limit 显式下发：省略时服务端按同一个默认值截断，
 *  且保留的是**最近**的行——十年区间会静默只剩最后 2000 天，看起来像一份完整序列。 */
const VALUATION_DEFAULT_LIMIT = 2000

/** 估值序列的完整性判定。
 *
 *  - 行数撞满 limit 且首行不是 startDate → 区间开头被截掉了，标 `limit_truncated`。首行恰好是
 *    startDate 时说明一行没少（区间正好 limit 天），不标。
 *  - 没撞满、首行却晚于 startDate → 服务端自己晚开始：之后才上市，或区间超出了账号的历史窗口
 *    （本接口对窗口外的部分直接不返回、不报错）。不是截断，只加一句说明。 */
function flagValuationRange(normalized: unknown, limit: number, startDate: unknown): unknown {
  const rec = Array.isArray(normalized) ? { list: normalized } : normalized
  if (!rec || typeof rec !== "object") return normalized
  const list = (rec as { list?: unknown }).list
  if (!Array.isArray(list)) return normalized
  const first = list[0] as Record<string, unknown> | undefined
  const firstDate = typeof first?.tradeDate === "string" ? first.tradeDate : undefined
  const start = typeof startDate === "string" ? startDate : undefined
  if (list.length >= limit && !(start && firstDate === start)) {
    return markPartial(rec as Record<string, unknown>, "limit_truncated", {
      _hint: `返回行数撞满 limit（${limit}）：本接口每个自然日一行（含周末），超出时保留最近的行，缺的是区间开头${firstDate ? `（本次从 ${firstDate} 开始）` : ""}。把 limit 调到区间天数以上（一年约 366 行），或把 startDate 往后挪。`,
    })
  }
  if (start && firstDate && firstDate > start) {
    return { ...rec, _note: `序列从 ${firstDate} 开始，晚于 startDate ${start}：可能是之后才上市，或区间超出了账号可取的历史窗口——本接口只返回窗口内的部分，不报错。` }
  }
  return rec
}

// 报表里有两个披露日字段，取值可能不同，而选错的后果是 point-in-time 校验得出相反结论
// （拿一个晚得多的日期去回溯，等于把未来信息当成当时可见）。这不是普遍现象、是个股级的，
// 所以只能靠字段选择规避，没法靠「换只票验一下」发现——茅台两个字段一致，用它当探针
// 什么也测不出来。
const PIT_NOTE = "做 point-in-time / 时点对齐时，announcementDate 是当前返回报表版本的公告日，earliestAnncDate 是接口记录的首次公告日。consolidated 也可能返回后来重述的数值，不能把它配上 earliestAnncDate 就当成首次披露值；category 仍可能是一季报/半年报告/三季报，不能靠它排除重述。应按返回版本的公告日控制数值可见时间；需要首次披露的原始数值时，请核对当时公告。"

/** 三表（含 legacy 各变体）与十大股东：period 只给 latest 时返回全部报告里的最新一期，fiscalYear 与日期区间都不起作用。
 *  按年份或区间查却拿到最新一期，看起来像正常结果，所以在本地拒（A39，撤除条件见 bug/server-open.md）。 */
function periodRangeProblem(body: Record<string, unknown>): string | undefined {
  const ranged = (Array.isArray(body.fiscalYear) && body.fiscalYear.length > 0) || body.startDate !== undefined || body.endDate !== undefined
  const periods = Array.isArray(body.period) ? body.period.map(String) : []
  if (ranged && periods.length > 0 && periods.every((p) => p === "latest")) {
    return "period 只给 latest 时本接口返回全部报告里的最新一期，fiscalYear 与 startDate / endDate 都不起作用。要某年或某段区间的报告就去掉 period（返回范围内各期）或改成 ['annual'] 等取值；只要最新一期就去掉 fiscalYear / startDate / endDate。"
  }
  return undefined
}

const US_STATEMENTS = new Set(["fundamental.income-statement-us", "fundamental.balance-sheet-us", "fundamental.cash-flow-us"])
/** 同一种报告期的两个期末至少隔 364 天（52 周财年），不超过 363 天的窗口里每种至多一期。 */
const US_WINDOW_DAYS = 363
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

/** 美股三表跨多个财年时，本接口每种报告期 × 报表类型只返回其中一年（不一定是最新那年）、不报错（A41）。
 *  所以按 fiscalYear 逐年、按日期区间分窗口各发一次；无从分段的（不给年份与日期、只给 endDate）本地拒。 */
function usStatementBodies(body: Record<string, unknown>): Record<string, unknown>[] {
  const periods = Array.isArray(body.period) ? body.period.map(String) : []
  if (periods.length > 0 && periods.every((p) => p === "latest")) return [body]
  const start = body.startDate as string | undefined
  if (start !== undefined || body.endDate !== undefined) {
    if (start === undefined) throw new ValidationError("美股报表按日期取须给 startDate（endDate 缺省到今天），或改给 fiscalYear（可多个）：跨多个财年时本接口每种报告期只返回其中一年，本工具按区间分段请求，只给 endDate 无从分段。")
    const last = (body.endDate as string | undefined) ?? today()
    if (start > last || addDays(start, US_WINDOW_DAYS) >= last) return [body]
    const bodies: Record<string, unknown>[] = []
    for (let from = start; from <= last; from = addDays(from, US_WINDOW_DAYS + 1)) {
      const to = addDays(from, US_WINDOW_DAYS)
      bodies.push({ ...body, startDate: from, endDate: to < last ? to : last })
    }
    return capped(bodies)
  }
  // 去重：每个年份各发一次，重复的年份会让同一期在合并结果里出现两次；升序让跳过段在 _note 里并得完整。
  const years = Array.isArray(body.fiscalYear) ? [...new Set(body.fiscalYear.map(Number))].sort((a, b) => a - b) : []
  if (years.length === 0) throw new ValidationError("美股报表须给 fiscalYear（可多个）或 startDate / endDate，只要最新一期用 period: ['latest']：不给年份与日期时本接口每种报告期只返回其中某一年（不一定是最新那年），本工具无从逐年请求。")
  return capped(years.map((y) => ({ ...body, fiscalYear: [y] })))
}

function capped(bodies: Record<string, unknown>[]): Record<string, unknown>[] {
  if (bodies.length > CALL_LIMITS.maxShards) throw new ValidationError(`美股报表本次要分 ${bodies.length} 段请求（逐个财年、或按日期每段约一年），超过 ${CALL_LIMITS.maxShards} 段：请缩短日期区间或少给几个 fiscalYear。`)
  return bodies
}

const endDateOf = (row: unknown) => String((row as Record<string, unknown> | null)?.endDate ?? "")
const rowsOf = (data: unknown): unknown[] => {
  const list = (normalizeRows(data) as { list?: unknown } | null)?.list
  return Array.isArray(list) ? list : []
}
const byEndDateDesc = (a: unknown, b: unknown) => (endDateOf(a) < endDateOf(b) ? 1 : endDateOf(a) > endDateOf(b) ? -1 : 0)
/** period=latest 时港股、美股的利润表与现金流量表可能多回一行 period 为空的：与同一 endDate 的有标签行区间不同（最近一个季度单季，A42）。 */
function withUnlabeledNote(result: Record<string, unknown>): Record<string, unknown> {
  const list = result.list as Array<Record<string, unknown> | null>
  const bare = list.filter((r) => r && !r.period && list.some((o) => o !== r && o?.period && o.endDate === r.endDate))
  if (bare.length === 0) return result
  const spans = bare.map((r) => `${r!.startDate !== undefined ? `${r!.startDate}～` : ""}${r!.endDate}`).join("、")
  return { ...result, _note: `period 为空的行（${spans}）区间比同一 endDate 的有标签行短（通常是最近一个季度单季），不是该报告期的累计值，别与有标签那行混用。` }
}
/** 整段在账号可取范围之外。一次请求跨过边界时本接口只返回范围内的部分、不报错，分段后整段在外的那几段就会报这个码。 */
const OUT_OF_RANGE = "110003"

/** 跳过的分段写进 `_note`：相邻的日期段并成一个区间、连续的财年并成「财年 a–b」，从远古起查也只占一两项。 */
function mergeSkipped(parts: Record<string, unknown>[]): string[] {
  const runs: Array<[string | number, string | number]> = []
  for (const b of parts) {
    const dated = b.startDate !== undefined
    const [from, to] = dated ? [b.startDate as string, b.endDate as string] : [Number((b.fiscalYear as unknown[])[0]), Number((b.fiscalYear as unknown[])[0])]
    const prev = runs[runs.length - 1]
    if (prev && (dated ? addDays(prev[1] as string, 1) === from : (prev[1] as number) + 1 === from)) prev[1] = to
    else runs.push([from, to])
  }
  return runs.map(([from, to]) => (typeof from === "string" ? `${from}～${to}` : from === to ? `财年 ${from}` : `财年 ${from}–${to}`))
}

/** 三表共用：本接口的多期结果不按报告期排序，这里按 endDate 降序排（最新在前）；美股按 usStatementBodies 拆开请求再合并，
 *  整段在账号范围外的分段跳过并写进 `_note`（与不拆分时的语义一致），全部在外才照常报错。 */
async function callStatement(client: GangtiseClient, endpointKey: string, body: Record<string, unknown>): Promise<unknown> {
  const bodies = US_STATEMENTS.has(endpointKey) ? usStatementBodies(body) : [body]
  if (bodies.length === 1) {
    const part = normalizeRows(await client.call(endpointKey, bodies[0])) as Record<string, unknown>
    return Array.isArray(part?.list) ? withUnlabeledNote({ ...part, list: [...part.list].sort(byEndDateDesc) }) : part
  }
  const settled = await Promise.allSettled(bodies.map((b) => client.call(endpointKey, b)))
  const outOfRange = (r: PromiseSettledResult<unknown>) => r.status === "rejected" && r.reason instanceof ApiError && r.reason.code === OUT_OF_RANGE
  const failed = settled.find((r) => r.status === "rejected" && !outOfRange(r)) ?? (settled.every(outOfRange) ? settled[0] : undefined)
  if (failed) throw (failed as PromiseRejectedResult).reason
  const rows = settled.flatMap((r) => (r.status === "fulfilled" ? rowsOf(r.value) : [])).sort(byEndDateDesc)
  const skipped = mergeSkipped(bodies.filter((_, i) => outOfRange(settled[i])))
  return { total: rows.length, list: rows, ...(skipped.length > 0 ? { _note: `美股报表按财年 / 区间分段请求，其中 ${skipped.join("、")} 超出账号可取的时间范围（110003），没有返回。` } : {}) }
}

function requirePeriodWithRange(body: Record<string, unknown>): Record<string, unknown> {
  const problem = periodRangeProblem(body)
  if (problem) throw new ValidationError(problem)
  return body
}

/** 三表按代码后缀选市场。period 的取值闭集按「市场 × 累计 / 单季」各一套，与原来按市场拆开的
 *  工具一致；对外 schema 是并集，resolve 定了市场再按那一套校验。单季口径只有 A 股利润表与现金流量表有。 */
const STATEMENT_PERIODS = {
  cn: ["q1", "interim", "q3", "annual", "latest"],
  cnQuarterly: ["q1", "interim", "q3", "annual", "latest"],
  hk: ["q1", "h1", "q3", "h2", "nsd", "annual", "latest"],
  us: ["q1", "h1", "q3", "nsd", "annual", "latest"],
} as const
const STATEMENT_PERIOD_VALUES = ["q1", "q3", "interim", "h1", "h2", "nsd", "annual", "latest"] as const
const MARKET_NAME = { cn: "A股", hk: "港股", us: "美股" } as const

function statementSpec(config: {
  name: string
  description: string
  endpoints: { cn: string; cnQuarterly?: string; hk: string; us: string }
}): JsonToolSpec {
  const { endpoints } = config
  return {
    name: config.name,
    tier: "core",
    description: config.description,
    endpointKey: endpoints.cn,
    paginated: false,
    inputSchema: {
      securityCode: nonEmptyString.describe("证券代码，按后缀选市场：A股 .SH/.SZ/.BJ（如 600519.SH）、港股 .HK（5 位数字前补零，如 00700.HK）、美股 .O/.N/.A（如 TSLA.O）"),
      ...dateRange,
      fiscalYear: fiscalYearStatement,
      period: enumList(z.enum(STATEMENT_PERIOD_VALUES)).optional().describe("按市场取值：A股 q1/interim/q3/annual/latest（quarterly=true 时同名取值按单季：interim=第二季度、annual=第四季度）；港股 q1/h1/q3/h2/nsd/annual/latest；美股 q1/h1/q3/nsd/annual/latest（interim/h1=中报 h2=下半年报 nsd=不规则跨度）"),
      ...(endpoints.cnQuarterly ? { quarterly: z.boolean().optional().describe("true=A股单季口径（港股、美股没有）；返回行的 period 仍是报告名（如「2025年报」即第四季度单季），数值是该季单季值，不是累计") } : {}),
      reportType: reportTypeEnum,
      fieldList,
    },
    resolve: ({ quarterly, ...body }) => {
      const code = String(body.securityCode)
      const market = parseSecurityCode(code).market
      // 只给 latest 配年份 / 区间与后缀 / quarterly 错同时存在时一并报出，免得改完一处再撞另一处（取值错与它不会同时出现）。
      const rangeProblem = periodRangeProblem(body) ?? ""
      if (!market) throw new ValidationError(`无法从 '${code}' 的后缀判断市场：A股 .SH/.SZ/.BJ、港股 .HK、美股 .O/.N/.A。${rangeProblem}`)
      if (quarterly === true && market !== "cn") throw new ValidationError(`单季口径（quarterly）只有 A 股有，'${code}' 是${MARKET_NAME[market]}代码：去掉 quarterly。${rangeProblem}`)
      const scheme = market === "cn" ? (quarterly === true ? "cnQuarterly" : "cn") : market
      const allowed: readonly string[] = STATEMENT_PERIODS[scheme]
      const bad = (Array.isArray(body.period) ? body.period : []).filter((p) => !allowed.includes(String(p)))
      if (bad.length > 0) {
        throw new ValidationError(`${MARKET_NAME[market]}${scheme === "cnQuarterly" ? "单季" : ""}报表的 period 只收 ${allowed.join(" / ")}，'${bad[0]}' 不在其中。`)
      }
      if (rangeProblem) throw new ValidationError(rangeProblem)
      const endpointKey = scheme === "cnQuarterly" ? endpoints.cnQuarterly! : endpoints[market]
      return { endpointKey, body }
    },
    call: callStatement,
  }
}

/** 盈利预测每个日期的行数：每个预测年度一行（常见 3 个年度）。只用于积分预估——覆盖薄的证券会少。 */
const FORECAST_ROWS_PER_DATE = 3

/** 按条计费且行数随区间增长，缺省日期必须补成确定的区间才估得出积分：与 CLI 相同，结束日缺省为今天（北京），
 *  起始日缺省为结束日前 365 天。 */
function forecastRange(body: Record<string, unknown>): Record<string, unknown> {
  const endDate = (body.endDate as string | undefined) ?? today()
  const startDate = (body.startDate as string | undefined) ?? new Date(Date.parse(`${endDate}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10)
  // endDate 是本地补的：别让报错点名一个调用方没传的参数。
  if (body.endDate === undefined && startDate > endDate) throw new ValidationError(`startDate (${startDate}) 晚于今天 (${endDate})：一致预期没有未来日期的数据，请把 startDate 改到今天或之前。`)
  return { ...body, startDate, endDate }
}

export const specs: JsonToolSpec[] = [
  statementSpec({
    name: "gangtise_income_statement",
    description: `查询利润表，按代码后缀自动选市场：A股（累计口径，quarterly=true 为单季）、港股（中国会计准则）、美股；支持期间、财年、报告类型筛选。${PIT_NOTE}单季口径的 companyType 返回的是未映射的数字码，要读公司类型请取累计口径报表的同名字段。`,
    endpoints: { cn: "fundamental.income-statement", cnQuarterly: "fundamental.income-statement-quarterly", hk: "fundamental.income-statement-hk", us: "fundamental.income-statement-us" },
  }),
  {
    name: "gangtise_income_statement_quarterly",
    tier: "legacy",
    description: `查询A股单季利润表。返回行的 period 仍是报告名（如「2025年报」即第四季度单季），数值是该季单季值，不是累计。${PIT_NOTE}本工具的 companyType 返回的是未映射的数字码，要读公司类型请取累计口径报表的同名字段。`,
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
    transformBody: requirePeriodWithRange,
    call: callStatement,
  },
  statementSpec({
    name: "gangtise_balance_sheet",
    description: `查询资产负债表，按代码后缀自动选市场：A股、港股（中国会计准则）、美股；支持期间、财年、报告类型筛选。${PIT_NOTE}`,
    endpoints: { cn: "fundamental.balance-sheet", hk: "fundamental.balance-sheet-hk", us: "fundamental.balance-sheet-us" },
  }),
  statementSpec({
    name: "gangtise_cash_flow",
    description: `查询现金流量表，按代码后缀自动选市场：A股（累计口径，quarterly=true 为单季）、港股（中国会计准则）、美股；支持期间、财年、报告类型筛选。${PIT_NOTE}单季口径的 companyType 返回的是未映射的数字码，要读公司类型请取累计口径报表的同名字段。`,
    endpoints: { cn: "fundamental.cash-flow", cnQuarterly: "fundamental.cash-flow-quarterly", hk: "fundamental.cash-flow-hk", us: "fundamental.cash-flow-us" },
  }),
  {
    name: "gangtise_cash_flow_quarterly",
    tier: "legacy",
    description: `查询A股单季现金流量表。返回行的 period 仍是报告名（如「2025年报」即第四季度单季），数值是该季单季值，不是累计。${PIT_NOTE}本工具的 companyType 返回的是未映射的数字码，要读公司类型请取累计口径报表的同名字段。`,
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
    transformBody: requirePeriodWithRange,
    call: callStatement,
  },
  {
    name: "gangtise_main_business",
    tier: "core",
    description: "查询主营业务构成（按产品、行业或地区拆分）。",
    endpointKey: "fundamental.main-business",
    paginated: false,
    inputSchema: {
      securityCode,
      breakdown: z.enum(["product", "industry", "region"]).describe("product=产品 | industry=行业 | region=地区（必填）"),
      ...dateRange,
      period: enumList(z.enum(["interim", "annual"])).optional().describe("interim=中报 | annual=年报"),
      fieldList: mainBusinessFieldList,
    },
  },
  {
    name: "gangtise_top_holders",
    tier: "core",
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
    transformBody: requirePeriodWithRange,
  },
  {
    name: "gangtise_earning_forecast",
    tier: "core",
    description: "查询盈利预测一致预期（EPS、PE、净利润、ROE 等）。roe 的单位是百分比（35.6 即 35.6%），不要再做 ÷100 换算——换算后的数字看着仍像个 ROE，不会报错。日期省略时取截至 endDate（缺省今天）的近一年；每个日期约 3 行（每个预测年度一行），行数随区间增长，发请求前按「工作日数 × 3 条」预估。",
    endpointKey: "fundamental.earning-forecast",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      consensusList: enumList(z.enum(["netIncome", "netIncomeYoy", "eps", "pe", "bps", "pb", "peg", "roe", "ps"])).optional().describe("netIncome=净利润 | netIncomeYoy=净利润增速 | eps | pe | bps | pb | peg | roe | ps"),
      confirmCost: z.boolean().optional(),
    },
    transformBody: forecastRange,
    call: (client, endpointKey, body) => {
      const billing = perRowBilling(ENDPOINTS[endpointKey])
      if (billing) assertWithinCostLimit({ rows: estimateTradingDays(body.startDate as string, body.endDate as string) * FORECAST_ROWS_PER_DATE }, billing, "请缩短日期区间分段取")
      return client.call(endpointKey, body)
    },
  },
  {
    name: "gangtise_income_statement_hk",
    tier: "legacy",
    description: "查询港股利润表（中国会计准则），支持期间、财年、报告类型筛选。",
    endpointKey: "fundamental.income-statement-hk",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeHk,
      ...dateRange,
      fiscalYear: fiscalYearHk,
      period: hkPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    transformBody: requirePeriodWithRange,
    call: callStatement,
  },
  {
    name: "gangtise_balance_sheet_hk",
    tier: "legacy",
    description: "查询港股资产负债表（中国会计准则），支持期间、财年、报告类型筛选。",
    endpointKey: "fundamental.balance-sheet-hk",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeHk,
      ...dateRange,
      fiscalYear: fiscalYearHk,
      period: hkPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    transformBody: requirePeriodWithRange,
    call: callStatement,
  },
  {
    name: "gangtise_cash_flow_hk",
    tier: "legacy",
    description: "查询港股现金流量表（中国会计准则），支持期间、财年、报告类型筛选。",
    endpointKey: "fundamental.cash-flow-hk",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeHk,
      ...dateRange,
      fiscalYear: fiscalYearHk,
      period: hkPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    transformBody: requirePeriodWithRange,
    call: callStatement,
  },
  {
    name: "gangtise_income_statement_us",
    tier: "legacy",
    description: "查询美股利润表，支持期间、财年、报告类型筛选。证券代码如 'TSLA.O'。",
    endpointKey: "fundamental.income-statement-us",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeUs,
      ...dateRange,
      fiscalYear: fiscalYearWithUs,
      period: usPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    transformBody: requirePeriodWithRange,
    call: callStatement,
  },
  {
    name: "gangtise_balance_sheet_us",
    tier: "legacy",
    description: "查询美股资产负债表，支持期间、财年、报告类型筛选。证券代码如 'TSLA.O'。",
    endpointKey: "fundamental.balance-sheet-us",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeUs,
      ...dateRange,
      fiscalYear: fiscalYearWithUs,
      period: usPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    transformBody: requirePeriodWithRange,
    call: callStatement,
  },
  {
    name: "gangtise_cash_flow_us",
    tier: "legacy",
    description: "查询美股现金流量表，支持期间、财年、报告类型筛选。证券代码如 'TSLA.O'。",
    endpointKey: "fundamental.cash-flow-us",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeUs,
      ...dateRange,
      fiscalYear: fiscalYearWithUs,
      period: usPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    transformBody: requirePeriodWithRange,
    call: callStatement,
  },
]

export const fundamentalFamily: FamilyModule = {
  name: "fundamental",
  endpoints: fundamentalEndpoints,
  tools: [
    ...specs.map(defineJsonTool),
    defineTool({
      name: "gangtise_valuation_analysis",
      tier: "core",
      access: "read",
      endpoint: "fundamental.valuation-analysis",
      description: "查询估值指标及历史分位数，支持 PE、PB、PEG、PS、PCF、EM。",
      input: {
        securityCode,
        indicator: z.enum(["peTtm", "pbMrq", "peg", "psTtm", "pcfTtm", "em"]).describe("peTtm | pbMrq | peg | psTtm | pcfTtm | em（必填）"),
        ...dateRange,
        limit: z.number().int().min(1).optional().describe("最大返回行数（默认 2000）。每个自然日一行（含周末），超出时保留最近的行、丢掉区间开头，撞满标 _partial"),
        skipNull: z.boolean().optional().describe("过滤掉 value 或 percentileRank 为空的行（客户端后处理；传了 fieldList 时只按其中请求到的那几列判空）"),
        fieldList: valuationFieldList,
      },
      run: async ({ client }, args) => {
        assertDateOrder(args)
        const { skipNull, ...rest } = args
        const limit = (rest.limit as number | undefined) ?? VALUATION_DEFAULT_LIMIT
        const body: Record<string, unknown> = { ...rest, limit }
        const raw = await client.call("fundamental.valuation-analysis", body)
        // 截断判定在 skipNull 之前：过滤掉空值行之后行数就不再能说明撞没撞满。
        const normalized = flagValuationRange(normalizeRows(raw), limit, rest.startDate)
        let result: unknown = normalized
        // 只按**请求到的**列判空。fieldList 投影掉 percentileRank 时那一列在行里根本不存在，
        // 把「没查」当「为空」会把一份正常数据整个过滤成零行且不报错。
        const requested = Array.isArray(body.fieldList) ? new Set(body.fieldList as string[]) : undefined
        const nullKeys = ["value", "percentileRank"].filter((key) => !requested || requested.has(key))
        if (skipNull && nullKeys.length > 0 && normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
          const rec = normalized as Record<string, unknown>
          if (Array.isArray(rec.list)) {
            const filtered = rec.list.filter((row): row is Record<string, unknown> => {
              if (!row || typeof row !== "object") return false
              const r = row as Record<string, unknown>
              return nullKeys.every((key) => r[key] != null)
            })
            result = { ...rec, list: filtered, total: filtered.length }
          }
        }
        return contentResult(await buildToolContent(result))
      },
    }),
  ],
}
