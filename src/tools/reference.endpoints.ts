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
  },
  "reference.chiefs-search": {
    method: "POST",
    path: "/application/open-reference/chiefs/search",
    kind: "json",
    description: "Search chief analyst IDs by name / institution / team",
    billing: UNPRICED_REFERENCE,
  },
  "reference.institution-search": {
    method: "POST",
    path: "/application/open-reference/institutions/search",
    kind: "json",
    description: "Search institution IDs by keyword (domestic broker / foreign / lead / opinion institution)",
    billing: { kind: "free" },
  },
  "reference.official-account-search": {
    method: "POST",
    path: "/application/open-reference/officialAccount/search",
    kind: "json",
    description: "Search official account (WeChat public account) IDs by name / institution / category",
    billing: { kind: "free" },
  },
  "reference.constant-category": {
    method: "GET",
    path: "/application/open-reference/constants/category",
    kind: "json",
    description: "List constant categories and their API usage scopes",
    billing: UNPRICED_REFERENCE,
  },
  "reference.constant-list": {
    method: "POST",
    path: "/application/open-reference/constants/getList",
    kind: "json",
    description: "List all constant values of a category",
    billing: UNPRICED_REFERENCE,
  },
  "reference.concept-search": {
    method: "POST",
    path: "/application/open-reference/concepts/search",
    kind: "json",
    description: "Search concept (theme) IDs by keyword",
    billing: UNPRICED_REFERENCE,
  },
  "reference.sector-search": {
    method: "POST",
    path: "/application/open-reference/sectors/search",
    kind: "json",
    description: "Search sector IDs by keyword",
    billing: UNPRICED_REFERENCE,
  },
  "reference.sector-constituents": {
    method: "POST",
    path: "/application/open-reference/sectors/constituents",
    kind: "json",
    description: "List constituent securities of a sector",
    billing: UNPRICED_REFERENCE,
  },
}
