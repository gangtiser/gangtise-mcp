import type { EndpointTable } from "../core/endpoints.js"

// EDE 按单元格计价，计分表只写「详见文档」，所以归 variable、不写死单价。
const EDE_CELL = {
  kind: "variable",
  note: "按单元格计价，单价见 gangtise CLI indicator.md（A股 0.05 / 港股 0.1 / 美股 0.2 每 100 单元格）",
} as const

// ─── indicator (EDE: security-level data indicators) ───
// 单层信封：成功时 `data` 就是载荷（search 是数组，三个取数端点是矩阵对象，查不到时各轴为空数组），失败一律走
// HTTP 4xx 的外层信封。矩阵端点声明 expects: "object"，`data: null` 在 HTTP 层就报错、带得上 traceId。
export const indicatorEndpoints: EndpointTable = {
  "indicator.search": {
    method: "POST",
    path: "/application/open-indicator/EDE/search",
    kind: "json",
    description: "Search data indicators by keyword (returns indicatorCode + params)",
    billing: { kind: "free" },
    retry: "no-999999",
    expects: "array",
  },
  "indicator.cross-section": {
    method: "POST",
    path: "/application/open-indicator/EDE/cross-section",
    kind: "json",
    description: "Get cross-section data (multi-indicator x multi-security, single date)",
    billing: { ...EDE_CELL, amplify: "按单元格计价，指标数×证券数×日期数即放大倍数，单次上限 3 万单元格（服务端硬限，超出报 100006 且不返回部分结果）" },
    retry: "no-999999",
    expects: "object",
  },
  "indicator.time-series": {
    method: "POST",
    path: "/application/open-indicator/EDE/time-series",
    kind: "json",
    description: "Get time-series data (multi-indicator x single-security OR single-indicator x multi-security)",
    billing: { ...EDE_CELL, amplify: "按单元格计价，指标数×证券数×日期数即放大倍数，单次上限 3 万单元格（服务端硬限，超出报 100006 且不返回部分结果）" },
    retry: "no-999999",
    expects: "object",
  },
  // Note the path: the screener sits directly under open-indicator, NOT under
  // the EDE/ prefix its three siblings share.
  "indicator.screener": {
    method: "POST",
    path: "/application/open-indicator/screener",
    kind: "json",
    description: "Screen securities by an expression over indicator values (条件选股)",
    // 放大倍数由 universe 展开后的证券数决定：一个板块 ID 会被服务端展开成全部成分股，
    // 请求里看不出来——不写进 amplify，模型会按自己传的 1 个 ID 估成本。
    billing: { ...EDE_CELL, amplify: "按单元格计价，指标数×证券数即放大倍数，单次上限 10 万单元格；板块 ID 由服务端展开成全部成分股，实际证券数可远大于传入条数" },
    retry: "no-999999",
    expects: "object",
  },
}
