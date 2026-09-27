import type { Billing, EndpointSpec, EndpointTable } from "../core/endpoints.js"

// 整族计费（多数按次，三个评级端点按条 / 按债券 / 按发行人），计费 + 可重放会重复扣费，所以全族 no-replay。
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
  // 族里唯一分页的端点，且不回 total：走不了按 total 规划的自动翻页；fetchAll 时由 paginate.ts 的
  // requestUntilEmptyPage 逐页取到空页（tools/bond.ts）。
  "bond.announcement": { ...bond("/application/open-fundamental/bond/announcement", "Query bond announcements (pageNo/pageSize, no total)"), pagination: { mode: "page", maxPageSize: 200 } },
  "bond.issuance-detail": bond("/application/open-fundamental/bond/issuance-detail", "Query bond issuance and re-issuance records (bidding, pricing, cover ratios)"),
  // 三个评级端点各 0.4，计量单位不同（与 EDB 按指标数同一写法：per row + unit）：一览按有资料的行（除代码外全
  // null 的行不计），变动按有数据的债券只数（与记录条数无关），主体变动按命中的发行人（响应里去重后的
  // issuerName）。每次最多 10 个单位；被错误码拒绝、130001 都不计费。
  "bond.rating-overview": bond("/application/open-fundamental/bond/rating-overview", "Query bond / issuer / guarantor ratings side by side (max 10 bonds per call)", { kind: "fixed", per: "row", price: 0.4, maxUnits: 10 }),
  "bond.rating-change": bond("/application/open-fundamental/bond/rating-change", "Query bond rating change history (max 10 bonds per call)", { kind: "fixed", per: "row", price: 0.4, maxUnits: 10, unit: "只" }),
  "bond.issuer-rating-change": bond("/application/open-fundamental/bond/issuer-rating-change", "Query issuer rating change history (by bond code or issuer name)", { kind: "fixed", per: "row", price: 0.4, maxUnits: 10, unit: "发行人" }),
  "bond.issuance-plan": bond("/application/open-fundamental/bond/issuance-plan", "Query the rate-bond issuance calendar over a date range"),
  "bond.exercise-notice": bond("/application/open-fundamental/bond/exercise-notice", "Query put/call exercise schedules and results for option-embedded bonds"),
}
