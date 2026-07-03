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

const INLINE_MAX_BYTES = 256_000
const PREVIEW_ITEMS = 20
const TEXT_PREVIEW_CHARS = 4_000

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
      _read_with: "gangtise_read_response",
      _total_bytes: byteLength,
      _preview_count: 0,
      has_more: false,
    }
  }

  // Guard: if preview itself exceeds the byte cap (e.g. large rows), drop list and return metadata only.
  if (Buffer.byteLength(JSON.stringify(preview), "utf8") > INLINE_MAX_BYTES) {
    const { list: _dropped, ...metaOnly } = preview as Record<string, unknown> & { list?: unknown }
    // The spill file still holds every item — recompute has_more from the item
    // count, or the reader sees has_more:false + 0 previews and never follows
    // up with gangtise_read_response.
    const totalItems = metaOnly._total_items
    preview = { ...metaOnly, _preview_count: 0, has_more: typeof totalItems === "number" && totalItems > 0, next_offset: typeof totalItems === "number" && totalItems > 0 ? 0 : null }
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
        from: z.number().int().min(0).optional().describe("起始行偏移（0-based，非页码），配合 size 翻页，默认 0"),
        size: z.number().int().min(1).optional().describe("返回总行数上限（跨页合并计数，默认 20）；fetchAll=true 时被忽略"),
        fetchAll: z.boolean().optional().describe("true 时忽略 size 拉取全部数据，大数据集可能较慢"),
      }
    : spec.inputSchema

  server.registerTool(
    spec.name,
    { description: spec.description, inputSchema: schema, annotations: { readOnlyHint: true } },
    async (args) => {
      try {
        const { fetchAll, ...rest } = args as Record<string, unknown>
        const body = sanitizeArgs(rest, { paginated: spec.paginated, fetchAll: Boolean(fetchAll) })
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
    { description: spec.description, inputSchema: spec.inputSchema, annotations: { readOnlyHint: true } },
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
