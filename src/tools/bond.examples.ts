import type { ExampleResponder, ToolExamples } from "../mcp/contract.examples.js"

const P = "/application/open-fundamental/bond"
const codes = (n: number) => Array.from({ length: n }, (_, i) => `1${String(i).padStart(5, "0")}.SZ`)
const ANNOUNCEMENT_FIELDS = ["announcementDate", "securityCode", "title"]
/** 债券公告按 pageNo 回 rows[pageNo - 1] 行，之后是空页。 */
const announcementPages = (rows: number[]): ExampleResponder => (req) => {
  if (req.endpoint !== "bond.announcement") return undefined
  const pageNo = (req.body as { pageNo: number }).pageNo
  return { data: { fieldList: ANNOUNCEMENT_FIELDS, list: Array.from({ length: rows[pageNo - 1] ?? 0 }, (_, i) => ["2026-09-01", "019742", `公告 ${pageNo}-${i}`]) } }
}

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
    {
      title: "超过 10 只按 10 只一批，fieldList 没点 securityCode 时补在最前",
      args: { securityList: codes(12), fieldList: ["bondRating"] },
      expect: {
        requests: [
          { method: "POST", path: `${P}/rating-overview`, body: { securityList: codes(10), fieldList: ["securityCode", "bondRating"] } },
          { method: "POST", path: `${P}/rating-overview`, body: { securityList: codes(12).slice(10), fieldList: ["securityCode", "bondRating"] } },
        ],
      },
    },
    { title: "去重后超过 1800 只本地拒绝", args: { securityList: codes(1801) }, expect: { rejects: /每次最多 1800 只/ } },
  ],
  gangtise_bond_announcement_list: [
    { title: "按代码，默认第 1 页 50 条", args: { securityList: ["019742.SH"] }, expect: { requests: [{ method: "POST", path: `${P}/announcement`, body: { pageNo: 1, pageSize: 50, securityList: ["019742.SH"] } }] } },
    { title: "按日期区间翻页", args: { startDate: "2026-09-01", endDate: "2026-09-05", pageNo: 3, pageSize: 200 }, expect: { requests: [{ method: "POST", path: `${P}/announcement`, body: { pageNo: 3, pageSize: 200, startDate: "2026-09-01", endDate: "2026-09-05" } }] } },
    { title: "fetchAll 缺省 pageSize 200，起始页为空即止", args: { securityList: ["019742.SH"], fetchAll: true }, expect: { requests: [{ method: "POST", path: `${P}/announcement`, body: { pageNo: 1, pageSize: 200, securityList: ["019742.SH"] } }] } },
    {
      title: "fetchAll 满页时下一轮加倍，见到不满的页逐页确认到空页",
      args: { startDate: "2026-09-01", endDate: "2026-09-05", pageSize: 2, fetchAll: true },
      upstream: announcementPages([2, 2, 1]),
      expect: { requests: [1, 2, 3, 4].map((pageNo) => ({ method: "POST" as const, path: `${P}/announcement`, body: { pageNo, pageSize: 2, startDate: "2026-09-01", endDate: "2026-09-05" } })) },
    },
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
    {
      title: "超过 10 只按 10 只一批，securityCode 恒在最前、fieldList 不补",
      args: { securityList: codes(11), fieldList: ["previousRating"] },
      expect: {
        requests: [
          { method: "POST", path: `${P}/rating-change`, body: { securityList: codes(10), fieldList: ["previousRating"] } },
          { method: "POST", path: `${P}/rating-change`, body: { securityList: codes(11).slice(10), fieldList: ["previousRating"] } },
        ],
      },
    },
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
