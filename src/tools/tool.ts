import { openAsBlob } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { isAsyncPending, pollUntilReady } from "../core/asyncContent.js"
import { downloadToResult } from "../core/download.js"
import { ENDPOINTS } from "../core/endpoints.js"
import { ApiError, AsyncTimeoutError, ValidationError } from "../core/errors.js"
import { buildDownloadContent } from "../core/present.js"
import type { GangtiseClient } from "../core/client.js"
import { defineJsonTool, defineTool, type FamilyModule } from "../mcp/define.js"
import { textResult } from "../mcp/handler.js"
import { nonEmptyList, nonEmptyString } from "../mcp/schemas.js"
import type { AiToolOptions } from "./ai.js"
import { toolEndpoints } from "./tool.endpoints.js"

/** 带正文时服务端每次最多 5 条。 */
const CONTENT_MAX_SIZE = 5
/** 解析接口单文件上限。 */
const FILE_PARSE_MAX_BYTES = 100 * 1024 * 1024

/** 取一次解析结果。未就绪（140001）返回 undefined，就绪返回 ZIP 的下载结果。免费，只有提交计费。 */
async function fetchParseResult(client: GangtiseClient, taskId: string) {
  try {
    return await downloadToResult(client, ENDPOINTS["tool.file-parse.result"], {}, { taskId })
  } catch (error) {
    if (isAsyncPending(error)) return undefined
    throw error
  }
}

const pending = (taskId: string) => textResult(JSON.stringify({ taskId, status: "pending", hint: "解析还没完成，约 1 分钟后用 gangtise_file_parse_check 取结果；不要重新提交（会再计费）" }))

export const toolFamily = (opts: AiToolOptions): FamilyModule => ({
  name: "tool",
  routingHint: "联网：平台外的公开网页用 gangtise_web_search；平台内的研报、纪要、公告优先用对应 *_list。",
  endpoints: toolEndpoints,
  tools: [
    {
      ...defineJsonTool({
        name: "gangtise_web_search",
        tier: "core",
        description: "投研定向检索公开网页：服务端已做转载去重、信源分级（tier T0–T3）与内容打标，零结果时 hints 给放宽建议。检索词原样发送、不做意图改写。⚠️ 排序是 tier 升序 → publishTime 降序 → 相关性，首条不等于最相关。publishTime 是规则判定的发布日期，判不出为 null（不代表网页没有日期）；indexTime 是索引记录的时间、不保证是发布时间，做时点判断用 publishTime。flags 标 rumor 传闻 / forward 转载 / disclaimer 免责声明 / toutSuspect 疑似荐股 / paywall 付费墙。",
        endpointKey: "tool.web-search",
        inputSchema: {
          query: nonEmptyString.max(200).describe("检索词，1–200 字；要限定站点用 siteList"),
          size: z.number().int().min(1).max(20).optional().describe(`返回条数（去重过滤之后，不足不补），默认 10；includeContent 时最多 ${CONTENT_MAX_SIZE}、省略即 ${CONTENT_MAX_SIZE}`),
          freshness: z.enum(["day", "week", "month", "none"]).optional().describe("按 publishTime 限时效，默认 none；⚠️ day / week / month 会连带丢掉 publishTime 判不出（null）的结果"),
          minTier: z.enum(["T0", "T1", "T2", "T3"]).optional().describe("最低信源等级，默认 T3（不过滤）"),
          siteList: nonEmptyList().optional().describe("限定注册域或子域（如 csrc.gov.cn），相互为或、子域按后缀匹配，去重后最多 10 个"),
          includeContent: z.boolean().optional().describe("返回网页正文 content（Markdown），个别页面取不到时为 null"),
          maxContentChars: z.number().int().min(1000).max(20000).optional().describe("每条正文字符上限，默认 8000，仅 includeContent 时生效；超出截断并标 contentTruncated"),
        },
        transformBody: (body) => {
          const out = { ...body }
          if (out.includeContent === true) {
            if (out.size === undefined) out.size = CONTENT_MAX_SIZE
            else if ((out.size as number) > CONTENT_MAX_SIZE) throw new ValidationError(`includeContent=true 时 size 最多 ${CONTENT_MAX_SIZE}（当前 ${String(out.size)}）：调小 size，或不取正文（最多 20 条摘要）。`)
          }
          if (Array.isArray(out.siteList)) {
            // 服务端按去重后的个数计上限。
            const sites = [...new Set(out.siteList as string[])]
            if (sites.length > 10) throw new ValidationError(`siteList 去重后 ${sites.length} 个，最多 10 个。`)
            out.siteList = sites
          }
          return out
        },
      }),
      // 结果来自公开网页，不是本平台的数据。
      openWorld: true,
    },
    defineTool({
      name: "gangtise_file_parse",
      tier: "extended",
      // 提交即按页计费、不可重复提交：不是只读；不改动已有数据，重复提交会再计费一次。
      access: "write",
      idempotent: false,
      requires: ["gangtise_file_parse_check"],
      endpoint: "tool.file-parse.submit",
      description: "把本机 PDF 解析成 Markdown 正文与图片，结果是 ZIP（file.md + images/），返回落盘路径。提交时按实际页数一次性计费；单文件最多 100MB、500 页，同时最多 10 个解析任务。filePath 是运行本服务的这台机器上的路径。提交后等待最多 waitSeconds 秒，没完成就返回 taskId：用 gangtise_file_parse_check 取结果，切勿重新提交（重新提交会再计费）。平台内的研报、公告先用 gangtise_download 的 Markdown 格式（fileType=2），不必解析。",
      input: {
        filePath: nonEmptyString.describe("本机 PDF 文件路径，绝对路径最稳"),
        waitSeconds: z.number().int().min(0).max(180).optional().describe(`最长等待秒数（默认 ${Math.round(opts.asyncTimeoutMs / 1000)}，最大 180）；解析一般要几分钟，超时返回 taskId`),
      },
      run: async ({ client }, args) => {
        const startedAt = Date.now()
        const { filePath, waitSeconds } = args as { filePath: string; waitSeconds?: number }
        const resolved = path.resolve(filePath)
        // 拒绝的理由都在上传之前查完：提交就计费，注定失败的文件不该先传一遍。
        const stat = await fs.stat(resolved).catch(() => undefined)
        if (!stat) throw new ValidationError(`找不到文件：${filePath}`)
        if (!stat.isFile()) throw new ValidationError(`不是文件：${filePath}`)
        if (stat.size === 0) throw new ValidationError(`文件是空的：${filePath}`)
        if (stat.size > FILE_PARSE_MAX_BYTES) throw new ValidationError(`文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB，解析接口单文件最多 100MB。`)
        if (path.extname(resolved).toLowerCase() !== ".pdf") throw new ValidationError(`只支持 PDF：${filePath}`)
        const blob = await openAsBlob(resolved, { type: "application/pdf" })
        const submitted = await client.uploadFile("tool.file-parse.submit", { filename: path.basename(resolved), blob }) as { taskId?: unknown } | null
        const taskId = submitted?.taskId
        if (taskId === undefined || taskId === null || taskId === "") {
          throw new ApiError("解析任务已提交，但响应里没有 taskId（返回结构可能已变更）。请带上工具名与文件报障，不要直接重新提交。", undefined, undefined, submitted)
        }
        const id = String(taskId)
        // 等待时长从调用开始算：上传本身可能就占掉不少。
        const remainingMs = (typeof waitSeconds === "number" ? waitSeconds * 1000 : opts.asyncTimeoutMs) - (Date.now() - startedAt)
        if (remainingMs <= 0) return pending(id)
        try {
          const result = await pollUntilReady(() => fetchParseResult(client, id), (value) => value ?? undefined, id, remainingMs)
          return { content: await buildDownloadContent(result) }
        } catch (error) {
          // 已提交（已计费）：任何取结果的失败都不能把 taskId 弄丢。
          if (error instanceof AsyncTimeoutError) return pending(id)
          throw new ApiError(`解析任务 ${id} 已提交，取结果失败：${error instanceof Error ? error.message : String(error)}。稍后用 gangtise_file_parse_check 按这个 taskId 取，不要重新提交。`)
        }
      },
    }),
    defineTool({
      name: "gangtise_file_parse_check",
      tier: "extended",
      access: "read",
      endpoint: "tool.file-parse.result",
      description: "按 taskId 取 PDF 解析结果 ZIP（file.md + images/），返回落盘路径；还没完成时返回 pending，约 1 分钟后再取。",
      input: { taskId: nonEmptyString.describe("解析任务 ID，来自 gangtise_file_parse") },
      run: async ({ client }, args) => {
        const { taskId } = args as { taskId: string }
        const result = await fetchParseResult(client, taskId)
        return result ? { content: await buildDownloadContent(result) } : pending(taskId)
      },
    }),
  ],
})
