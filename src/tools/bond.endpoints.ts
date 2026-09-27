import type { Billing, EndpointSpec, EndpointTable } from "../core/endpoints.js"

// 整族按次计费（三个按条 / 按债券 / 按发行人计），计费 + 可重放会重复扣费，所以全族 no-replay。
// 列式返回 `{fieldList, list[[…]], total}`，normalizeRows 按列名拍平。没有数据时返回 130001
// （可能带 HTTP 404），收成零行。
const PER_CALL: Billing = { kind: "fixed", per: "call", price: 0.4 }

function bond(path: string, description: string, billing: Billing = PER_CALL): EndpointSpec {
  return { method: "POST", path, kind: "json", description, billing, retry: "no-replay", expects: "list", emptyCodes: ["130001"] }
}

// ─── bond ───
export const bondEndpoints: EndpointTable = {
  "bond.basic-info": bond("/application/open-fundamental/bond/basic-info", "Query bond static profiles (issuance, term, coupon, rating, options)"),
  "bond.issuer-info": bond("/application/open-fundamental/bond/issuer-info", "Query bond issuer profiles (by bond code or issuer name)"),
  "bond.daily-quote": bond("/application/open-quote/bond/daily-quote-exchange-cfets", "Query bond daily close quotes (exchange + CFETS; dirty/clean price, YTM, duration)"),
  "bond.valuation": bond("/application/open-fundamental/bond/valuation-shclearing", "Query Shanghai Clearing House bond valuations (price, yield, risk measures)"),
  "bond.cash-flow": bond("/application/open-fundamental/bond/cash-flow", "Query bond interest payment and redemption schedule"),
  // 族里唯一分页的端点，且不回 total：不能自动翻页，由调用方按页取到空页为止。
  "bond.announcement": { ...bond("/application/open-fundamental/bond/announcement", "Query bond announcements (pageNo/pageSize, no total)"), pagination: { mode: "page", maxPageSize: 200 } },
  "bond.issuance-detail": bond("/application/open-fundamental/bond/issuance-detail", "Query bond issuance and re-issuance records (bidding, pricing, cover ratios)"),
  // 这三个按文档是按返回条数 / 有数据的债券只数 / 发行人计，单价未单列。
  "bond.rating-overview": bond("/application/open-fundamental/bond/rating-overview", "Query bond / issuer / guarantor ratings side by side (max 10 bonds per call)", { kind: "variable", note: "按返回条数计，单价以平台计费为准", basis: "按返回条数" }),
  "bond.rating-change": bond("/application/open-fundamental/bond/rating-change", "Query bond rating change history (max 10 bonds per call)", { kind: "variable", note: "按有数据的债券只数计，单价以平台计费为准", basis: "按债券只数" }),
  "bond.issuer-rating-change": bond("/application/open-fundamental/bond/issuer-rating-change", "Query issuer rating change history (by bond code or issuer name)", { kind: "variable", note: "按发行人计，单价以平台计费为准", basis: "按发行人数" }),
  "bond.issuance-plan": bond("/application/open-fundamental/bond/issuance-plan", "Query the rate-bond issuance calendar over a date range"),
  "bond.exercise-notice": bond("/application/open-fundamental/bond/exercise-notice", "Query put/call exercise schedules and results for option-embedded bonds"),
}
