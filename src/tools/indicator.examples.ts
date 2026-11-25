import type { ExampleResponder, ToolExamples } from "../mcp/contract.examples.js"

const CS = "/application/open-indicator/EDE/cross-section"
const REPORT = { paramKey: "reportDate", paramValue: "2025-12-31" }
const TRADE = { paramKey: "tradeDate", paramValue: "2026-11-24" }
/** 第一次请求以 100001 拒绝，之后走默认应答。 */
const refuseFirst = (msg: string): ExampleResponder => (_req, index) => (index === 0 ? { status: 400, json: { code: "100001", msg } } : undefined)
const BOTH_DATES_ARGS = { indicatorCodeList: ["finc_pe", "is_op_rev"], securityCodeList: ["600519.SH"], date: "2026-11-24", indicatorParamList: [{ indicatorCode: "finc_pe", parameters: [REPORT] }, { indicatorCode: "is_op_rev", parameters: [REPORT] }] }
const bothDatesBody = (...finc: object[]) => ({ indicatorCodeList: ["finc_pe", "is_op_rev"], universe: ["600519.SH"], indicatorParamList: [{ indicatorCode: "finc_pe", parameters: [REPORT, ...finc] }, { indicatorCode: "is_op_rev", parameters: [REPORT] }] })

export const indicatorExamples: ToolExamples = {
  gangtise_indicator_search: [
    { title: "关键词 + limit", args: { keyword: "收盘价", limit: 5 }, upstream: () => ({ data: [] }), expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/search", body: { keyword: "收盘价", limit: 5 } }] } },
  ],
  gangtise_indicator_cross_section: [
    { title: "证券键名是 universe；去重；按指标注入 tradeDate", args: { indicatorCodeList: ["qte_close", "qte_mkt_cptl", "qte_close"], securityCodeList: ["600519.SH", "600519.SH", "00700.HK"], date: "2026-09-25", scale: "8", indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "2" }] }] }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/cross-section", body: { indicatorCodeList: ["qte_close", "qte_mkt_cptl"], universe: ["600519.SH", "00700.HK"], scale: "8", indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "2" }, { paramKey: "tradeDate", paramValue: "2026-09-25" }] }, { indicatorCode: "qte_mkt_cptl", parameters: [{ paramKey: "tradeDate", paramValue: "2026-09-25" }] }] } }] } },
    { title: "reportDate 已声明则不注入；noQueryDate 不进 body", args: { indicatorCodeList: ["is_opr", "div_cash_yr"], securityCodeList: ["600519.SH"], date: "2026-09-25", indicatorParamList: [{ indicatorCode: "is_opr", parameters: [{ paramKey: "reportDate", paramValue: "2025/12/31" }] }, { indicatorCode: "div_cash_yr", parameters: [{ paramKey: "fiscalYear", paramValue: "2025" }], noQueryDate: true }] }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/cross-section", body: { indicatorCodeList: ["is_opr", "div_cash_yr"], universe: ["600519.SH"], indicatorParamList: [{ indicatorCode: "is_opr", parameters: [{ paramKey: "reportDate", paramValue: "2025-12-31" }] }, { indicatorCode: "div_cash_yr", parameters: [{ paramKey: "fiscalYear", paramValue: "2025" }] }] } }] } },
    {
      title: "reportDate 之外还必填 tradeDate 的指标：被拒后只给点名的指标补上 date 作 tradeDate，重发一次",
      args: BOTH_DATES_ARGS,
      upstream: refuseFirst("finc_pe: 必填参数 tradeDate 不能为空"),
      expect: { requests: [{ method: "POST", path: CS, body: bothDatesBody() }, { method: "POST", path: CS, body: bothDatesBody(TRADE) }] },
    },
    {
      title: "报错还说了别的原因时不重发",
      args: BOTH_DATES_ARGS,
      upstream: refuseFirst("finc_pe: 必填参数 tradeDate 不能为空; is_op_rev: 不支持参数 tradeDate; 必填参数 reportDate 不能为空"),
      expect: { rejects: /必填参数 tradeDate 不能为空/, requests: [{ method: "POST", path: CS, body: bothDatesBody() }] },
    },
    {
      title: "声明了 noQueryDate 的指标被点名缺 tradeDate 时不重发",
      args: { indicatorCodeList: ["finc_pe"], securityCodeList: ["600519.SH"], date: "2026-11-24", indicatorParamList: [{ indicatorCode: "finc_pe", parameters: [REPORT], noQueryDate: true }] },
      upstream: refuseFirst("finc_pe: 必填参数 tradeDate 不能为空"),
      expect: { rejects: /必填参数 tradeDate 不能为空/, requests: [{ method: "POST", path: CS, body: { indicatorCodeList: ["finc_pe"], universe: ["600519.SH"], indicatorParamList: [{ indicatorCode: "finc_pe", parameters: [REPORT] }] } }] },
    },
    { title: "同一参数两个取值本地拒绝", args: { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-09-25", indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "2" }] }, { indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "3" }] }] }, expect: { rejects: /两个不同的值/ } },
  ],
  gangtise_indicator_time_series: [
    { title: "未传 calendarType：不发，一次取数", args: { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH", "000858.SZ"], startDate: "2026-09-01", endDate: "2026-09-25" }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/time-series", body: { indicatorCodeList: ["qte_close"], universe: ["600519.SH", "000858.SZ"], startDate: "2026-09-01", endDate: "2026-09-25", indicatorParamList: [] } }] } },
    { title: "RD 原样下发", args: { indicatorCodeList: ["is_op_rev"], securityCodeList: ["600519.SH"], startDate: "2025-01-01", endDate: "2026-10-30", calendarType: "RD" }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/time-series", body: { indicatorCodeList: ["is_op_rev"], universe: ["600519.SH"], startDate: "2025-01-01", endDate: "2026-10-30", calendarType: "RD", indicatorParamList: [] } }] } },
    { title: "显式 TD", args: { indicatorCodeList: ["qte_close", "qte_open"], securityCodeList: ["600519.SH"], startDate: "2026-09-01", endDate: "2026-09-25", calendarType: "TD", currency: "USD" }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/time-series", body: { indicatorCodeList: ["qte_close", "qte_open"], universe: ["600519.SH"], startDate: "2026-09-01", endDate: "2026-09-25", calendarType: "TD", currency: "USD", indicatorParamList: [] } }] } },
    { title: "多指标 × 多证券本地拒绝", args: { indicatorCodeList: ["qte_close", "qte_open"], securityCodeList: ["600519.SH", "000858.SZ"], startDate: "2026-09-01", endDate: "2026-09-25" }, expect: { rejects: /不能同时多于 1 个/ } },
  ],
  gangtise_indicator_screener: [
    { title: "按变量注入 tradeDate；证券键名是 universe", args: { indicatorList: [{ field: "F1", indicatorCode: "qte_mkt_cptl", parameters: [{ paramKey: "scale", paramValue: "8" }] }, { field: "F2", indicatorCode: "scr_exchg_sctr", noQueryDate: true }], expression: "F1 >= 500 && F2 contains '创业板'", securityCodeList: ["2000000014"], date: "2026-09-25" }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/screener", body: { universe: ["2000000014"], expression: "F1 >= 500 && F2 contains '创业板'", indicatorList: [{ field: "F1", indicatorCode: "qte_mkt_cptl", parameters: [{ paramKey: "scale", paramValue: "8" }, { paramKey: "tradeDate", paramValue: "2026-09-25" }] }, { field: "F2", indicatorCode: "scr_exchg_sctr", parameters: [] }] } }] } },
    {
      title: "按变量重发：被点名缺 tradeDate 的变量补上 date",
      args: { indicatorList: [{ field: "F1", indicatorCode: "finc_pe", parameters: [REPORT] }, { field: "F2", indicatorCode: "is_op_rev", parameters: [REPORT] }], expression: "F1 > 0 && F2 > 0", securityCodeList: ["600519.SH"], date: "2026-11-24" },
      upstream: refuseFirst("F1 (指标代码 finc_pe): 必填参数 tradeDate 不能为空"),
      expect: { requests: [[], [TRADE]].map((added) => ({ method: "POST" as const, path: "/application/open-indicator/screener", body: { universe: ["600519.SH"], expression: "F1 > 0 && F2 > 0", indicatorList: [{ field: "F1", indicatorCode: "finc_pe", parameters: [REPORT, ...added] }, { field: "F2", indicatorCode: "is_op_rev", parameters: [REPORT] }] } })) },
    },
    { title: "表达式引用未绑定变量本地拒绝", args: { indicatorList: [{ field: "F1", indicatorCode: "qte_close" }], expression: "F2 > 0", securityCodeList: ["600519.SH"], date: "2026-09-25" }, expect: { rejects: /引用了变量 F2/ } },
  ],
}
