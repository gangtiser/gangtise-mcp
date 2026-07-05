import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { registerJsonTool, registerDownloadTool, buildToolContent, type JsonToolSpec, type DownloadToolSpec } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"
import { normalizeRows } from "../core/normalize.js"
import { dateTimeDesc, dateTimeString } from "../core/dateContext.js"

const listSpecs: JsonToolSpec[] = [
  {
    name: "gangtise_drive_list",
    description: "查询 Gangtise 云盘文件列表，支持按关键词、文件类型、空间类型、时间范围筛选。",
    endpointKey: "vault.drive.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      keyword: z.string().optional(),
      fileTypeList: z.array(z.number().int()).optional().describe("1=文档 | 2=图片 | 3=视频 | 4=公众号 | 5=其他"),
      spaceTypeList: z.array(z.number().int()).optional().describe("1=个人空间 | 2=企业空间"),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
    },
  },
  {
    name: "gangtise_record_list",
    description: "查询 Gangtise 语音录音转写列表，支持按关键词、类别、时间范围筛选。",
    endpointKey: "vault.record.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      keyword: z.string().optional(),
      categoryList: z.array(z.string()).optional().describe("upload=上传 | link=链接 | mobile=移动端 | gtNote=GT笔记 | pc=PC端 | share=分享"),
      spaceTypeList: z.array(z.number().int()).optional().describe("1=个人录音 | 2=企业录音"),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
    },
  },
  {
    name: "gangtise_my_conference_list",
    description: "查询我的会议录音列表，支持按证券、机构、类别、时间范围筛选。",
    endpointKey: "vault.my-conference.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      keyword: z.string().optional(),
      researchAreaList: z.array(z.string()).optional().describe("研究方向 ID，来自 gangtise_constant_list category=gangtiseIndustry（行业 1008001xx + 方向 122000xxx：宏观/策略/固收/金工/海外/其他）"),
      securityList: z.array(z.string()).optional(),
      institutionList: z.array(z.string()).optional().describe("机构 ID（牵头机构）：用 gangtise_institution_search categoryList=['leadInstitution'] 按名称搜；需全量枚举用 gangtise_lookup type=meeting-orgs"),
      categoryList: z.array(z.string()).optional().describe("earningsCall=业绩会 | strategyMeeting=策略会 | fundRoadshow=路演 | shareholdersMeeting=股东大会 | maMeeting=并购 | specialMeeting=专题会 | companyAnalysis=公司分析 | industryAnalysis=行业分析 | other=其他"),
      sourceList: z.array(z.number().int()).optional().describe("录制来源：1=企微会议助理 | 2=会议服务微信群（可多选，不传返回全部）"),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
    },
  },
  {
    name: "gangtise_wechat_message_list",
    description: "查询微信群消息列表，支持按群 ID、行业、类别、标签、时间范围筛选。",
    endpointKey: "vault.wechat-message.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      keyword: z.string().optional(),
      securityList: z.array(z.string()).optional().describe("证券代码列表，如 ['000001.SZ']"),
      wechatGroupIdList: z.array(z.string()).optional().describe("群 ID，来自 gangtise_wechat_chatroom_list"),
      industryIdList: z.array(z.string()).optional().describe("行业 ID，来自 gangtise_constant_list category=citicIndustry（1008001xx；wechat 只认中信码，传申万码会静默返全量）"),
      categoryList: z.array(z.string()).optional().describe("text=文字 | image=图片 | documents=文件 | url=链接"),
      tagList: z.array(z.string()).optional().describe("roadShow=路演 | research=调研 | strategyMeeting=策略会 | meetingSummary=会议纪要 | industryComment=行业点评 | companyComment=公司点评 | earningsReview=业绩点评"),
      startTime: dateTimeString.optional().describe(dateTimeDesc()),
      endTime: dateTimeString.optional().describe(dateTimeDesc()),
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

const downloadSpecs: DownloadToolSpec[] = [
  {
    name: "gangtise_drive_download",
    description: "按 fileId 从 Gangtise 云盘下载文件。",
    endpointKey: "vault.drive.download",
    inputSchema: {
      fileId: z.string().describe("文件 ID，来自 gangtise_drive_list"),
    },
  },
  {
    name: "gangtise_record_download",
    description: "下载语音录音转写内容，可选原始音频、ASR 文字或 AI 摘要。",
    endpointKey: "vault.record.download",
    inputSchema: {
      recordId: z.string().describe("录音 ID，来自 gangtise_record_list"),
      contentType: z.enum(["original", "asr", "summary"]).describe("original=原始音频 | asr=语音转文字 | summary=AI摘要（必填）"),
    },
  },
  {
    name: "gangtise_my_conference_download",
    description: "下载会议录音资源，返回 ASR 转写或 AI 摘要。",
    endpointKey: "vault.my-conference.download",
    inputSchema: {
      conferenceId: z.string().describe("会议 ID，来自 gangtise_my_conference_list"),
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
        roomName: z.array(z.string()).optional().describe("按群名称筛选；多个会以逗号拼接发送"),
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
        poolIdList: z.array(z.string()).min(1, "poolIdList 不能为空数组——查询所有池请省略该参数").optional().describe("池 ID 列表，来自 gangtise_stock_pool_list；不传默认 ['all'] 即所有池"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const { poolIdList = ["all"] } = args as { poolIdList?: string[] }
      const result = await client.call("vault.stock-pool.stocks", { poolIdList })
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )
}
