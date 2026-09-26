import type { ToolExamples } from "../mcp/contract.examples.js"

export const aiExamples: ToolExamples = {
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
  gangtise_knowledge_resource_download: [
    { title: "resourceType + sourceId", args: { resourceType: 10, sourceId: "src-1" }, expect: { requests: [{ method: "GET", path: "/application/open-data/ai/resource/download", query: { resourceType: "10", sourceId: "src-1" } }] } },
  ],
  gangtise_theme_tracking: [
    { title: "单个 type 包成数组", args: { themeId: "121000130", date: "2026-09-01", type: "morning" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/theme-tracking", body: { date: "2026-09-01", themeId: "121000130", type: ["morning"] } }] } },
    { title: "未来日期本地拒绝", args: { themeId: "121000130", date: "2099-01-01" }, expect: { rejects: /不能晚于当前日期/ } },
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
}
