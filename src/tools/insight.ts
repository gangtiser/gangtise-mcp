import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { registerJsonTool, registerDownloadTool, buildToolContent, sanitizeArgs, type JsonToolSpec, type DownloadToolSpec } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"
import { normalizeRows } from "../core/normalize.js"
import { ValidationError } from "../core/errors.js"
import { dateString, dateTimeDesc, dateTimeString } from "../core/dateContext.js"
import { nonEmptyString, intLiteralEnum } from "./schemas.js"
import { withBilling } from "./billing.js"

// insight.qa.list accepts either a plain date or a full datetime; the string is
// passed through to the API as-is (no timestamp conversion).
const qaTimeString = z.union([dateString, dateTimeString])

// Each schedule endpoint accepts a different subset of filters (per API spec).
// Previously all four shared one big schema, so unsupported filters (e.g.
// strategy --research-area) silently sent and returned 0. Now each tool only
// declares its real fields. CLI v0.17.0 made the same change in source.
const SCHED_RESEARCH_AREA_DESC = "研究方向 ID，来自 gangtise_constant_list category=gangtiseIndustry（行业 1008001xx + 方向 122000xxx：宏观/策略/固收/金工/海外/其他）"
const SCHED_LOCATION_DESC = "地点 ID（省级），来自 gangtise_constant_list category=domesticCity"
// 券商研报 / 外资研报共用同一 category 闭集（源：gangtise CLI insight.md）。
// 上游对未知 category 静默 no-op 返回全量，schema 层是唯一防线，故收紧为 z.enum。
const RESEARCH_CATEGORY_ENUM = z.enum(["macro", "strategy", "industry", "company", "bond", "quant", "morningNotes", "fund", "forex", "futures", "options", "warrants", "market", "wealthManagement", "other"])
const RESEARCH_CATEGORY_DESC = "macro=宏观 | strategy=策略 | industry=行业 | company=个股 | bond=债券 | quant=量化 | morningNotes=晨报 | fund=基金 | forex=外汇 | futures=期货 | options=期权 | warrants=权证 | market=市场 | wealthManagement=财富管理 | other=其他"
// 券商/外资研报与观点共用的评级、评级变动、LLM 标签闭集（源：gangtise CLI insight.md）。
const RATING_DESC = "buy=买入 | overweight=增持 | neutral=中性 | underweight=减持 | sell=卖出"
const RATING_CHANGE_DESC = "upgrade=上调 | maintain=维持 | downgrade=下调 | initiate=首次覆盖"
const LLM_TAG_DESC = "inDepth=深度报告 | earningsReview=业绩点评 | industryStrategy=行业策略"

type ScheduleFields = {
  researchArea?: boolean
  institution?: boolean
  security?: boolean
  object?: boolean
  category?: string
  market?: string
  participantRole?: boolean
  brokerType?: boolean
  permission?: boolean
  location?: boolean
}

function scheduleInputSchema(fields: ScheduleFields): Record<string, z.ZodTypeAny> {
  const schema: Record<string, z.ZodTypeAny> = {
    from: z.number().int().min(0).optional(),
    startTime: dateTimeString.optional().describe(dateTimeDesc()),
    endTime: dateTimeString.optional().describe(dateTimeDesc()),
    keyword: z.string().optional(),
  }
  if (fields.researchArea) schema.researchAreaList = z.array(z.string()).optional().describe(SCHED_RESEARCH_AREA_DESC)
  if (fields.institution) schema.institutionList = z.array(z.string()).optional().describe("机构 ID（牵头机构）：用 gangtise_institution_search categoryList=['leadInstitution'] 按名称搜；需全量枚举用 gangtise_lookup type=meeting-orgs")
  if (fields.security) schema.securityList = z.array(z.string()).optional()
  if (fields.object) schema.objectList = z.array(z.string()).optional().describe("company=公司 | industry=行业")
  if (fields.category) schema.categoryList = z.array(z.string()).optional().describe(fields.category)
  if (fields.market) schema.marketList = z.array(z.string()).optional().describe(fields.market)
  if (fields.participantRole) schema.participantRoleList = z.array(z.string()).optional().describe("management=管理层 | expert=专家")
  if (fields.brokerType) schema.brokerTypeList = z.array(z.string()).optional().describe("cnBroker=内资 | otherBroker=外资")
  if (fields.permission) schema.permission = z.array(z.number().int()).optional().describe("1=公开 | 2=私密")
  if (fields.location) schema.locationList = z.array(z.string()).optional().describe(SCHED_LOCATION_DESC)
  return schema
}

function scheduleSpec(name: string, label: string, endpointKey: string, fields: ScheduleFields, extra = ""): JsonToolSpec {
  return {
    name,
    description: `查询${label}活动日程安排（时间、主办机构、地点等，不含会议内容正文）。${extra}`,
    endpointKey,
    paginated: true,
    inputSchema: scheduleInputSchema(fields),
  }
}

export const listSpecs: JsonToolSpec[] = [
  {
    name: "gangtise_opinion_list",
    description: "查询国内机构首席观点列表，支持按证券、券商、研究方向、行业、时间范围、语义标签等筛选。本工具返回首席观点结论摘要，无专用下载工具。",
    endpointKey: "insight.opinion.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      rankType: z.number().int().optional().describe("1=综合排序（默认）| 2=时间倒序"),
      researchAreaList: z.array(z.string()).optional().describe("研究方向 ID，来自 gangtise_constant_list category=gangtiseIndustry（行业 1008001xx + 方向 122000xxx：宏观/策略/固收/金工/海外/其他）"),
      chiefList: z.array(z.string()).optional().describe("首席分析师 ID 列表"),
      securityList: z.array(z.string()).optional().describe("证券代码列表，如 ['600519.SH']"),
      brokerList: z.array(z.string()).optional().describe("机构 ID（内资观点机构）：用 gangtise_institution_search categoryList=['opinionInstitution'] 按名称搜；需全量枚举用 gangtise_lookup type=broker-orgs"),
      industryList: z.array(z.string()).optional().describe("行业 ID，来自 gangtise_constant_list category=citicIndustry（1008001xx，全场景首选）"),
      conceptList: z.array(z.string()).optional().describe("题材/概念 ID，来自 gangtise_concept_search，如 '121000130'（机器人）"),
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
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=标题搜索（快）| 2=全文搜索"),
      rankType: z.number().int().optional().describe("1=综合排序（默认）| 2=时间倒序"),
      researchAreaList: z.array(z.string()).optional().describe("研究方向 ID，来自 gangtise_constant_list category=gangtiseIndustry（行业 1008001xx + 方向 122000xxx：宏观/策略/固收/金工/海外/其他）"),
      securityList: z.array(z.string()).optional(),
      institutionList: z.array(z.string()).optional().describe("机构 ID（牵头机构）：用 gangtise_institution_search categoryList=['leadInstitution'] 按名称搜；需全量枚举用 gangtise_lookup type=meeting-orgs"),
      categoryList: z.array(z.enum(["earningsCall", "strategyMeeting", "fundRoadshow", "shareholdersMeeting", "maMeeting", "specialMeeting", "companyAnalysis", "industryAnalysis", "other"])).optional().describe("earningsCall=业绩会 | strategyMeeting=策略会 | fundRoadshow=基金路演 | shareholdersMeeting=股东大会 | maMeeting=并购会议 | specialMeeting=特别会议 | companyAnalysis=公司分析 | industryAnalysis=行业分析 | other=其他"),
      marketList: z.array(z.string()).optional().describe("aShares=A股 | hkStocks=港股 | usChinaConcept=中概 | usStocks=美股"),
      participantRoleList: z.array(z.string()).optional().describe("management=管理层 | expert=专家"),
      sourceList: z.array(z.number().int()).optional().describe("1=实时 | 2=公开"),
    },
  },
  scheduleSpec("gangtise_roadshow_list", "路演", "insight.roadshow.list", {
    researchArea: true, institution: true, security: true, location: true,
    category: "路演类型：earningsCall=业绩会 | strategyMeeting=策略会 | companyAnalysis=公司分析 | industryAnalysis=行业分析 | fundRoadshow=基金路演",
    market: "市场：aShares=A股 | hkStocks=港股 | usChinaConcept=中概 | usStocks=美股",
    participantRole: true, brokerType: true, permission: true,
  }, "要路演的会后纪要内容用 gangtise_summary_list categoryList=['fundRoadshow']。"),
  scheduleSpec("gangtise_site_visit_list", "调研", "insight.site-visit.list", {
    researchArea: true, institution: true, security: true, location: true, object: true,
    category: "调研形式：single=单场 | series=系列",
    market: "市场：aShares=A股 | hkStocks=港股 | usChinaConcept=中概（调研无美股）",
    permission: true,
  }, "要调研的会后纪要内容用 gangtise_summary_list（按 keyword/机构 检索；其 categoryList 无独立调研类别）。"),
  scheduleSpec("gangtise_strategy_list", "策略会", "insight.strategy.list", {
    institution: true, location: true,
  }, "要策略会的会后纪要内容用 gangtise_summary_list categoryList=['strategyMeeting']。"),
  scheduleSpec("gangtise_forum_list", "论坛", "insight.forum.list", {
    researchArea: true, location: true,
  }, "指线下行业论坛/峰会活动，非网络论坛帖子。"),
  {
    name: "gangtise_research_list",
    description: "查询券商研报列表，支持按证券、券商、行业、类别、评级、时间范围筛选。",
    endpointKey: "insight.research.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=标题搜索 | 2=全文搜索"),
      rankType: z.number().int().optional().describe("1=综合排序（默认）| 2=时间倒序"),
      brokerList: z.array(z.string()).optional().describe("券商机构 ID（内资券商）：用 gangtise_institution_search categoryList=['domesticBroker'] 按名称搜；需全量枚举用 gangtise_lookup type=broker-orgs"),
      securityList: z.array(z.string()).optional(),
      industryList: z.array(z.string()).optional().describe("行业 ID，来自 gangtise_constant_list category=citicIndustry（1008001xx，全场景首选）"),
      categoryList: z.array(RESEARCH_CATEGORY_ENUM).optional().describe(RESEARCH_CATEGORY_DESC),
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
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=标题搜索 | 2=全文搜索"),
      rankType: z.number().int().optional().describe("1=综合排序 | 2=时间倒序"),
      securityList: z.array(z.string()).optional(),
      regionList: z.array(z.string()).optional().describe("地区 ID，来自 gangtise_constant_list category=regionCategory"),
      categoryList: z.array(RESEARCH_CATEGORY_ENUM).optional().describe(RESEARCH_CATEGORY_DESC),
      industryList: z.array(z.string()).optional().describe("行业 ID，来自 gangtise_constant_list category=citicIndustry（1008001xx，全场景首选）"),
      brokerList: z.array(z.string()).optional().describe("外资机构 ID：用 gangtise_institution_search categoryList=['foreignInstitution'] 按名称搜"),
      llmTagList: z.array(z.string()).optional().describe(LLM_TAG_DESC),
      ratingList: z.array(z.string()).optional().describe(RATING_DESC),
      ratingChangeList: z.array(z.string()).optional().describe(RATING_CHANGE_DESC),
      minReportPages: z.number().int().min(0).optional(),
      maxReportPages: z.number().int().min(0).optional(),
    },
  },
  {
    name: "gangtise_announcement_list",
    description: "查询 A 股公告列表，支持按证券、公告分类、时间范围筛选。",
    endpointKey: "insight.announcement.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=标题搜索 | 2=全文搜索"),
      rankType: z.number().int().optional().describe("1=综合排序 | 2=时间倒序"),
      securityList: z.array(z.string()).optional(),
      categoryList: z.array(z.string()).optional().describe("公告分类 ID，来自 gangtise_constant_list category=aShareAnnouncementCategory"),
    },
  },
  {
    name: "gangtise_announcement_hk_list",
    description: "查询港股公告列表，支持按证券、类别、时间范围筛选。",
    endpointKey: "insight.announcement-hk.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=标题搜索 | 2=全文搜索"),
      rankType: z.number().int().optional().describe("1=综合排序 | 2=时间倒序"),
      securityList: z.array(z.string()).optional(),
      categoryList: z.array(z.string()).optional().describe("公告类别 ID，来自 gangtise_constant_list category=hkShareAnnouncementCategory"),
    },
  },
  {
    name: "gangtise_announcement_us_list",
    description: "查询美股公告列表，支持按证券、类别、时间范围筛选。",
    endpointKey: "insight.announcement-us.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      searchType: z.number().int().optional().describe("1=标题搜索 | 2=全文搜索"),
      rankType: z.number().int().optional().describe("1=综合排序 | 2=时间倒序"),
      securityList: z.array(z.string()).optional().describe("证券代码列表，如 ['TSLA.O']"),
      categoryList: z.array(z.string()).optional().describe("公告类别 ID，来自 gangtise_constant_list category=usShareAnnouncementCategory"),
    },
  },
  {
    name: "gangtise_foreign_opinion_list",
    description: "查询外资机构观点列表（高盛、摩根士丹利等），支持按证券、地区、行业、券商、评级、时间范围筛选。本工具返回外资机构观点结论摘要，无专用下载工具。",
    endpointKey: "insight.foreign-opinion.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      rankType: z.number().int().optional().describe("1=综合排序 | 2=时间倒序"),
      regionList: z.array(z.string()).optional().describe("地区 ID，来自 gangtise_constant_list category=regionCategory"),
      industryList: z.array(z.string()).optional().describe("行业 ID，来自 gangtise_constant_list category=citicIndustry（1008001xx，全场景首选）"),
      securityList: z.array(z.string()).optional(),
      brokerList: z.array(z.string()).optional().describe("外资观点机构 ID：用 gangtise_institution_search categoryList=['foreignOpinionInstitution'] 按名称搜"),
      ratingList: z.array(z.string()).optional().describe(RATING_DESC),
      ratingChangeList: z.array(z.string()).optional().describe(RATING_CHANGE_DESC),
    },
  },
  {
    name: "gangtise_independent_opinion_list",
    description: "查询境外独立研究员观点列表，支持按证券、行业、评级、时间范围筛选。",
    endpointKey: "insight.independent-opinion.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
      keyword: z.string().optional(),
      rankType: z.number().int().optional().describe("1=综合排序 | 2=时间倒序"),
      industryList: z.array(z.string()).optional().describe("行业 ID，来自 gangtise_constant_list category=citicIndustry（1008001xx，全场景首选）"),
      securityList: z.array(z.string()).optional(),
      ratingList: z.array(z.string()).optional().describe(RATING_DESC),
      ratingChangeList: z.array(z.string()).optional().describe(RATING_CHANGE_DESC),
    },
  },
  {
    name: "gangtise_official_account_list",
    description: "查询产业公众号资讯列表，支持按公众号、证券、文章类型、行业、时间范围、关键词筛选；返回含模型摘要及关联行业/题材/证券列表。",
    endpointKey: "insight.official-account.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
      keyword: z.string().optional().describe("需用数据中的具体词（如 泡泡玛特），不要用整句白话"),
      searchType: z.number().int().optional().describe("1=标题搜索（默认）| 2=全文搜索"),
      rankType: z.number().int().optional().describe("1=综合排序（默认）| 2=时间倒序"),
      accountIdList: z.array(z.string()).optional().describe("公众号 ID，来自 gangtise_official_account_search（或本工具此前返回的 accountId）"),
      securityList: z.array(z.string()).optional().describe("证券代码列表，如 ['000001.SZ']"),
      categoryList: z.array(z.string()).optional().describe("文章类型：news=新闻资讯 | law=法律法规 | report=报告类 | view=个人观点 | data=产业数据 | event=日程活动 | meeting=会议纪要 | notice=通知 | recruit=招聘 | investEdu=投资科普 | brand=品牌宣传 | notes=个人随笔 | other=其他"),
      industryList: z.array(z.string()).optional().describe("行业 ID，来自 gangtise_constant_list category=citicIndustry（1008001xx，全场景首选）"),
    },
  },
  {
    name: "gangtise_qa_list",
    description:
      "按证券提取投资者问答 QA（互动平台/电话会议/调研纪要中的提问与回答，含回答方身份 member 与问题分类）。",
    endpointKey: "insight.qa.list",
    paginated: true,
    inputSchema: {
      securityCode: nonEmptyString.describe("证券代码（必填），如 '601012.SH'，按单只证券提取"),
      startTime: qaTimeString.optional().describe("YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss"),
      endTime: qaTimeString.optional().describe("YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss"),
      source: z
        .array(z.string())
        .optional()
        .describe("问题来源（可多选）：conference=电话会议 | interactive=互动平台 | survey=调研纪要；不传查全部（拼写错误服务端报 100003，不做本地白名单）"),
      questionCategory: z
        .array(z.string())
        .optional()
        .describe(
          "问题分类（可多选）：productAndBusiness=产品技术与业务布局 | capacityAndProjects=产能与项目进展 | ordersAndCustomers=订单与客户 | financialData=财务与经营数据 | materialEvents=重大事项 | capitalOperations=资本运作 | shareholdersAndDividends=股东户数与常规分红 | corporateGovernance=治理与管理 | marketAndValuation=市场与估值 | macroAndIndustry=宏观与行业看法 | risksAndOthers=风险质疑其他（拼写错误服务端报 100003，不做本地白名单）",
        ),
      answerImportant: z
        .array(intLiteralEnum([0, 1]))
        .optional()
        .describe("答案是否涉及重要信息：[1]=只取重要 | [0]=只取不重要；省略或 [0,1]=不按此维度筛选"),
    },
  },
  {
    name: "gangtise_report_image_list",
    description:
      "按关键词搜索研报图表，返回 chunkId 及元数据（标题/券商/页码/图注/该页 OCR 文本）；原图用 gangtise_report_image_download 按 chunkId 下载。",
    endpointKey: "insight.report-image.list",
    paginated: false,
    inputSchema: {
      keyword: nonEmptyString.describe("搜索关键词（必填），如 'AI' '新能源汽车'"),
      top: z.number().int().min(1).max(20).optional().describe("最大返回条数（默认 10，上限 20）"),
      sourceId: nonEmptyString.optional().describe("研报 ID，限定到某篇研报（来自研报列表或知识库结果）"),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
    },
  },
]

export const downloadSpecs: DownloadToolSpec[] = [
  {
    name: "gangtise_summary_download",
    description: "按 summaryId 下载会议纪要文件，返回文本内容或文件路径。",
    endpointKey: "insight.summary.download",
    inputSchema: {
      summaryId: nonEmptyString.describe("纪要 ID，来自 gangtise_summary_list"),
      fileType: intLiteralEnum([1, 2]).optional().describe("1=原始文件（默认）| 2=HTML（仅限会议平台纪要）"),
    },
  },
  {
    name: "gangtise_research_download",
    description: "按 reportId 下载券商研报，返回 Markdown 文本或 PDF 文件路径。",
    endpointKey: "insight.research.download",
    inputSchema: {
      reportId: nonEmptyString.describe("研报 ID，来自 gangtise_research_list"),
      fileType: intLiteralEnum([1, 2]).optional().describe("1=PDF（默认）| 2=Markdown"),
    },
  },
  {
    name: "gangtise_foreign_report_download",
    description: "下载外资研报，支持原文 PDF、Markdown、中文 PDF 和中文 Markdown 格式。",
    endpointKey: "insight.foreign-report.download",
    inputSchema: {
      reportId: nonEmptyString.describe("研报 ID，来自 gangtise_foreign_report_list"),
      fileType: intLiteralEnum([1, 2, 3, 4]).optional().describe("1=PDF | 2=Markdown | 3=中文PDF | 4=中文Markdown"),
    },
  },
  {
    name: "gangtise_announcement_download",
    description: "按 announcementId 下载 A 股公告文件。",
    endpointKey: "insight.announcement.download",
    inputSchema: {
      announcementId: nonEmptyString.describe("公告 ID，来自 gangtise_announcement_list"),
      fileType: intLiteralEnum([1, 2]).optional().describe("1=PDF（默认）| 2=Markdown"),
    },
  },
  {
    name: "gangtise_announcement_hk_download",
    description: "下载港股公告文件。",
    endpointKey: "insight.announcement-hk.download",
    inputSchema: {
      announcementId: nonEmptyString.describe("公告 ID，来自 gangtise_announcement_hk_list"),
      fileType: intLiteralEnum([1, 2]).optional().describe("1=原始（默认）| 2=Markdown"),
    },
  },
  {
    name: "gangtise_announcement_us_download",
    description: "下载美股公告文件。",
    endpointKey: "insight.announcement-us.download",
    inputSchema: {
      announcementId: nonEmptyString.describe("公告 ID，来自 gangtise_announcement_us_list"),
      fileType: intLiteralEnum([1, 2]).optional().describe("1=原始 PDF（默认）| 2=Markdown"),
    },
  },
  {
    name: "gangtise_independent_opinion_download",
    description: "下载境外独立研究员观点文件，返回 HTML 内容（原文或中文翻译）。",
    endpointKey: "insight.independent-opinion.download",
    inputSchema: {
      independentOpinionId: nonEmptyString.describe("观点 ID，来自 gangtise_independent_opinion_list 的 independentOpinionId 字段"),
      fileType: intLiteralEnum([1, 2]).describe("1=原文 HTML | 2=中文翻译 HTML（必填）"),
    },
  },
  {
    name: "gangtise_official_account_download",
    description: "按 articleId 下载产业公众号文章，返回 txt 文本或 HTML。",
    endpointKey: "insight.official-account.download",
    inputSchema: {
      articleId: nonEmptyString.describe("文章 ID，来自 gangtise_official_account_list"),
      fileType: intLiteralEnum([1, 2]).optional().describe("1=txt（默认）| 2=HTML"),
    },
  },
  {
    name: "gangtise_report_image_download",
    description: "按 chunkId 下载研报图表原图（JPEG 二进制）。chunkId 来自 gangtise_report_image_list。",
    endpointKey: "insight.report-image.download",
    inputSchema: {
      chunkId: nonEmptyString.describe("图片唯一标识，来自 gangtise_report_image_list 的 chunkId"),
    },
  },
  {
    name: "gangtise_performance_calendar_download",
    description: "按 performanceReportId 下载业绩报告原文 PDF。仅 gangtise_performance_calendar_list 中 hasAttachment=true 的记录可下载。",
    endpointKey: "insight.performance-calendar.download",
    inputSchema: {
      performanceReportId: nonEmptyString.describe("业绩报告 ID，来自 gangtise_performance_calendar_list"),
    },
  },
]

// 财报日历的枚举闭集。实测 2026-07-26：枚举拼错时上游**静默返回全量**
// （categoryList:["bogusCategory"] 与不传筛选同为 total=126683，code 仍是 000000），
// 且按 0.1/条 照常计费 —— schema 层的 z.enum 是唯一防线。
const PERFORMANCE_MARKET_ENUM = z.enum(["aShares", "hkStocks", "usChinaConcept", "usStocks"])
const PERFORMANCE_CATEGORY_ENUM = z.enum(["performanceForecast", "performanceExpress", "performanceAnnouncement"])

/** securityList 单约束时的隐式行数上限。实测服务端确实按 securityList 过滤
 *  （无效码返 total=0，不像错枚举那样被静默忽略），单只证券整段日历只有几十条
 *  （茅台 total=10），所以这个上限在正常使用中感知不到。但不拿五位数积分赌它不变：
 *  筛选一旦失效，结果在此截断并标 _partial，而不是把 12 万行日历翻完。 */
const SECURITY_ONLY_ROW_CAP = 1000
/** 完全无筛选时允许请求的最大行数。超过直接拒（而不是静默截断）——调用方加个筛选
 *  就能解决，静默返 1000 行反而让人以为那就是全部。 */
const UNFILTERED_MAX_ROWS = 1000
/** registry.sanitizeArgs 对分页工具注入的默认 size，本地判「实际要取多少行」时需与之一致。 */
const DEFAULT_ROWS = 20

// 财报日历按天查是常态。实测 2026-07-26：该端点对 "2026-07-20" 与
// "2026-07-20 00:00:00" 返回完全相同的结果（total 均为 517），故两种写法都放行，
// 不逼调用方为一个按天的日程接口补 00:00:00。
const calendarTimeString = z.union([dateString, dateTimeString])

export function registerInsightTools(server: McpServer, client: GangtiseClient): void {
  for (const spec of listSpecs) {
    registerJsonTool(server, client, spec)
  }
  for (const spec of downloadSpecs) {
    registerDownloadTool(server, client, spec)
  }

  // 直接注册而非走 registerJsonTool：fetchAll 需要「必须有真实约束」的前置校验，
  // 而 registerJsonTool 没有留出这个钩子。
  server.registerTool(
    "gangtise_performance_calendar_list",
    {
      description: withBilling(
        "gangtise_performance_calendar_list",
        "查询财报日历：业绩预告 / 业绩快报 / 业绩公告三类事件的发布日程（含未来已排期）。按 publishDate 过滤，返回 performanceReportId（下载用）、securityCodeList（A+H 同时上市会有多个码）、securityName、category、publishDate、title、hasAttachment。查「某公司何时披露财报」用 securityList，查「某段时间谁要出业绩」用 startTime+endTime。本工具只给排期与标题，公告全文请用 gangtise_announcement_list / _download 系列。",
        true,
      ),
      inputSchema: {
        from: z.number().int().min(0).optional().describe("0-based 起始偏移，默认 0"),
        size: z.number().int().min(1).optional().describe(`总行数上限，默认 20。无筛选时最多 ${UNFILTERED_MAX_ROWS} 行（超出本地拒绝）；仅用 securityList 筛选时封顶 ${SECURITY_ONLY_ROW_CAP} 行`),
        fetchAll: z.boolean().optional().describe("拉取全部页并忽略 size（等价于不限行数）。要求同时给出 startTime+endTime 或 securityList，否则拒绝执行"),
        startTime: calendarTimeString.optional().describe("YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss，过滤 publishDate（含端点）"),
        endTime: calendarTimeString.optional().describe("YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss，过滤 publishDate（含端点）"),
        securityList: z.array(z.string()).optional().describe("证券代码，需含交易所后缀（600519.SH / 00700.HK）"),
        marketList: z.array(PERFORMANCE_MARKET_ENUM).optional().describe("aShares=A股 | hkStocks=港股 | usChinaConcept=美股中概 | usStocks=美股"),
        categoryList: z.array(PERFORMANCE_CATEGORY_ENUM).optional().describe("performanceForecast=业绩预告 | performanceExpress=业绩快报 | performanceAnnouncement=业绩公告"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const { fetchAll, ...rest } = args
      const hasDateRange = Boolean(rest.startTime && rest.endTime)
      const hasSecurity = Array.isArray(rest.securityList) && rest.securityList.length > 0
      // 闸门必须按「实际要取多少行」判，不能只看 fetchAll：client.requestPaginated
      // 把 size 当作**总目标行数**按 total 自动翻页，所以 size:50000 与 fetchAll 是
      // 同一件事（都能拉满 MAX_PAGES × 50 = 5 万行 ≈ 5000 积分）。
      const requestedRows = fetchAll
        ? Number.POSITIVE_INFINITY
        : (typeof rest.size === "number" ? rest.size : DEFAULT_ROWS)

      // 不加筛选时 total 是十万量级（实测 2026-07-26 为 126683，含未来排期），
      // 按 0.1/条计费。marketList / categoryList 都不算约束（单个 aShares 实测仍有
      // 64327 条）。这里拒而不截断：加个筛选就能解决，静默返 1000 行会被读成全部。
      if (!hasDateRange && !hasSecurity && requestedRows > UNFILTERED_MAX_ROWS) {
        throw new ValidationError(
          `无筛选时本接口有十万量级数据（按 0.1/条计费），最多只能取 ${UNFILTERED_MAX_ROWS} 行：请同时给出 startTime 与 endTime，或给出 securityList，或把 size 降到 ${UNFILTERED_MAX_ROWS} 以内（fetchAll 视为不限行数）。`,
        )
      }
      const body = sanitizeArgs(rest, { paginated: true, fetchAll: Boolean(fetchAll) })
      // securityList 单约束（无日期区间）时封顶。走到这里 requestedRows > 上限就意味着
      // hasSecurity 为真（否则上面已拒），fetchAll 与显式大 size 一视同仁。
      const capped = !hasDateRange && requestedRows > SECURITY_ONLY_ROW_CAP
      if (capped) body.size = SECURITY_ONLY_ROW_CAP

      const result = await client.call("insight.performance-calendar.list", body)

      // 取满上限且 total 显示还有剩余 = securityList 过滤可能已失效，屏上这批
      // 是整本日历的一段切片而非某公司的日历。判据用 total 而非只看行数：
      // 恰好 1000 行且 from+行数 >= total 是完整结果，不能误标 _partial。
      if (capped && result && typeof result === "object" && !Array.isArray(result)) {
        const rec = result as Record<string, unknown>
        const list = rec.list
        const from = typeof body.from === "number" ? body.from : 0
        if (Array.isArray(list) && list.length >= SECURITY_ONLY_ROW_CAP) {
          const total = typeof rec.total === "number" ? rec.total : undefined
          if (total === undefined || from + list.length < total) {
            // _partial_reason 是**逗号拼接的多原因列表**（见 client.requestPaginated）：
            // 分页层可能已经写入 page_cap / total_drift / failed_pages 等，直接赋值
            // 会把那些诊断信息抹掉。追加，不覆盖。
            const prior = typeof rec._partial_reason === "string" && rec._partial_reason
              ? rec._partial_reason.split(",")
              : []
            if (!prior.includes("security_only_row_cap")) prior.push("security_only_row_cap")
            rec._partial = true
            rec._partial_reason = prior.join(",")
            rec._hint = `securityList 是唯一约束时最多取 ${SECURITY_ONLY_ROW_CAP} 行，且结果已取满、total=${String(rec.total)} 显示还有剩余 —— 该筛选可能未生效，请改用 startTime+endTime 重查。`
          }
        }
      }

      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )
}
