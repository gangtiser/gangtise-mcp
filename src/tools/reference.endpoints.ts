import type { Billing, EndpointTable } from "../core/endpoints.js"

// 计分表未列的参考类接口。不得擅自标 free —— 未确认 ≠ 免费。
const UNPRICED_REFERENCE: Billing = { kind: "unknown", note: "计分表未列此参考类接口，单价未确认" }

// ─── reference ───
export const referenceEndpoints: EndpointTable = {
  "reference.securities-search": {
    method: "POST",
    path: "/application/open-reference/securities/search",
    kind: "json",
    description: "Search GTS codes (securities)",
    billing: UNPRICED_REFERENCE,
    expects: "list",
  },
  "reference.chiefs-search": {
    method: "POST",
    path: "/application/open-reference/chiefs/search",
    kind: "json",
    description: "Search chief analyst IDs by name / institution / team",
    billing: UNPRICED_REFERENCE,
    expects: "list",
  },
  "reference.institution-search": {
    method: "POST",
    path: "/application/open-reference/institutions/search",
    kind: "json",
    description: "Search institution IDs by keyword (domestic broker / foreign / lead / opinion institution)",
    billing: { kind: "free" },
    expects: "list",
  },
  "reference.official-account-search": {
    method: "POST",
    path: "/application/open-reference/officialAccount/search",
    kind: "json",
    description: "Search official account (WeChat public account) IDs by name / institution / category",
    billing: { kind: "free" },
    expects: "list",
  },
  // 免费。按 from / size 分页（其余搜索用 top），搜索词的键是 accountName。
  "reference.overseas-account-search": {
    method: "POST",
    path: "/application/open-reference/overseasAccount/search",
    kind: "json",
    description: "Search overseas opinion account IDs by name fragment",
    billing: { kind: "free" },
    pagination: { mode: "offset", maxPageSize: 50 },
    rowId: "accountId",
    expects: "list",
  },
  "reference.constant-category": {
    method: "GET",
    path: "/application/open-reference/constants/category",
    kind: "json",
    description: "List constant categories and their API usage scopes",
    billing: UNPRICED_REFERENCE,
    expects: "list",
  },
  "reference.constant-list": {
    method: "POST",
    path: "/application/open-reference/constants/getList",
    kind: "json",
    description: "List all constant values of a category",
    billing: UNPRICED_REFERENCE,
    expects: "object",
  },
  "reference.concept-search": {
    method: "POST",
    path: "/application/open-reference/concepts/search",
    kind: "json",
    description: "Search concept (theme) IDs by keyword",
    billing: UNPRICED_REFERENCE,
    expects: "list",
  },
  "reference.sector-search": {
    method: "POST",
    path: "/application/open-reference/sectors/search",
    kind: "json",
    description: "Search sector IDs by keyword",
    billing: UNPRICED_REFERENCE,
    expects: "list",
  },
  "reference.sector-constituents": {
    method: "POST",
    path: "/application/open-reference/sectors/constituents",
    kind: "json",
    description: "List constituent securities of a sector",
    billing: UNPRICED_REFERENCE,
    expects: "list",
  },
  // 在 open-quote 下、平台归在参考数据里。不分页：一次返回所选指数当日的全部成分。
  "reference.index-weight": {
    method: "POST",
    path: "/application/open-quote/index/constituent-weight",
    kind: "json",
    description: "List index constituents with their weights (%) on one trading date",
    billing: { kind: "free" },
    expects: "list",
  },
}
