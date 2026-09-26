import type { EndpointTable } from "../core/endpoints.js"

// ─── fundamental ───
export const fundamentalEndpoints: EndpointTable = {
  "fundamental.income-statement": {
    method: "POST",
    path: "/application/open-fundamental/financial-report/income-statement/accumulated",
    kind: "json",
    description: "Query income statement (accumulated)",
    billing: { kind: "free" },
  },
  "fundamental.income-statement-quarterly": {
    method: "POST",
    path: "/application/open-fundamental/financial-report/income-statement/quarterly",
    kind: "json",
    description: "Query income statement (quarterly)",
    billing: { kind: "free" },
  },
  "fundamental.balance-sheet": {
    method: "POST",
    path: "/application/open-fundamental/financial-report/balance-sheet/accumulated",
    kind: "json",
    description: "Query balance sheet (accumulated)",
    billing: { kind: "free" },
  },
  "fundamental.cash-flow": {
    method: "POST",
    path: "/application/open-fundamental/financial-report/cash-flow-statement/accumulated",
    kind: "json",
    description: "Query cash flow statement (accumulated)",
    billing: { kind: "free" },
  },
  "fundamental.cash-flow-quarterly": {
    method: "POST",
    path: "/application/open-fundamental/financial-report/cash-flow-statement/quarterly",
    kind: "json",
    description: "Query cash flow statement (quarterly)",
    billing: { kind: "free" },
  },
  "fundamental.main-business": {
    method: "POST",
    path: "/application/open-fundamental/main-business",
    kind: "json",
    description: "Query main business composition",
    billing: { kind: "free" },
  },
  "fundamental.valuation-analysis": {
    method: "POST",
    path: "/application/open-fundamental/valuation-analysis",
    kind: "json",
    description: "Query valuation analysis",
    billing: { kind: "free" },
  },
  "fundamental.top-holders": {
    method: "POST",
    path: "/application/open-fundamental/capital-structure/top-holders",
    kind: "json",
    description: "Query top holders (top10 / top10 float)",
    billing: { kind: "free" },
  },
  "fundamental.earning-forecast": {
    method: "POST",
    path: "/application/open-fundamental/earning-forecast",
    kind: "json",
    description: "Query earning forecast (consensus estimates)",
    billing: { kind: "fixed", per: "row", price: 0.5, maxUnits: Number.POSITIVE_INFINITY },
    // 按行计费（0.5/条），行数随日期区间增长：每个工作日一个日期 × 三个预测年度，区间上限只受
    // 账号的取数窗口约束。单次调用可以远超几千积分，而客户端给不出可靠的行数上界，所以不重放。
    retry: "no-replay",
  },
  "fundamental.income-statement-hk": {
    method: "POST",
    path: "/application/open-fundamental/financial-report/income-statement/hk",
    kind: "json",
    description: "Query HK income statement (China GAAP)",
    billing: { kind: "free" },
  },
  "fundamental.balance-sheet-hk": {
    method: "POST",
    path: "/application/open-fundamental/financial-report/balance-sheet/hk",
    kind: "json",
    description: "Query HK balance sheet (China GAAP)",
    billing: { kind: "free" },
  },
  "fundamental.cash-flow-hk": {
    method: "POST",
    path: "/application/open-fundamental/financial-report/cash-flow-statement/hk",
    kind: "json",
    description: "Query HK cash flow statement (China GAAP)",
    billing: { kind: "free" },
  },
  "fundamental.income-statement-us": {
    method: "POST",
    path: "/application/open-fundamental/financial-report/income-statement/us",
    kind: "json",
    description: "Query US income statement",
    billing: { kind: "free" },
  },
  "fundamental.balance-sheet-us": {
    method: "POST",
    path: "/application/open-fundamental/financial-report/balance-sheet/us",
    kind: "json",
    description: "Query US balance sheet",
    billing: { kind: "free" },
  },
  "fundamental.cash-flow-us": {
    method: "POST",
    path: "/application/open-fundamental/financial-report/cash-flow-statement/us",
    kind: "json",
    description: "Query US cash flow statement",
    billing: { kind: "free" },
  },
}
