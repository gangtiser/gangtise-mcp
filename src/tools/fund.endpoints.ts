import type { EndpointSpec, EndpointTable } from "../core/endpoints.js"

// 整族 0.4 积分/次（与返回行数、基金只数无关），计费 + 可重放会重复扣费，所以全族 no-replay。
// 返回 `{list}`（对象行，无 total、不分页）；代码查不到时是 `{list: []}`。单次超过 10000 行时整批报
// 100006，不返回截断的部分，所以没有截断要标。
function fund(path: string, description: string): EndpointSpec {
  return { method: "POST", path, kind: "json", description, billing: { kind: "fixed", per: "call", price: 0.4 }, retry: "no-replay", expects: "list" }
}
const F = "/application/open-fundamental/fund"

// ─── fund ───
export const fundEndpoints: EndpointTable = {
  "fund.basic-info": fund(`${F}/basic-info`, "Query fund profiles (category, manager, subscription rules, benchmark, tracked index)"),
  "fund.nav": fund("/application/open-quote/fund/nav", "Query fund daily NAV (unit / accumulated / adjusted; money-market yields)"),
  "fund.fee-rate": fund(`${F}/fee-rate`, "Query fund fee rates (purchase / redemption / management / custodian / sales service)"),
  "fund.manager-info": fund(`${F}/manager-info`, "Query fund manager profiles by name (exact match; same-name managers all returned)"),
  "fund.manager-history": fund(`${F}/manager-history`, "Query a fund's past and present managers (tenure + return over tenure)"),
  "fund.asset-allocation": fund(`${F}/asset-allocation`, "Query a fund's asset allocation per report date (equity / bonds / cash ...)"),
  "fund.asset-size": fund(`${F}/asset-size`, "Query a fund's shares, subscriptions / redemptions and net assets per report date"),
  "fund.holder-structure": fund(`${F}/holder-structure`, "Query a fund's holder structure per report date (institutional / individual / employee)"),
  "fund.top10-holders": fund(`${F}/top10-holders`, "Query a listed fund's top 10 holders per report date"),
  "fund.stock-portfolio": fund(`${F}/stock-portfolio`, "Query a fund's stock holdings per report date"),
  "fund.industry-allocation": fund(`${F}/industry-allocation`, "Query a fund's stock holdings grouped by industry (SW / CITIC level 1)"),
  "fund.bond-portfolio": fund(`${F}/bond-portfolio`, "Query a fund's bond holdings per report date"),
  "fund.bond-type-allocation": fund(`${F}/bond-type-allocation`, "Query a fund's bond holdings grouped by bond type"),
  "fund.fund-portfolio": fund(`${F}/fund-portfolio`, "Query a fund-of-funds' holdings of other funds"),
  "fund.fund-type-allocation": fund(`${F}/fund-type-allocation`, "Query a fund-of-funds' holdings grouped by fund category"),
  "fund.etf-pcf-header": fund(`${F}/etf-pcf-header`, "Query ETF creation/redemption parameters (latest trade date)"),
  "fund.etf-pcf-components": fund(`${F}/etf-pcf-components`, "Query the ETF creation/redemption component list (latest trade date)"),
  "fund.etf-share-change": fund(`${F}/etf-share-change`, "Query ETF shares and scale per trade date"),
}
