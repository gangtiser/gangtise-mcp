import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { registerJsonTool, registerDownloadTool, buildToolContent, type JsonToolSpec, type DownloadToolSpec } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"
import { normalizeRows } from "../core/normalize.js"
import { dateTimeDesc } from "../core/dateContext.js"
import { errorMessage } from "../core/errors.js"

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
      startTime: z.string().optional().describe(dateTimeDesc()),
      endTime: z.string().optional().describe(dateTimeDesc()),
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
      startTime: z.string().optional().describe(dateTimeDesc()),
      endTime: z.string().optional().describe(dateTimeDesc()),
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
      institutionList: z.array(z.string()).optional(),
      categoryList: z.array(z.string()).optional().describe("earningsCall=业绩会 | strategyMeeting=策略会 | fundRoadshow=路演 | shareholdersMeeting=股东大会 | maMeeting=并购 | specialMeeting=专题会 | companyAnalysis=公司分析 | industryAnalysis=行业分析 | other=其他"),
      startTime: z.string().optional().describe(dateTimeDesc()),
      endTime: z.string().optional().describe(dateTimeDesc()),
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
      startTime: z.string().optional().describe(dateTimeDesc()),
      endTime: z.string().optional().describe(dateTimeDesc()),
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
      contentType: z.string().describe("original=原始音频 | asr=语音转文字 | summary=AI摘要（必填）"),
    },
  },
  {
    name: "gangtise_my_conference_download",
    description: "下载会议录音资源，返回 ASR 转写或 AI 摘要。",
    endpointKey: "vault.my-conference.download",
    inputSchema: {
      conferenceId: z.string().describe("会议 ID，来自 gangtise_my_conference_list"),
      contentType: z.string().describe("asr=语音转文字 | summary=AI摘要（必填，不支持原始音频）"),
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
      description: "查询可用的微信群 ID 和群名称列表。",
      inputSchema: {
        from: z.number().int().min(0).optional(),
        size: z.number().int().min(1).optional().describe("最大返回条数；省略则自动翻页拉取全部群（接口无 total，按页上限 50 串行翻页）"),
        roomName: z.array(z.string()).optional().describe("按群名称筛选；多个会以逗号拼接发送"),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const { roomName, size: requestedSize, from } = args as { roomName?: string[]; size?: number; from?: number }
      const baseBody: Record<string, unknown> = {}
      if (roomName && roomName.length > 0) baseBody.roomName = roomName.join(",")

      // No `total` in the response and the server caps each page at 50, so omitting
      // `size` must serial-page to fetch every group (a single size>50 request would
      // silently return only 50). `size`, when given, is a total cap across pages.
      const MAX_PAGE = 50
      const MAX_PAGES = 1000
      const collected: unknown[] = []
      let firstPage: Record<string, unknown> | null = null
      let cursor = typeof from === "number" ? from : 0
      let hitPageCap = false
      let unexpectedShape = false
      const failedPages: Array<{ from: number; size: number; error: string }> = []

      for (let page = 0; ; page++) {
        const remaining = requestedSize === undefined ? MAX_PAGE : requestedSize - collected.length
        if (requestedSize !== undefined && remaining <= 0) break
        const pageSize = Math.min(MAX_PAGE, remaining)
        let pageData: Record<string, unknown>
        try {
          pageData = (await client.call("vault.wechat-chatroom.list", { ...baseBody, from: cursor, size: pageSize })) as Record<string, unknown>
        } catch (err) {
          // First page fails fast (nothing collected yet); a later page fails soft so
          // the rows already fetched survive — same contract as client.requestPaginated.
          if (page === 0) throw err
          failedPages.push({ from: cursor, size: pageSize, error: errorMessage(err) })
          break
        }
        if (firstPage === null) firstPage = pageData
        const list = Array.isArray(pageData?.chatRoomList) ? (pageData.chatRoomList as unknown[]) : null
        if (list === null) {
          // First response not a list shape → return it untouched; a later page losing
          // shape keeps the rows already collected (loud _partial, not silent loss).
          if (page === 0) return contentResult(await buildToolContent(normalizeRows(firstPage)))
          unexpectedShape = true
          break
        }
        collected.push(...list)
        if (list.length < pageSize) break
        if (page + 1 >= MAX_PAGES) {
          hitPageCap = true
          break
        }
        cursor += list.length
      }

      const out: Record<string, unknown> = { ...(firstPage ?? {}), chatRoomList: collected }
      const reasons: string[] = []
      if (hitPageCap) reasons.push("page_cap")
      if (unexpectedShape) reasons.push("unexpected_page_shape")
      if (failedPages.length > 0) {
        reasons.push("failed_pages")
        out._failed_pages = failedPages
      }
      if (reasons.length > 0) {
        out._partial = true
        out._partial_reason = reasons.join(",")
      }
      return contentResult(await buildToolContent(normalizeRows(out)))
    }),
  )

  server.registerTool(
    "gangtise_stock_pool_stocks",
    {
      description: "查询指定自选股池中的证券列表。不传 poolIdList 时默认返回所有池的股票。",
      inputSchema: {
        poolIdList: z.array(z.string()).optional().describe("池 ID 列表，来自 gangtise_stock_pool_list；不传默认 ['all'] 即所有池"),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const { poolIdList = ["all"] } = args as { poolIdList?: string[] }
      const result = await client.call("vault.stock-pool.stocks", { poolIdList })
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )
}
