import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { registerJsonTool, registerDownloadTool, type JsonToolSpec, type DownloadToolSpec } from "./registry.js"
import { dateTimeDesc } from "../core/dateContext.js"

// roadshow / site-visit / strategy / forum are all schedule lists with an
// identical filter set — share one schema and a spec builder.
const scheduleListSchema = {
  from: z.number().int().min(0).optional(),
  startTime: z.string().optional().describe(dateTimeDesc()),
  endTime: z.string().optional().describe(dateTimeDesc()),
  keyword: z.string().optional(),
  researchAreaList: z.array(z.string()).optional(),
  institutionList: z.array(z.string()).optional(),
  securityList: z.array(z.string()).optional(),
  categoryList: z.array(z.string()).optional(),
  marketList: z.array(z.string()).optional(),
  participantRoleList: z.array(z.string()).optional(),
  brokerTypeList: z.array(z.string()).optional(),
  objectList: z.array(z.string()).optional().describe("company=公司 | industry=行业"),
  permission: z.array(z.number().int()).optional(),
}

function scheduleSpec(name: string, label: string, endpointKey: string): JsonToolSpec {
  return {
    name,
    description: `查询${label}日程列表，支持按研究方向、机构、证券、类别、市场、参会角色等筛选。`,
    endpointKey,
    paginated: true,
    inputSchema: scheduleListSchema,
  }
}

const listSpecs: JsonToolSpec[] = [
  {
    name: "gangtise_opinion_list",
    description: "查询国内机构首席观点列表，支持按证券、券商、研究方向、行业、时间范围、语义标签等筛选。",
    endpointKey: "insight.opinion.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe(dateTimeDesc()),
      endTime: z.string().optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      rankType: z.number().int().optional().describe("1=综合排序（默认）| 2=时间倒序"),
      researchAreaList: z.array(z.string()).optional().describe("研究方向 ID，来自 gangtise_lookup type=research-areas"),
      chiefList: z.array(z.string()).optional().describe("首席分析师 ID 列表"),
      securityList: z.array(z.string()).optional().describe("证券代码列表，如 ['600519.SH']"),
      brokerList: z.array(z.string()).optional().describe("券商机构 ID，来自 gangtise_lookup type=broker-orgs"),
      industryList: z.array(z.string()).optional(),
      conceptList: z.array(z.string()).optional().describe("概念 ID 列表"),
      llmTagList: z.array(z.string()).optional().describe("strongRcmd=强推 | earningsReview=业绩点评 | topBroker=头部券商 | newFortune=新财富"),
      sourceList: z.array(z.string()).optional().describe("realTime=实时 | openSource=公开"),
    },
  },
  {
    name: "gangtise_summary_list",
    description: "查询会议纪要列表（业绩会、路演、专家访谈、调研纪要等），支持按证券、机构、类别、时间范围筛选。",
    endpointKey: "insight.summary.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe(dateTimeDesc()),
      endTime: z.string().optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=标题搜索（快）| 2=全文搜索"),
      rankType: z.number().int().optional().describe("1=综合排序（默认）| 2=时间倒序"),
      researchAreaList: z.array(z.string()).optional(),
      securityList: z.array(z.string()).optional(),
      institutionList: z.array(z.string()).optional(),
      categoryList: z.array(z.string()).optional().describe("earningsCall=业绩会 | strategyMeeting=策略会 | fundRoadshow=路演 | expertInterview=专家访谈 | fieldResearch=调研 | industryConference=行业会议 等"),
      marketList: z.array(z.string()).optional().describe("aShares=A股 | hkStocks=港股 | usChinaConcept=中概 | usStocks=美股"),
      participantRoleList: z.array(z.string()).optional().describe("management=管理层 | expert=专家"),
      sourceList: z.array(z.number().int()).optional().describe("1=实时 | 2=公开"),
    },
  },
  scheduleSpec("gangtise_roadshow_list", "路演", "insight.roadshow.list"),
  scheduleSpec("gangtise_site_visit_list", "调研", "insight.site-visit.list"),
  scheduleSpec("gangtise_strategy_list", "策略会", "insight.strategy.list"),
  scheduleSpec("gangtise_forum_list", "论坛", "insight.forum.list"),
  {
    name: "gangtise_research_list",
    description: "查询券商研报列表，支持按证券、券商、行业、类别、评级、时间范围筛选。",
    endpointKey: "insight.research.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe(dateTimeDesc()),
      endTime: z.string().optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=标题搜索 | 2=全文搜索"),
      rankType: z.number().int().optional(),
      brokerList: z.array(z.string()).optional(),
      securityList: z.array(z.string()).optional(),
      industryList: z.array(z.string()).optional(),
      categoryList: z.array(z.string()).optional().describe("macro=宏观 | strategy=策略 | industry=行业 | company=个股 | bond=债券 | fund=基金 | quantitative=量化 等"),
      llmTagList: z.array(z.string()).optional().describe("inDepth=深度报告 | earningsReview=业绩点评 | industryStrategy=行业策略"),
      ratingList: z.array(z.string()).optional().describe("buy=买入 | overweight=增持 | neutral=中性 | underweight=减持 | sell=卖出"),
      ratingChangeList: z.array(z.string()).optional().describe("upgrade=上调 | maintain=维持 | downgrade=下调 | initiate=首次覆盖"),
      minReportPages: z.number().int().optional(),
      maxReportPages: z.number().int().optional(),
      sourceList: z.array(z.string()).optional().describe("数字字符串，1=PDF研报 | 2=公众号"),
    },
  },
  {
    name: "gangtise_foreign_report_list",
    description: "查询外资机构研报列表，支持按证券、地区、行业、券商、评级、时间范围、关键词等筛选。",
    endpointKey: "insight.foreign-report.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe(dateTimeDesc()),
      endTime: z.string().optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=标题搜索 | 2=全文搜索"),
      rankType: z.number().int().optional().describe("1=综合排序 | 2=时间倒序"),
      securityList: z.array(z.string()).optional(),
      regionList: z.array(z.string()).optional().describe("地区 ID，来自 gangtise_lookup type=regions"),
      categoryList: z.array(z.string()).optional(),
      industryList: z.array(z.string()).optional(),
      brokerList: z.array(z.string()).optional(),
      llmTagList: z.array(z.string()).optional(),
      ratingList: z.array(z.string()).optional(),
      ratingChangeList: z.array(z.string()).optional(),
      minReportPages: z.number().int().min(0).optional(),
      maxReportPages: z.number().int().min(0).optional(),
    },
  },
  {
    name: "gangtise_announcement_list",
    description: "查询 A 股公告列表，支持按证券、公告类型、类别、时间范围筛选。",
    endpointKey: "insight.announcement.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe(dateTimeDesc()),
      endTime: z.string().optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=标题搜索 | 2=全文搜索"),
      rankType: z.number().int().optional().describe("1=综合排序 | 2=时间倒序"),
      securityList: z.array(z.string()).optional(),
      announcementTypeList: z.array(z.string()).optional(),
      categoryList: z.array(z.string()).optional().describe("公告类别 ID，来自 gangtise_lookup type=announcement-categories"),
    },
  },
  {
    name: "gangtise_announcement_hk_list",
    description: "查询港股公告列表，支持按证券、类别、时间范围筛选。",
    endpointKey: "insight.announcement-hk.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe(dateTimeDesc()),
      endTime: z.string().optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=标题搜索 | 2=全文搜索"),
      rankType: z.number().int().optional().describe("1=综合排序 | 2=时间倒序"),
      securityList: z.array(z.string()).optional(),
      categoryList: z.array(z.string()).optional(),
    },
  },
  {
    name: "gangtise_foreign_opinion_list",
    description: "查询外资机构观点列表（高盛、摩根士丹利等），支持按证券、地区、行业、券商、评级、时间范围筛选。",
    endpointKey: "insight.foreign-opinion.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe(dateTimeDesc()),
      endTime: z.string().optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      rankType: z.number().int().optional().describe("1=综合排序 | 2=时间倒序"),
      regionList: z.array(z.string()).optional().describe("地区 ID，来自 gangtise_lookup type=regions"),
      industryList: z.array(z.string()).optional(),
      securityList: z.array(z.string()).optional(),
      brokerList: z.array(z.string()).optional(),
      ratingList: z.array(z.string()).optional(),
      ratingChangeList: z.array(z.string()).optional(),
    },
  },
  {
    name: "gangtise_independent_opinion_list",
    description: "查询境外独立研究员观点列表，支持按证券、行业、评级、时间范围筛选。",
    endpointKey: "insight.independent-opinion.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: z.string().optional().describe(dateTimeDesc()),
      endTime: z.string().optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      rankType: z.number().int().optional().describe("1=综合排序 | 2=时间倒序"),
      industryList: z.array(z.string()).optional(),
      securityList: z.array(z.string()).optional(),
      ratingList: z.array(z.string()).optional(),
      ratingChangeList: z.array(z.string()).optional(),
    },
  },
]

const downloadSpecs: DownloadToolSpec[] = [
  {
    name: "gangtise_summary_download",
    description: "按 summaryId 下载会议纪要文件，返回文本内容或文件路径。",
    endpointKey: "insight.summary.download",
    inputSchema: {
      summaryId: z.string().describe("纪要 ID，来自 gangtise_summary_list"),
      fileType: z.number().int().optional().describe("1=原始文件（默认）| 2=HTML（仅限会议平台纪要）"),
    },
  },
  {
    name: "gangtise_research_download",
    description: "按 reportId 下载券商研报，返回 Markdown 文本或 PDF 文件路径。",
    endpointKey: "insight.research.download",
    inputSchema: {
      reportId: z.string().describe("研报 ID，来自 gangtise_research_list"),
      fileType: z.number().int().optional().describe("1=PDF（默认）| 2=Markdown"),
    },
  },
  {
    name: "gangtise_foreign_report_download",
    description: "下载外资研报，支持原文 PDF、Markdown、中文 PDF 和中文 Markdown 格式。",
    endpointKey: "insight.foreign-report.download",
    inputSchema: {
      reportId: z.string().describe("研报 ID，来自 gangtise_foreign_report_list"),
      fileType: z.number().int().optional().describe("1=PDF | 2=Markdown | 3=中文PDF | 4=中文Markdown"),
    },
  },
  {
    name: "gangtise_announcement_download",
    description: "按 announcementId 下载 A 股公告文件。",
    endpointKey: "insight.announcement.download",
    inputSchema: {
      announcementId: z.string().describe("公告 ID，来自 gangtise_announcement_list"),
      fileType: z.number().int().optional().describe("1=PDF（默认）| 2=Markdown"),
    },
  },
  {
    name: "gangtise_announcement_hk_download",
    description: "下载港股公告文件。",
    endpointKey: "insight.announcement-hk.download",
    inputSchema: {
      announcementId: z.string().describe("公告 ID，来自 gangtise_announcement_hk_list"),
    },
  },
  {
    name: "gangtise_independent_opinion_download",
    description: "下载境外独立研究员观点文件，返回 HTML 内容（原文或中文翻译）。",
    endpointKey: "insight.independent-opinion.download",
    inputSchema: {
      opinionId: z.string().describe("观点 ID，来自 gangtise_independent_opinion_list"),
      fileType: z.number().int().describe("1=原文 HTML | 2=中文翻译 HTML（必填）"),
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
