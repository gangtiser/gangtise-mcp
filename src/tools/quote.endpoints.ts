import type { EndpointTable } from "../core/endpoints.js"

// ─── quote ───
export const quoteEndpoints: EndpointTable = {
  "quote.day-kline": {
    method: "POST",
    path: "/application/open-quote/kline/daily",
    kind: "json",
    description: "Query A-share historical daily kline (SH/SZ/BJ)",
    billing: { kind: "free" },
    expects: "list",
  },
  "quote.day-kline-hk": {
    method: "POST",
    path: "/application/open-quote/kline-hk/daily",
    kind: "json",
    description: "Query HK stock historical daily kline (HK)",
    billing: { kind: "free" },
    expects: "list",
  },
  "quote.day-kline-us": {
    method: "POST",
    path: "/application/open-quote/kline-us/daily",
    kind: "json",
    description: "Query US stock historical daily kline (NYSE/NASDAQ/AMEX)",
    billing: { kind: "free" },
    expects: "list",
  },
  "quote.index-day-kline": {
    method: "POST",
    path: "/application/open-quote/index/kline/daily",
    kind: "json",
    description: "Query SH/SZ/BJ index daily kline",
    billing: { kind: "free" },
    expects: "list",
  },
  "quote.minute-kline": {
    method: "POST",
    path: "/application/open-quote/kline/minute",
    kind: "json",
    description: "Query A-share minute kline (SH/SZ/BJ)",
    billing: { kind: "free" },
    expects: "list",
  },
  "quote.realtime": {
    method: "POST",
    path: "/application/open-quote/quote/realtime",
    kind: "json",
    description: "Query realtime quote snapshot (A-share / HK / US)",
    billing: { kind: "free" },
    expects: "list",
  },
  "quote.fund-flow": {
    method: "POST",
    path: "/application/open-quote/fund-flow/daily",
    kind: "json",
    description: "Query A-share daily fund flow (SH/SZ/BJ; small/medium/large/xlarge orders + main net inflow)",
    billing: { kind: "free" },
    expects: "list",
  },
}
