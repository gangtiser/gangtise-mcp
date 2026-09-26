import type { ToolExamples } from "../mcp/contract.examples.js"
import { paged } from "../mcp/contract.examples.js"

export const insightExamples: ToolExamples = {
  gangtise_opinion_list: [
    { title: "默认注入 size=20、from 原样", args: { securityList: ["600519.SH"], rankType: 2 }, expect: { requests: [{ method: "POST", path: "/application/open-insight/chief-opinion/getList", body: { rankType: 2, securityList: ["600519.SH"], size: 20, from: 0 } }] } },
    { title: "withContent=false 走只回 brief 的端点，开关不进 body", args: { securityList: ["600519.SH"], withContent: false }, expect: { requests: [{ method: "POST", path: "/application/open-insight/chief-opinion/v2/getList", body: { securityList: ["600519.SH"], size: 20, from: 0 } }] } },
    { title: "withContent=true 与缺省同端点", args: { securityList: ["600519.SH"], withContent: true }, expect: { requests: [{ method: "POST", path: "/application/open-insight/chief-opinion/getList", body: { securityList: ["600519.SH"], size: 20, from: 0 } }] } },
    { title: "显式 size 与 from", args: { keyword: "机器人", from: 40, size: 5, llmTagList: ["strongRcmd"], sourceList: ["realTime"] }, expect: { requests: [{ method: "POST", path: "/application/open-insight/chief-opinion/getList", body: { from: 40, keyword: "机器人", llmTagList: ["strongRcmd"], sourceList: ["realTime"], size: 5 } }] } },
  ],
  gangtise_summary_list: [
    { title: "sourceList 发数字", args: { securityList: ["600519.SH"], categoryList: ["earningsCall"], searchType: 2, sourceList: [1], marketList: ["aShares"] }, expect: { requests: [{ method: "POST", path: "/application/open-insight/summary/v2/getList", body: { searchType: 2, securityList: ["600519.SH"], categoryList: ["earningsCall"], marketList: ["aShares"], sourceList: [1], size: 20, from: 0 } }] } },
  ],
  gangtise_pamirs_summary_list: [
    { title: "行业码 + 类别", args: { researchAreaList: ["100800119"], categoryList: ["companyAnalysis"] }, expect: { requests: [{ method: "POST", path: "/application/open-insight/pamirs-summary/getList", body: { researchAreaList: ["100800119"], categoryList: ["companyAnalysis"], size: 20, from: 0 } }] } },
    { title: "summary 独有的 sourceList 被 strict 拒绝", args: { sourceList: [1] }, expect: { rejects: /Unrecognized key.*sourceList/ } },
  ],
  gangtise_roadshow_list: [
    { title: "时间窗 + 市场 + 权限", args: { startTime: "2026-09-01 00:00:00", endTime: "2026-09-07 23:59:59", marketList: ["aShares"], permission: [1], brokerTypeList: ["cnBroker"] }, expect: { requests: [{ method: "POST", path: "/application/open-insight/schedule/roadshow/getList", body: { startTime: "2026-09-01 00:00:00", endTime: "2026-09-07 23:59:59", marketList: ["aShares"], brokerTypeList: ["cnBroker"], permission: [1], size: 20, from: 0 } }] } },
  ],
  gangtise_site_visit_list: [
    { title: "调研对象 + 形式", args: { objectList: ["company"], categoryList: ["single"], marketList: ["hkStocks"] }, expect: { requests: [{ method: "POST", path: "/application/open-insight/schedule/site-visit/getList", body: { objectList: ["company"], categoryList: ["single"], marketList: ["hkStocks"], size: 20, from: 0 } }] } },
  ],
  gangtise_strategy_list: [
    { title: "机构 + 地点", args: { institutionList: ["inst-1"], locationList: ["loc-1"] }, expect: { requests: [{ method: "POST", path: "/application/open-insight/schedule/strategy-meeting/getList", body: { institutionList: ["inst-1"], locationList: ["loc-1"], size: 20, from: 0 } }] } },
    { title: "本端点不收 researchAreaList", args: { researchAreaList: ["100800119"] }, expect: { rejects: /Unrecognized key.*researchAreaList/ } },
  ],
  gangtise_forum_list: [
    { title: "方向码", args: { researchAreaList: ["122000001"], keyword: "新能源" }, expect: { requests: [{ method: "POST", path: "/application/open-insight/schedule/forum/getList", body: { keyword: "新能源", researchAreaList: ["122000001"], size: 20, from: 0 } }] } },
  ],
  gangtise_research_list: [
    { title: "筛选项原样下发", args: { ratingList: ["buy"], ratingChangeList: ["upgrade"], minReportPages: 10, sourceList: ["1"], categoryList: ["company"] }, expect: { requests: [{ method: "POST", path: "/application/open-insight/broker-report/getList", body: { categoryList: ["company"], ratingList: ["buy"], ratingChangeList: ["upgrade"], minReportPages: 10, sourceList: ["1"], size: 20, from: 0 } }] } },
    { title: "size 大于单页：首页串行、其余按 50 一页扇出", args: { keyword: "AI", size: 120 }, upstream: paged(300), expect: { requests: [
        { method: "POST", path: "/application/open-insight/broker-report/getList", body: { keyword: "AI", size: 20, from: 100 } },
        { method: "POST", path: "/application/open-insight/broker-report/getList", body: { keyword: "AI", size: 50, from: 0 } },
        { method: "POST", path: "/application/open-insight/broker-report/getList", body: { keyword: "AI", size: 50, from: 50 } },
      ] } },
    { title: "fetchAll 拉到 total 为止，不带 size", args: { keyword: "AI", fetchAll: true }, upstream: paged(75), expect: { requests: [
        { method: "POST", path: "/application/open-insight/broker-report/getList", body: { keyword: "AI", from: 0, size: 50 } },
        { method: "POST", path: "/application/open-insight/broker-report/getList", body: { keyword: "AI", from: 50, size: 25 } },
        { method: "POST", path: "/application/open-insight/broker-report/getList", body: { keyword: "AI", from: 75, size: 1 } },
      ] } },
    { title: "短页覆盖到 total 时探一行 from=total", args: { keyword: "AI", size: 20 }, upstream: paged(7), expect: { requests: [
        { method: "POST", path: "/application/open-insight/broker-report/getList", body: { keyword: "AI", size: 1, from: 7 } },
        { method: "POST", path: "/application/open-insight/broker-report/getList", body: { keyword: "AI", size: 20, from: 0 } },
      ] } },
    { title: "负页数本地拒绝", args: { minReportPages: -1 }, expect: { rejects: /at minReportPages/ } },
  ],
  gangtise_foreign_report_list: [
    { title: "地区闭集", args: { regionList: ["cnHk"], categoryList: ["company"], searchType: 1 }, expect: { requests: [{ method: "POST", path: "/application/open-insight/foreign-report/getList", body: { searchType: 1, regionList: ["cnHk"], categoryList: ["company"], size: 20, from: 0 } }] } },
    { title: "码表外的地区本地拒绝", args: { regionList: ["hk"] }, expect: { rejects: /Invalid enum value.*at regionList/ } },
  ],
  gangtise_announcement_list: [
    { title: "A 股公告", args: { securityList: ["600519.SH"], categoryList: ["cat-1"], startTime: "2026-01-01 00:00:00", endTime: "2026-06-30 23:59:59" }, expect: { requests: [{ method: "POST", path: "/application/open-insight/announcement/getList", body: { startTime: "2026-01-01 00:00:00", endTime: "2026-06-30 23:59:59", securityList: ["600519.SH"], categoryList: ["cat-1"], size: 20, from: 0 } }] } },
  ],
  gangtise_announcement_hk_list: [
    { title: "港股公告", args: { securityList: ["00700.HK"], keyword: "业绩" }, expect: { requests: [{ method: "POST", path: "/application/open-insight/announcement-hk/getList", body: { keyword: "业绩", securityList: ["00700.HK"], size: 20, from: 0 } }] } },
  ],
  gangtise_announcement_us_list: [
    { title: "美股公告", args: { securityList: ["TSLA.O"], rankType: 2 }, expect: { requests: [{ method: "POST", path: "/application/open-insight/announcement-us/getList", body: { rankType: 2, securityList: ["TSLA.O"], size: 20, from: 0 } }] } },
  ],
  gangtise_foreign_opinion_list: [
    { title: "申万码 + 外资观点机构", args: { industryList: ["104340000"], brokerList: ["F-1"], regionList: ["us"] }, expect: { requests: [{ method: "POST", path: "/application/open-insight/foreign-opinion/getList", body: { regionList: ["us"], industryList: ["104340000"], brokerList: ["F-1"], size: 20, from: 0 } }] } },
    { title: "withContent=false 走只回 brief 的端点", args: { securityList: ["AAPL.O"], withContent: false }, expect: { requests: [{ method: "POST", path: "/application/open-insight/foreign-opinion/v2/getList", body: { securityList: ["AAPL.O"], size: 20, from: 0 } }] } },
  ],
  gangtise_independent_opinion_list: [
    { title: "评级变动", args: { ratingChangeList: ["upgrade"], securityList: ["AAPL.O"] }, expect: { requests: [{ method: "POST", path: "/application/open-insight/independent-opinion/getList", body: { securityList: ["AAPL.O"], ratingChangeList: ["upgrade"], size: 20, from: 0 } }] } },
  ],
  gangtise_official_account_list: [
    { title: "公众号 + 文章类型", args: { accountIdList: ["acc-1"], categoryList: ["news"], searchType: 1 }, expect: { requests: [{ method: "POST", path: "/application/open-insight/officialAccount/getList", body: { searchType: 1, accountIdList: ["acc-1"], categoryList: ["news"], size: 20, from: 0 } }] } },
  ],
  gangtise_qa_list: [
    { title: "日期与日期时间都原样直传", args: { securityCode: "601012.SH", startTime: "2026-01-01", endTime: "2026-06-30 23:59:59", source: ["interactive"], answerImportant: [1] }, expect: { requests: [{ method: "POST", path: "/application/open-insight/Q&A-data/getList", body: { securityCode: "601012.SH", startTime: "2026-01-01", endTime: "2026-06-30 23:59:59", source: ["interactive"], answerImportant: [1], size: 20, from: 0 } }] } },
  ],
  gangtise_report_image_list: [
    { title: "非分页，不注入 size", args: { keyword: "AI", top: 5, startTime: "2026-01-01 00:00:00" }, expect: { requests: [{ method: "POST", path: "/application/open-insight/report-image/getList", body: { keyword: "AI", top: 5, startTime: "2026-01-01 00:00:00" } }] } },
  ],
  gangtise_summary_download: [
    { title: "summaryId + fileType", args: { summaryId: "sum-1", fileType: 2 }, expect: { requests: [{ method: "GET", path: "/application/open-insight/summary/v2/download/file", query: { summaryId: "sum-1", fileType: "2" } }] } },
  ],
  gangtise_pamirs_summary_download: [
    { title: "summaryId", args: { summaryId: "pam-1" }, expect: { requests: [{ method: "GET", path: "/application/open-insight/pamirs-summary/download/file", query: { summaryId: "pam-1" } }] } },
  ],
  gangtise_research_download: [
    { title: "reportId + fileType", args: { reportId: "rep-1", fileType: 2 }, expect: { requests: [{ method: "GET", path: "/application/open-insight/broker-report/download/file", query: { reportId: "rep-1", fileType: "2" } }] } },
  ],
  gangtise_foreign_report_download: [
    { title: "中文 Markdown", args: { reportId: "frep-1", fileType: 4 }, expect: { requests: [{ method: "GET", path: "/application/open-insight/foreign-report/download/file", query: { reportId: "frep-1", fileType: "4" } }] } },
    { title: "fileType 闭集外本地拒绝", args: { reportId: "frep-1", fileType: 5 }, expect: { rejects: /at fileType/ } },
  ],
  gangtise_announcement_download: [
    { title: "announcementId", args: { announcementId: "ann-1", fileType: 2 }, expect: { requests: [{ method: "GET", path: "/application/open-insight/announcement/download/file", query: { announcementId: "ann-1", fileType: "2" } }] } },
  ],
  gangtise_announcement_hk_download: [
    { title: "announcementId", args: { announcementId: "annhk-1" }, expect: { requests: [{ method: "GET", path: "/application/open-insight/announcement-hk/download/file", query: { announcementId: "annhk-1" } }] } },
  ],
  gangtise_announcement_us_download: [
    { title: "announcementId", args: { announcementId: "annus-1", fileType: 1 }, expect: { requests: [{ method: "GET", path: "/application/open-insight/announcement-us/download/file", query: { announcementId: "annus-1", fileType: "1" } }] } },
  ],
  gangtise_independent_opinion_download: [
    { title: "参数名是 independentOpinionId", args: { independentOpinionId: "io-1", fileType: 2 }, expect: { requests: [{ method: "GET", path: "/application/open-insight/independent-opinion/download/file", query: { independentOpinionId: "io-1", fileType: "2" } }] } },
    { title: "fileType 必填", args: { independentOpinionId: "io-1" }, expect: { rejects: /at fileType/ } },
  ],
  gangtise_official_account_download: [
    { title: "articleId", args: { articleId: "art-1", fileType: 2 }, expect: { requests: [{ method: "GET", path: "/application/open-insight/officialAccount/download/file", query: { articleId: "art-1", fileType: "2" } }] } },
  ],
  gangtise_report_image_download: [
    { title: "chunkId", args: { chunkId: "chunk-1" }, expect: { requests: [{ method: "GET", path: "/application/open-insight/report-image/download/file", query: { chunkId: "chunk-1" } }] } },
  ],
  gangtise_performance_calendar_download: [
    { title: "performanceReportId", args: { performanceReportId: "perf-1" }, expect: { requests: [{ method: "GET", path: "/application/open-insight/schedule/performance-calendar/download/file", query: { performanceReportId: "perf-1" } }] } },
  ],
  gangtise_opinion_detail: [
    { title: "内资：按 20 个一批串行、重复 ID 只取一次", args: { kind: "domestic", ids: Array.from({ length: 21 }, (_, i) => `co-${i}`).concat(["co-0"]) }, upstream: (req) => (req.endpoint === "insight.opinion.detail" ? { data: [] } : undefined), expect: { requests: [
        { method: "POST", path: "/application/open-insight/chief-opinion/getDetail", body: { chiefOpinionIdList: Array.from({ length: 20 }, (_, i) => `co-${i}`) } },
        { method: "POST", path: "/application/open-insight/chief-opinion/getDetail", body: { chiefOpinionIdList: ["co-20"] } },
      ] } },
    { title: "外资：ID 列表键是 foreignOpinionIdList", args: { kind: "foreign", ids: ["fo-1"] }, upstream: (req) => (req.endpoint === "insight.foreign-opinion.detail" ? { data: [] } : undefined), expect: { requests: [{ method: "POST", path: "/application/open-insight/foreign-opinion/getDetail", body: { foreignOpinionIdList: ["fo-1"] } }] } },
    { title: "第一批就有不是对象的元素时整次报错", args: { kind: "domestic", ids: ["co-1"] }, upstream: (req) => (req.endpoint === "insight.opinion.detail" ? { data: [null] } : undefined), expect: { rejects: /不是对象的元素/, requests: [{ method: "POST", path: "/application/open-insight/chief-opinion/getDetail", body: { chiefOpinionIdList: ["co-1"] } }] } },
    { title: "返回不是数组时整次报错（第一批）", args: { kind: "domestic", ids: ["co-1"] }, upstream: (req) => (req.endpoint === "insight.opinion.detail" ? { data: { list: [] } } : undefined), expect: { rejects: /不是预期的数组结构/, requests: [{ method: "POST", path: "/application/open-insight/chief-opinion/getDetail", body: { chiefOpinionIdList: ["co-1"] } }] } },
  ],
  gangtise_performance_calendar_list: [
    { title: "日期键是 startDate/endDate", args: { startDate: "2026-07-20", endDate: "2026-07-26", categoryList: ["performanceForecast"] }, expect: { requests: [{ method: "POST", path: "/application/open-insight/schedule/performance-calendar/getList", body: { startDate: "2026-07-20", endDate: "2026-07-26", categoryList: ["performanceForecast"], size: 20, from: 0 } }] } },
    { title: "旧键 startTime 被 strict 拒绝", args: { startTime: "2026-07-20" }, expect: { rejects: /Unrecognized key.*startTime/ } },
    { title: "无强约束 fetchAll 本地拒绝", args: { marketList: ["aShares"], fetchAll: true }, expect: { rejects: /缺少强约束/ } },
    { title: "仅 securityList + fetchAll 放行（1000 行封顶由响应 fixture 覆盖）", args: { securityList: ["600519.SH"], fetchAll: true }, expect: { requests: [{ method: "POST", path: "/application/open-insight/schedule/performance-calendar/getList", body: { securityList: ["600519.SH"], size: 50, from: 0 } }] } },
    { title: "仅日期区间 + fetchAll 先探 total 再取", args: { startDate: "2026-07-20", endDate: "2026-07-26", fetchAll: true }, expect: { requests: [
        { method: "POST", path: "/application/open-insight/schedule/performance-calendar/getList", body: { startDate: "2026-07-20", endDate: "2026-07-26", from: 0, size: 1 } },
        { method: "POST", path: "/application/open-insight/schedule/performance-calendar/getList", body: { startDate: "2026-07-20", endDate: "2026-07-26", from: 0, size: 50 } },
      ] } },
  ],
}
