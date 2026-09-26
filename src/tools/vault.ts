import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { registerJsonTool, registerDownloadTool, type JsonToolSpec, type DownloadToolSpec } from "./registry.js"
import { buildToolContent } from "../core/present.js"
import { toolHandler, contentResult } from "../mcp/handler.js"
import { normalizeRows } from "../core/normalize.js"
import { ENDPOINTS } from "../core/endpoints.js"
import { ValidationError } from "../core/errors.js"
import { intLiteralEnum, nonEmptyString, nonEmptyList, enumList } from "../mcp/schemas.js"
import { dateTimeString } from "../core/dateContext.js"

/** 删池的后果说明只有一份，写在端点上（core/endpoints.ts），工具描述与确认闸门都读它。 */
const STOCK_POOL_DELETE_WARNING = ENDPOINTS["vault.stock-pool.delete"].destructive!.warning

export const listSpecs: JsonToolSpec[] = [
  {
    name: "gangtise_drive_list",
    description: "查询 Gangtise 云盘文件列表，支持按关键词、文件类型、空间类型、时间范围筛选。",
    endpointKey: "vault.drive.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      keyword: nonEmptyString.optional(),
      fileTypeList: enumList(intLiteralEnum([1, 2, 3, 4, 5])).optional().describe("1=文档 | 2=图片 | 3=视频 | 4=公众号 | 5=其他"),
      spaceTypeList: enumList(intLiteralEnum([1, 2])).optional().describe("1=个人空间 | 2=企业空间"),
      startTime: dateTimeString.optional(),
      endTime: dateTimeString.optional(),
    },
  },
  {
    name: "gangtise_record_list",
    description: "查询 Gangtise 语音录音转写列表，支持按关键词、类别、时间范围筛选。",
    endpointKey: "vault.record.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      keyword: nonEmptyString.optional(),
      categoryList: enumList(z.enum(["upload", "link", "mobile", "gtNote", "pc", "share"])).optional().describe("upload=上传 | link=链接 | mobile=移动端 | gtNote=GT笔记 | pc=PC端 | share=分享"),
      spaceTypeList: enumList(intLiteralEnum([1, 2])).optional().describe("1=个人录音 | 2=企业录音"),
      startTime: dateTimeString.optional(),
      endTime: dateTimeString.optional(),
    },
  },
  {
    name: "gangtise_my_conference_list",
    description: "查询我的会议录音列表，支持按证券、机构、类别、时间范围筛选。",
    endpointKey: "vault.my-conference.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      keyword: nonEmptyString.optional(),
      researchAreaList: nonEmptyList().optional().describe("研究方向 ID，接受两类码：行业码用 gangtise_constant_list category=citicIndustry（1008001xx，如食品饮料 100800119）；宏观/策略/固收/金工/海外/其他这类方向码用 category=gangtiseIndustry（122000xxx，该 category 只有这 6 条、不含行业）。本端点不支持申万码（104xxxxxx），传了会返 0 条而不报错"),
      securityList: nonEmptyList().optional(),
      institutionList: nonEmptyList().optional().describe("机构 ID（牵头机构）：用 gangtise_institution_search categoryList=['leadInstitution'] 按名称搜；需全量枚举用 gangtise_lookup type=meeting-orgs"),
      categoryList: enumList(z.enum(["earningsCall", "strategyMeeting", "fundRoadshow", "shareholdersMeeting", "maMeeting", "specialMeeting", "companyAnalysis", "industryAnalysis", "other"])).optional().describe("earningsCall=业绩会 | strategyMeeting=策略会 | fundRoadshow=路演 | shareholdersMeeting=股东大会 | maMeeting=并购 | specialMeeting=专题会 | companyAnalysis=公司分析 | industryAnalysis=行业分析 | other=其他"),
      sourceList: enumList(intLiteralEnum([1, 2])).optional().describe("录制来源：1=企微会议助理 | 2=会议服务微信群（可多选，不传返回全部）"),
      startTime: dateTimeString.optional(),
      endTime: dateTimeString.optional(),
    },
  },
  {
    name: "gangtise_wechat_message_list",
    description: "查询微信群消息列表，支持按群 ID、行业、类别、标签、时间范围筛选。",
    endpointKey: "vault.wechat-message.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      keyword: nonEmptyString.optional(),
      securityList: nonEmptyList().optional().describe("证券代码列表，如 ['000001.SZ']"),
      wechatGroupIdList: nonEmptyList().optional().describe("群 ID，来自 gangtise_wechat_chatroom_list"),
      industryIdList: nonEmptyList().optional().describe("行业 ID，来自 gangtise_constant_list category=citicIndustry（1008001xx）；本端点只认中信码，申万码（104xxxxxx）会被接口拒绝"),
      categoryList: enumList(z.enum(["text", "image", "documents", "url"])).optional().describe("text=文字 | image=图片 | documents=文件 | url=链接"),
      tagList: enumList(z.enum(["roadShow", "research", "strategyMeeting", "meetingSummary", "industryComment", "companyComment", "earningsReview"])).optional().describe("roadShow=路演 | research=调研 | strategyMeeting=策略会 | meetingSummary=会议纪要 | industryComment=行业点评 | companyComment=公司点评 | earningsReview=业绩点评"),
      startTime: dateTimeString.optional(),
      endTime: dateTimeString.optional(),
    },
  },
  {
    name: "gangtise_stock_pool_list",
    description: "查询用户的自选股池列表，返回池 ID 和名称。",
    endpointKey: "vault.stock-pool.list",
    paginated: false,
    inputSchema: {},
  },
]

export const downloadSpecs: DownloadToolSpec[] = [
  {
    name: "gangtise_drive_download",
    description: "按 fileId 从 Gangtise 云盘下载文件。",
    endpointKey: "vault.drive.download",
    inputSchema: {
      fileId: nonEmptyString.describe("文件 ID，来自 gangtise_drive_list"),
    },
  },
  {
    name: "gangtise_record_download",
    description: "下载语音录音转写内容，可选原始音频、ASR 文字或 AI 摘要。",
    endpointKey: "vault.record.download",
    inputSchema: {
      recordId: nonEmptyString.describe("录音 ID，来自 gangtise_record_list"),
      contentType: z.enum(["original", "asr", "summary"]).describe("original=原始音频 | asr=语音转文字 | summary=AI摘要（必填）"),
    },
  },
  {
    name: "gangtise_my_conference_download",
    description: "下载会议录音资源，返回 ASR 转写或 AI 摘要。",
    endpointKey: "vault.my-conference.download",
    inputSchema: {
      conferenceId: nonEmptyString.describe("会议 ID，来自 gangtise_my_conference_list"),
      contentType: z.enum(["asr", "summary"]).describe("asr=语音转文字 | summary=AI摘要（必填，不支持原始音频）"),
    },
  },
]

export function registerVaultTools(server: McpServer, client: GangtiseClient): void {
  for (const spec of listSpecs) {
    registerJsonTool(server, client, spec)
  }
  for (const spec of downloadSpecs) {
    registerDownloadTool(server, client, spec)
  }

  server.registerTool(
    "gangtise_wechat_chatroom_list",
    {
      description: "查询可用的微信群 ID 和群名称列表（服务端返回 {total, list}，按 total 自动并发翻页；省略 size 拉取全部群，传 size 取前 N 条）。",
      inputSchema: {
        from: z.number().int().min(0).optional().describe("起始行偏移（0-based），默认 0"),
        size: z.number().int().min(1).optional().describe("返回总行数上限；省略则拉取全部群"),
        roomName: nonEmptyList().optional().describe("按群名称筛选；多个会以逗号拼接发送"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const { roomName, from, size } = args as { roomName?: string[]; from?: number; size?: number }
      const body: Record<string, unknown> = {}
      if (typeof from === "number") body.from = from
      if (typeof size === "number") body.size = size
      // Upstream reads roomName as a comma-joined scalar (not an array), matching the CLI.
      if (roomName && roomName.length > 0) body.roomName = roomName.join(",")
      // The endpoint declares pagination, so client.call fans out pages by `total`
      // and merges them (with loud-partial markers). Omitting size fetches all groups.
      const result = await client.call("vault.wechat-chatroom.list", body)
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )

  server.registerTool(
    "gangtise_stock_pool_stocks",
    {
      description: "查询指定自选股池中的证券列表。不传 poolIdList 时默认返回所有池的股票。",
      inputSchema: {
        // Live-tested: upstream returns [] for an empty list instead of the
        // "all pools" default — reject it locally so the model omits the param.
        poolIdList: nonEmptyList().min(1, "poolIdList 不能为空数组——查询所有池请省略该参数").optional().describe("池 ID 列表，来自 gangtise_stock_pool_list；不传默认 ['all'] 即所有池"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const { poolIdList = ["all"] } = args as { poolIdList?: string[] }
      const result = await client.call("vault.stock-pool.stocks", { poolIdList })
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )

  // ─── 股票池写操作 ───
  // 本服务仅有的五个写工具，只动当前账号本人的自选股；其余 9x 个工具全是只读。
  // 三个逐条端点的失败藏在成功信封里，由 client 按端点上的 itemFailures 标记统一标注，
  // handler 这里不重复一遍。

  const poolId = nonEmptyString.describe("池 ID，来自 gangtise_stock_pool_list")
  // 🔴 有意不加 `.trim()`：zod 的 trim 是**转换**，会真的改掉发出去的值。而池名判重是
  // 整串精确比较（首尾空格不 trim），所以替调用方 trim 既改了用户指定的名字，又可能让
  // 一个本来不冲突的名字撞上已有池。只判「是不是全空白」，长度与发送都用原串。
  const poolName = z
    .string()
    .min(1, "池名不能为空")
    .max(10, "池名最多 10 个字符（中文算 1 个）")
    .refine((value) => value.trim().length > 0, "池名不能全是空白字符")
    .describe("池名，最多 10 个字符（中文算 1 个，超出报 230007）；不能与该账号已有的池重名（报 230006，判重是整串精确比较，首尾空格不 trim、大小写不归一）")
  const securityCodeList = nonEmptyList()
    .describe("证券代码列表，须带市场后缀且大小写敏感，如 ['600519.SH','00700.HK']。单池上限 10000 只")

  server.registerTool(
    "gangtise_stock_pool_create",
    {
      description:
        "新建自选股池（写操作，只动当前账号本人的自选股）。返回 {poolId, poolName}。每账号最多 30 个池。⚠️ **不重放**：池名不许重复，超时后自动重发会撞重名、把一次已经成功的创建报成失败。所以超时请先用 gangtise_stock_pool_list 查一眼建成没有，不要直接重试。",
      inputSchema: { poolName },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const result = await client.call("vault.stock-pool.create", { poolName: args.poolName })
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )

  server.registerTool(
    "gangtise_stock_pool_rename",
    {
      description:
        "自选股池改名（写操作）。返回 {poolId, poolName}。改回自己当前的名字算成功；用了别的池的名字报 230006。",
      inputSchema: { poolId, poolName },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const result = await client.call("vault.stock-pool.rename", { poolId: args.poolId, poolName: args.poolName })
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )

  server.registerTool(
    "gangtise_stock_pool_add_stock",
    {
      description:
        "把证券加进指定的自选股池（写操作）。重复加已在池内的证券算幂等成功。返回 {successList, failList}；🔴 单条失败（如代码写错）**不会**让整次调用报错，只标 _partial + failedItems——拿到结果先看有没有这个标记，否则会以为传进去的都加成功了。",
      inputSchema: { poolId, securityCodeList },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const result = await client.call("vault.stock-pool.add-stock", { poolId: args.poolId, securityCodeList: args.securityCodeList })
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )

  server.registerTool(
    "gangtise_stock_pool_remove_stock",
    {
      description:
        "把证券移出指定的自选股池（写操作）。移除本来就不在池内的证券算幂等成功；只动池内的关注关系，不删池。返回与单条失败标记同 gangtise_stock_pool_add_stock。",
      inputSchema: { poolId, securityCodeList },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const result = await client.call("vault.stock-pool.remove-stock", { poolId: args.poolId, securityCodeList: args.securityCodeList })
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )

  server.registerTool(
    "gangtise_stock_pool_delete",
    {
      description:
        `删除自选股池（写操作）。🔴 ${STOCK_POOL_DELETE_WARNING}另外四个写工具都能跑一次相反的操作还原，只有这一个不能——所以删之前先用 gangtise_stock_pool_list 核对 poolId 是哪个池、把池名念给用户确认，再把 confirm 置为 true。删一个不存在的池算幂等成功。返回与单条失败标记同 gangtise_stock_pool_add_stock。`,
      inputSchema: {
        poolIdList: nonEmptyList().describe("要删除的池 ID 列表，来自 gangtise_stock_pool_list"),
        // 有意用 optional boolean 而不是 literal(true)：literal 会让「没传」和「传了
        // false」都在 schema 层被拒成一句通用的 -32602，而**被拒时那句话恰恰是唯一
        // 会告诉调用方「这次要删掉什么」的话**。让所有非 true 的情形都走到闸门，
        // 拿到的就是端点上那段后果说明。
        confirm: z
          .boolean()
          .optional()
          .describe("必须显式传 true 才会发出请求。这是不可恢复操作的二次确认：请先向用户复述将被删除的池名并得到同意，不要仅因为被拒绝过就补上这个参数重试"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      // 网关读端点上的 destructive 标记，而不是把规则再抄一遍在这里：规则复制成两份，
      // 早晚只改其中一份。校验在取得任何网络资源之前，被拒时一个请求都不会发出去。
      assertConfirmed("vault.stock-pool.delete", args.confirm === true)
      const result = await client.call("vault.stock-pool.delete", { poolIdList: args.poolIdList })
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )
}

/** 不可逆端点的确认闸门。文案取自 `ENDPOINTS[key].destructive`，所以「这个请求会做什么」
 *  只有一份事实。 */
function assertConfirmed(endpointKey: string, confirmed: boolean): void {
  const destructive = ENDPOINTS[endpointKey]?.destructive
  if (!destructive || confirmed) return
  throw new ValidationError(`${destructive.warning}确认要执行请把 confirm 置为 true。`)
}

