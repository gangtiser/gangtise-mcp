import type { ToolExamples } from "../mcp/contract.examples.js"

const P = "/application/open-fundamental/bond"

export const bondExamples: ToolExamples = {
  gangtise_bond_basic_info: [
    { title: "重复代码去重后下发", args: { securityList: ["019742.SH", "220205.IB", "019742.SH"], fieldList: ["latestParValue"] }, expect: { requests: [{ method: "POST", path: `${P}/basic-info`, body: { securityList: ["019742.SH", "220205.IB"], fieldList: ["latestParValue"] } }] } },
  ],
  gangtise_bond_daily_quote: [
    { title: "两个日期必填", args: { securityList: ["019742.SH"], startDate: "2026-09-01", endDate: "2026-09-05" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/bond/daily-quote-exchange-cfets", body: { securityList: ["019742.SH"], startDate: "2026-09-01", endDate: "2026-09-05" } }] } },
    { title: "缺 endDate 在 schema 层拒绝", args: { securityList: ["019742.SH"], startDate: "2026-09-01" }, expect: { rejects: /endDate/ } },
  ],
  gangtise_bond_valuation: [
    { title: "confidenceLevel 原样下发", args: { securityList: ["220205.IB"], startDate: "2026-09-01", endDate: "2026-09-05", confidenceLevel: "不推荐" }, expect: { requests: [{ method: "POST", path: `${P}/valuation-shclearing`, body: { securityList: ["220205.IB"], startDate: "2026-09-01", endDate: "2026-09-05", confidenceLevel: "不推荐" } }] } },
  ],
  gangtise_bond_cash_flow: [
    { title: "日期可省", args: { securityList: ["019742.SH"] }, expect: { requests: [{ method: "POST", path: `${P}/cash-flow`, body: { securityList: ["019742.SH"] } }] } },
  ],
  gangtise_bond_rating_overview: [
    { title: "去重后 10 只以内", args: { securityList: ["019742.SH", "019742.SH"] }, expect: { requests: [{ method: "POST", path: `${P}/rating-overview`, body: { securityList: ["019742.SH"] } }] } },
    { title: "去重后超过 10 只本地拒绝", args: { securityList: Array.from({ length: 11 }, (_, i) => `0197${String(i).padStart(2, "0")}.SH`) }, expect: { rejects: /每次最多 10 只/ } },
  ],
  gangtise_bond_announcement_list: [
    { title: "按代码，默认第 1 页 50 条", args: { securityList: ["019742.SH"] }, expect: { requests: [{ method: "POST", path: `${P}/announcement`, body: { pageNo: 1, pageSize: 50, securityList: ["019742.SH"] } }] } },
    { title: "按日期区间翻页", args: { startDate: "2026-09-01", endDate: "2026-09-05", pageNo: 3, pageSize: 200 }, expect: { requests: [{ method: "POST", path: `${P}/announcement`, body: { pageNo: 3, pageSize: 200, startDate: "2026-09-01", endDate: "2026-09-05" } }] } },
    { title: "代码与日期同传本地拒绝", args: { securityList: ["019742.SH"], startDate: "2026-09-01" }, expect: { rejects: /只能传一种/ } },
    { title: "都不传本地拒绝", args: { pageNo: 1 }, expect: { rejects: /其中一种/ } },
    { title: "pageSize 超 200 在 schema 层拒绝", args: { securityList: ["019742.SH"], pageSize: 201 }, expect: { rejects: /pageSize/ } },
  ],
  gangtise_bond_issuer_info: [
    { title: "按发行人名称", args: { issuerNameList: ["贵州茅台"] }, expect: { requests: [{ method: "POST", path: `${P}/issuer-info`, body: { issuerNameList: ["贵州茅台"] } }] } },
    { title: "两种都传本地拒绝", args: { securityList: ["019742.SH"], issuerNameList: ["国开行"] }, expect: { rejects: /只能传一个/ } },
    { title: "都不传本地拒绝", args: {}, expect: { rejects: /其中一个/ } },
  ],
  gangtise_bond_rating_change: [
    { title: "日期筛公告日", args: { securityList: ["123456.SZ"], startDate: "2026-01-01", endDate: "2026-09-01" }, expect: { requests: [{ method: "POST", path: `${P}/rating-change`, body: { securityList: ["123456.SZ"], startDate: "2026-01-01", endDate: "2026-09-01" } }] } },
  ],
  gangtise_bond_issuer_rating_change: [
    { title: "按债券找主体", args: { securityList: ["123456.SZ", "123456.SZ"] }, expect: { requests: [{ method: "POST", path: `${P}/issuer-rating-change`, body: { securityList: ["123456.SZ"] } }] } },
  ],
  gangtise_bond_issuance_detail: [
    { title: "代码 + fieldList", args: { securityList: ["220205.IB"], fieldList: ["issueDate"] }, expect: { requests: [{ method: "POST", path: `${P}/issuance-detail`, body: { securityList: ["220205.IB"], fieldList: ["issueDate"] } }] } },
  ],
  gangtise_bond_issuance_plan: [
    { title: "只收日期", args: { startDate: "2026-09-01", endDate: "2026-09-30" }, expect: { requests: [{ method: "POST", path: `${P}/issuance-plan`, body: { startDate: "2026-09-01", endDate: "2026-09-30" } }] } },
    { title: "不收债券码", args: { startDate: "2026-09-01", endDate: "2026-09-30", securityList: ["019742.SH"] }, expect: { rejects: /Unrecognized key.*securityList/ } },
  ],
  gangtise_bond_exercise_notice: [
    { title: "日期筛行权日", args: { securityList: ["123456.SZ"], startDate: "2026-01-01" }, expect: { requests: [{ method: "POST", path: `${P}/exercise-notice`, body: { securityList: ["123456.SZ"], startDate: "2026-01-01" } }] } },
  ],
}
