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
const AVAILABLE_FIELDS_MAX = 50

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
function emptyResultHint(normalized: unknown, options?: BuildOptions): Record<string, unknown> | undefined {
  const hint = options?.emptyHint ?? EMPTY_RESULT_HINT
  // A null payload means zero rows on the few LIST endpoints known to answer that
  // way — probed 2026-08-09: insight.foreign-opinion.list and
  // insight.independent-opinion.list answer any `industryList` value (valid citic
  // code, valid sw code, or garbage) with a literal `null`, which used to render as
  // the bare text "null" with isError=false.
  //
  // Strictly OPT-IN (`nullMeansEmpty`). buildToolContent is shared by every JSON
  // tool including single-object ones (concept-info, edb-data, AI content, lookup);
  // turning their `null` into `{list: [], _hint: "…证券代码…日期区间…"}` would both
  // answer a non-list question with a list and disguise a protocol anomaly as a
  // normal empty result. Those must keep failing loudly instead.
  if (options?.nullMeansEmpty && (normalized === null || normalized === undefined)) {
    return { list: [], _hint: hint }
  }
  if (Array.isArray(normalized)) {
    return normalized.length === 0 ? { list: [], _hint: hint } : undefined
  }
  if (normalized !== null && typeof normalized === "object") {
    const list = (normalized as Record<string, unknown>).list
    if (list === null || (Array.isArray(list) && list.length === 0)) {
      return { ...(normalized as Record<string, unknown>), list: Array.isArray(list) ? list : [], _hint: hint }
    }
  }
  return undefined
}

/** 采样前 PREVIEW_ITEMS 行汇总顶层字段名，供调用方决定 read_response 的 fields 投影。
 *  这是**提示**，不是正确性判定：采样窗口外的稀疏字段可能漏列，代价只是提示不全。
 *  read_response 的未知字段判定另扫全量 —— 两者刻意解耦，不要合并。
 *
 *  `_available_fields` 与 `_available_fields_sampled` **必须成对出现、缺一不可**：
 *  读者靠 `_available_fields_sampled < _total_items` 判断字段清单可能不全。
 *  一行字段都没采到时也返回 `[]` + 实际扫描行数（而不是两个都省略），以区分
 *  「采了 N 行」与「压根没采」。注意 sampled 计的是**扫描行数（含非对象行）**：
 *  `[]` + sampled:20 可能是 20 个空对象、也可能是 20 个非对象行，本提示不细分二者。 */
function availableFieldsMeta(list: unknown[]): Record<string, unknown> {
  const sampled = Math.min(PREVIEW_ITEMS, list.length)
  const names: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < sampled; i += 1) {
    const row = list[i]
    if (!row || typeof row !== "object" || Array.isArray(row)) continue
    for (const key of Object.keys(row as object)) {
      if (!seen.has(key)) {
        seen.add(key)
        names.push(key)
      }
    }
  }
  const truncated = names.length > AVAILABLE_FIELDS_MAX
  return {
    _available_fields: truncated ? names.slice(0, AVAILABLE_FIELDS_MAX) : names,
    _available_fields_sampled: sampled,
    ...(truncated ? { _available_fields_truncated: true } : {}),
  }
}

export interface BuildOptions {
  /** Overrides the generic zero-row hint (EDE says the opposite of the default). */
  emptyHint?: string
  /** Opt in to treating a `null` payload as zero rows. List endpoints only. */
  nullMeansEmpty?: boolean
}

export async function buildToolContent(normalized: unknown, options?: BuildOptions): Promise<Array<{ type: "text"; text: string }>> {
  // 没开 nullMeansEmpty 的端点收到 null/undefined = 协议异常，必须**响亮失败**。
  // 此前它会被 JSON.stringify 成字面量 "null" 原样返回、且 isError=false，调用方分不清
  // 「报错 / 无数据 / 坏了」——这正是 CHANGELOG 承诺「其余保持原样响亮暴露」时没做到的。
  // 只有确认以 null 表示零行的**列表**端点才 opt-in（目前是两个外资观点列表）。
  if (!options?.nullMeansEmpty && (normalized === null || normalized === undefined)) {
    // 有意**不**让调用方「带上 trace」：走到这里时信封已被剥掉，而 attachEnvelopeTraceId
    // 挂不到 null 上，所以这条路径根本没有 traceId 可给——要一个不存在的东西只会让人白找。
    throw new Error("本接口返回了空响应体（null），而它不以 null 表示零行——这是一次异常响应。请重试；持续出现请带上工具名与入参报障。")
  }
  const empty = emptyResultHint(normalized, options)
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
      ...availableFieldsMeta(list),
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
      ...availableFieldsMeta(normalized),
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
      // Even one row exceeds the budget — fall back to metadata-only. Field names
      // still reach the model via _available_fields (capped at 50 + a
      // _available_fields_truncated flag), which survives the ...metaOnly spread.
      // We deliberately do NOT re-dump the first row's keys here: an unbounded
      // Object.keys(row) can itself blow the byte budget on a pathologically wide
      // row — the exact case this fallback handles — and it only duplicates the
      // (bounded) _available_fields anyway.
      const { list: _dropped, ...metaOnly } = preview as Record<string, unknown> & { list?: unknown }
      const anyLeft = typeof totalItems === "number" && totalItems > 0
      preview = { ...metaOnly, _preview_count: 0, has_more: anyLeft, next_offset: anyLeft ? 0 : null }
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
  /**
   * 该端点用 `null` 表示「零行」时置 true —— 只对**列表**端点开。
   * 默认关闭：null 一律原样透出，让协议异常响亮地暴露，而不是被伪装成空列表。
   *
   * ⚠️ **当前没有任何 spec 开这个开关。** 两个外资观点列表曾经需要它（那时它们对任何
   * industryList 取值都返回字面 null），服务端改为返回 {total:0,list:[]} 后已撤回。
   * 字段保留是因为这个形状随时可能在别的端点上再出现；要开之前必须先实测确认该端点
   * 确实以 null 表示零行——开错了会把协议异常伪装成一次正常的空查询。
   */
  nullMeansEmpty?: boolean
  /**
   * 覆盖零行时的 `_hint`。通用文案以「可能该条件下确无数据」开头并指向证券后缀 /
   * 日期区间 / 市场——当某个端点的零行有**已知的、别的**真因时，那段话每一条都不对，
   * 模型会照着排查错方向。给出真因即可。
   */
  emptyHint?: string
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

/** 把 raw shape 收成 **strict** ZodObject —— 未声明的键**报错**，而不是被静默剥掉。
 *
 * 为什么必须 strict：SDK 用这个 schema 解析入参，非 strict 时未知键在进 handler 之前
 * 就被 strip 掉，于是「传了个没人认识的参数」会变成一次**没有该筛选条件的正常调用**，
 * `isError=false`、按条计费、返回全量。而我们发布的 JSON Schema 里写的是
 * `additionalProperties: false`——契约声明拒绝，行为却是静默接受，两者矛盾。
 *
 * 这不是假想：财报日历 2026-08-08 把日期入参从 `startTime`/`endTime` 改成
 * `startDate`/`endDate`（服务端换了接受的字段名），沿用旧名的调用方因此静默拿到
 * 12.8 万行全库切片。strict 之后他们会收到一条指名道姓的报错。
 *
 * registerTool 的 inputSchema 接受 `ZodRawShapeCompat | AnySchema`（1.29.0 起即如此），
 * 所以可以直接传 ZodObject。
 * 对已发布的 tools/list schema 表面无影响（strict 只改解析行为，不加字段）。 */
function strictSchema(shape: ZodShape) {
  return z.object(shape).strict()
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
    { description: withBilling(spec.name, spec.description, Boolean(spec.paginated)), inputSchema: strictSchema(schema), annotations: { readOnlyHint: true, openWorldHint: false } },
    async (args) => {
      try {
        const { fetchAll, ...rest } = args as Record<string, unknown>
        const sanitized = sanitizeArgs(rest, { paginated: spec.paginated, fetchAll: Boolean(fetchAll) })
        const body = spec.transformBody ? spec.transformBody(sanitized) : sanitized
        const result = await client.call(spec.endpointKey, body)
        return { content: await buildToolContent(normalizeRows(result), { nullMeansEmpty: spec.nullMeansEmpty, emptyHint: spec.emptyHint }) }
      } catch (err) {
        return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true }
      }
    },
  )
}

export function registerDownloadTool(server: McpServer, client: GangtiseClient, spec: DownloadToolSpec): void {
  server.registerTool(
    spec.name,
    { description: withBilling(spec.name, spec.description), inputSchema: strictSchema(spec.inputSchema), annotations: { readOnlyHint: true, openWorldHint: false } },
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
