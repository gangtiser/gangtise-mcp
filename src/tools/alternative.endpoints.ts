import type { EndpointTable } from "../core/endpoints.js"

// ─── alternative ───
export const alternativeEndpoints: EndpointTable = {
  "alternative.edb-search": {
    method: "POST",
    path: "/application/open-alternative/EDB/search",
    kind: "json",
    description: "Search industry indicator list by keyword",
    billing: { kind: "free" },
  },
  "alternative.edb-data": {
    method: "POST",
    path: "/application/open-alternative/EDB/getData",
    kind: "json",
    description: "Get industry indicator time-series data by indicator ID list",
    // 30/指标。不带 amplify：上界 300 = 30 × indicatorIdList 最多 10 个，与日期范围无关。
    billing: { kind: "fixed", per: "row", price: 30, maxUnits: 10, unit: "指标" },
  },
  // 题材两档：v2（50/次）不含催化事件与重点标记，-full 走 v1（500/次）带全。
  "alternative.concept-info": {
    method: "POST",
    path: "/application/open-alternative/concept/v2/info",
    kind: "json",
    description: "Query latest concept (theme index) profile by conceptId (without keyEvents)",
    billing: { kind: "fixed", per: "call", price: 50 },
    retry: "no-replay",
  },
  "alternative.concept-info-full": {
    method: "POST",
    path: "/application/open-alternative/concept/info",
    kind: "json",
    description: "Query latest concept (theme index) profile by conceptId, with keyEvents",
    billing: { kind: "fixed", per: "call", price: 500 },
    retry: "no-replay",
  },
  "alternative.concept-securities": {
    method: "POST",
    path: "/application/open-alternative/concept/v2/securities",
    kind: "json",
    description: "Query concept (theme index) constituent securities, grouped (without isKey / inclusionReason)",
    billing: { kind: "fixed", per: "call", price: 50 },
    retry: "no-replay",
  },
  "alternative.concept-securities-full": {
    method: "POST",
    path: "/application/open-alternative/concept/securities",
    kind: "json",
    description: "Query concept (theme index) constituent securities, grouped, with isKey / inclusionReason",
    billing: { kind: "fixed", per: "call", price: 500 },
    retry: "no-replay",
  },
}
