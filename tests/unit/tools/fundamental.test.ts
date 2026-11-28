import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { fundamentalFamily } from "../../../src/tools/fundamental.js"
import { registerFamilies } from "../../../src/mcp/register.js"
import type { GangtiseClient } from "../../../src/core/client.js"
import { ApiError } from "../../../src/core/errors.js"
import { currentSignal } from "../../../src/core/requestContext.js"

function makeClient() {
  const call = vi.fn(async () => ({ list: [], total: 0 }))
  return { call, download: vi.fn() } as unknown as GangtiseClient
}

async function connect(client: GangtiseClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerFamilies(server, client, [fundamentalFamily])
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

const base = { securityCode: "600519.SH", indicator: "peTtm" }

// 分位、均值、中位数与 ±1 标准差都按所查区间统计（同一天换区间：8 天 50、1 年 98.6、5 年 34.2、只查当天 100）。
// 描述不写明，短区间的结果会被当成历史分位。
describe("gangtise_valuation_analysis description", () => {
  it("says the percentile and band statistics are over the queried range, and that the tool is A-share only", async () => {
    const mcp = await connect(makeClient())
    const tool = (await mcp.listTools()).tools.find((t) => t.name === "gangtise_valuation_analysis")!
    expect(tool.description).toMatch(/percentileRank \/ average \/ median \/ upper1Std \/ lower1Std 都按 startDate\.\.endDate 这段区间统计/)
    expect(tool.description).toMatch(/只查一天恒为 100/)
    expect(tool.description).toMatch(/只收 A 股股票/)
    expect(tool.description).toMatch(/limit 只截返回的行，不改变统计区间/)
  })
})

// 主营构成同一期里上级分类与下级分类并列（五粮液 2024 年报：酒类 = 五粮液产品 + 其他酒产品），整列求和会重复计算。
describe("gangtise_main_business description", () => {
  it("warns that totals and parent categories sit beside their children", async () => {
    const mcp = await connect(makeClient())
    const tool = (await mcp.listTools()).tools.find((t) => t.name === "gangtise_main_business")!
    expect(tool.description).toMatch(/汇总项（总计、上级分类）与其下级分类的行，整列求和会重复计算/)
  })
})

describe("gangtise_valuation_analysis schema", () => {
  it("rejects a non-positive limit without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_valuation_analysis", arguments: { ...base, limit: 0 } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("accepts a positive limit and calls the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_valuation_analysis", arguments: { ...base, limit: 100 } })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})

// valuation-analysis 的字段名收成 z.enum 闭集，非法值在发请求前就被拒。2026-07-26 时传不存在的
// 字段名（如 securityCode）会静默错列、字段数与行长仍然相等，闭集是为那时加的；服务端现在报
// 100005，闭集留着省一次请求、挡只传 tradeDate 的 0 行，并防回归。上面的行为用例钉「本地拒绝
// 且不调 API」，下面的描述用例钉那份字段清单本身，别再退回泛泛的「指定返回字段」。
describe("fieldList closed set (schema is the defence against equal-length mis-zip)", () => {
  async function schemaOf(name: string) {
    const mcp = await connect(makeClient())
    const tool = (await mcp.listTools()).tools.find((t) => t.name === name)
    return JSON.stringify(tool?.inputSchema)
  }

  // 描述只是建议，schema 才会拒 —— 这两条钉住「本地拒绝且不发请求」的实际行为。
  it("rejects an unknown valuation field locally, without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_valuation_analysis",
      arguments: { ...base, fieldList: ["securityCode", "tradeDate", "value"] },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("accepts the real valuation fields", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_valuation_analysis",
      arguments: { ...base, fieldList: ["value", "percentileRank"] },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it("rejects an unknown main-business field locally, without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_main_business",
      arguments: { securityCode: "600519.SH", breakdown: "product", fieldList: ["categoryName", "revenue"] },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("offers the 6 selectable valuation fields and warns off tradeDate / securityCode", async () => {
    const schema = await schemaOf("gangtise_valuation_analysis")
    for (const f of ["value", "percentileRank", "average", "median", "upper1Std", "lower1Std"]) {
      expect(schema, `应列出可选字段 ${f}`).toContain(f)
    }
    expect(schema).toContain("没有 securityCode")
    expect(schema).toContain("不在可选列内")
  })

  // tradeDate 总是自动前置到每一行，不在可选列内；只传它时接口返回 0 行、不报错。
  it("rejects tradeDate in the valuation fieldList — it is always returned anyway", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_valuation_analysis",
      arguments: { ...base, fieldList: ["tradeDate", "value"] },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("lists main-business's real field names, not the stale endDate/revenue ones", async () => {
    const schema = await schemaOf("gangtise_main_business")
    for (const f of ["periodName", "periodEndDate", "categoryName", "opRevenue", "grossProfit"]) {
      expect(schema, `应列出真实字段 ${f}`).toContain(f)
    }
  })
})

// companyType 与 currency 两列曾经取值互换，现已各归各位（一般企业/银行/保险/证券四类
// 逐一核对，companyType 跟着公司变而 currency 恒为币种）。注记已撤——留着一条针对已修
// 问题的警示，等于教调用方按值反推列名、把对的读法读成错的。
describe("companyType/currency swap note is withdrawn", () => {
  it("no longer tells anyone the two columns are swapped", async () => {
    const mcp = await connect(makeClient())
    for (const [, description] of (await mcp.listTools()).tools.map((t) => [t.name, t.description ?? ""])) {
      expect(description).not.toContain("取值互换")
    }
  })
})

// 两个披露日字段的取值可能不同，而选错的后果是 point-in-time 校验得出相反结论。
// 只挂在**真的有 earliestAnncDate 的** A 股报表上：港股/美股报表没有这个字段，
// 在那里教人用它等于指向一个不存在的列。
describe("point-in-time announcement-date guidance", () => {
  it("distinguishes the returned report version from its first announcement on A-share statements", async () => {
    const mcp = await connect(makeClient())
    const byName = new Map((await mcp.listTools()).tools.map((t) => [t.name, t.description ?? ""]))
    for (const n of [
      "gangtise_income_statement",
      "gangtise_income_statement_quarterly",
      "gangtise_balance_sheet",
      "gangtise_cash_flow",
      "gangtise_cash_flow_quarterly",
    ]) {
      const description = byName.get(n)
      expect(description, `${n} 应区分两个公告日`).toContain("announcementDate 是当前返回报表版本的公告日")
      expect(description).toContain("earliestAnncDate 是接口记录的首次公告日")
      expect(description, `${n} 应写明港股、美股没有 earliestAnncDate`).toContain("只有 A 股报表返回")
      expect(description).toContain("不能靠它排除重述")
      expect(description).not.toContain("都填成最后一期的披露日")
    }
  })

  it("stays off the HK/US statements, which have no such field", async () => {
    const mcp = await connect(makeClient())
    const byName = new Map((await mcp.listTools()).tools.map((t) => [t.name, t.description ?? ""]))
    for (const n of [
      "gangtise_income_statement_hk",
      "gangtise_balance_sheet_hk",
      "gangtise_cash_flow_hk",
      "gangtise_income_statement_us",
      "gangtise_balance_sheet_us",
      "gangtise_cash_flow_us",
    ]) {
      expect(byName.get(n), `${n} 不该提 earliestAnncDate`).not.toContain("earliestAnncDate")
    }
  })
})

// skipNull 是「过滤掉没有取到值的行」，判据必须只看**请求到的**列。
// fieldList 把 percentileRank 投影掉时，那一列在返回的行里根本不存在——把「没查这一列」
// 当成「这一列为空」，会把一份完全正常的估值数据整个过滤成零行，且 isError=false。
describe("gangtise_valuation_analysis skipNull × fieldList", () => {
  function clientWithRows(rows: Array<Record<string, unknown>>) {
    const call = vi.fn(async () => ({ list: rows, total: rows.length }))
    return { call, download: vi.fn() } as unknown as GangtiseClient
  }
  const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text)

  it("keeps rows when fieldList projected percentileRank away", async () => {
    // 投影只留 value 时，行里没有 percentileRank —— 它不是「空」，是没请求。
    const mcp = await connect(clientWithRows([{ tradeDate: "2026-09-01", value: 20.06 }]))
    const result = await mcp.callTool({
      name: "gangtise_valuation_analysis",
      arguments: { ...base, skipNull: true, fieldList: ["value"] },
    })
    expect(result.isError).toBeFalsy()
    expect(parse(result).list).toHaveLength(1)
  })

  it("still drops a row whose requested column is genuinely null", async () => {
    const mcp = await connect(clientWithRows([
      { tradeDate: "2026-09-01", value: 20.06 },
      { tradeDate: "2026-09-02", value: null },
    ]))
    const result = await mcp.callTool({
      name: "gangtise_valuation_analysis",
      arguments: { ...base, skipNull: true, fieldList: ["value"] },
    })
    expect(parse(result).list).toHaveLength(1)
  })

  it("without fieldList both columns still gate the row", async () => {
    const mcp = await connect(clientWithRows([
      { tradeDate: "2026-09-01", value: 20.06, percentileRank: 0.4 },
      { tradeDate: "2026-09-02", value: 20.5, percentileRank: null },
    ]))
    const result = await mcp.callTool({
      name: "gangtise_valuation_analysis",
      arguments: { ...base, skipNull: true },
    })
    expect(parse(result).list).toHaveLength(1)
  })
})

// 单季口径返回行的 period 用的是报告名：第四季度单季那行写「2025年报」，与累计年报只差一个字，
// 读成全年数就是错数。声明住在两个面上：统一入口在 quarterly 参数说明，legacy 单季工具在工具描述——各钉各的。
describe("single-quarter period label note", () => {
  const NOTE = /period 仍是报告名.{0,40}第四季度单季.{0,30}不是累计/
  it("is on the quarterly param of the unified income and cash-flow statements", async () => {
    const mcp = await connect(makeClient())
    const tools = new Map((await mcp.listTools()).tools.map((t) => [t.name, t]))
    for (const n of ["gangtise_income_statement", "gangtise_cash_flow"]) {
      const quarterly = (tools.get(n)?.inputSchema.properties as Record<string, { description?: string }>).quarterly
      expect(quarterly?.description, `${n} 的 quarterly 说明应写明单季行的 period 标签`).toMatch(NOTE)
    }
  })

  it("is in the description of the legacy single-quarter tools", async () => {
    const mcp = await connect(makeClient())
    const byName = new Map((await mcp.listTools()).tools.map((t) => [t.name, t.description ?? ""]))
    for (const n of ["gangtise_income_statement_quarterly", "gangtise_cash_flow_quarterly"]) {
      expect(byName.get(n), `${n} 应写明单季行的 period 标签`).toMatch(NOTE)
    }
  })
})

// 港股、美股的 fiscalYear 按公司财年，即返回行的 fiscalYear：3 月财年的公司 fiscalYear 2027 是「2027一季报」「2027半年报告」；
// 美股的 period 标签不带年份。统一入口与 6 个 legacy 港美股工具都写。
describe("HK/US fiscal-year note", () => {
  it("is on the fiscalYear param of the unified statements and the legacy HK / US tools", async () => {
    const mcp = await connect(makeClient())
    const tools = new Map((await mcp.listTools()).tools.map((t) => [t.name, t]))
    for (const n of ["gangtise_income_statement", "gangtise_balance_sheet", "gangtise_cash_flow"]) {
      const fy = (tools.get(n)?.inputSchema.properties as Record<string, { description?: string }>).fiscalYear
      expect(fy?.description, `${n} 的 fiscalYear 说明应写明港美股按公司财年`).toMatch(/港股、美股按公司财年（即返回行的 fiscalYear）/)
      expect(fy?.description).not.toMatch(/自然年筛|美股须给/)
    }
    for (const n of ["income_statement", "balance_sheet", "cash_flow"].flatMap((t) => [`gangtise_${t}_hk`, `gangtise_${t}_us`])) {
      const fy = (tools.get(n)?.inputSchema.properties as Record<string, { description?: string }>).fiscalYear
      expect(fy?.description, `${n} 的 fiscalYear 说明应写明按公司财年`).toMatch(/按公司财年（即返回行的 fiscalYear）/)
    }
  })
})

// 两条结果提示：latest 取到所问范围之外的报告期（A39 余下形态），区间开头的报告期可能被账号可查范围截断（A43）。
describe("statement and top-holder notes", () => {
  const statementRows = (rows: Array<[string, string]>) => ({ total: rows.length, list: rows.map(([endDate, fiscalYear]) => ({ securityCode: "600519.SH", endDate, fiscalYear, period: "p" })) })
  const holderRows = (periods: string[]) => ({ total: periods.length * 2, list: periods.flatMap((reportPeriod) => [1, 2].map((rank) => ({ reportPeriod, rank }))) })
  // 单查：起止同为一天、或只给一个 fiscalYear 的请求。可查下界取 2016-01-01（日历财年）
  const isProbe = (body: Record<string, unknown>) => (body.startDate !== undefined && body.startDate === body.endDate && Object.keys(body).length === 3) || (Array.isArray(body.fiscalYear) && body.fiscalYear.length === 1 && Object.keys(body).length === 2)
  const beforeWindow = (body: Record<string, unknown>) => (body.startDate !== undefined ? String(body.startDate) < "2016-01-01" : Number((body.fiscalYear as number[])[0]) < 2016)
  async function run(name: string, args: Record<string, unknown>, data: unknown, probe: (body: Record<string, unknown>) => Promise<unknown> = async (body) => { if (beforeWindow(body)) throw new ApiError("超出时间范围限制", "110003"); return { total: 0, list: [] } }) {
    const client = makeClient()
    vi.mocked(client.call).mockImplementation((async (_key: string, body: Record<string, unknown>) => (isProbe(body) ? probe(body) : data)) as never)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name, arguments: args })
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text) as { _note?: string; _hint?: string; list: Array<Record<string, unknown>> }
    const calls = vi.mocked(client.call).mock.calls
    return Object.assign(parsed, { probes: calls.filter(([, body]) => isProbe(body as Record<string, unknown>)), calls: calls.length })
  }
  const IS = "gangtise_income_statement"
  const TH = "gangtise_top_holders"
  const th = { securityCode: "600519.SH", holderType: "top10" }

  it("names the reports latest brought in from outside the fiscal years", async () => {
    const out = await run(IS, { securityCode: "600519.SH", fiscalYear: [2020], period: ["annual", "latest"] }, statementRows([["20201231", "2020"], ["20260930", "2026"]]))
    expect(out._note).toMatch(/期末 2026-09-30 的报告期不在所问的 fiscalYear 内/)
    expect(out.list.map((r) => r.endDate)).toEqual(["20260930", "20201231"])
  })

  it("names the reports latest brought in from outside the dates, on either side", async () => {
    const out = await run(IS, { securityCode: "600519.SH", startDate: "2020-01-01", endDate: "2020-12-31", period: ["annual", "latest"] }, statementRows([["20191231", "2019"], ["20201231", "2020"], ["20260930", "2026"]]))
    expect(out._note).toMatch(/期末 2019-12-31、2026-09-30 的报告期不在所问的日期区间内/)
  })

  it("stays quiet without latest, without a range, or when latest lands inside", async () => {
    expect((await run(IS, { securityCode: "600519.SH", fiscalYear: [2026], period: ["annual"] }, statementRows([["20260930", "2026"]])))._note).toBeUndefined()
    expect((await run(IS, { securityCode: "600519.SH", period: ["annual", "latest"] }, statementRows([["20251231", "2025"], ["20260930", "2026"]])))._note).toBeUndefined()
    expect((await run(IS, { securityCode: "600519.SH", fiscalYear: [2026], period: ["q1", "latest"] }, statementRows([["20260331", "2026"], ["20260930", "2026"]])))._note).toBeUndefined()
  })

  it("asks the endpoint about startDate alone when the earliest report is later, and says so only on 110003", async () => {
    const cut = await run(IS, { securityCode: "600519.SH", startDate: "2000-01-01", endDate: "2026-12-31", reportType: ["consolidated"] }, statementRows([["20160630", "2016"], ["20160331", "2016"]]))
    expect(cut._note).toBe("startDate 2000-01-01 早于账号可查的历史范围：范围之前的报告期本接口不返回、不报错，返回的只是可查范围内的部分（最早一期 2016-03-31）。")
    expect(cut.probes).toEqual([["fundamental.income-statement", { securityCode: "600519.SH", startDate: "2000-01-01", endDate: "2000-01-01" }]])
    // 起点在可查范围内：首期再晚也是公司那几期没有（上市较晚、只报年报），不提示
    const listedLater = await run("gangtise_cash_flow", { securityCode: "LX.O", startDate: "2017-01-01", endDate: "2017-12-31" }, statementRows([["20171231", "2017"]]))
    expect(listedLater._note).toBeUndefined()
    expect(listedLater.probes).toHaveLength(1)
    // 首期就是 startDate：那天可查，不提示（单查与主请求同时发出，结果不用）
    expect((await run(IS, { securityCode: "600519.SH", startDate: "2016-03-31" }, statementRows([["20160331", "2016"]])))._note).toBeUndefined()
    // 起止同一天：主请求成功就说明那天可查，不再发一个一模一样的请求
    expect((await run(IS, { securityCode: "600519.SH", startDate: "2016-01-01", endDate: "2016-01-01" }, { total: 0, list: [] })).calls).toBe(1)
    // 带 latest 也一样：日期整段在外时主请求本身就报 110003，成功了就是那天可查
    expect((await run(IS, { securityCode: "600519.SH", startDate: "2016-01-01", endDate: "2016-01-01", period: ["annual", "latest"] }, statementRows([["20260930", "2026"]]))).calls).toBe(1)
    // 上市较晚的公司起点早于可查范围：只说返回的是范围内的部分，不把范围内没有的年份算成截断
    const late = await run(IS, { securityCode: "688981.SH", startDate: "2015-01-01", endDate: "2021-12-31", period: ["annual"] }, statementRows([["20171231", "2017"], ["20181231", "2018"]]))
    expect(late._note).toBe("startDate 2015-01-01 早于账号可查的历史范围：范围之前的报告期本接口不返回、不报错，返回的只是可查范围内的部分（最早一期 2017-12-31）。")
    // 单查报别的错：不下结论
    expect((await run(IS, { securityCode: "600519.SH", startDate: "2000-01-01" }, statementRows([["20160331", "2016"]]), async () => { throw new ApiError("系统错误", "999999") }))._note).toBeUndefined()
  })

  it("flags a start before the window whatever periods are asked for, and stays quiet from inside it", async () => {
    // AAPL 2015-12-26 一季报被截掉：选什么 period 都提示（含只返回中报与下一年一季报的短窗口）
    const aapl = statementRows([["20160326", "2016"], ["20161231", "2017"]])
    for (const period of [["q1", "h1"], ["q1", "h1", "q3"], ["h1"]]) {
      expect((await run(IS, { securityCode: "AAPL.O", startDate: "2015-09-27", endDate: "2016-12-31", period }, aapl))._note, period.join()).toMatch(/startDate 2015-09-27 早于账号可查的历史范围.*（最早一期 2016-03-26）/)
    }
    // annual + latest 自可查范围内的年初起不提示；港股 h1 + annual + latest、q3 + annual 起点早于可查范围，提示（CLI 仓 D35 的判据）
    expect((await run(IS, { securityCode: "600519.SH", startDate: "2025-01-01", period: ["annual", "latest"] }, statementRows([["20251231", "2025"], ["20260930", "2026"]])))._note).toBeUndefined()
    expect((await run("gangtise_cash_flow", { securityCode: "00700.HK", startDate: "2015-09-01", endDate: "2016-12-31", period: ["h1", "annual", "latest"] }, statementRows([["20160630", "2016"], ["20161231", "2016"]])))._note).toMatch(/startDate 2015-09-01 早于.*（最早一期 2016-06-30）/)
    expect((await run(IS, { securityCode: "600519.SH", startDate: "2015-01-01", endDate: "2017-12-31", period: ["q3", "annual"] }, statementRows([["20160930", "2016"], ["20161231", "2016"], ["20170930", "2017"], ["20171231", "2017"]])))._note).toMatch(/startDate 2015-01-01 早于.*（最早一期 2016-09-30）/)
  })

  it("says so when nothing inside the dates came back and startDate is before the window", async () => {
    const empty = await run(IS, { securityCode: "600519.SH", startDate: "2015-06-01", endDate: "2016-02-01" }, { total: 0, list: [] })
    expect(empty._note).toMatch(/startDate 2015-06-01 早于账号可查的历史范围.*区间内一期也没有返回。$/)
    expect(empty._hint).toMatch(/^0 行结果/)
  })

  it("asks about the missing earlier fiscal years by halving, and lists those before the window", async () => {
    const out = await run(IS, { securityCode: "600519.SH", fiscalYear: [2015, 2013, 2016, 2014, 2015] }, statementRows([["20160331", "2016"], ["20161231", "2016"]]))
    expect(out._note).toBe("fiscalYear 2013、2014、2015 早于账号可查的历史范围，本接口对范围外的年份不返回、不报错；返回的最早是 2016。")
    expect(out.probes.length).toBeLessThanOrEqual(2)
    expect(out.probes.every(([key, body]) => key === "fundamental.income-statement" && Object.keys(body as object).join() === "securityCode,fiscalYear")).toBe(true)
    // 下界落在缺的几年中间：只列早于下界的
    const mid = await run(IS, { securityCode: "600519.SH", fiscalYear: [2014, 2015, 2016, 2017, 2018] }, statementRows([["20181231", "2018"]]))
    expect(mid._note).toMatch(/^fiscalYear 2014、2015 早于账号可查的历史范围/)
    // 缺的年份都在范围内（公司那几年没有报告）、只有更晚的年份没返回、只给 endDate：都不提示
    expect((await run(IS, { securityCode: "600519.SH", fiscalYear: [2018, 2019] }, statementRows([["20191231", "2019"]])))._note).toBeUndefined()
    expect((await run(IS, { securityCode: "600519.SH", fiscalYear: [2025, 2026] }, statementRows([["20251231", "2025"]])))._note).toBeUndefined()
    const endOnly = await run(IS, { securityCode: "600519.SH", endDate: "2017-12-31" }, statementRows([["20160331", "2016"]]))
    expect(endOnly._note).toBeUndefined()
    expect(endOnly.probes).toHaveLength(0)
    // 一年都没返回（09988.HK 2015 在范围外、2016 在范围内但没有报告）：照样问，所问最晚的那年主请求已确认可查、不用问
    const empty = await run(IS, { securityCode: "09988.HK", fiscalYear: [2015, 2016] }, { total: 0, list: [] })
    expect(empty._note).toBe("fiscalYear 2015 早于账号可查的历史范围，本接口对范围外的年份不返回、不报错。")
    expect(empty.probes.map(([, body]) => (body as { fiscalYear: number[] }).fiscalYear)).toEqual([[2015]])
    // 只问一年、不带 latest：主请求成功就说明那年可查
    expect((await run(IS, { securityCode: "600519.SH", fiscalYear: [2016] }, { total: 0, list: [] })).calls).toBe(1)
  })

  it("claims only what the endpoint confirmed when some rows cannot be placed", async () => {
    // 一行没有 endDate：起点越界是确认了的，「最早一期」「一期也没有」从行里推不出，不说
    const dated = await run(IS, { securityCode: "600519.SH", startDate: "2000-01-01" }, { total: 1, list: [{ fiscalYear: "2016", period: "2016年年报" }] })
    expect(dated._note).toBe("startDate 2000-01-01 早于账号可查的历史范围：范围之前的报告期本接口不返回、不报错，返回的只是可查范围内的部分。")
    // 一行没有 fiscalYear：最早年份推不出，不说
    const byYear = await run(IS, { securityCode: "600519.SH", fiscalYear: [2015, 2016] }, { total: 2, list: [{ endDate: "20161231", fiscalYear: "2016" }, { endDate: "20160630" }] })
    expect(byYear._note).toBe("fiscalYear 2015 早于账号可查的历史范围，本接口对范围外的年份不返回、不报错。")
  })

  it("gives up on the check after 5 seconds and returns what the main request got", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 20)
      return controller.signal
    })
    try {
      // 与真实客户端一样：信号已中止就立即失败，否则等到中止
      const hang = () => new Promise((_, reject) => {
        const signal = currentSignal()
        if (signal?.aborted) reject(new Error("aborted"))
        else signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })
      const dated = await run(IS, { securityCode: "600519.SH", startDate: "2000-01-01" }, statementRows([["20160331", "2016"]]), hang)
      expect(dated.list).toHaveLength(1)
      expect(dated._note).toBeUndefined()
      const byYear = await run(IS, { securityCode: "600519.SH", fiscalYear: [2014, 2015, 2016] }, statementRows([["20161231", "2016"]]), hang)
      expect(byYear.list).toHaveLength(1)
      expect(byYear._note).toBeUndefined()
      // 截止时间从工具调用开始算，给单查的是剩下的时间
      expect(timeout.mock.calls.every(([ms]) => ms > 0 && ms <= 5_000)).toBe(true)
      // 单查等的是共享登录这类中止信号停不下的东西：到点照样交回主结果
      const stuck = () => new Promise(() => {})
      expect((await run(IS, { securityCode: "600519.SH", startDate: "2000-01-01" }, statementRows([["20160331", "2016"]]), stuck)).list).toHaveLength(1)
      expect((await run(IS, { securityCode: "600519.SH", fiscalYear: [2014, 2015, 2016] }, statementRows([["20161231", "2016"]]), stuck)).list).toHaveLength(1)
    } finally {
      timeout.mockRestore()
    }
  })

  it("skips the fiscal-year check when the main request already used up the 5 seconds", async () => {
    const base = Date.now()
    let now = base
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const client = makeClient()
      vi.mocked(client.call).mockImplementation((async () => {
        now = base + 6_000
        return statementRows([["20161231", "2016"]])
      }) as never)
      const mcp = await connect(client)
      const result = await mcp.callTool({ name: IS, arguments: { securityCode: "600519.SH", fiscalYear: [2014, 2015, 2016] } })
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)._note).toBeUndefined()
      expect(vi.mocked(client.call)).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })

  it("stops the startDate check when the main request fails", async () => {
    let probeSignal: AbortSignal | undefined
    const client = makeClient()
    vi.mocked(client.call).mockImplementation((async (_key: string, body: Record<string, unknown>) => {
      if (isProbe(body)) {
        probeSignal = currentSignal()
        return new Promise(() => {})
      }
      throw new ApiError("超出时间范围限制", "110003")
    }) as never)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: IS, arguments: { securityCode: "600519.SH", startDate: "2000-01-01", endDate: "2005-12-31" } })
    expect(result.isError).toBe(true)
    expect(probeSignal?.aborted).toBe(true)
  })

  it("does not judge the top holders' window, which a single day cannot answer", async () => {
    const out = await run(TH, { ...th, startDate: "2000-01-01", endDate: "2026-12-31", period: ["annual"] }, holderRows(["2016-12-31", "2017-12-31"]))
    expect(out._note).toBeUndefined()
    expect(out.probes).toHaveLength(0)
    expect((await run(TH, { ...th, fiscalYear: [2020], period: ["annual", "latest"] }, holderRows(["2020-12-31", "2026-09-30"])))._note).toMatch(/期末 2026-09-30 的报告期不在所问的 fiscalYear 内/)
    expect((await run(TH, { ...th, period: ["latest"] }, holderRows(["2026-09-30"])))._note).toBeUndefined()
  })

  it("joins both notes when both apply", async () => {
    const out = await run(IS, { securityCode: "600519.SH", startDate: "2000-01-01", endDate: "2020-12-31", period: ["annual", "latest"] }, statementRows([["20161231", "2016"], ["20171231", "2017"], ["20260930", "2026"]]))
    expect(out._note).toMatch(/^期末 2026-09-30 .*去掉 latest；startDate 2000-01-01 早于账号可查的历史范围.*（最早一期 2016-12-31）。$/)
  })

  it("says nothing inside the fiscal years came back when latest is all there is", async () => {
    const out = await run(IS, { securityCode: "600519.SH", fiscalYear: [2005], period: ["annual", "latest"] }, statementRows([["20260930", "2026"]]))
    // 带 latest 时整段在外也只回最新一期、不报错，所以只问一年也要单查
    expect(out._note).toMatch(/^期末 2026-09-30 的报告期不在所问的 fiscalYear 内：.*最新一期；所问 fiscalYear 内一期也没有返回，.*去掉 latest 也取不到；fiscalYear 2005 早于账号可查的历史范围，本接口对范围外的年份不返回、不报错。$/)
    expect(out._note).not.toMatch(/只要所问范围就去掉 latest/)
    // 十大股东按年份取不受账号可查范围约束：只说公司那时可能还没有报告
    const holders = await run(TH, { ...th, fiscalYear: [1995], period: ["annual", "latest"] }, holderRows(["2026-09-30"]))
    expect(holders._note).toMatch(/所问 fiscalYear 内一期也没有返回，可能是公司那时还没有报告，去掉 latest 也取不到。$/)
    const holdersByDate = await run(TH, { ...th, startDate: "2005-01-01", endDate: "2005-12-31", period: ["annual", "latest"] }, holderRows(["2026-09-30"]))
    expect(holdersByDate._note).toMatch(/也可能是整段早于账号可查的历史范围/)
  })

  it("names only the rows known to be outside, and claims nothing about the range, when some rows cannot be placed", async () => {
    const byYear = await run(IS, { securityCode: "600519.SH", fiscalYear: [2020], period: ["annual", "latest"] }, { total: 2, list: [{ endDate: "20201231", fiscalYear: null, period: "2020年年报" }, { endDate: "20260930", fiscalYear: "2026", period: "2026年三季报" }] })
    expect(byYear._note).toMatch(/^期末 2026-09-30 的报告期不在所问的 fiscalYear 内.*只要所问范围就去掉 latest。$/)
    const byDate = await run(IS, { securityCode: "600519.SH", startDate: "2020-01-01", endDate: "2020-12-31", period: ["annual", "latest"] }, { total: 2, list: [{ fiscalYear: "2020", period: "2020年年报" }, { endDate: "20260930", fiscalYear: "2026", period: "2026年三季报" }] })
    expect(byDate._note).toMatch(/^期末 2026-09-30 的报告期不在所问的日期区间内.*只要所问范围就去掉 latest。$/)
  })

  it("does not judge the year of rows that carry no fiscalYear", async () => {
    const out = await run("gangtise_income_statement", { securityCode: "00700.HK", fiscalYear: [2026], period: ["h1", "latest"] }, { total: 1, list: [{ securityCode: "00700.HK", endDate: "2026-06-30", period: "h1" }] })
    expect(out._note).toBeUndefined()
  })

  it("sorts and notes responses that come without total, and sorts rows out of order", async () => {
    const bare = await run(IS, { securityCode: "600519.SH", fiscalYear: [2020], period: ["annual", "latest"] }, { fieldList: ["securityCode", "endDate", "fiscalYear", "reportType"], list: [["600519.SH", "20201231", "2020", "consolidated"], ["600519.SH", "20260930", "2026", "consolidated"]] })
    expect(bare.list.map((r) => r.endDate)).toEqual(["20260930", "20201231"])
    expect(bare._note).toMatch(/期末 2026-09-30 的报告期不在所问的 fiscalYear 内/)
    const holders = await run(TH, { ...th, fiscalYear: [2020], period: ["annual", "latest"] }, { list: [{ reportPeriod: "2020-12-31", rank: 1 }, { reportPeriod: "2026-09-30", rank: 1 }] })
    expect(holders._note).toMatch(/期末 2026-09-30 的报告期不在所问的 fiscalYear 内/)
    const mixed = await run(IS, { securityCode: "600519.SH", fiscalYear: [2023, 2024], period: ["annual"], reportType: ["consolidated", "consolidatedRestated"] }, {
      total: 4,
      list: [["20231231", "consolidatedRestated"], ["20241231", "consolidated"], ["20231231", "consolidated"], ["20241231", "consolidatedRestated"]].map(([endDate, reportType]) => ({ endDate, reportType, fiscalYear: endDate.slice(0, 4) })),
    })
    expect(mixed.list.map((r) => r.endDate)).toEqual(["20241231", "20241231", "20231231", "20231231"])
  })

  it("points an empty dated top-holders result at the account's history range", async () => {
    const client = makeClient()
    vi.mocked(client.call).mockResolvedValue({ total: 0, list: [] } as never)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: TH, arguments: { ...th, startDate: "2005-01-01", endDate: "2005-12-31" } })
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/整段早于账号可查的历史范围也是空结果/)
  })
})

// roe 的单位是百分比：再做一次 ÷100 得到的数字看着仍像个 ROE，不会报错。
describe("gangtise_earning_forecast unit note", () => {
  it("states the roe percentage unit in the description", async () => {
    const mcp = await connect(makeClient())
    const byName = new Map((await mcp.listTools()).tools.map((t) => [t.name, t.description ?? ""]))
    expect(byName.get("gangtise_earning_forecast")).toContain("百分比")
  })
})

// 按条计费、行数随区间增长：缺省日期补成「截至今天（北京）的近一年」，积分才估得出来（与 CLI 相同）。
describe("gangtise_earning_forecast default range", () => {
  it("fills the year before today (Asia/Shanghai) when both dates are omitted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-09-29T17:30:00Z")) // 北京时间 2026-09-30 01:30
    try {
      const client = makeClient()
      const mcp = await connect(client)
      await mcp.callTool({ name: "gangtise_earning_forecast", arguments: { securityCode: "600519.SH" } })
      expect(client.call).toHaveBeenCalledWith("fundamental.earning-forecast", { securityCode: "600519.SH", startDate: "2025-09-30", endDate: "2026-09-30" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects a start date after the defaulted end date without calling the API", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-09-30T04:00:00Z"))
    try {
      const client = makeClient()
      const mcp = await connect(client)
      const result = await mcp.callTool({ name: "gangtise_earning_forecast", arguments: { securityCode: "600519.SH", startDate: "2026-10-08" } })
      expect(result.isError).toBe(true)
      expect(client.call).not.toHaveBeenCalled()
      // endDate 是本地补的，报错不能点名它
      const text = (result.content as Array<{ text: string }>)[0].text
      expect(text).toMatch(/startDate \(2026-10-08\) 晚于今天/)
      expect(text).not.toContain("endDate")
    } finally {
      vi.useRealTimers()
    }
  })
})
