import fs from "node:fs/promises"
import path from "node:path"

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { ENDPOINTS } from "../core/endpoints.js"
import { normalizeRows } from "../core/normalize.js"
import { downloadToResult, type DownloadResult } from "../core/download.js"
import { errorMessage } from "../core/errors.js"
import { createManagedTempDir } from "../core/tempCleanup.js"
import { INLINE_MAX_BYTES } from "../core/config.js"
import { withBilling } from "./billing.js"

const PREVIEW_ITEMS = 20
const TEXT_PREVIEW_CHARS = 4_000

/** 溢出文件的本地处理提示。仅在「server 与客户端共享文件系统 且 客户端获准访问该路径」
 *  时适用；不直接给 shell 命令。远程 MCP / 容器隔离 / 无文件权限的客户端继续走
 *  gangtise_read_response（read_response 自身的 owned-temp-path 校验不变；
 *  本地直读不受该 guard 保护，安全性依赖客户端自己的文件权限）。 */
const LOCAL_HINT_JSON =
  "该路径存的是完整 JSON；若本机可直接读取，请在本地做投影/过滤/聚合后只取所需结果，不要把整个文件读进上下文。"
const LOCAL_HINT_TEXT =
  "该路径存的是完整正文；若本机可直接读取，请在本地搜索/分段定位所需片段，不要把整个文件读进上下文。"

interface PaginatedShape {
  list: unknown[]
  [key: string]: unknown
}

function isPaginatedShape(value: unknown): value is PaginatedShape {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).list)
  )
}

const EMPTY_RESULT_HINT =
  "0 行结果：可能该条件下确无数据；也可能是参数不匹配——证券代码需含交易所后缀（600519.SH / 00700.HK / AAPL.O），可用 gangtise_securities_search 核实，并检查日期区间与市场是否匹配。"

/** Empty results are the costliest silent error in research: the model can't tell
 * "genuinely no data" from a param mismatch (missing code suffix / wrong market).
 * Returns a hinted payload when the result is empty, else undefined. Empty payloads
 * are tiny, so this always inlines and never spills. */
function emptyResultHint(normalized: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(normalized)) {
    return normalized.length === 0 ? { list: [], _hint: EMPTY_RESULT_HINT } : undefined
  }
  if (normalized !== null && typeof normalized === "object") {
    const list = (normalized as Record<string, unknown>).list
    if (list === null || (Array.isArray(list) && list.length === 0)) {
      return { ...(normalized as Record<string, unknown>), list: Array.isArray(list) ? list : [], _hint: EMPTY_RESULT_HINT }
    }
  }
  return undefined
}

export async function buildToolContent(normalized: unknown): Promise<Array<{ type: "text"; text: string }>> {
  const empty = emptyResultHint(normalized)
  if (empty !== undefined) {
    return [{ type: "text" as const, text: JSON.stringify(empty) }]
  }
  const json = JSON.stringify(normalized)
  const byteLength = Buffer.byteLength(json, "utf8")

  if (byteLength <= INLINE_MAX_BYTES) {
    return [{ type: "text" as const, text: json }]
  }

  const tempDir = await createManagedTempDir()
  const savedPath = path.join(tempDir, "response.json")
  await fs.writeFile(savedPath, json, "utf8")

  let preview: Record<string, unknown>

  if (isPaginatedShape(normalized)) {
    const { list, ...rest } = normalized
    const previewList = list.slice(0, PREVIEW_ITEMS)
    preview = {
      ...rest,
      list: previewList,
      _truncated: true,
      _saved_to: savedPath,
      _local_hint: LOCAL_HINT_JSON,
      _read_with: "gangtise_read_response",
      _total_bytes: byteLength,
      _total_items: list.length,
      _preview_count: previewList.length,
      has_more: list.length > PREVIEW_ITEMS,
      next_offset: list.length > PREVIEW_ITEMS ? previewList.length : null,
    }
  } else if (Array.isArray(normalized)) {
    const previewList = normalized.slice(0, PREVIEW_ITEMS)
    preview = {
      list: previewList,
      _truncated: true,
      _saved_to: savedPath,
      _local_hint: LOCAL_HINT_JSON,
      _read_with: "gangtise_read_response",
      _total_bytes: byteLength,
      _total_items: normalized.length,
      _preview_count: previewList.length,
      has_more: normalized.length > PREVIEW_ITEMS,
      next_offset: normalized.length > PREVIEW_ITEMS ? previewList.length : null,
    }
  } else {
    preview = {
      _truncated: true,
      _saved_to: savedPath,
      _local_hint: LOCAL_HINT_JSON,
      _read_with: "gangtise_read_response",
      _total_bytes: byteLength,
      _preview_count: 0,
      has_more: false,
    }
  }

  // Guard: if the preview itself exceeds the byte cap (large rows), shrink the
  // sample by halving until it fits, so the model still gets a few example rows to
  // learn field names and plan paging — instead of an all-or-nothing empty list.
  // The spill file still holds every item; has_more/next_offset point past the
  // sample so the reader continues via gangtise_read_response.
  if (Array.isArray(preview.list) && Buffer.byteLength(JSON.stringify(preview), "utf8") > INLINE_MAX_BYTES) {
    const fullPreviewList = preview.list as unknown[]
    let sample = fullPreviewList
    while (
      sample.length > 0 &&
      Buffer.byteLength(JSON.stringify({ ...preview, list: sample, _preview_count: sample.length }), "utf8") > INLINE_MAX_BYTES
    ) {
      sample = sample.slice(0, Math.floor(sample.length / 2))
    }
    const totalItems = preview._total_items
    if (sample.length > 0) {
      const more = typeof totalItems === "number" && totalItems > sample.length
      preview = { ...preview, list: sample, _preview_count: sample.length, has_more: more, next_offset: more ? sample.length : null }
    } else {
      // Even one row exceeds the budget — fall back to metadata-only, but surface
      // the first row's keys so the model still learns the field names.
      const { list: _dropped, ...metaOnly } = preview as Record<string, unknown> & { list?: unknown }
      const first = fullPreviewList[0]
      const firstItemKeys = first && typeof first === "object" && !Array.isArray(first) ? Object.keys(first as object) : undefined
      const anyLeft = typeof totalItems === "number" && totalItems > 0
      preview = { ...metaOnly, _preview_count: 0, ...(firstItemKeys ? { _first_item_keys: firstItemKeys } : {}), has_more: anyLeft, next_offset: anyLeft ? 0 : null }
    }
  }

  return [{ type: "text" as const, text: JSON.stringify(preview) }]
}

/**
 * Like buildToolContent but for plain text payloads (Markdown/HTML from AI
 * tools, downloads, etc.). Small text is returned inline; oversized text is
 * streamed to a temp .md file with a preview pointer so the MCP response never
 * blows the context window. Page the rest with gangtise_read_response.
 */
export async function buildTextResult(text: string): Promise<Array<{ type: "text"; text: string }>> {
  if (Buffer.byteLength(text, "utf8") <= INLINE_MAX_BYTES) {
    return [{ type: "text" as const, text }]
  }
  const meta = await spillTextMeta(text)
  return [{ type: "text" as const, text: JSON.stringify(meta) }]
}

/** Trims a slice end that would land inside a surrogate pair (4-byte chars like
 * emoji), which would emit an unpaired surrogate — mojibake or a hard parse
 * error for strict UTF-8 consumers. Shared with the read-back tool. */
export function alignSliceEnd(text: string, end: number): number {
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) return end - 1
  }
  return end
}

/** Writes oversized text to a temp .md file and returns the truncation-pointer metadata. */
async function spillTextMeta(text: string): Promise<Record<string, unknown>> {
  const tempDir = await createManagedTempDir()
  const savedPath = path.join(tempDir, "response.md")
  await fs.writeFile(savedPath, text, "utf8")

  const preview = text.slice(0, alignSliceEnd(text, TEXT_PREVIEW_CHARS))
  return {
    _truncated: true,
    _saved_to: savedPath,
    _local_hint: LOCAL_HINT_TEXT,
    _read_with: "gangtise_read_response",
    _total_bytes: Buffer.byteLength(text, "utf8"),
    _total_chars: text.length,
    _preview_chars: preview.length,
    has_more: text.length > preview.length,
    next_offset: text.length > preview.length ? preview.length : null,
    _preview: preview,
  }
}

/**
 * Serializes a DownloadResult for the MCP response. Oversized text payloads
 * (Markdown research reports, HTML opinions, ASR transcripts) are spilled to a
 * temp file with a preview pointer — same contract as buildTextResult — while
 * url/savedPath metadata stays inline untouched.
 */
export async function buildDownloadContent(result: DownloadResult): Promise<Array<{ type: "text"; text: string }>> {
  const json = JSON.stringify(result)
  if (result.text === undefined || Buffer.byteLength(json, "utf8") <= INLINE_MAX_BYTES) {
    return [{ type: "text" as const, text: json }]
  }
  const { text, ...rest } = result
  const meta = await spillTextMeta(text)
  return [{ type: "text" as const, text: JSON.stringify({ ...rest, ...meta }) }]
}

// Zod raw shape type (compatible with registerTool inputSchema)
type ZodShape = Record<string, z.ZodTypeAny>

export interface JsonToolSpec {
  name: string
  description: string
  endpointKey: string
  inputSchema: ZodShape
  /** Set true for paginated list endpoints — adds size/fetchAll params and default size: 20 */
  paginated?: boolean
  /**
   * 发请求前改写 body（如把时间字符串转 epoch 毫秒）。契约：
   * 同步、纯函数、必须返回新对象，不得原地改入参。
   * 调用点固定在 sanitizeArgs 之后、client.call 之前 —— 因此它看到的是
   * 已注入分页默认 size 的 body，且**不得**删改 from/size。
   * 抛错走既有 catch → errorMessage() → isError: true。
   */
  transformBody?: (body: Record<string, unknown>) => Record<string, unknown>
}

export interface DownloadToolSpec {
  name: string
  description: string
  endpointKey: string
  inputSchema: ZodShape
}

interface SanitizeOptions {
  paginated?: boolean
  fetchAll?: boolean
}

export function sanitizeArgs(
  args: Record<string, unknown>,
  opts: SanitizeOptions = {},
): Record<string, unknown> {
  const { fetchAll: _fetchAll, ...rest } = args
  if (opts.paginated) {
    if (opts.fetchAll) {
      delete rest.size
    } else if (rest.size === undefined) {
      rest.size = 20
    }
  }
  return rest
}

export function registerJsonTool(server: McpServer, client: GangtiseClient, spec: JsonToolSpec): void {
  const schema: ZodShape = spec.paginated
    ? {
        ...spec.inputSchema,
        from: z.number().int().min(0).optional().describe("0-based 起始偏移，默认 0"),
        size: z.number().int().min(1).optional().describe("总行数上限，默认 20"),
        fetchAll: z.boolean().optional().describe("拉取全部页并忽略 size，可能较慢或产生大响应"),
      }
    : spec.inputSchema

  server.registerTool(
    spec.name,
    { description: withBilling(spec.name, spec.description, Boolean(spec.paginated)), inputSchema: schema, annotations: { readOnlyHint: true, openWorldHint: false } },
    async (args) => {
      try {
        const { fetchAll, ...rest } = args as Record<string, unknown>
        const sanitized = sanitizeArgs(rest, { paginated: spec.paginated, fetchAll: Boolean(fetchAll) })
        const body = spec.transformBody ? spec.transformBody(sanitized) : sanitized
        const result = await client.call(spec.endpointKey, body)
        return { content: await buildToolContent(normalizeRows(result)) }
      } catch (err) {
        return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true }
      }
    },
  )
}

export function registerDownloadTool(server: McpServer, client: GangtiseClient, spec: DownloadToolSpec): void {
  server.registerTool(
    spec.name,
    { description: withBilling(spec.name, spec.description), inputSchema: spec.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
    async (args) => {
      try {
        const endpoint = ENDPOINTS[spec.endpointKey]
        if (!endpoint) throw new Error(`Unknown endpoint: ${spec.endpointKey}`)
        const query = args as Record<string, string | number>
        const result = await downloadToResult(client, endpoint, query)
        return { content: await buildDownloadContent(result) }
      } catch (err) {
        return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true }
      }
    },
  )
}
