import type { ContractExample } from "./types.js"
import { oneQuoteRow, paged } from "./upstream.js"

/** 每个工具至少一条：入参 → 发到服务端的 HTTP 请求序列。
 *
 *  这些示例钉的是**请求**（客户真正被计费、真正拿到数据的那一半），与 tests/surface 的
 *  措辞快照互补。优先覆盖有过事故的：财报日历日期键、EDE `universe`、下载参数名、全市场
 *  分片、多证券逐只、分页 from/size、港美股三表 `reportType` 照常下发。 */
export const EXAMPLES: Record<string, ContractExample[]> = {
  // ─── context / local ───
  gangtise_current_date: [
    { title: "本地工具不发请求", args: {}, expect: { requests: [] } },
  ],
  gangtise_lookup: [
    { title: "本地码表不发请求", args: { type: "broker-orgs" }, expect: { requests: [] } },
    { title: "未知 type 本地拒绝", args: { type: "bogus" }, expect: { rejects: /Invalid enum value.*at type/ } },
  ],
  gangtise_read_response: [
    { title: "非本进程临时文件拒读", args: { saved_to: "/etc/hosts" }, expect: { rejects: /gangtise-mcp- temp file/ } },
  ],

  // ─── reference ───
  gangtise_securities_search: [
    { title: "关键词 + 类别", args: { keyword: "贵州茅台", category: ["stock"], top: 5 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/securities/search", body: { keyword: "贵州茅台", category: ["stock"], top: 5 } }] } },
  ],
  gangtise_chiefs_search: [
    { title: "按姓名", args: { keyword: "张三", top: 3 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/chiefs/search", body: { keyword: "张三", top: 3 } }] } },
  ],
  gangtise_institution_search: [
    { title: "按类别", args: { keyword: "中金", categoryList: ["leadInstitution"] }, expect: { requests: [{ method: "POST", path: "/application/open-reference/institutions/search", body: { keyword: "中金", categoryList: ["leadInstitution"] } }] } },
  ],
  gangtise_official_account_search: [
    { title: "按分类", args: { keyword: "中信证券", category: ["broker"], top: 3 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/officialAccount/search", body: { keyword: "中信证券", category: ["broker"], top: 3 } }] } },
  ],
  gangtise_constant_category: [
    { title: "GET 无参", args: {}, expect: { requests: [{ method: "GET", path: "/application/open-reference/constants/category" }] } },
  ],
  gangtise_constant_list: [
    { title: "闭集内的分类", args: { category: "citicIndustry" }, expect: { requests: [{ method: "POST", path: "/application/open-reference/constants/getList", body: { category: "citicIndustry" } }] } },
    { title: "闭集外的分类本地拒绝", args: { category: "fundType" }, expect: { rejects: /Invalid enum value.*at category/ } },
  ],
  gangtise_concept_search: [
    { title: "按拼音首字母", args: { keyword: "jqr", top: 5 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/concepts/search", body: { keyword: "jqr", top: 5 } }] } },
  ],
  gangtise_sector_search: [
    { title: "按关键词", args: { keyword: "白酒", top: 3 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/sectors/search", body: { keyword: "白酒", top: 3 } }] } },
    { title: "缺省关键词浏览顶层", args: {}, expect: { requests: [{ method: "POST", path: "/application/open-reference/sectors/search", body: {} }] } },
  ],
  gangtise_sector_constituents: [
    { title: "申万一级行业指数板块", args: { sectorId: "2000000014" }, expect: { requests: [{ method: "POST", path: "/application/open-reference/sectors/constituents", body: { sectorId: "2000000014" } }] } },
  ],

  // ─── insight lists ───
  gangtise_opinion_list: [
    { title: "默认注入 size=20、from 原样", args: { securityList: ["600519.SH"], rankType: 2 }, expect: { requests: [{ method: "POST", path: "/application/open-insight/chief-opinion/getList", body: { rankType: 2, securityList: ["600519.SH"], size: 20, from: 0 } }] } },
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

  // ─── insight downloads（参数名直接透传为 query，必须等于接口的参数名） ───
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

  // ─── quote ───
  gangtise_day_kline: [
    { title: "单只：钉住 limit=6000", args: { security: "600519.SH", startDate: "2026-09-01", endDate: "2026-09-05", fieldList: ["securityCode", "tradeDate", "close"] }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["600519.SH"], startDate: "2026-09-01", endDate: "2026-09-05", fieldList: ["securityCode", "tradeDate", "close"], limit: 6000 } }] } },
    { title: "多只且单请求装不下（4 只 × 约 1695 个交易日 > 6000）：逐只请求", args: { security: ["600519.SH", "000858.SZ", "00700.HK", "AAPL.O"], startDate: "2020-01-01", endDate: "2026-06-30" }, upstream: oneQuoteRow(), expect: { requests: [
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["000858.SZ"], startDate: "2020-01-01", endDate: "2026-06-30", limit: 6000 } },
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["00700.HK"], startDate: "2020-01-01", endDate: "2026-06-30", limit: 6000 } },
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["600519.SH"], startDate: "2020-01-01", endDate: "2026-06-30", limit: 6000 } },
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["AAPL.O"], startDate: "2020-01-01", endDate: "2026-06-30", limit: 6000 } },
      ] } },
    { title: "多只但装得下：一个请求", args: { security: ["600519.SH", "00700.HK"], startDate: "2026-09-01", endDate: "2026-09-30" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["600519.SH", "00700.HK"], startDate: "2026-09-01", endDate: "2026-09-30", limit: 6000 } }] } },
    { title: "aShares 全市场：1 天/片、跳周末、limit=10000", args: { security: "aShares", startDate: "2026-09-04", endDate: "2026-09-08" }, upstream: oneQuoteRow(), expect: { requests: [
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["aShares"], startDate: "2026-09-04", endDate: "2026-09-04", limit: 10000 } },
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["aShares"], startDate: "2026-09-07", endDate: "2026-09-07", limit: 10000 } },
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["aShares"], startDate: "2026-09-08", endDate: "2026-09-08", limit: 10000 } },
      ] } },
    { title: "hkStocks 全市场：2 天/片，关键字大小写归一", args: { security: "HKSTOCKS", startDate: "2026-09-07", endDate: "2026-09-10" }, upstream: oneQuoteRow(), expect: { requests: [
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["hkStocks"], startDate: "2026-09-07", endDate: "2026-09-08", limit: 10000 } },
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["hkStocks"], startDate: "2026-09-09", endDate: "2026-09-10", limit: 10000 } },
      ] } },
    { title: "全市场关键字与代码混传本地拒绝", args: { security: ["aShares", "600519.SH"], startDate: "2026-09-01", endDate: "2026-09-02" }, expect: { rejects: /全市场关键字必须单独传/ } },
    { title: "all 不是本工具的关键字", args: { security: "all", startDate: "2026-09-01", endDate: "2026-09-02" }, expect: { rejects: /'all' 不是 gangtise_day_kline 的全市场关键字/ } },
  ],
  gangtise_day_kline_hk: [
    { title: "港股代码", args: { security: "00700.HK", startDate: "2026-09-01", endDate: "2026-09-05" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline-hk/daily", body: { securityList: ["00700.HK"], startDate: "2026-09-01", endDate: "2026-09-05", limit: 6000 } }] } },
    { title: "all：2 天/片", args: { security: "all", startDate: "2026-09-07", endDate: "2026-09-10" }, upstream: oneQuoteRow(), expect: { requests: [
        { method: "POST", path: "/application/open-quote/kline-hk/daily", body: { securityList: ["all"], startDate: "2026-09-07", endDate: "2026-09-08", limit: 10000 } },
        { method: "POST", path: "/application/open-quote/kline-hk/daily", body: { securityList: ["all"], startDate: "2026-09-09", endDate: "2026-09-10", limit: 10000 } },
      ] } },
    { title: "美股代码本地拒绝", args: { security: "AAPL.O" }, expect: { rejects: /是美股代码/ } },
  ],
  gangtise_day_kline_us: [
    { title: "美股代码", args: { security: "AAPL.O", startDate: "2026-09-01", endDate: "2026-09-05", limit: 100 }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline-us/daily", body: { securityList: ["AAPL.O"], startDate: "2026-09-01", endDate: "2026-09-05", limit: 100 } }] } },
    { title: "港股代码本地拒绝", args: { security: "00700.HK" }, expect: { rejects: /是港股代码/ } },
  ],
  gangtise_index_day_kline: [
    { title: "单个指数", args: { security: "000001.SH", startDate: "2026-09-01", endDate: "2026-09-05" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/index/kline/daily", body: { securityList: ["000001.SH"], startDate: "2026-09-01", endDate: "2026-09-05", limit: 6000 } }] } },
    { title: "all 本地拒绝（本端点对 all 返回空结果）", args: { security: "all", startDate: "2026-08-01", endDate: "2026-08-31" }, expect: { rejects: /没有全市场关键字/ } },
  ],
  gangtise_minute_kline: [
    { title: "单只：securityCode 标量", args: { security: "600519.SH", startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline/minute", body: { startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 6000, securityCode: "600519.SH" } }] } },
    { title: "多只：逐只请求", args: { security: ["600519.SH", "512800.SH"], startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 500 }, upstream: oneQuoteRow(), expect: { requests: [
        { method: "POST", path: "/application/open-quote/kline/minute", body: { startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 500, securityCode: "512800.SH" } },
        { method: "POST", path: "/application/open-quote/kline/minute", body: { startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 500, securityCode: "600519.SH" } },
      ] } },
  ],
  gangtise_realtime: [
    { title: "混合市场 + fieldList", args: { security: ["600519.SH", "00700.HK", "AAPL.O"], fieldList: ["securityCode", "latestPrice"] }, expect: { requests: [{ method: "POST", path: "/application/open-quote/quote/realtime", body: { securityList: ["600519.SH", "00700.HK", "AAPL.O"], fieldList: ["securityCode", "latestPrice"] } }] } },
    { title: "全市场关键字大小写归一", args: { security: "usstocks" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/quote/realtime", body: { securityList: ["usStocks"] } }] } },
  ],
  gangtise_fund_flow: [
    { title: "单只", args: { security: "600519.SH", startDate: "2026-09-01", endDate: "2026-09-05" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/fund-flow/daily", body: { securityList: ["600519.SH"], startDate: "2026-09-01", endDate: "2026-09-05", limit: 6000 } }] } },
    { title: "aShares 全市场：1 天/片", args: { security: "aShares", startDate: "2026-09-04", endDate: "2026-09-07" }, upstream: oneQuoteRow(), expect: { requests: [
        { method: "POST", path: "/application/open-quote/fund-flow/daily", body: { securityList: ["aShares"], startDate: "2026-09-04", endDate: "2026-09-04", limit: 10000 } },
        { method: "POST", path: "/application/open-quote/fund-flow/daily", body: { securityList: ["aShares"], startDate: "2026-09-07", endDate: "2026-09-07", limit: 10000 } },
      ] } },
    { title: "全市场缺日期本地拒绝", args: { security: "aShares", startDate: "2026-09-04" }, expect: { rejects: /须同时提供 startDate 和 endDate/ } },
    { title: "港股代码本地拒绝", args: { security: "00700.HK" }, expect: { rejects: /仅支持 A 股/ } },
  ],

  // ─── fundamental ───
  gangtise_income_statement: [
    { title: "A 股累计", args: { securityCode: "600519.SH", fiscalYear: [2024, 2025], period: ["annual"], reportType: ["consolidated"], fieldList: ["announcementDate", "opRevenue"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/accumulated", body: { securityCode: "600519.SH", fiscalYear: [2024, 2025], period: ["annual"], reportType: ["consolidated"], fieldList: ["announcementDate", "opRevenue"] } }] } },
    { title: "港股期间 h1 本地拒绝", args: { securityCode: "600519.SH", period: ["h1"] }, expect: { rejects: /at period/ } },
  ],
  gangtise_income_statement_quarterly: [
    { title: "A 股单季", args: { securityCode: "600519.SH", period: ["q2"], startDate: "2024-01-01", endDate: "2025-12-31" }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/quarterly", body: { securityCode: "600519.SH", startDate: "2024-01-01", endDate: "2025-12-31", period: ["q2"] } }] } },
  ],
  gangtise_balance_sheet: [
    { title: "A 股", args: { securityCode: "600519.SH", period: ["interim"], reportType: ["standalone"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/accumulated", body: { securityCode: "600519.SH", period: ["interim"], reportType: ["standalone"] } }] } },
  ],
  gangtise_cash_flow: [
    { title: "A 股累计", args: { securityCode: "600519.SH", fiscalYear: [2025], period: ["q3"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/accumulated", body: { securityCode: "600519.SH", fiscalYear: [2025], period: ["q3"] } }] } },
  ],
  gangtise_cash_flow_quarterly: [
    { title: "A 股单季", args: { securityCode: "600519.SH", period: ["q4", "latest"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/quarterly", body: { securityCode: "600519.SH", period: ["q4", "latest"] } }] } },
  ],
  gangtise_main_business: [
    { title: "按产品", args: { securityCode: "600519.SH", breakdown: "product", periodList: ["annual"], fieldList: ["periodName", "opRevenue"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/main-business", body: { securityCode: "600519.SH", breakdown: "product", periodList: ["annual"], fieldList: ["periodName", "opRevenue"] } }] } },
  ],
  gangtise_top_holders: [
    { title: "前十大股东", args: { securityCode: "600519.SH", holderType: "top10", fiscalYear: [2025], period: ["interim"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/capital-structure/top-holders", body: { securityCode: "600519.SH", holderType: "top10", fiscalYear: [2025], period: ["interim"] } }] } },
  ],
  gangtise_earning_forecast: [
    { title: "一致预期", args: { securityCode: "600519.SH", consensusList: ["eps", "pe"], startDate: "2026-01-01", endDate: "2026-09-01" }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/earning-forecast", body: { securityCode: "600519.SH", startDate: "2026-01-01", endDate: "2026-09-01", consensusList: ["eps", "pe"] } }] } },
  ],
  gangtise_income_statement_hk: [
    { title: "港股：reportType 照常下发", args: { securityCode: "00700.HK", period: ["h1"], reportType: ["consolidatedRestated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/hk", body: { securityCode: "00700.HK", period: ["h1"], reportType: ["consolidatedRestated"] } }] } },
  ],
  gangtise_balance_sheet_hk: [
    { title: "港股", args: { securityCode: "00700.HK", period: ["annual"], reportType: ["consolidated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/hk", body: { securityCode: "00700.HK", period: ["annual"], reportType: ["consolidated"] } }] } },
  ],
  gangtise_cash_flow_hk: [
    { title: "港股", args: { securityCode: "00700.HK", period: ["h2"], fiscalYear: [2025] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/hk", body: { securityCode: "00700.HK", fiscalYear: [2025], period: ["h2"] } }] } },
  ],
  gangtise_income_statement_us: [
    { title: "美股：reportType 照常下发", args: { securityCode: "TSLA.O", period: ["nsd"], reportType: ["standaloneRestated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/us", body: { securityCode: "TSLA.O", period: ["nsd"], reportType: ["standaloneRestated"] } }] } },
  ],
  gangtise_balance_sheet_us: [
    { title: "美股", args: { securityCode: "TSLA.O", period: ["annual"], reportType: ["consolidated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/us", body: { securityCode: "TSLA.O", period: ["annual"], reportType: ["consolidated"] } }] } },
  ],
  gangtise_cash_flow_us: [
    { title: "美股", args: { securityCode: "TSLA.O", period: ["q1"], fieldList: ["announcementDate"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/us", body: { securityCode: "TSLA.O", period: ["q1"], fieldList: ["announcementDate"] } }] } },
  ],
  gangtise_valuation_analysis: [
    { title: "skipNull 不进 body，limit 不传则不发", args: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2021-01-01", endDate: "2026-09-01", skipNull: true }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/valuation-analysis", body: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2021-01-01", endDate: "2026-09-01" } }] } },
    { title: "fieldList 不收 tradeDate", args: { securityCode: "600519.SH", indicator: "pbMrq", fieldList: ["tradeDate", "value"] }, expect: { rejects: /at fieldList/ } },
  ],

  // ─── ai ───
  gangtise_stock_summary: [
    { title: "具体代码批量", args: { securityList: ["600519.SH", "00700.HK"] }, expect: { requests: [{ method: "POST", path: "/application/open-ai/stock-summary/getList", body: { securityList: ["600519.SH", "00700.HK"] } }] } },
    { title: "全市场关键字本地拒绝", args: { securityList: ["aShares"] }, expect: { rejects: /全市场关键字/ } },
  ],
  gangtise_knowledge_batch: [
    { title: "时间转 +08:00 毫秒，秒级补到毫秒", args: { queries: ["AI 算力"], resourceTypes: [10, 60], startTime: "2026-07-01 00:00:00", endTime: 1782921600 }, expect: { requests: [{ method: "POST", path: "/application/open-data/ai/search/knowledge/batch", body: { queries: ["AI 算力"], resourceTypes: [10, 60], startTime: 1782835200000, endTime: 1782921600000 } }] } },
    { title: "纯日期不收", args: { queries: ["AI"], endTime: "2026-07-01" }, expect: { rejects: /at endTime/ } },
  ],
  gangtise_security_clue_list: [
    { title: "按个股", args: { startTime: "2026-09-01 00:00:00", endTime: "2026-09-07 23:59:59", queryMode: "bySecurity", gtsCodeList: ["600519.SH"], source: ["researchReport"] }, expect: { requests: [{ method: "POST", path: "/application/open-ai/security-clue/getList", body: { startTime: "2026-09-01 00:00:00", endTime: "2026-09-07 23:59:59", queryMode: "bySecurity", gtsCodeList: ["600519.SH"], source: ["researchReport"], size: 20, from: 0 } }] } },
  ],
  gangtise_hot_topic: [
    { title: "版别 + 精简开关", args: { startDate: "2026-09-01", endDate: "2026-09-05", categoryList: ["morningBriefing"], withCloseReading: false }, expect: { requests: [{ method: "POST", path: "/application/open-ai/hot-topic/getList", body: { startDate: "2026-09-01", endDate: "2026-09-05", categoryList: ["morningBriefing"], withCloseReading: false, size: 20, from: 0 } }] } },
  ],
  gangtise_management_discuss_announcement: [
    { title: "年报", args: { securityCode: "600519.SH", reportDate: "2025-12-31", discussionDimension: "all" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/management-discuss/from-announcement", body: { securityCode: "600519.SH", reportDate: "2025-12-31", discussionDimension: "all" } }] } },
    { title: "一季报日期本地拒绝", args: { securityCode: "600519.SH", reportDate: "2025-03-31", discussionDimension: "all" }, expect: { rejects: /季末日/ } },
  ],
  gangtise_management_discuss_earnings_call: [
    { title: "三季度", args: { securityCode: "600519.SH", reportDate: "2025-09-30", discussionDimension: "businessOperation" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/management-discuss/from-earningsCall", body: { securityCode: "600519.SH", reportDate: "2025-09-30", discussionDimension: "businessOperation" } }] } },
  ],
  gangtise_theme_tracking: [
    { title: "单个 type 包成数组", args: { themeId: "121000130", date: "2026-09-01", type: "morning" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/theme-tracking", body: { date: "2026-09-01", themeId: "121000130", type: ["morning"] } }] } },
    { title: "未来日期本地拒绝", args: { themeId: "121000130", date: "2099-01-01" }, expect: { rejects: /不能晚于当前日期/ } },
  ],
  gangtise_knowledge_resource_download: [
    { title: "resourceType + sourceId", args: { resourceType: 10, sourceId: "src-1" }, expect: { requests: [{ method: "GET", path: "/application/open-data/ai/resource/download", query: { resourceType: "10", sourceId: "src-1" } }] } },
  ],
  gangtise_one_pager: [
    { title: "securityCode", args: { securityCode: "600519.SH" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/one-pager", body: { securityCode: "600519.SH" } }] } },
  ],
  gangtise_investment_logic: [
    { title: "securityCode", args: { securityCode: "00700.HK" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/investment-logic", body: { securityCode: "00700.HK" } }] } },
  ],
  gangtise_peer_comparison: [
    { title: "securityCode", args: { securityCode: "600519.SH" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/peer-comparison", body: { securityCode: "600519.SH" } }] } },
  ],
  gangtise_research_outline: [
    { title: "securityCode", args: { securityCode: "600519.SH" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/research-outline", body: { securityCode: "600519.SH" } }] } },
  ],
  gangtise_earnings_review: [
    { title: "提交后立即轮询；waitSeconds 不进 body", args: { securityCode: "600519.SH", period: "2025q3", waitSeconds: 5 }, expect: { requests: [
        { method: "POST", path: "/application/open-ai/agent/earnings-review-getcontent", body: { dataId: "mock-data-id" } },
        { method: "POST", path: "/application/open-ai/agent/earnings-review-getid", body: { securityCode: "600519.SH", period: "2025q3" } },
      ] } },
    { title: "waitSeconds=0 只提交不轮询", args: { securityCode: "600519.SH", period: "2025annual", waitSeconds: 0 }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/earnings-review-getid", body: { securityCode: "600519.SH", period: "2025annual" } }] } },
    { title: "报告期格式本地拒绝", args: { securityCode: "600519.SH", period: "2025Q3" }, expect: { rejects: /at period/ } },
  ],
  gangtise_earnings_review_check: [
    { title: "dataId", args: { dataId: "data-1" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/earnings-review-getcontent", body: { dataId: "data-1" } }] } },
  ],
  gangtise_viewpoint_debate: [
    { title: "提交后立即轮询", args: { viewpoint: "白酒行业将在 2027 年触底", waitSeconds: 5 }, expect: { requests: [
        { method: "POST", path: "/application/open-ai/agent/viewpoint-debate-getcontent", body: { dataId: "mock-data-id" } },
        { method: "POST", path: "/application/open-ai/agent/viewpoint-debate-getid", body: { viewpoint: "白酒行业将在 2027 年触底" } },
      ] } },
  ],
  gangtise_viewpoint_debate_check: [
    { title: "dataId", args: { dataId: "data-2" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/viewpoint-debate-getcontent", body: { dataId: "data-2" } }] } },
  ],

  // ─── vault ───
  gangtise_drive_list: [
    { title: "文件类型 + 空间", args: { keyword: "纪要", fileTypeList: [1], spaceTypeList: [2] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/drive/getList", body: { keyword: "纪要", fileTypeList: [1], spaceTypeList: [2], size: 20, from: 0 } }] } },
  ],
  gangtise_record_list: [
    { title: "来源类别", args: { categoryList: ["upload", "pc"], spaceTypeList: [1] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/record/getList", body: { categoryList: ["upload", "pc"], spaceTypeList: [1], size: 20, from: 0 } }] } },
  ],
  gangtise_my_conference_list: [
    { title: "来源 + 类别", args: { sourceList: [1], categoryList: ["earningsCall"] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/my-conference/getList", body: { categoryList: ["earningsCall"], sourceList: [1], size: 20, from: 0 } }] } },
  ],
  gangtise_wechat_message_list: [
    { title: "群 + 标签", args: { wechatGroupIdList: ["g-1"], tagList: ["research"], industryIdList: ["100800119"] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/wechatgroupmsg/list", body: { wechatGroupIdList: ["g-1"], industryIdList: ["100800119"], tagList: ["research"], size: 20, from: 0 } }] } },
  ],
  gangtise_wechat_chatroom_list: [
    { title: "roomName 逗号拼接；省略 size 拉全部", args: { roomName: ["医药", "消费"] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/wechatgroupmsg/chatroomId", body: { roomName: "医药,消费", from: 0, size: 50 } }] } },
  ],
  gangtise_stock_pool_list: [
    { title: "无参", args: {}, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/getPoolList", body: {} }] } },
  ],
  gangtise_stock_pool_stocks: [
    { title: "缺省为 ['all']", args: {}, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/getStockList", body: { poolIdList: ["all"] } }] } },
    { title: "空数组本地拒绝", args: { poolIdList: [] }, expect: { rejects: /不能为空数组/ } },
  ],
  gangtise_drive_download: [
    { title: "fileId", args: { fileId: "file-1" }, expect: { requests: [{ method: "GET", path: "/application/open-vault/drive/download/file", query: { fileId: "file-1" } }] } },
  ],
  gangtise_record_download: [
    { title: "recordId + contentType", args: { recordId: "rec-1", contentType: "asr" }, expect: { requests: [{ method: "GET", path: "/application/open-vault/record/download/file", query: { recordId: "rec-1", contentType: "asr" } }] } },
  ],
  gangtise_my_conference_download: [
    { title: "conferenceId + contentType", args: { conferenceId: "conf-1", contentType: "summary" }, expect: { requests: [{ method: "GET", path: "/application/open-vault/my-conference/download/file", query: { conferenceId: "conf-1", contentType: "summary" } }] } },
    { title: "不支持原始音频", args: { conferenceId: "conf-1", contentType: "original" }, expect: { rejects: /at contentType/ } },
  ],
  gangtise_stock_pool_create: [
    { title: "池名不 trim、原样下发", args: { poolName: " 我的池 " }, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/createPool", body: { poolName: " 我的池 " } }] } },
  ],
  gangtise_stock_pool_rename: [
    { title: "poolId + poolName", args: { poolId: "pool-1", poolName: "新名字" }, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/updatePool", body: { poolId: "pool-1", poolName: "新名字" } }] } },
  ],
  gangtise_stock_pool_add_stock: [
    { title: "poolId + securityCodeList", args: { poolId: "pool-1", securityCodeList: ["600519.SH", "00700.HK"] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/addStock", body: { poolId: "pool-1", securityCodeList: ["600519.SH", "00700.HK"] } }] } },
  ],
  gangtise_stock_pool_remove_stock: [
    { title: "poolId + securityCodeList", args: { poolId: "pool-1", securityCodeList: ["600519.SH"] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/deleteStock", body: { poolId: "pool-1", securityCodeList: ["600519.SH"] } }] } },
  ],
  gangtise_stock_pool_delete: [
    { title: "confirm=true 才下发，confirm 不进 body", args: { poolIdList: ["pool-1"], confirm: true }, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/deletePool", body: { poolIdList: ["pool-1"] } }] } },
    { title: "未确认零请求拒绝", args: { poolIdList: ["pool-1"] }, expect: { rejects: /confirm 置为 true/ } },
  ],

  // ─── alternative ───
  gangtise_edb_search: [
    { title: "关键词 + limit", args: { keyword: "PMI", limit: 10 }, expect: { requests: [{ method: "POST", path: "/application/open-alternative/EDB/search", body: { keyword: "PMI", limit: 10 } }] } },
  ],
  gangtise_edb_data: [
    { title: "指标 + 区间", args: { indicatorIdList: ["edb-1", "edb-2"], startDate: "2025-01-01", endDate: "2026-06-30" }, expect: { requests: [{ method: "POST", path: "/application/open-alternative/EDB/getData", body: { indicatorIdList: ["edb-1", "edb-2"], startDate: "2025-01-01", endDate: "2026-06-30" } }] } },
  ],
  gangtise_concept_info: [
    { title: "conceptId", args: { conceptId: "121000130" }, expect: { requests: [{ method: "POST", path: "/application/open-alternative/concept/info", body: { conceptId: "121000130" } }] } },
  ],
  gangtise_concept_securities: [
    { title: "conceptId", args: { conceptId: "121000130" }, expect: { requests: [{ method: "POST", path: "/application/open-alternative/concept/securities", body: { conceptId: "121000130" } }] } },
  ],

  // ─── indicator (EDE) ───
  gangtise_indicator_search: [
    { title: "关键词 + limit", args: { keyword: "收盘价", limit: 5 }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/search", body: { keyword: "收盘价", limit: 5 } }] } },
  ],
  gangtise_indicator_cross_section: [
    { title: "证券键名是 universe；去重；按指标注入 tradeDate", args: { indicatorCodeList: ["qte_close", "qte_mkt_cptl", "qte_close"], securityCodeList: ["600519.SH", "600519.SH", "00700.HK"], date: "2026-09-25", scale: "8", indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "2" }] }] }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/cross-section", body: { indicatorCodeList: ["qte_close", "qte_mkt_cptl"], universe: ["600519.SH", "00700.HK"], scale: "8", indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "2" }, { paramKey: "tradeDate", paramValue: "2026-09-25" }] }, { indicatorCode: "qte_mkt_cptl", parameters: [{ paramKey: "tradeDate", paramValue: "2026-09-25" }] }] } }] } },
    { title: "reportDate 已声明则不注入；noQueryDate 不进 body", args: { indicatorCodeList: ["is_opr", "div_cash_yr"], securityCodeList: ["600519.SH"], date: "2026-09-25", indicatorParamList: [{ indicatorCode: "is_opr", parameters: [{ paramKey: "reportDate", paramValue: "2025/12/31" }] }, { indicatorCode: "div_cash_yr", parameters: [{ paramKey: "fiscalYear", paramValue: "2025" }], noQueryDate: true }] }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/cross-section", body: { indicatorCodeList: ["is_opr", "div_cash_yr"], universe: ["600519.SH"], indicatorParamList: [{ indicatorCode: "is_opr", parameters: [{ paramKey: "reportDate", paramValue: "2025-12-31" }] }, { indicatorCode: "div_cash_yr", parameters: [{ paramKey: "fiscalYear", paramValue: "2025" }] }] } }] } },
    { title: "同一参数两个取值本地拒绝", args: { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-09-25", indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "2" }] }, { indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "3" }] }] }, expect: { rejects: /两个不同的值/ } },
  ],
  gangtise_indicator_time_series: [
    { title: "未传 calendarType：先免费探指标元数据再取数", args: { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH", "000858.SZ"], startDate: "2026-09-01", endDate: "2026-09-25" }, expect: { requests: [
        { method: "POST", path: "/application/open-indicator/EDE/search", body: { keyword: "qte_close", limit: 100 } },
        { method: "POST", path: "/application/open-indicator/EDE/time-series", body: { indicatorCodeList: ["qte_close"], universe: ["600519.SH", "000858.SZ"], startDate: "2026-09-01", endDate: "2026-09-25", indicatorParamList: [] } },
      ] } },
    { title: "显式 TD 不探针", args: { indicatorCodeList: ["qte_close", "qte_open"], securityCodeList: ["600519.SH"], startDate: "2026-09-01", endDate: "2026-09-25", calendarType: "TD", currency: "USD" }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/EDE/time-series", body: { indicatorCodeList: ["qte_close", "qte_open"], universe: ["600519.SH"], startDate: "2026-09-01", endDate: "2026-09-25", calendarType: "TD", currency: "USD", indicatorParamList: [] } }] } },
    { title: "多指标 × 多证券本地拒绝", args: { indicatorCodeList: ["qte_close", "qte_open"], securityCodeList: ["600519.SH", "000858.SZ"], startDate: "2026-09-01", endDate: "2026-09-25" }, expect: { rejects: /不能同时多于 1 个/ } },
  ],
  gangtise_indicator_screener: [
    { title: "按变量注入 tradeDate；证券键名是 universe", args: { indicatorList: [{ field: "F1", indicatorCode: "qte_mkt_cptl", parameters: [{ paramKey: "scale", paramValue: "8" }] }, { field: "F2", indicatorCode: "scr_exchg_sctr", noQueryDate: true }], expression: "F1 >= 500 && F2 contains '创业板'", securityCodeList: ["2000000014"], date: "2026-09-25" }, expect: { requests: [{ method: "POST", path: "/application/open-indicator/screener", body: { universe: ["2000000014"], expression: "F1 >= 500 && F2 contains '创业板'", indicatorList: [{ field: "F1", indicatorCode: "qte_mkt_cptl", parameters: [{ paramKey: "scale", paramValue: "8" }, { paramKey: "tradeDate", paramValue: "2026-09-25" }] }, { field: "F2", indicatorCode: "scr_exchg_sctr", parameters: [] }] } }] } },
    { title: "表达式引用未绑定变量本地拒绝", args: { indicatorList: [{ field: "F1", indicatorCode: "qte_close" }], expression: "F2 > 0", securityCodeList: ["600519.SH"], date: "2026-09-25" }, expect: { rejects: /引用了变量 F2/ } },
  ],
}
