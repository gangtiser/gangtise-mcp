import { z } from "zod"
import { assertDateOrder, defineJsonTool, defineTool, type FamilyModule, type JsonToolSpec } from "../mcp/define.js"
import { buildToolContent } from "../core/present.js"
import { contentResult } from "../mcp/handler.js"
import { normalizeRows } from "../core/normalize.js"
import { markPartial } from "../core/partial.js"
import { withNote } from "../core/lateStart.js"
import { currentSignal, runWithRequestContext } from "../core/requestContext.js"
import { dateString, today } from "../core/dateContext.js"
import { estimateTradingDays } from "../core/batch.js"
import { ENDPOINTS, perRowBilling } from "../core/endpoints.js"
import { assertWithinCostLimit } from "../core/paginate.js"
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
const fiscalYear = fiscalYearList(`财年列表，如 [2023, 2024]。${ALL_HISTORY}，${LATEST_ONLY}`)
const COMPANY_FISCAL_YEAR = "按公司财年（即返回行的 fiscalYear），按期末所在自然年取改用日期区间"
const fiscalYearStatement = fiscalYearList(`财年列表，如 [2023, 2024]；港股、美股${COMPANY_FISCAL_YEAR}。${ALL_HISTORY}，${LATEST_ONLY}`)
const fiscalYearOverseas = fiscalYearList(`财年列表，如 [2023, 2024]，${COMPANY_FISCAL_YEAR}。${ALL_HISTORY}，${LATEST_ONLY}`)
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
const PIT_NOTE = "做 point-in-time / 时点对齐时，announcementDate 是当前返回报表版本的公告日，earliestAnncDate 是接口记录的首次公告日（只有 A 股报表返回）。consolidated 也可能返回后来重述的数值，不能把它配上 earliestAnncDate 就当成首次披露值；category 仍可能是一季报/半年报告/三季报，不能靠它排除重述。应按返回版本的公告日控制数值可见时间；需要首次披露的原始数值时，请核对当时公告。"

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

type Row = Record<string, unknown>
type DateOf = (row: Row) => string | undefined
type YearOf = (row: Row) => string | undefined
const isRow = (row: unknown): row is Row => !!row && typeof row === "object"
/** 归一后的行：响应只有 fieldList / list、没有 total 等元数据时 normalizeRows 交出的是裸数组；HTTP 层按合法空结果放行的
 *  `{total: 0}`（list 缺失或为 null）当作零行。 */
const listOf = (data: unknown): unknown[] | undefined => {
  if (Array.isArray(data)) return data
  const rec = data as { list?: unknown; total?: unknown } | null
  if (Array.isArray(rec?.list)) return rec.list
  return rec?.total === 0 && (rec.list === undefined || rec.list === null) ? [] : undefined
}
/** `yyyyMMdd`（三表的 endDate）或 `yyyy-MM-dd`（十大股东的 reportPeriod）统一成 `yyyy-MM-dd`。 */
function isoDay(value: unknown): string | undefined {
  const text = String(value ?? "")
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : undefined
}

/** period 含 latest 时那一期不受 fiscalYear 与日期约束：与其他取值同传时 A 股报表与十大股东另加上最新一期，所问年份整段早于
 *  账号可查范围时三表各市场都只回最新一期（A39 余下的形态；只给 latest 的已由 periodRangeProblem 拒掉）。结果里有所问范围之外的
 *  报告期就写 `_note`；每一行都判得出、又都在范围外时说明范围内一期也没有、去掉 latest 也取不到。latest 守住年份与日期后
 *  自然不再出现。没有日期 / 年份的行不判（不拿期末的自然年推非 12 月财年），有这种行时也不说范围内一期都没有。十大股东按年份取
 *  不受账号可查下界约束（A43），`yearsWindowed: false` 时不把范围内没有归到账号范围上。 */
function latestOutsideNote(rows: Row[], body: Row, dateOf: DateOf, yearOf: YearOf, yearsWindowed = true): string | undefined {
  if (!(Array.isArray(body.period) && body.period.includes("latest"))) return undefined
  const start = body.startDate as string | undefined
  const end = body.endDate as string | undefined
  const years = Array.isArray(body.fiscalYear) ? body.fiscalYear.map(String) : []
  const dated = Boolean(start || end)
  if (!dated && years.length === 0) return undefined
  const outsideRows = rows.filter((row) => {
    const day = dateOf(row)
    const year = yearOf(row)
    return day !== undefined && (dated ? (!!start && day < start) || (!!end && day > end) : year !== undefined && !years.includes(year))
  })
  if (outsideRows.length === 0) return undefined
  const outside = [...new Set(outsideRows.map(dateOf))].sort()
  const asked = dated ? "日期区间" : " fiscalYear "
  const head = `期末 ${outside.join("、")} 的报告期不在所问的${asked}内：period 里的 latest 不受年份与日期约束，取的是全部报告里的最新一期`
  return outsideRows.length === rows.length
    ? `${head}；所问${asked}内一期也没有返回，可能是公司那时还没有报告${dated || yearsWindowed ? "，也可能是整段早于账号可查的历史范围" : ""}，去掉 latest 也取不到。`
    : `${head}。只要所问范围就去掉 latest。`
}

/** 这一天（或这个财年）是否早于账号可查的下界：报表起止同为那一天、或只给那个 fiscalYear 单查，早于下界时本接口报 110003，
 *  界内不报错，与证券、period、口径无关。别的错误、超时都不下结论。 */
async function beforeWindow(client: GangtiseClient, endpointKey: string, body: Row, probe: Row): Promise<boolean> {
  try {
    await client.call(endpointKey, { securityCode: body.securityCode, ...probe })
    return false
  } catch (error) {
    return error instanceof ApiError && error.code === "110003"
  }
}

/** 单查的截止时间，从工具调用开始算：主请求本身可能连重试拖到客户端的等待上限（约 60 s）附近，从单查开始算会超。 */
const PROBE_BUDGET_MS = 5_000

/** 一轮单查：到 `deadline`、或 `stop` 中止（主请求失败）时不再等，返回 `fallback`（不下结论），主结果照常交回。到点直接交回、
 *  不靠中止——单查碰上 token 失效时等的是共享登录，中止信号停不下那段等待，登录照常留给别的请求；同时中止在飞的单查请求与退避。 */
function probeUntil<T>(deadline: number, stop: AbortSignal, fallback: T, fn: () => Promise<T>): Promise<T> {
  const ms = deadline - Date.now()
  const parent = currentSignal()
  if (ms <= 0 || stop.aborted || parent?.aborted) return Promise.resolve(fallback)
  const signal = AbortSignal.any([AbortSignal.timeout(ms), stop, ...(parent ? [parent] : [])])
  const work = runWithRequestContext(signal, fn).catch(() => fallback)
  const expired = new Promise<T>((resolve) => signal.addEventListener("abort", () => resolve(fallback), { once: true }))
  return Promise.race([work, expired])
}

/** 按日期或年份取时，早于账号可查下界的报告期不返回、不报错（三表整段在外才报 110003），看着像那几年没有报告（A43）。从返回行
 *  判不出是被截断还是公司那几期本来没有，所以问服务端，报 110003 才写 `_note`，且只说接口确认了的：起点早于可查范围、返回的只是
 *  范围内的部分。范围内仍没有的是公司那时没有报告，提示不把它算成截断；有判不了日期 / 年份的行时，从行里推的那半句不说。
 *  单查都在工具调用开始后 5 s 内（`probeUntil`），过了就不下结论；主请求失败时中止单查。
 *  - 按日期：与主请求同时单查 startDate 那一天（`startCut`）。起止同一天时主请求成功就说明那天可查（日期整段在外时带 latest 也报
 *    110003，A39），不用问；只给 endDate 不判。
 *  - 按年份：比最早返回年份更早的那几年（一年都没返回时是全部）按从早到晚二分单查——下界是日期，早于它的年份排在前面。不带 latest
 *    时主请求成功就说明所问最晚的那年可查，不用问；带 latest 时整段在外也只回最新一期、不报错（A39），照样要问。
 *  十大股东单日查询界内界外都是 0 行，问不出下界，不判。与 CLI 的 noteCutAtWindow 同一思路。 */
function startCutNote(rows: Row[], body: Row, cut: boolean): string | undefined {
  if (!cut) return undefined
  const start = body.startDate as string
  const end = body.endDate as string | undefined
  const days = rows.map(statementDate)
  const first = days.filter((day): day is string => day !== undefined && day >= start && (!end || day <= end)).sort()[0]
  const tail = days.includes(undefined) ? "" : first ? `（最早一期 ${first}）` : "，区间内一期也没有返回"
  return `startDate ${start} 早于账号可查的历史范围：范围之前的报告期本接口不返回、不报错，返回的只是可查范围内的部分${tail}。`
}

async function yearsCutNote(client: GangtiseClient, endpointKey: string, body: Row, rows: Row[], deadline: number, stop: AbortSignal): Promise<string | undefined> {
  if (body.startDate !== undefined || body.endDate !== undefined) return undefined
  const requested = Array.isArray(body.period) ? body.period.map(String) : []
  if (requested.length > 0 && requested.every((p) => p === "latest")) return undefined
  const years = [...new Set(Array.isArray(body.fiscalYear) ? body.fiscalYear.map(Number) : [])].sort((a, b) => a - b)
  if (years.length === 0) return undefined
  const rowYears = rows.map(statementYear)
  const returned = rowYears.filter((year) => year !== undefined && years.includes(Number(year))).map(Number)
  const earliest = returned.length > 0 ? Math.min(...returned) : undefined
  const below = earliest ?? (requested.includes("latest") ? Infinity : years[years.length - 1])
  const missing = years.filter((year) => year < below)
  if (missing.length === 0) return undefined
  const cut = await probeUntil(deadline, stop, 0, async () => {
    let lo = 0
    for (let hi = missing.length; lo < hi; ) {
      const mid = (lo + hi) >> 1
      if (await beforeWindow(client, endpointKey, body, { fiscalYear: [missing[mid]] })) lo = mid + 1
      else hi = mid
    }
    return lo
  })
  if (cut === 0) return undefined
  const tail = earliest !== undefined && !rowYears.includes(undefined) ? `；返回的最早是 ${earliest}` : ""
  return `fiscalYear ${missing.slice(0, cut).join("、")} 早于账号可查的历史范围，本接口对范围外的年份不返回、不报错${tail}。`
}

const endDateOf = (row: unknown) => String((row as Row | null)?.endDate ?? "")
const byEndDateDesc = (a: unknown, b: unknown) => (endDateOf(a) < endDateOf(b) ? 1 : endDateOf(a) > endDateOf(b) ? -1 : 0)
const statementDate = (row: Row) => isoDay(row.endDate)
const statementYear = (row: Row) => (row.fiscalYear === undefined || row.fiscalYear === null || row.fiscalYear === "" ? undefined : String(row.fiscalYear))
const holderDate = (row: Row) => isoDay(row.reportPeriod)
const holderYear = (row: Row) => holderDate(row)?.slice(0, 4)

/** 三表共用：本接口多期按 endDate 升序返回，这里改成降序（最新在前）；latest 取到范围外、区间开头被账号可查范围截断时写 `_note`。 */
async function callStatement(client: GangtiseClient, endpointKey: string, body: Record<string, unknown>): Promise<unknown> {
  const deadline = Date.now() + PROBE_BUDGET_MS
  const stop = new AbortController()
  const start = body.startDate as string | undefined
  const startCut = start !== undefined && start !== body.endDate ? probeUntil(deadline, stop.signal, false, () => beforeWindow(client, endpointKey, body, { startDate: start, endDate: start })) : undefined
  let result: unknown
  try {
    result = normalizeRows(await client.call(endpointKey, body))
  } catch (error) {
    stop.abort()
    throw error
  }
  const list = listOf(result)
  if (!list) return result
  const sorted = [...list].sort(byEndDateDesc)
  const rows = sorted.filter(isRow)
  const shaped = Array.isArray(result) ? { list: sorted } : { ...(result as Row), list: sorted }
  const cutNote = startCut ? startCutNote(rows, body, await startCut) : await yearsCutNote(client, endpointKey, body, rows, deadline, stop.signal)
  return withNote(shaped, latestOutsideNote(rows, body, statementDate, statementYear), cutNote)
}

/** 十大股东：latest 取到范围外时写 `_note`（按年份取不受账号可查下界约束）；区间开头被截断问不出，不判，空结果提示写明。 */
async function callTopHolders(client: GangtiseClient, endpointKey: string, body: Record<string, unknown>): Promise<unknown> {
  const result = normalizeRows(await client.call(endpointKey, body))
  const list = listOf(result)
  if (!list) return result
  const rows = list.filter(isRow)
  return withNote(Array.isArray(result) ? { list } : { ...(result as Row), list }, latestOutsideNote(rows, body, holderDate, holderYear, false))
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
    description: "查询 A 股主营业务构成（按产品、行业或地区拆分）。同一报告期可能同时有汇总项（总计、上级分类）与其下级分类的行，整列求和会重复计算；该期未披露的分类各列为 null。",
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
    description: "查询 A 股前十大股东或前十大流通股东。",
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
    call: callTopHolders,
    emptyHint: "0 行结果：可能该条件下确无数据；按日期区间查时，整段早于账号可查的历史范围也是空结果、不报错，把区间往后挪再查；也可能是代码不对——本工具只查 A 股（代码含 .SH / .SZ / .BJ 后缀），可用 gangtise_securities_search 核实。",
  },
  {
    name: "gangtise_earning_forecast",
    tier: "core",
    description: "查询 A 股盈利预测一致预期（EPS、PE、净利润、ROE 等）。roe 的单位是百分比（35.6 即 35.6%），不要再做 ÷100 换算——换算后的数字看着仍像个 ROE，不会报错。日期省略时取截至 endDate（缺省今天）的近一年；每个日期约 3 行（每个预测年度一行），行数随区间增长，发请求前按「工作日数 × 3 条」预估。",
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
      fiscalYear: fiscalYearOverseas,
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
      fiscalYear: fiscalYearOverseas,
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
      fiscalYear: fiscalYearOverseas,
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
      fiscalYear: fiscalYearOverseas,
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
      fiscalYear: fiscalYearOverseas,
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
      fiscalYear: fiscalYearOverseas,
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
      description: "查询 A 股单只股票的估值指标逐日序列及其在所查区间内的分位，支持 PE、PB、PEG、PS、PCF、EM（只收 A 股股票，其余代码报 120001；港 / 美股分位用 EDE 的 finc_*_quantile）。🔴 percentileRank / average / median / upper1Std / lower1Std 都按 startDate..endDate 这段区间统计，区间就是分位的回看窗口：要「近 5 年分位」把 startDate 设到 5 年前，只查几天得到的是这几天内的分位（只查一天恒为 100），不是历史分位。不传 startDate 按近一年；limit 只截返回的行，不改变统计区间。",
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
