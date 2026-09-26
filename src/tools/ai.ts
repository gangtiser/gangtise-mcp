import { z } from "zod"
import { defineDownloadTool, defineJsonTool, defineTool, type DownloadToolSpec, type FamilyModule, type JsonToolSpec, type ToolSpec } from "../mcp/define.js"
import type { Examples } from "../mcp/examples.js"
import { buildTextResult, buildToolContent } from "../core/present.js"
import { textResult, contentResult } from "../mcp/handler.js"
import { pollAsyncContent, isAsyncFailed, isAsyncPending } from "../core/asyncContent.js"
import { normalizeRows } from "../core/normalize.js"
import { AsyncTimeoutError, ValidationError, errorMessage } from "../core/errors.js"
import { dateString, dateTimeString, quarterEndDate, today, todayDate } from "../core/dateContext.js"
import { nonEmptyString, nonEmptyList, intLiteralEnum, MARKET_KEYWORDS, enumList } from "../mcp/schemas.js"
import { aiEndpoints } from "./ai.endpoints.js"

export interface AiToolOptions {
  asyncTimeoutMs: number
}

// epoch 只认 10 位（秒）或 13 位（毫秒）两种量级。其余量级基本是单位搞错，而把
// 秒级时间戳静默当毫秒会读成 1970 年 —— 上游照单全收、返回空结果，看不出是时间界错了。
const EPOCH_SECONDS_MIN = 1e9
const EPOCH_SECONDS_MAX = 1e10
const EPOCH_MILLIS_MIN = 1e12
const EPOCH_MILLIS_MAX = 1e13

const epochTimestamp = z
  .number()
  .int()
  .refine(
    (v) => (v >= EPOCH_SECONDS_MIN && v < EPOCH_SECONDS_MAX) || (v >= EPOCH_MILLIS_MIN && v < EPOCH_MILLIS_MAX),
    "时间戳须为 10 位（秒）或 13 位（毫秒）",
  )

/** knowledge_batch 的 startTime/endTime 既收 "YYYY-MM-DD HH:mm:ss" 也收 epoch 时间戳。
 *  不收纯日期 —— endTime 传 "2026-07-01" 会被当成 00:00:00，静默丢掉当天全部数据。 */
const knowledgeTime = z.union([dateTimeString, epochTimestamp])

/** 字符串按固定 +08:00 转毫秒（不依赖机器时区）；10 位秒级时间戳补到毫秒，13 位原样透传。 */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number") return value < EPOCH_MILLIS_MIN ? value * 1000 : value
  if (typeof value === "string") return Date.parse(`${value.replace(" ", "T")}+08:00`)
  return undefined
}

/** transformBody hook：见 JsonToolSpec.transformBody 的契约（同步、纯、返回新对象）。 */
export function knowledgeBatchTransform(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body }
  const start = toEpochMs(next.startTime)
  const end = toEpochMs(next.endTime)
  // 直接调用者（非 MCP 路径，绕过 dateTimeString schema）可能传入非法字符串 →
  // Date.parse → NaN，或直接传 ±Infinity；二者都会静默通过下面的 start>end 比较
  // （非有限数比较恒 false）并 JSON.stringify → null，悄悄丢掉时间界。用 isFinite 拦掉
  // NaN 与 Infinity；负数/小数是合法时刻（如 1970 前的日期字符串），不拦——那正是
  // epochTimestamp 的位数校验只约束数字入参、不约束字符串路径的原因。
  if ((start !== undefined && !Number.isFinite(start)) || (end !== undefined && !Number.isFinite(end))) {
    throw new ValidationError("startTime / endTime 无效：应为 YYYY-MM-DD HH:mm:ss 或有限的 epoch 时间戳。")
  }
  if (start !== undefined && end !== undefined && start > end) {
    throw new ValidationError("startTime 不能晚于 endTime。")
  }
  if (start !== undefined) next.startTime = start
  if (end !== undefined) next.endTime = end
  return next
}

export const jsonSpecs: JsonToolSpec[] = [
  {
    name: "gangtise_stock_summary",
    tier: "core",
    description: "查询个股看点（精炼投研总结），按证券返回；无看点的证券不返回。返回平台已生成的个股看点条目、可批量按证券取；单证券长文另用 one_pager 等。",
    endpointKey: "ai.stock-summary.list",
    paginated: false,
    inputSchema: {
      securityList: z
        .array(z.string().trim().min(1))
        .min(1, "securityList 不能为空")
        // 接口上限 6000，够一次提交完整个 A 股市场。
        .max(6000, "securityList 单次最多 6000 个（接口上限），请分批")
        // 本接口只按具体代码批量，市场关键字会被判为无效证券代码（报「证券代码无效」，
        // 读起来像代码写错了）。按条计费，所以在 schema 层就拦下、不发请求。
        .refine(
          (list) => !list.some((code) => MARKET_KEYWORDS.has(code.toLowerCase())),
          "本工具不支持 aShares / hkStocks 这类全市场关键字，请传具体证券代码（单次最多 6000 个）",
        )
        .describe(
          "证券代码列表（A股/港股，如 ['600519.SH','00700.HK']，单次最多 6000 个）。必填，且**只接受具体代码**——本工具不支持全市场关键字。⚠️ 本工具按条计费，成本随实际返回条数增长，别为了省调用次数一次性铺满 6000 个代码",
        ),
    },
    examples: [
      { title: "具体代码批量", args: { securityList: ["600519.SH", "00700.HK"] }, expect: { requests: [{ method: "POST", path: "/application/open-ai/stock-summary/getList", body: { securityList: ["600519.SH", "00700.HK"] } }] } },
      { title: "全市场关键字本地拒绝", args: { securityList: ["aShares"] }, expect: { rejects: /全市场关键字/ } },
    ],
  },
  {
    name: "gangtise_knowledge_batch",
    tier: "core",
    description: "在 Gangtise 知识库（研报、纪要、观点、公告等）中进行语义搜索，单次最多支持 5 个查询词。适合开放式语义检索；按券商/评级/公告分类/时间范围等结构化条件精确筛选时，改用对应列表工具（gangtise_research_list / gangtise_summary_list / gangtise_opinion_list / gangtise_announcement_list 等）。",
    endpointKey: "ai.knowledge-batch",
    paginated: false,
    inputSchema: {
      queries: nonEmptyList().min(1).max(5).describe("搜索词列表（最多 5 个）"),
      top: z.number().int().min(1).max(20).optional().describe("每个查询词返回的结果数（默认 10，最大 20）"),
      resourceTypes: enumList(intLiteralEnum([10, 11, 20, 40, 50, 51, 60, 70, 80, 90])).optional().describe("10=研报 | 11=外资研报 | 20=内部 | 40=观点 | 50=公告 | 51=港股公告 | 60=纪要 | 70=调研 | 80=网络纪要 | 90=公众号"),
      knowledgeNames: enumList(z.enum(["system_knowledge_doc", "tenant_knowledge_doc"])).optional().describe("system_knowledge_doc | tenant_knowledge_doc"),
      startTime: knowledgeTime.optional().describe("YYYY-MM-DD HH:mm:ss，或 epoch 时间戳（10 位秒 / 13 位毫秒）"),
      endTime: knowledgeTime.optional().describe("YYYY-MM-DD HH:mm:ss，或 epoch 时间戳（10 位秒 / 13 位毫秒）"),
    },
    transformBody: knowledgeBatchTransform,
    examples: [
      { title: "时间转 +08:00 毫秒，秒级补到毫秒", args: { queries: ["AI 算力"], resourceTypes: [10, 60], startTime: "2026-07-01 00:00:00", endTime: 1782921600 }, expect: { requests: [{ method: "POST", path: "/application/open-data/ai/search/knowledge/batch", body: { queries: ["AI 算力"], resourceTypes: [10, 60], startTime: 1782835200000, endTime: 1782921600000 } }] } },
      { title: "纯日期不收", args: { queries: ["AI"], endTime: "2026-07-01" }, expect: { rejects: /at endTime/ } },
    ],
  },
  {
    name: "gangtise_security_clue_list",
    tier: "core",
    description: "查询 AI 生成的个股或行业投资线索列表，需传入时间范围。",
    endpointKey: "ai.security-clue.list",
    paginated: true,
    inputSchema: {
      startTime: dateTimeString,
      endTime: dateTimeString,
      queryMode: z.enum(["bySecurity", "byIndustry"]).describe("bySecurity=按个股 | byIndustry=按行业（必填）"),
      gtsCodeList: nonEmptyList().optional().describe("个股代码（如 600519.SH）或申万行业代码（801xxx.SWI，如 801780.SWI 申万银行）列表。全量 31 个行业代码用 gangtise_sector_constituents sectorId=2000000014；单个行业可用 gangtise_securities_search（如 keyword=申万银行 category=['index']）"),
      source: enumList(z.enum(["researchReport", "conference", "announcement", "view"])).optional().describe("researchReport=研报 | conference=会议 | announcement=公告 | view=观点"),
    },
    examples: [
      { title: "按个股", args: { startTime: "2026-09-01 00:00:00", endTime: "2026-09-07 23:59:59", queryMode: "bySecurity", gtsCodeList: ["600519.SH"], source: ["researchReport"] }, expect: { requests: [{ method: "POST", path: "/application/open-ai/security-clue/getList", body: { startTime: "2026-09-01 00:00:00", endTime: "2026-09-07 23:59:59", queryMode: "bySecurity", gtsCodeList: ["600519.SH"], source: ["researchReport"], size: 20, from: 0 } }] } },
    ],
  },
  {
    name: "gangtise_hot_topic",
    tier: "core",
    description: "查询 AI 生成的热点话题简报列表，支持早报、午报、午后快讯、晚报等版别。",
    endpointKey: "ai.hot-topic",
    paginated: true,
    inputSchema: {
      startDate: dateString.optional(),
      endDate: dateString.optional(),
      categoryList: enumList(z.enum(["morningBriefing", "noonBriefing", "afternoonFlash", "eveningBriefing"])).optional().describe("morningBriefing=早报 | noonBriefing=午报 | afternoonFlash=午后快讯 | eveningBriefing=晚报"),
      withRelatedSecurities: z.boolean().optional().describe("是否返回话题关联证券（默认 true；只需话题清单时传 false 精简响应）"),
      withCloseReading: z.boolean().optional().describe("是否返回话题精读长文（默认 true；传 false 可大幅减小响应体积）"),
    },
    examples: [
      { title: "版别 + 精简开关", args: { startDate: "2026-09-01", endDate: "2026-09-05", categoryList: ["morningBriefing"], withCloseReading: false }, expect: { requests: [{ method: "POST", path: "/application/open-ai/hot-topic/getList", body: { startDate: "2026-09-01", endDate: "2026-09-05", categoryList: ["morningBriefing"], withCloseReading: false, size: 20, from: 0 } }] } },
    ],
  },
  {
    name: "gangtise_management_discuss_announcement",
    tier: "core",
    description: "从财报公告（半年报/年报）中提取 AI 整理的管理层讨论内容，仅支持中报和年报。",
    endpointKey: "ai.management-discuss-announcement",
    paginated: false,
    inputSchema: {
      securityCode: nonEmptyString.describe("证券代码，如 '600519.SH'"),
      reportDate: quarterEndDate("06-30", "12-31").describe("xxxx-06-30（中报）或 xxxx-12-31（年报）"),
      discussionDimension: z.enum(["businessOperation", "financialPerformance", "developmentAndRisk", "all"]).describe("businessOperation=经营情况 | financialPerformance=财务表现 | developmentAndRisk=发展与风险 | all=全部维度（必填）"),
    },
    examples: [
      { title: "年报", args: { securityCode: "600519.SH", reportDate: "2025-12-31", discussionDimension: "all" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/management-discuss/from-announcement", body: { securityCode: "600519.SH", reportDate: "2025-12-31", discussionDimension: "all" } }] } },
      { title: "一季报日期本地拒绝", args: { securityCode: "600519.SH", reportDate: "2025-03-31", discussionDimension: "all" }, expect: { rejects: /季末日/ } },
    ],
  },
  {
    name: "gangtise_management_discuss_earnings_call",
    tier: "core",
    description: "从业绩会会议纪要中提取 AI 整理的管理层讨论内容。",
    endpointKey: "ai.management-discuss-earnings-call",
    paginated: false,
    inputSchema: {
      securityCode: nonEmptyString.describe("证券代码，如 '600519.SH'"),
      reportDate: quarterEndDate("03-31", "06-30", "09-30", "12-31").describe("xxxx-03-31 | xxxx-06-30 | xxxx-09-30 | xxxx-12-31"),
      discussionDimension: z.enum(["businessOperation", "financialPerformance", "developmentAndRisk"]).describe("businessOperation=经营情况 | financialPerformance=财务表现 | developmentAndRisk=发展与风险（必填）"),
    },
    examples: [
      { title: "三季度", args: { securityCode: "600519.SH", reportDate: "2025-09-30", discussionDimension: "businessOperation" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/management-discuss/from-earningsCall", body: { securityCode: "600519.SH", reportDate: "2025-09-30", discussionDimension: "businessOperation" } }] } },
    ],
  },
]

export const downloadSpecs: DownloadToolSpec[] = [
  {
    name: "gangtise_knowledge_resource_download",
    tier: "core",
    description: "按资源类型和 sourceId 下载知识库资源文件。sourceId 来自 gangtise_knowledge_batch 返回结果。",
    endpointKey: "ai.knowledge-resource.download",
    inputSchema: {
      resourceType: intLiteralEnum([10, 11, 20, 40, 50, 51, 60, 70, 80, 90]).describe("资源类型（必填）：10=研报 | 11=外资研报 | 20=内部 | 40=观点 | 50=公告 | 51=港股公告 | 60=纪要 | 70=调研 | 80=网络纪要 | 90=公众号"),
      sourceId: nonEmptyString.describe("资源 ID，来自 gangtise_knowledge_batch 返回结果（必填）"),
    },
    examples: [
      { title: "resourceType + sourceId", args: { resourceType: 10, sourceId: "src-1" }, expect: { requests: [{ method: "GET", path: "/application/open-data/ai/resource/download", query: { resourceType: "10", sourceId: "src-1" } }] } },
    ],
  },
]

function aiContentRun(endpointKey: string): ToolSpec["run"] {
  return async ({ client }, args) => {
    const result = await client.call(endpointKey, args) as { content?: string }
    if (typeof result?.content === "string") {
      if (!result.content.trim()) return textResult("该证券暂无相关 AI 生成内容（后端未生成或数据缺失）。")
      return contentResult(await buildTextResult(result.content))
    }
    return contentResult(await buildToolContent(normalizeRows(result)))
  }
}

function defineAsyncPair(
  opts: AiToolOptions,
  config: {
    name: string
    tier: ToolSpec["tier"]
    description: string
    inputSchema: Record<string, z.ZodTypeAny>
    submitEndpoint: string
    pollEndpoint: string
    submitIdField: string
    checkName: string
    checkDescription: string
    examples: Examples
    checkExamples: Examples
  },
): ToolSpec[] {
  // Submit + poll tool
  const submit = defineTool({
    name: config.name,
    tier: config.tier,
    // NOT read-only: submitting creates a billed, non-idempotent task (the submit
    // endpoint carries retry: "no-replay"). Leave the hint false so agentic clients
    // confirm before auto-invoking. The _check poll tool below stays read-only.
    access: "write",
    endpoint: config.submitEndpoint,
    description: config.description + `任务计费且不可重复提交：超时/失败后用返回的 dataId 调 ${config.checkName} 续查，切勿重新提交。`,
    input: {
      ...config.inputSchema,
      // 默认值来自 GANGTISE_MCP_ASYNC_TIMEOUT_MS，写死「55」在改过该环境变量的部署上就是假的。
      waitSeconds: z.number().int().min(0).max(180).optional().describe(`最长等待秒数（默认 ${Math.round(opts.asyncTimeoutMs / 1000)}，最大 180）；超时返回 dataId，用对应 *_check 工具续查`),
    },
    examples: config.examples,
    run: async ({ client }, args) => {
      // Absolute deadline from the tool call's start: submit itself can take up
      // to the request timeout (~30s), and that time must count against the wait
      // budget — otherwise submit + poll can jointly exceed the client's ~60s
      // cutoff and the billed task's dataId is lost before it reaches the model.
      const startedAt = Date.now()
      const { waitSeconds, ...submitArgs } = args
      const timeoutMs = typeof waitSeconds === "number" ? waitSeconds * 1000 : opts.asyncTimeoutMs
      const submitResult = await client.call(config.submitEndpoint, submitArgs) as Record<string, string> | null
      const dataId = submitResult?.[config.submitIdField]
      if (!dataId) throw new Error(`提交成功但响应里没有 ${config.submitIdField}（返回结构可能已变更）。请重试；持续出现请带上工具名与入参报障。`)

      // waitSeconds=0 (or a submit that already ate the whole budget) hands back
      // the dataId immediately — no wasted, billed poll round-trip.
      const remainingMs = timeoutMs - (Date.now() - startedAt)
      if (remainingMs <= 0) {
        return textResult(JSON.stringify({ dataId, status: "timeout", hint: `Call ${config.checkName} with this dataId in ~3 minutes` }))
      }

      try {
        const polled = await pollAsyncContent(client, config.pollEndpoint, dataId, remainingMs)
        if (!polled.content.trim()) return textResult("任务已完成，但 AI 内容为空（后端未生成或数据缺失）。")
        return contentResult(await buildTextResult(polled.content))
      } catch (err) {
        if (err instanceof AsyncTimeoutError) {
          return textResult(JSON.stringify({ dataId, status: "timeout", hint: `Call ${config.checkName} with this dataId in ~3 minutes` }))
        }
        // Submit already succeeded (and may be billed); never swallow the dataId on
        // a mid-poll failure, or the user can't recover the job via _check.
        // 410111 / 140002 are terminal backend failures; anything else is
        // transient → suggest retry.
        if (isAsyncFailed(err)) {
          return { ...textResult(JSON.stringify({ dataId, status: "failed", error: errorMessage(err) })), isError: true }
        }
        return textResult(JSON.stringify({ dataId, status: "error", error: errorMessage(err), hint: `Call ${config.checkName} with this dataId to retry` }))
      }
    },
  })

  // Single-shot check tool
  const check = defineTool({
    name: config.checkName,
    tier: config.tier,
    access: "read",
    endpoint: config.pollEndpoint,
    description: config.checkDescription + `dataId 来自 ${config.name} 的超时/错误响应；pending 表示仍在生成，间隔 1-3 分钟再查。`,
    input: { dataId: nonEmptyString.describe("异步任务 ID，来自对应提交工具的超时/错误响应") },
    examples: config.checkExamples,
    run: async ({ client }, args) => {
      const { dataId } = args as { dataId: string }
      try {
        const result = await client.call(config.pollEndpoint, { dataId }) as { content?: string } | null
        // content: "" is a *finished* task with empty output (matches the poll
        // loop's `content != null` check) — a truthiness test would report the
        // billed task as pending forever.
        if (result?.content != null) {
          if (!result.content.trim()) return textResult("任务已完成，但 AI 内容为空（后端未生成或数据缺失）。")
          return contentResult(await buildTextResult(result.content))
        }
        return textResult(JSON.stringify({ status: "pending", dataId }))
      } catch (err) {
        if (isAsyncFailed(err))
          return { ...textResult(JSON.stringify({ status: "failed", dataId, error: errorMessage(err) })), isError: true }
        if (isAsyncPending(err))
          return textResult(JSON.stringify({ status: "pending", dataId }))
        throw err
      }
    },
  })

  return [submit, check]
}

/** 异步工具的描述里带着默认等待时长（来自 GANGTISE_MCP_ASYNC_TIMEOUT_MS），所以本族按选项构建。 */
export function aiFamily(opts: AiToolOptions): FamilyModule {
  return {
    name: "ai",
    endpoints: aiEndpoints,
    tools: [
      ...jsonSpecs.map(defineJsonTool),
      // gangtise_theme_tracking: registered directly to enforce the future-date guard
      defineTool({
        name: "gangtise_theme_tracking",
        tier: "core",
        access: "read",
        endpoint: "ai.theme-tracking",
        description: "获取指定主题的每日跟踪报告（早报或晚报版），需传入主题 ID 和日期。",
        input: {
          themeId: nonEmptyString.describe("主题 ID，来自 gangtise_concept_search（必填）"),
          date: dateString.describe("YYYY-MM-DD（必填）"),
          type: z.union([z.enum(["morning", "night"]), enumList(z.enum(["morning", "night"]))]).optional().describe("morning=早报 | night=晚报；可传单个值或数组"),
        },
        run: async ({ client }, args) => {
          const { date, type, ...rest } = args as { date: string; type?: string | string[]; [k: string]: unknown }
          const inputDate = new Date(`${date}T00:00:00+08:00`)
          if (Number.isNaN(inputDate.getTime())) {
            throw new ValidationError(`date 格式无效：'${date}'，应为 YYYY-MM-DD。`)
          }
          const diffDays = Math.floor((todayDate().getTime() - inputDate.getTime()) / 86_400_000)
          // 取数窗口随账号权限变化，MCP 不硬编码拦截过旧日期 —— 超范围由上游报 110003
          // （errors.ts 的 ERROR_HINTS 会把人话贴在错误消息上）。
          // 未来日期是例外：没有账号能拿到明天的早报，且上游对未来日期的行为未证；
          // 本工具 50 积分/次，保留这条零成本本地拒绝。
          if (diffDays < 0) {
            throw new ValidationError(`date 不能晚于当前日期（${today()}）。`)
          }
          const body: Record<string, unknown> = { date, ...rest }
          if (type !== undefined) body.type = Array.isArray(type) ? type : [type]
          const result = await client.call("ai.theme-tracking", body)
          return contentResult(await buildToolContent(normalizeRows(result)))
        },
        examples: [
          { title: "单个 type 包成数组", args: { themeId: "121000130", date: "2026-09-01", type: "morning" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/theme-tracking", body: { date: "2026-09-01", themeId: "121000130", type: ["morning"] } }] } },
          { title: "未来日期本地拒绝", args: { themeId: "121000130", date: "2099-01-01" }, expect: { rejects: /不能晚于当前日期/ } },
        ],
      }),
      ...downloadSpecs.map(defineDownloadTool),
      // Synchronous AI tools: fetch pre-generated content (returns it directly).
      defineTool({
        name: "gangtise_one_pager",
        tier: "core",
        access: "read",
        endpoint: "ai.one-pager",
        description: "获取指定证券的 AI 一页纸投资摘要，返回 Markdown 内容。",
        input: { securityCode: nonEmptyString.describe("A 股或港股证券代码") },
        run: aiContentRun("ai.one-pager"),
        examples: [
          { title: "securityCode", args: { securityCode: "600519.SH" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/one-pager", body: { securityCode: "600519.SH" } }] } },
        ],
      }),
      defineTool({
        name: "gangtise_investment_logic",
        tier: "core",
        access: "read",
        endpoint: "ai.investment-logic",
        description: "获取指定证券的 AI 投资逻辑梳理报告，返回 Markdown 内容。",
        input: { securityCode: nonEmptyString.describe("A 股或港股证券代码") },
        run: aiContentRun("ai.investment-logic"),
        examples: [
          { title: "securityCode", args: { securityCode: "00700.HK" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/investment-logic", body: { securityCode: "00700.HK" } }] } },
        ],
      }),
      defineTool({
        name: "gangtise_peer_comparison",
        tier: "core",
        access: "read",
        endpoint: "ai.peer-comparison",
        description: "获取指定证券的 AI 同业竞争格局对比报告，返回 Markdown 内容。",
        input: { securityCode: nonEmptyString.describe("A 股或港股证券代码") },
        run: aiContentRun("ai.peer-comparison"),
        examples: [
          { title: "securityCode", args: { securityCode: "600519.SH" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/peer-comparison", body: { securityCode: "600519.SH" } }] } },
        ],
      }),
      defineTool({
        name: "gangtise_research_outline",
        tier: "core",
        access: "read",
        endpoint: "ai.research-outline",
        description: "获取指定证券的 AI 生成公司研究提纲，返回 Markdown 内容。",
        input: { securityCode: nonEmptyString.describe("仅支持 A 股证券代码") },
        run: aiContentRun("ai.research-outline"),
        examples: [
          { title: "securityCode", args: { securityCode: "600519.SH" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/research-outline", body: { securityCode: "600519.SH" } }] } },
        ],
      }),
      // Async tools: earnings-review
      ...defineAsyncPair(opts, {
        name: "gangtise_earnings_review",
        tier: "core",
        description: `生成 AI 业绩点评报告。提交任务后等待最多 waitSeconds 秒（默认 ${Math.round(opts.asyncTimeoutMs / 1000)}s），超时返回 dataId 供 gangtise_earnings_review_check 续查。`,
        inputSchema: {
          securityCode: nonEmptyString.describe("仅支持 A 股证券代码"),
          period: nonEmptyString.regex(/^\d{4}(q1|interim|q3|annual)$/, "格式：<年份>q1|interim|q3|annual（小写），如 2025q3").describe("报告期，格式 <年份>q1 | <年份>interim | <年份>q3 | <年份>annual，如 2025q3；仅覆盖最近 6 期"),
        },
        submitEndpoint: "ai.earnings-review.get-id",
        pollEndpoint: "ai.earnings-review.get-content",
        submitIdField: "dataId",
        checkName: "gangtise_earnings_review_check",
        checkDescription: "按 dataId 查询业绩点评任务的生成状态。",
        examples: [
          { title: "提交后立即轮询；waitSeconds 不进 body", args: { securityCode: "600519.SH", period: "2025q3", waitSeconds: 5 }, expect: { requests: [
              { method: "POST", path: "/application/open-ai/agent/earnings-review-getcontent", body: { dataId: "mock-data-id" } },
              { method: "POST", path: "/application/open-ai/agent/earnings-review-getid", body: { securityCode: "600519.SH", period: "2025q3" } },
            ] } },
          { title: "waitSeconds=0 只提交不轮询", args: { securityCode: "600519.SH", period: "2025annual", waitSeconds: 0 }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/earnings-review-getid", body: { securityCode: "600519.SH", period: "2025annual" } }] } },
          { title: "报告期格式本地拒绝", args: { securityCode: "600519.SH", period: "2025Q3" }, expect: { rejects: /at period/ } },
        ],
        checkExamples: [
          { title: "dataId", args: { dataId: "data-1" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/earnings-review-getcontent", body: { dataId: "data-1" } }] } },
        ],
      }),
      // Async tools: viewpoint-debate
      ...defineAsyncPair(opts, {
        name: "gangtise_viewpoint_debate",
        tier: "core",
        description: `对给定投资观点生成 AI 多空辩论报告。提交任务后等待最多 waitSeconds 秒（默认 ${Math.round(opts.asyncTimeoutMs / 1000)}s），超时返回 dataId 供对应 *_check 工具续查。`,
        inputSchema: {
          viewpoint: nonEmptyString.max(1000).describe("投资观点文本（最多 1000 字）"),
        },
        submitEndpoint: "ai.viewpoint-debate.get-id",
        pollEndpoint: "ai.viewpoint-debate.get-content",
        submitIdField: "dataId",
        checkName: "gangtise_viewpoint_debate_check",
        checkDescription: "按 dataId 查询多空辩论任务的生成状态。",
        examples: [
          { title: "提交后立即轮询", args: { viewpoint: "白酒行业将在 2027 年触底", waitSeconds: 5 }, expect: { requests: [
              { method: "POST", path: "/application/open-ai/agent/viewpoint-debate-getcontent", body: { dataId: "mock-data-id" } },
              { method: "POST", path: "/application/open-ai/agent/viewpoint-debate-getid", body: { viewpoint: "白酒行业将在 2027 年触底" } },
            ] } },
        ],
        checkExamples: [
          { title: "dataId", args: { dataId: "data-2" }, expect: { requests: [{ method: "POST", path: "/application/open-ai/agent/viewpoint-debate-getcontent", body: { dataId: "data-2" } }] } },
        ],
      }),
    ],
  }
}
