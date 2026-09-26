import type { ToolExamples } from "../mcp/contract.examples.js"

export const indicatorExamples: ToolExamples = {
  gangtise_indicator_search: [
    { title: "关键词 + limit", args: { keyword: "收盘价", limit: 5 }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/search", body: { keyword: "收盘价", limit: 5 } }] } },
  ],
  gangtise_indicator_cross_section: [
    { title: "证券键名是 universe；去重；按指标注入 tradeDate", args: { indicatorCodeList: ["qte_close", "qte_mkt_cptl", "qte_close"], securityCodeList: ["600519.SH", "600519.SH", "00700.HK"], date: "2026-09-25", scale: "8", indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "2" }] }] }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/cross-section", body: { indicatorCodeList: ["qte_close", "qte_mkt_cptl"], universe: ["600519.SH", "00700.HK"], scale: "8", indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "2" }, { paramKey: "tradeDate", paramValue: "2026-09-25" }] }, { indicatorCode: "qte_mkt_cptl", parameters: [{ paramKey: "tradeDate", paramValue: "2026-09-25" }] }] } }] } },
    { title: "reportDate 已声明则不注入；noQueryDate 不进 body", args: { indicatorCodeList: ["is_opr", "div_cash_yr"], securityCodeList: ["600519.SH"], date: "2026-09-25", indicatorParamList: [{ indicatorCode: "is_opr", parameters: [{ paramKey: "reportDate", paramValue: "2025/12/31" }] }, { indicatorCode: "div_cash_yr", parameters: [{ paramKey: "fiscalYear", paramValue: "2025" }], noQueryDate: true }] }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/cross-section", body: { indicatorCodeList: ["is_opr", "div_cash_yr"], universe: ["600519.SH"], indicatorParamList: [{ indicatorCode: "is_opr", parameters: [{ paramKey: "reportDate", paramValue: "2025-12-31" }] }, { indicatorCode: "div_cash_yr", parameters: [{ paramKey: "fiscalYear", paramValue: "2025" }] }] } }] } },
    { title: "同一参数两个取值本地拒绝", args: { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-09-25", indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "2" }] }, { indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "3" }] }] }, expect: { rejects: /两个不同的值/ } },
  ],
  gangtise_indicator_time_series: [
    { title: "未传 calendarType：先免费探指标元数据再取数", args: { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH", "000858.SZ"], startDate: "2026-09-01", endDate: "2026-09-25" }, expect: { requests: [
        { method: "POST", path: "/application/open-indicator/EDE/search", body: { keyword: "qte_close", limit: 100 } },
        { method: "POST", path: "/application/open-indicator/EDE/time-series", body: { indicatorCodeList: ["qte_close"], universe: ["600519.SH", "000858.SZ"], startDate: "2026-09-01", endDate: "2026-09-25", indicatorParamList: [] } },
      ] } },
    { title: "显式 TD 不探针", args: { indicatorCodeList: ["qte_close", "qte_open"], securityCodeList: ["600519.SH"], startDate: "2026-09-01", endDate: "2026-09-25", calendarType: "TD", currency: "USD" }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/time-series", body: { indicatorCodeList: ["qte_close", "qte_open"], universe: ["600519.SH"], startDate: "2026-09-01", endDate: "2026-09-25", calendarType: "TD", currency: "USD", indicatorParamList: [] } }] } },
    { title: "多指标 × 多证券本地拒绝", args: { indicatorCodeList: ["qte_close", "qte_open"], securityCodeList: ["600519.SH", "000858.SZ"], startDate: "2026-09-01", endDate: "2026-09-25" }, expect: { rejects: /不能同时多于 1 个/ } },
  ],
  gangtise_indicator_screener: [
    { title: "按变量注入 tradeDate；证券键名是 universe", args: { indicatorList: [{ field: "F1", indicatorCode: "qte_mkt_cptl", parameters: [{ paramKey: "scale", paramValue: "8" }] }, { field: "F2", indicatorCode: "scr_exchg_sctr", noQueryDate: true }], expression: "F1 >= 500 && F2 contains '创业板'", securityCodeList: ["2000000014"], date: "2026-09-25" }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/screener", body: { universe: ["2000000014"], expression: "F1 >= 500 && F2 contains '创业板'", indicatorList: [{ field: "F1", indicatorCode: "qte_mkt_cptl", parameters: [{ paramKey: "scale", paramValue: "8" }, { paramKey: "tradeDate", paramValue: "2026-09-25" }] }, { field: "F2", indicatorCode: "scr_exchg_sctr", parameters: [] }] } }] } },
    { title: "表达式引用未绑定变量本地拒绝", args: { indicatorList: [{ field: "F1", indicatorCode: "qte_close" }], expression: "F2 > 0", securityCodeList: ["600519.SH"], date: "2026-09-25" }, expect: { rejects: /引用了变量 F2/ } },
  ],
}
