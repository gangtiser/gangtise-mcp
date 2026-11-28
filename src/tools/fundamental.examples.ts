import type { ExampleResponder, ToolExamples } from "../mcp/contract.examples.js"

/** 所问的每个财年各回一行年报（数据齐全的常见情形：不触发对更早年份的单查）。 */
const yearRows: ExampleResponder = (req) => {
  const years = ((req.body as { fiscalYear?: number[] } | undefined)?.fiscalYear ?? [])
  return { data: { total: years.length, list: years.map((year) => ({ endDate: `${year}1231`, fiscalYear: String(year), period: `${year}年年报` })) } }
}

export const fundamentalExamples: ToolExamples = {
  gangtise_income_statement: [
    { title: "A 股累计", args: { securityCode: "600519.SH", fiscalYear: [2024, 2025], period: ["annual"], reportType: ["consolidated"], fieldList: ["announcementDate", "opRevenue"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/accumulated", body: { securityCode: "600519.SH", fiscalYear: [2024, 2025], period: ["annual"], reportType: ["consolidated"], fieldList: ["announcementDate", "opRevenue"] } }] }, upstream: yearRows },
    { title: "A 股配港股的 period 本地拒绝", args: { securityCode: "600519.SH", fiscalYear: [2025], period: ["h1"] }, expect: { rejects: /A股报表的 period 只收/ } },
    { title: "只给 fiscalYear 放行（返回该年各期）", args: { securityCode: "600519.SH", fiscalYear: [2019] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/accumulated", body: { securityCode: "600519.SH", fiscalYear: [2019] } }] } },
    { title: "fiscalYear 配 period=latest：零请求拒绝（返回的是全部报告里的最新一期）", args: { securityCode: "600519.SH", fiscalYear: [2019], period: ["latest"] }, expect: { rejects: /只给 latest 时本接口返回全部报告里的最新一期/, requests: [] } },
    { title: "日期区间配 period=latest 同样拒绝", args: { securityCode: "00700.HK", startDate: "2019-01-01", endDate: "2019-12-31", period: ["latest"] }, expect: { rejects: /只给 latest/, requests: [] } },
    { title: "只给 period 放行（返回该类全部报告）", args: { securityCode: "600519.SH", period: ["annual"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/accumulated", body: { securityCode: "600519.SH", period: ["annual"] } }] } },
    { title: "什么都不给放行（返回全部历史报告期）", args: { securityCode: "600519.SH" }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/accumulated", body: { securityCode: "600519.SH" } }] } },
    { title: "只给 period=latest 放行", args: { securityCode: "600519.SH", period: ["latest"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/accumulated", body: { securityCode: "600519.SH", period: ["latest"] } }] } },
    { title: "只给 endDate 配 period 放行", args: { securityCode: "600519.SH", endDate: "2019-12-31", period: ["annual"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/accumulated", body: { securityCode: "600519.SH", endDate: "2019-12-31", period: ["annual"] } }] } },
    { title: "只给一端日期配 period 放行；区间内一期都没有时单查 startDate 那一天确认是否早于可查范围", args: { securityCode: "600519.SH", startDate: "2019-01-01", period: ["annual"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/accumulated", body: { securityCode: "600519.SH", startDate: "2019-01-01", period: ["annual"] } }, { method: "POST", path: "/application/open-fundamental/financial-report/income-statement/accumulated", body: { securityCode: "600519.SH", startDate: "2019-01-01", endDate: "2019-01-01" } }] } },
    { title: "A 股单季口径：第二季度写 interim", args: { securityCode: "600519.SH", quarterly: true, fiscalYear: [2025], period: ["interim"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/quarterly", body: { securityCode: "600519.SH", fiscalYear: [2025], period: ["interim"] } }] } },
    { title: "单季口径不收 q2", args: { securityCode: "600519.SH", quarterly: true, fiscalYear: [2025], period: ["q2"] }, expect: { rejects: /at period/, requests: [] } },
    { title: "港股按后缀路由，reportType 照常下发", args: { securityCode: "00700.HK", fiscalYear: [2025], period: ["h1"], reportType: ["consolidated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/hk", body: { securityCode: "00700.HK", fiscalYear: [2025], period: ["h1"], reportType: ["consolidated"] } }] } },
    { title: "美股按后缀路由", args: { securityCode: "TSLA.O", fiscalYear: [2025], period: ["nsd"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/us", body: { securityCode: "TSLA.O", fiscalYear: [2025], period: ["nsd"] } }] } },
    { title: "美股多个财年一次请求", args: { securityCode: "AAPL.O", fiscalYear: [2024, 2025], period: ["annual"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/us", body: { securityCode: "AAPL.O", fiscalYear: [2024, 2025], period: ["annual"] } }] }, upstream: yearRows },
    { title: "美股不给年份与日期放行（返回全部历史报告期）", args: { securityCode: "AAPL.O", period: ["annual"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/us", body: { securityCode: "AAPL.O", period: ["annual"] } }] } },
    { title: "美股只给 latest 放行", args: { securityCode: "AAPL.O", period: ["latest"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/us", body: { securityCode: "AAPL.O", period: ["latest"] } }] } },
    { title: "单季口径配港股本地拒绝", args: { securityCode: "00700.HK", quarterly: true }, expect: { rejects: /单季口径（quarterly）只有 A 股有/ } },
    { title: "单季口径配港股且年份配 latest：一并报出", args: { securityCode: "00700.HK", quarterly: true, fiscalYear: [2025], period: ["latest"] }, expect: { rejects: /只有 A 股有.*只给 latest/, requests: [] } },
    { title: "认不出后缀本地拒绝", args: { securityCode: "600519" }, expect: { rejects: /无法从 '600519' 的后缀判断市场/ } },
    { title: "认不出后缀且年份配 latest：一并报出", args: { securityCode: "600519", fiscalYear: [2025], period: ["latest"] }, expect: { rejects: /后缀判断市场.*只给 latest/, requests: [] } },
  ],
  gangtise_income_statement_quarterly: [
    { title: "A 股单季（单查 startDate 走同一个单季端点）", args: { securityCode: "600519.SH", period: ["interim"], startDate: "2024-01-01", endDate: "2025-12-31" }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/quarterly", body: { securityCode: "600519.SH", startDate: "2024-01-01", endDate: "2025-12-31", period: ["interim"] } }, { method: "POST", path: "/application/open-fundamental/financial-report/income-statement/quarterly", body: { securityCode: "600519.SH", startDate: "2024-01-01", endDate: "2024-01-01" } }] } },
  ],
  gangtise_balance_sheet: [
    { title: "港股按后缀路由", args: { securityCode: "00700.HK", fiscalYear: [2025], period: ["h2"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/hk", body: { securityCode: "00700.HK", fiscalYear: [2025], period: ["h2"] } }] } },
    { title: "资产负债表没有单季口径", args: { securityCode: "600519.SH", quarterly: true }, expect: { rejects: /Unrecognized key.*quarterly/ } },
    { title: "A 股", args: { securityCode: "600519.SH", fiscalYear: [2025], period: ["interim"], reportType: ["standalone"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/accumulated", body: { securityCode: "600519.SH", fiscalYear: [2025], period: ["interim"], reportType: ["standalone"] } }] } },
  ],
  gangtise_cash_flow: [
    { title: "A 股单季口径：第四季度写 annual", args: { securityCode: "000858.SZ", quarterly: true, fiscalYear: [2025], period: ["annual"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/quarterly", body: { securityCode: "000858.SZ", fiscalYear: [2025], period: ["annual"] } }] } },
    { title: "美股单季口径本地拒绝", args: { securityCode: "AAPL.O", quarterly: true }, expect: { rejects: /单季口径（quarterly）只有 A 股有/ } },
    { title: "A 股累计", args: { securityCode: "600519.SH", fiscalYear: [2025], period: ["q3"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/accumulated", body: { securityCode: "600519.SH", fiscalYear: [2025], period: ["q3"] } }] } },
  ],
  gangtise_cash_flow_quarterly: [
    { title: "A 股单季", args: { securityCode: "600519.SH", fiscalYear: [2025], period: ["annual", "latest"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/quarterly", body: { securityCode: "600519.SH", fiscalYear: [2025], period: ["annual", "latest"] } }] }, upstream: yearRows },
    { title: "legacy 单季：日期区间配 period latest 同样零请求拒绝", args: { securityCode: "600519.SH", startDate: "2020-01-01", endDate: "2020-12-31", period: ["latest"] }, expect: { rejects: /只给 latest/, requests: [] } },
  ],
  gangtise_main_business: [
    { title: "旧键 periodList 不收", args: { securityCode: "600519.SH", breakdown: "product", periodList: ["annual"] }, expect: { rejects: /Unrecognized key.*periodList/, requests: [] } },
    { title: "按产品", args: { securityCode: "600519.SH", breakdown: "product", period: ["annual"], fieldList: ["periodName", "opRevenue"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/main-business", body: { securityCode: "600519.SH", breakdown: "product", period: ["annual"], fieldList: ["periodName", "opRevenue"] } }] } },
  ],
  gangtise_top_holders: [
    { title: "前十大股东", args: { securityCode: "600519.SH", holderType: "top10", fiscalYear: [2025], period: ["interim"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/capital-structure/top-holders", body: { securityCode: "600519.SH", holderType: "top10", fiscalYear: [2025], period: ["interim"] } }] } },
    { title: "不传日期与 period：全部报告期", args: { securityCode: "600519.SH", holderType: "top10Float" }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/capital-structure/top-holders", body: { securityCode: "600519.SH", holderType: "top10Float" } }] } },
    { title: "日期区间配 period=latest：零请求拒绝", args: { securityCode: "600519.SH", holderType: "top10", startDate: "2020-01-01", endDate: "2020-12-31", period: ["latest"] }, expect: { rejects: /只给 latest/, requests: [] } },
  ],
  gangtise_earning_forecast: [
    { title: "一致预期", args: { securityCode: "600519.SH", consensusList: ["eps", "pe"], startDate: "2026-01-01", endDate: "2026-09-01" }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/earning-forecast", body: { securityCode: "600519.SH", startDate: "2026-01-01", endDate: "2026-09-01", consensusList: ["eps", "pe"] } }] } },
    { title: "只给 endDate：起点补成前 365 天", args: { securityCode: "600519.SH", endDate: "2026-09-01" }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/earning-forecast", body: { securityCode: "600519.SH", startDate: "2025-09-01", endDate: "2026-09-01" } }] } },
    { title: "长区间按工作日 × 3 条预估超阈值：零请求拒绝", args: { securityCode: "600519.SH", startDate: "2016-01-01", endDate: "2026-09-01" }, expect: { rejects: /本次预计取 \d+ 条（0\.5 积分\/条）.*超过积分预估保护/ } },
    { title: "confirmCost 放行，且不进请求体", args: { securityCode: "600519.SH", startDate: "2016-01-01", endDate: "2026-09-01", confirmCost: true }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/earning-forecast", body: { securityCode: "600519.SH", startDate: "2016-01-01", endDate: "2026-09-01" } }] } },
  ],
  gangtise_income_statement_hk: [
    { title: "港股：reportType 照常下发", args: { securityCode: "00700.HK", fiscalYear: [2025], period: ["h1"], reportType: ["consolidatedRestated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/hk", body: { securityCode: "00700.HK", fiscalYear: [2025], period: ["h1"], reportType: ["consolidatedRestated"] } }] } },
    { title: "legacy 变体同样拦：fiscalYear 配 period=latest 时零请求拒绝", args: { securityCode: "00700.HK", fiscalYear: [2019], period: ["latest"] }, expect: { rejects: /只给 latest/, requests: [] } },
  ],
  gangtise_balance_sheet_hk: [
    { title: "港股", args: { securityCode: "00700.HK", fiscalYear: [2025], period: ["annual"], reportType: ["consolidated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/hk", body: { securityCode: "00700.HK", fiscalYear: [2025], period: ["annual"], reportType: ["consolidated"] } }] } },
  ],
  gangtise_cash_flow_hk: [
    { title: "港股", args: { securityCode: "00700.HK", period: ["h2"], fiscalYear: [2025] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/hk", body: { securityCode: "00700.HK", fiscalYear: [2025], period: ["h2"] } }] } },
  ],
  gangtise_income_statement_us: [
    { title: "美股：reportType 照常下发", args: { securityCode: "TSLA.O", fiscalYear: [2025], period: ["nsd"], reportType: ["standaloneRestated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/us", body: { securityCode: "TSLA.O", fiscalYear: [2025], period: ["nsd"], reportType: ["standaloneRestated"] } }] } },
  ],
  gangtise_balance_sheet_us: [
    { title: "美股", args: { securityCode: "TSLA.O", fiscalYear: [2025], period: ["annual"], reportType: ["consolidated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/us", body: { securityCode: "TSLA.O", fiscalYear: [2025], period: ["annual"], reportType: ["consolidated"] } }] } },
  ],
  gangtise_cash_flow_us: [
    { title: "legacy 美股多个财年一次请求", args: { securityCode: "TSLA.O", fiscalYear: [2023, 2024] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/us", body: { securityCode: "TSLA.O", fiscalYear: [2023, 2024] } }] }, upstream: yearRows },
    { title: "美股", args: { securityCode: "TSLA.O", fiscalYear: [2025], period: ["q1"], fieldList: ["announcementDate"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/us", body: { securityCode: "TSLA.O", fiscalYear: [2025], period: ["q1"], fieldList: ["announcementDate"] } }] } },
  ],
  gangtise_valuation_analysis: [
    { title: "skipNull 不进 body；limit 缺省时显式发 2000", args: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2021-01-01", endDate: "2026-09-01", skipNull: true }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/valuation-analysis", body: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2021-01-01", endDate: "2026-09-01", limit: 2000 } }] } },
    { title: "显式 limit 原样下发", args: { securityCode: "600519.SH", indicator: "pbMrq", startDate: "2016-01-01", endDate: "2026-09-01", limit: 3900 }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/valuation-analysis", body: { securityCode: "600519.SH", indicator: "pbMrq", startDate: "2016-01-01", endDate: "2026-09-01", limit: 3900 } }] } },
    { title: "fieldList 不收 tradeDate", args: { securityCode: "600519.SH", indicator: "pbMrq", fieldList: ["tradeDate", "value"] }, expect: { rejects: /at fieldList/ } },
    { title: "返回不是列表结构时报形状异常，不当成空结果", args: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2026-09-01", endDate: "2026-09-05" }, upstream: (req) => (req.endpoint === "fundamental.valuation-analysis" ? { data: null } : undefined), expect: { rejects: /不是预期的列表/, requests: [{ method: "POST", path: "/application/open-fundamental/valuation-analysis", body: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2026-09-01", endDate: "2026-09-05", limit: 2000 } }] } },
  ],
}
