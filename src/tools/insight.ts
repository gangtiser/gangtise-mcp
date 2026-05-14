import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { registerJsonTool, registerDownloadTool, type JsonToolSpec, type DownloadToolSpec } from "./registry.js"

const listSpecs: JsonToolSpec[] = [
  {
    name: "gangtise_opinion_list",
    description: "List domestic institution chief opinions. Filter by security, broker, research area, industry, date range, or LLM tag.",
    endpointKey: "insight.opinion.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      keyword: z.string().optional(),
      rankType: z.number().int().optional().describe("1=composite (default), 2=time descending"),
      researchAreaList: z.array(z.string()).optional().describe("Research area IDs from gangtise_lookup type=research-areas"),
      securityList: z.array(z.string()).optional().describe("Security codes e.g. ['600519.SH']"),
      brokerList: z.array(z.string()).optional().describe("Broker org IDs from gangtise_lookup type=broker-orgs"),
      industryList: z.array(z.string()).optional(),
      llmTagList: z.array(z.string()).optional().describe("strongRcmd | earningsReview | topBroker | newFortune"),
      source: z.string().optional().describe("realTime | openSource"),
    },
  },
  {
    name: "gangtise_summary_list",
    description: "List conference summaries and meeting minutes. Filter by security, institution, category, date range.",
    endpointKey: "insight.summary.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=title search (fast), 2=full-text search"),
      rankType: z.number().int().optional().describe("1=composite (default), 2=time descending"),
      researchAreaList: z.array(z.string()).optional(),
      securityList: z.array(z.string()).optional(),
      institutionList: z.array(z.string()).optional(),
      category: z.string().optional().describe("earningsCall | strategyMeeting | fundRoadshow | expertInterview | fieldResearch | industryConference | etc"),
      market: z.string().optional().describe("aShares | hkStocks | usChinaConcept | usStocks"),
      participantRole: z.string().optional().describe("management | expert"),
      source: z.number().int().optional().describe("1=realTime, 2=openSource"),
    },
  },
  {
    name: "gangtise_roadshow_list",
    description: "List roadshow events. Filter by security, date range, keyword.",
    endpointKey: "insight.roadshow.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      keyword: z.string().optional(),
      rankType: z.number().int().optional(),
      securityList: z.array(z.string()).optional(),
    },
  },
  {
    name: "gangtise_site_visit_list",
    description: "List site visit events. Filter by security, date range, keyword.",
    endpointKey: "insight.site-visit.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      keyword: z.string().optional(),
      rankType: z.number().int().optional(),
      securityList: z.array(z.string()).optional(),
    },
  },
  {
    name: "gangtise_strategy_list",
    description: "List strategy meeting events. Filter by date range, keyword.",
    endpointKey: "insight.strategy.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      keyword: z.string().optional(),
      rankType: z.number().int().optional(),
    },
  },
  {
    name: "gangtise_forum_list",
    description: "List forum events. Filter by date range, keyword.",
    endpointKey: "insight.forum.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      keyword: z.string().optional(),
      rankType: z.number().int().optional(),
    },
  },
  {
    name: "gangtise_research_list",
    description: "List broker research reports. Filter by security, broker, industry, category, rating, date range.",
    endpointKey: "insight.research.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=title, 2=full-text"),
      rankType: z.number().int().optional(),
      brokerList: z.array(z.string()).optional(),
      securityList: z.array(z.string()).optional(),
      industryList: z.array(z.string()).optional(),
      category: z.string().optional().describe("macro | strategy | industry | company | bond | fund | quantitative | etc"),
      llmTag: z.string().optional().describe("inDepth | earningsReview | industryStrategy"),
      rating: z.string().optional().describe("buy | overweight | neutral | underweight | sell"),
      ratingChange: z.string().optional().describe("upgrade | maintain | downgrade | initiate"),
      minPages: z.number().int().optional(),
      maxPages: z.number().int().optional(),
      source: z.number().int().optional().describe("1=PDF研报, 2=公众号"),
    },
  },
  {
    name: "gangtise_foreign_report_list",
    description: "List foreign institution research reports. Filter by security, date range, keyword.",
    endpointKey: "insight.foreign-report.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      keyword: z.string().optional(),
      rankType: z.number().int().optional(),
      securityList: z.array(z.string()).optional(),
    },
  },
  {
    name: "gangtise_announcement_list",
    description: "List A-share announcements. Filter by security, category, date range.",
    endpointKey: "insight.announcement.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      keyword: z.string().optional(),
      rankType: z.number().int().optional(),
      securityList: z.array(z.string()).optional(),
      categoryList: z.array(z.string()).optional().describe("Announcement category IDs from gangtise_lookup type=announcement-categories"),
    },
  },
  {
    name: "gangtise_announcement_hk_list",
    description: "List Hong Kong stock announcements. Filter by security, date range.",
    endpointKey: "insight.announcement-hk.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      keyword: z.string().optional(),
      securityList: z.array(z.string()).optional(),
    },
  },
  {
    name: "gangtise_foreign_opinion_list",
    description: "List foreign institution opinions (Goldman Sachs, Morgan Stanley, etc.). Filter by security, date range.",
    endpointKey: "insight.foreign-opinion.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      keyword: z.string().optional(),
      rankType: z.number().int().optional(),
      securityList: z.array(z.string()).optional(),
    },
  },
  {
    name: "gangtise_independent_opinion_list",
    description: "List foreign independent analyst opinions. Filter by security, date range.",
    endpointKey: "insight.independent-opinion.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
      keyword: z.string().optional(),
      rankType: z.number().int().optional(),
      securityList: z.array(z.string()).optional(),
    },
  },
]

const downloadSpecs: DownloadToolSpec[] = [
  {
    name: "gangtise_summary_download",
    description: "Download a conference summary file by summaryId. Returns text content or file path.",
    endpointKey: "insight.summary.download",
    inputSchema: {
      summaryId: z.string().describe("Summary ID from gangtise_summary_list"),
      fileType: z.number().int().optional().describe("1=original (default), 2=HTML (meeting platforms only)"),
    },
  },
  {
    name: "gangtise_research_download",
    description: "Download a broker research report by reportId. Returns Markdown text or PDF file path.",
    endpointKey: "insight.research.download",
    inputSchema: {
      reportId: z.string().describe("Report ID from gangtise_research_list"),
      fileType: z.number().int().optional().describe("1=PDF (default), 2=Markdown"),
    },
  },
  {
    name: "gangtise_foreign_report_download",
    description: "Download a foreign research report. Supports original PDF, Markdown, Chinese PDF, and Chinese Markdown.",
    endpointKey: "insight.foreign-report.download",
    inputSchema: {
      reportId: z.string().describe("Report ID from gangtise_foreign_report_list"),
      fileType: z.number().int().optional().describe("1=PDF, 2=Markdown, 3=Chinese PDF, 4=Chinese Markdown"),
    },
  },
  {
    name: "gangtise_announcement_download",
    description: "Download an A-share announcement file by announcementId.",
    endpointKey: "insight.announcement.download",
    inputSchema: {
      announcementId: z.string().describe("Announcement ID from gangtise_announcement_list"),
      fileType: z.number().int().optional().describe("1=PDF (default), 2=Markdown"),
    },
  },
  {
    name: "gangtise_announcement_hk_download",
    description: "Download a Hong Kong stock announcement file.",
    endpointKey: "insight.announcement-hk.download",
    inputSchema: {
      announcementId: z.string().describe("Announcement ID from gangtise_announcement_hk_list"),
    },
  },
  {
    name: "gangtise_independent_opinion_download",
    description: "Download a foreign independent analyst opinion. Returns HTML content (original or Chinese translation).",
    endpointKey: "insight.independent-opinion.download",
    inputSchema: {
      opinionId: z.string().describe("Opinion ID from gangtise_independent_opinion_list"),
      fileType: z.number().int().describe("1=original HTML (required), 2=Chinese translation HTML (required)"),
    },
  },
]

export function registerInsightTools(server: McpServer, client: GangtiseClient): void {
  for (const spec of listSpecs) {
    registerJsonTool(server, client, spec)
  }
  for (const spec of downloadSpecs) {
    registerDownloadTool(server, client, spec)
  }
}
