import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { registerJsonTool, registerDownloadTool, buildToolContent, buildTextResult, type JsonToolSpec, type DownloadToolSpec } from "./registry.js"
import { toolHandler, textResult, contentResult } from "./helpers.js"
import { pollAsyncContent } from "../core/asyncContent.js"
import { normalizeRows } from "../core/normalize.js"
import { ApiError, AsyncTimeoutError, ValidationError, errorMessage } from "../core/errors.js"
import { dateDesc, dateString, dateTimeDesc, dateTimeString, quarterEndDate, today, todayDate } from "../core/dateContext.js"

export interface AiToolOptions {
  asyncTimeoutMs: number
}

export const jsonSpecs: JsonToolSpec[] = [
  {
    name: "gangtise_stock_summary",
    description: "查询个股看点（精炼投研总结），按证券返回；无看点的证券不返回、不扣分。",
    endpointKey: "ai.stock-summary.list",
    paginated: false,
    inputSchema: {
      securityList: z
        .array(z.string().trim().min(1))
        .min(1, "securityList 不能为空")
        .describe(
          "证券代码列表（A股/港股，如 ['600519.SH','00700.HK']，单次最多 6000），或市场关键词 aShares=A股全市场 | hkStocks=港股全市场。必填，避免误触发全市场扣费",
        ),
    },
  },
  {
    name: "gangtise_knowledge_batch",
    description: "在 Gangtise 知识库（研报、纪要、观点、公告等）中进行语义搜索，单次最多支持 5 个查询词。适合开放式语义检索；按券商/评级/公告分类/时间范围等结构化条件精确筛选时，改用对应列表工具（gangtise_research_list / gangtise_summary_list / gangtise_opinion_list / gangtise_announcement_list 等）。",
    endpointKey: "ai.knowledge-batch",
    paginated: false,
    inputSchema: {
      queries: z.array(z.string()).min(1).max(5).describe("搜索词列表（最多 5 个）"),
      top: z.number().int().min(1).max(20).optional().describe("每个查询词返回的结果数（默认 10，最大 20）"),
      resourceTypes: z.array(z.number().int()).optional().describe("10=研报 | 11=外资研报 | 20=内部 | 40=观点 | 50=公告 | 51=港股公告 | 60=纪要 | 70=调研 | 80=网络纪要 | 90=公众号"),
      knowledgeNames: z.array(z.string()).optional().describe("system_knowledge_doc | tenant_knowledge_doc"),
      startTime: z.number().int().min(0).optional().describe("开始时间（epoch 毫秒）"),
      endTime: z.number().int().min(0).optional().describe("结束时间（epoch 毫秒）"),
    },
  },
  {
    name: "gangtise_security_clue_list",
    description: "查询 AI 生成的个股或行业投资线索列表，需传入时间范围。",
    endpointKey: "ai.security-clue.list",
    paginated: true,
    inputSchema: {
      startTime: dateTimeString.describe(dateTimeDesc() + "（必填）"),
      endTime: dateTimeString.describe(dateTimeDesc() + "（必填）"),
      queryMode: z.enum(["bySecurity", "byIndustry"]).describe("bySecurity=按个股 | byIndustry=按行业（必填）"),
      gtsCodeList: z.array(z.string()).optional().describe("个股代码（如 600519.SH）或申万行业代码（如 821035.SWI）列表。全量 31 个行业代码用 gangtise_sector_constituents sectorId=2000000014；单个行业可用 gangtise_securities_search（如 keyword=申万银行 category=['index']）"),
      source: z.array(z.string()).optional().describe("researchReport=研报 | conference=会议 | announcement=公告 | view=观点"),
    },
  },
  {
    name: "gangtise_hot_topic",
    description: "查询 AI 生成的热点话题简报列表，支持早报、午报、午后快讯、晚报等版别。",
    endpointKey: "ai.hot-topic",
    paginated: true,
    inputSchema: {
      startDate: dateString.optional().describe(dateDesc()),
      endDate: dateString.optional().describe(dateDesc()),
      categoryList: z.array(z.string()).optional().describe("morningBriefing=早报 | noonBriefing=午报 | afternoonFlash=午后快讯 | eveningBriefing=晚报"),
      withRelatedSecurities: z.boolean().optional().describe("是否返回话题关联证券（默认 true；只需话题清单时传 false 精简响应）"),
      withCloseReading: z.boolean().optional().describe("是否返回话题精读长文（默认 true；传 false 可大幅减小响应体积）"),
    },
  },
  {
    name: "gangtise_management_discuss_announcement",
    description: "从财报公告（半年报/年报）中提取 AI 整理的管理层讨论内容，仅支持中报和年报。",
    endpointKey: "ai.management-discuss-announcement",
    paginated: false,
    inputSchema: {
      securityCode: z.string().describe("证券代码，如 '600519.SH'"),
      reportDate: quarterEndDate("06-30", "12-31").describe("xxxx-06-30（中报）或 xxxx-12-31（年报）"),
      discussionDimension: z.enum(["businessOperation", "financialPerformance", "developmentAndRisk", "all"]).describe("businessOperation=经营情况 | financialPerformance=财务表现 | developmentAndRisk=发展与风险 | all=全部维度（必填）"),
    },
  },
  {
    name: "gangtise_management_discuss_earnings_call",
    description: "从业绩会会议纪要中提取 AI 整理的管理层讨论内容。",
    endpointKey: "ai.management-discuss-earnings-call",
    paginated: false,
    inputSchema: {
      securityCode: z.string().describe("证券代码，如 '600519.SH'"),
      reportDate: quarterEndDate("03-31", "06-30", "09-30", "12-31").describe("xxxx-03-31 | xxxx-06-30 | xxxx-09-30 | xxxx-12-31"),
      discussionDimension: z.enum(["businessOperation", "financialPerformance", "developmentAndRisk"]).describe("businessOperation=经营情况 | financialPerformance=财务表现 | developmentAndRisk=发展与风险（必填）"),
    },
  },
]

export const downloadSpecs: DownloadToolSpec[] = [
  {
    name: "gangtise_knowledge_resource_download",
    description: "按资源类型和 sourceId 下载知识库资源文件。sourceId 来自 gangtise_knowledge_batch 返回结果。",
    endpointKey: "ai.knowledge-resource.download",
    inputSchema: {
      resourceType: z.number().int().describe("资源类型（必填）：10=研报 | 11=外资研报 | 20=内部 | 40=观点 | 50=公告 | 51=港股公告 | 60=纪要 | 70=调研 | 80=网络纪要 | 90=公众号"),
      sourceId: z.string().describe("资源 ID，来自 gangtise_knowledge_batch 返回结果（必填）"),
    },
  },
]

function makeAiContentHandler(client: GangtiseClient, endpointKey: string) {
  return toolHandler(async (args: Record<string, unknown>) => {
    const result = await client.call(endpointKey, args) as { content?: string }
    if (typeof result?.content === "string") {
      if (!result.content.trim()) return textResult("该证券暂无相关 AI 生成内容（后端未生成或数据缺失）。")
      return contentResult(await buildTextResult(result.content))
    }
    return contentResult(await buildToolContent(normalizeRows(result)))
  })
}

function makeAsyncToolPair(
  server: McpServer,
  client: GangtiseClient,
  opts: AiToolOptions,
  config: {
    name: string
    description: string
    inputSchema: Record<string, z.ZodTypeAny>
    submitEndpoint: string
    pollEndpoint: string
    submitIdField: string
    checkName: string
    checkDescription: string
  },
) {
  // Submit + poll tool
  server.registerTool(
    config.name,
    {
      description: config.description + `任务计费且不可重复提交：超时/失败后用返回的 dataId 调 ${config.checkName} 续查，切勿重新提交。`,
      inputSchema: {
        ...config.inputSchema,
        waitSeconds: z.number().int().min(0).max(180).optional().describe("最长等待秒数（默认 55，最大 180）；超时返回 dataId，用对应 *_check 工具续查"),
      },
      // NOT read-only: submitting creates a billed, non-idempotent task (the submit
      // endpoint carries noRetry). Leave the hint false so agentic clients confirm
      // before auto-invoking. The _check poll tool below stays read-only.
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const { waitSeconds, ...submitArgs } = args
      const timeoutMs = typeof waitSeconds === "number" ? waitSeconds * 1000 : opts.asyncTimeoutMs
      const submitResult = await client.call(config.submitEndpoint, submitArgs) as Record<string, string>
      const dataId = submitResult[config.submitIdField]
      if (!dataId) throw new Error(`No ${config.submitIdField} in response`)

      try {
        const polled = await pollAsyncContent(client, config.pollEndpoint, dataId, timeoutMs)
        if (!polled.content.trim()) return textResult("任务已完成，但 AI 内容为空（后端未生成或数据缺失）。")
        return contentResult(await buildTextResult(polled.content))
      } catch (err) {
        if (err instanceof AsyncTimeoutError) {
          return textResult(JSON.stringify({ dataId, status: "timeout", hint: `Call ${config.checkName} with this dataId in ~3 minutes` }))
        }
        // Submit already succeeded (and may be billed); never swallow the dataId on
        // a mid-poll failure, or the user can't recover the job via _check. 410111
        // is a terminal backend failure; anything else is transient → suggest retry.
        if (err instanceof ApiError && err.code === "410111") {
          return { ...textResult(JSON.stringify({ dataId, status: "failed", error: errorMessage(err) })), isError: true }
        }
        return textResult(JSON.stringify({ dataId, status: "error", error: errorMessage(err), hint: `Call ${config.checkName} with this dataId to retry` }))
      }
    }),
  )

  // Single-shot check tool
  server.registerTool(
    config.checkName,
    {
      description: config.checkDescription + `dataId 来自 ${config.name} 的超时/错误响应；pending 表示仍在生成，间隔 1-3 分钟再查。`,
      inputSchema: { dataId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async ({ dataId }: { dataId: string }) => {
      try {
        const result = await client.call(config.pollEndpoint, { dataId }) as { content?: string }
        // content: "" is a *finished* task with empty output (matches the poll
        // loop's `content != null` check) — a truthiness test would report the
        // billed task as pending forever.
        if (result.content != null) {
          if (!result.content.trim()) return textResult("任务已完成，但 AI 内容为空（后端未生成或数据缺失）。")
          return contentResult(await buildTextResult(result.content))
        }
        return textResult(JSON.stringify({ status: "pending", dataId }))
      } catch (err) {
        if (err instanceof ApiError && err.code === "410111")
          return { ...textResult(JSON.stringify({ status: "failed", dataId, error: errorMessage(err) })), isError: true }
        if (err instanceof ApiError && err.code === "410110")
          return textResult(JSON.stringify({ status: "pending", dataId }))
        throw err
      }
    }),
  )
}

export function registerAiTools(server: McpServer, client: GangtiseClient, opts: AiToolOptions): void {
  // Spec-driven JSON tools
  for (const spec of jsonSpecs) {
    registerJsonTool(server, client, spec)
  }

  // gangtise_theme_tracking: registered directly to enforce 30-day date guard
  server.registerTool(
    "gangtise_theme_tracking",
    {
      description: "获取指定主题的每日跟踪报告（早报或晚报版），需传入主题 ID 和日期。",
      inputSchema: {
        themeId: z.string().describe("主题 ID，来自 gangtise_concept_search（必填）"),
        date: dateString.describe("YYYY-MM-DD，仅支持最近 30 天（必填）"),
        type: z.union([z.enum(["morning", "night"]), z.array(z.enum(["morning", "night"]))]).optional().describe("morning=早报 | night=晚报；可传单个值或数组"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const { date, type, ...rest } = args as { date: string; type?: string | string[]; [k: string]: unknown }
      const inputDate = new Date(`${date}T00:00:00+08:00`)
      if (Number.isNaN(inputDate.getTime())) {
        throw new ValidationError(`date 格式无效：'${date}'，应为 YYYY-MM-DD。`)
      }
      const diffDays = Math.floor((todayDate().getTime() - inputDate.getTime()) / 86_400_000)
      if (diffDays > 30 || diffDays < 0) {
        throw new ValidationError(`date 超出最近 30 天范围。当前日期是 ${today()}，请按当前日期重新换算。`)
      }
      const body: Record<string, unknown> = { date, ...rest }
      if (type !== undefined) body.type = Array.isArray(type) ? type : [type]
      const result = await client.call("ai.theme-tracking", body)
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )

  // Spec-driven download tools
  for (const spec of downloadSpecs) {
    registerDownloadTool(server, client, spec)
  }

  // Synchronous AI content generation tools (returns content directly)
  server.registerTool(
    "gangtise_one_pager",
    {
      description: "生成指定证券的 AI 一页纸投资摘要，返回 Markdown 内容。",
      inputSchema: { securityCode: z.string().describe("A 股或港股证券代码") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => makeAiContentHandler(client, "ai.one-pager")(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_investment_logic",
    {
      description: "生成指定证券的 AI 投资逻辑梳理报告，返回 Markdown 内容。",
      inputSchema: { securityCode: z.string().describe("A 股或港股证券代码") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => makeAiContentHandler(client, "ai.investment-logic")(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_peer_comparison",
    {
      description: "生成指定证券的 AI 同业竞争格局对比报告，返回 Markdown 内容。",
      inputSchema: { securityCode: z.string().describe("A 股或港股证券代码") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => makeAiContentHandler(client, "ai.peer-comparison")(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_research_outline",
    {
      description: "获取指定证券的 AI 生成公司研究提纲，返回 Markdown 内容。",
      inputSchema: { securityCode: z.string().describe("仅支持 A 股证券代码") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => makeAiContentHandler(client, "ai.research-outline")(args as Record<string, unknown>),
  )

  // Async tools: earnings-review
  makeAsyncToolPair(server, client, opts, {
    name: "gangtise_earnings_review",
    description: "生成 AI 业绩点评报告。提交任务后等待最多 waitSeconds 秒（默认 55s），超时返回 dataId 供 gangtise_earnings_review_check 续查。",
    inputSchema: {
      securityCode: z.string().describe("仅支持 A 股证券代码"),
      period: z.string().regex(/^\d{4}(q1|interim|q3|annual)$/, "格式：<年份>q1|interim|q3|annual（小写），如 2025q3").describe("报告期，格式 <年份>q1 | <年份>interim | <年份>q3 | <年份>annual，如 2025q3；仅覆盖最近 6 期"),
    },
    submitEndpoint: "ai.earnings-review.get-id",
    pollEndpoint: "ai.earnings-review.get-content",
    submitIdField: "dataId",
    checkName: "gangtise_earnings_review_check",
    checkDescription: "按 dataId 查询业绩点评任务的生成状态。",
  })

  // Async tools: viewpoint-debate
  makeAsyncToolPair(server, client, opts, {
    name: "gangtise_viewpoint_debate",
    description: "对给定投资观点生成 AI 多空辩论报告。提交任务后等待最多 waitSeconds 秒（默认 55s），超时返回 dataId 供对应 *_check 工具续查。",
    inputSchema: {
      viewpoint: z.string().max(1000).describe("投资观点文本（最多 1000 字）"),
    },
    submitEndpoint: "ai.viewpoint-debate.get-id",
    pollEndpoint: "ai.viewpoint-debate.get-content",
    submitIdField: "dataId",
    checkName: "gangtise_viewpoint_debate_check",
    checkDescription: "按 dataId 查询多空辩论任务的生成状态。",
  })
}
