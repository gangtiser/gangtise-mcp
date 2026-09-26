import type { ToolExamples } from "../mcp/contract.examples.js"

export const fundamentalExamples: ToolExamples = {
  gangtise_income_statement: [
    { title: "A 股累计", args: { securityCode: "600519.SH", fiscalYear: [2024, 2025], period: ["annual"], reportType: ["consolidated"], fieldList: ["announcementDate", "opRevenue"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/accumulated", body: { securityCode: "600519.SH", fiscalYear: [2024, 2025], period: ["annual"], reportType: ["consolidated"], fieldList: ["announcementDate", "opRevenue"] } }] } },
    { title: "港股期间 h1 本地拒绝", args: { securityCode: "600519.SH", period: ["h1"] }, expect: { rejects: /at period/ } },
  ],
  gangtise_income_statement_quarterly: [
    { title: "A 股单季", args: { securityCode: "600519.SH", period: ["q2"], startDate: "2024-01-01", endDate: "2025-12-31" }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/quarterly", body: { securityCode: "600519.SH", startDate: "2024-01-01", endDate: "2025-12-31", period: ["q2"] } }] } },
  ],
  gangtise_balance_sheet: [
    { title: "A 股", args: { securityCode: "600519.SH", period: ["interim"], reportType: ["standalone"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/accumulated", body: { securityCode: "600519.SH", period: ["interim"], reportType: ["standalone"] } }] } },
  ],
  gangtise_cash_flow: [
    { title: "A 股累计", args: { securityCode: "600519.SH", fiscalYear: [2025], period: ["q3"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/accumulated", body: { securityCode: "600519.SH", fiscalYear: [2025], period: ["q3"] } }] } },
  ],
  gangtise_cash_flow_quarterly: [
    { title: "A 股单季", args: { securityCode: "600519.SH", period: ["q4", "latest"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/quarterly", body: { securityCode: "600519.SH", period: ["q4", "latest"] } }] } },
  ],
  gangtise_main_business: [
    { title: "按产品", args: { securityCode: "600519.SH", breakdown: "product", periodList: ["annual"], fieldList: ["periodName", "opRevenue"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/main-business", body: { securityCode: "600519.SH", breakdown: "product", periodList: ["annual"], fieldList: ["periodName", "opRevenue"] } }] } },
  ],
  gangtise_top_holders: [
    { title: "前十大股东", args: { securityCode: "600519.SH", holderType: "top10", fiscalYear: [2025], period: ["interim"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/capital-structure/top-holders", body: { securityCode: "600519.SH", holderType: "top10", fiscalYear: [2025], period: ["interim"] } }] } },
  ],
  gangtise_earning_forecast: [
    { title: "一致预期", args: { securityCode: "600519.SH", consensusList: ["eps", "pe"], startDate: "2026-01-01", endDate: "2026-09-01" }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/earning-forecast", body: { securityCode: "600519.SH", startDate: "2026-01-01", endDate: "2026-09-01", consensusList: ["eps", "pe"] } }] } },
  ],
  gangtise_income_statement_hk: [
    { title: "港股：reportType 照常下发", args: { securityCode: "00700.HK", period: ["h1"], reportType: ["consolidatedRestated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/hk", body: { securityCode: "00700.HK", period: ["h1"], reportType: ["consolidatedRestated"] } }] } },
  ],
  gangtise_balance_sheet_hk: [
    { title: "港股", args: { securityCode: "00700.HK", period: ["annual"], reportType: ["consolidated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/hk", body: { securityCode: "00700.HK", period: ["annual"], reportType: ["consolidated"] } }] } },
  ],
  gangtise_cash_flow_hk: [
    { title: "港股", args: { securityCode: "00700.HK", period: ["h2"], fiscalYear: [2025] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/hk", body: { securityCode: "00700.HK", fiscalYear: [2025], period: ["h2"] } }] } },
  ],
  gangtise_income_statement_us: [
    { title: "美股：reportType 照常下发", args: { securityCode: "TSLA.O", period: ["nsd"], reportType: ["standaloneRestated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/us", body: { securityCode: "TSLA.O", period: ["nsd"], reportType: ["standaloneRestated"] } }] } },
  ],
  gangtise_balance_sheet_us: [
    { title: "美股", args: { securityCode: "TSLA.O", period: ["annual"], reportType: ["consolidated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/us", body: { securityCode: "TSLA.O", period: ["annual"], reportType: ["consolidated"] } }] } },
  ],
  gangtise_cash_flow_us: [
    { title: "美股", args: { securityCode: "TSLA.O", period: ["q1"], fieldList: ["announcementDate"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/us", body: { securityCode: "TSLA.O", period: ["q1"], fieldList: ["announcementDate"] } }] } },
  ],
  gangtise_valuation_analysis: [
    { title: "skipNull 不进 body；limit 缺省时显式发 2000", args: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2021-01-01", endDate: "2026-09-01", skipNull: true }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/valuation-analysis", body: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2021-01-01", endDate: "2026-09-01", limit: 2000 } }] } },
    { title: "显式 limit 原样下发", args: { securityCode: "600519.SH", indicator: "pbMrq", startDate: "2016-01-01", endDate: "2026-09-01", limit: 3900 }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/valuation-analysis", body: { securityCode: "600519.SH", indicator: "pbMrq", startDate: "2016-01-01", endDate: "2026-09-01", limit: 3900 } }] } },
    { title: "fieldList 不收 tradeDate", args: { securityCode: "600519.SH", indicator: "pbMrq", fieldList: ["tradeDate", "value"] }, expect: { rejects: /at fieldList/ } },
  ],
}
