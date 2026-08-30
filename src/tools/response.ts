import fs from "node:fs/promises"
import path from "node:path"

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { errorMessage, ValidationError } from "../core/errors.js"
import { beginSpillRead, endSpillRead, isOwnedTempPath, touchOwnedTempDir } from "../core/tempCleanup.js"
import { INLINE_MAX_BYTES } from "../core/config.js"
import { alignSliceEnd, sampleDiagnostics } from "./registry.js"
import { withBilling } from "./billing.js"

const DEFAULT_LIMIT = 50

/** 采样诊断元数据时给行留出的余地。
 *
 * 采样是「削到不超预算就停」，若把整份预算都算作可用，削完正好卡在上限、一行都装不下，
 * 回读就退化成每页 0～1 行的空转。8KB 是 `GANGTISE_INLINE_MAX_BYTES` 允许的最小值，
 * 用它做下限保证任何配置下都留得出至少一屏行。 */
const MIN_ROW_ROOM = 8192
const MAX_LIMIT = 500
/** Per-call character window for raw text / large-object chunk payloads. Derived
 * from INLINE_MAX_BYTES so a chunk of worst-case 3-byte UTF-8 chars (e.g. Chinese —
 * the max per UTF-16 unit for an unescaped char) still fits the inline budget:
 * 0.27 × budget × 3 ≈ 0.81 × budget, leaving headroom for the JSON envelope.
 *
 * ⚠️ 它是**起点，不是保证**：非 ASCII 确实以 3 字节/字符封顶，但 `JSON.stringify` 会把
 * 控制字符转义成 6 字符的 `\uXXXX`，超出这个假设一倍。真正的字节收敛由 `fitByBytes`
 * 按序列化后的实际长度做，本常数只决定「最多试多长」。
 *
 * Exported for tests that construct fixtures on the chunk boundary. INLINE_MAX_BYTES is
 * the byte-based spill threshold, shared with registry.ts via config.js. */
export const TEXT_CHUNK_CHARS = Math.floor(INLINE_MAX_BYTES * 0.27)

/** 本页少于请求 limit 时附在 payload 上的说明。信封预估也要带上它。
 *  导出供测试直接引用，避免测试逐字复刻本文案造成同源漂移（见 response.test.ts 用例 d）。 */
export function pageNote(returned: number): string {
  return `本页按 ${Math.round(INLINE_MAX_BYTES / 1024)}KB 字节预算返回 ${returned} 条（少于请求的 limit），用 next_offset 继续翻页`
}

/** 按**实际序列化字节**收敛一个字符分片，并用收敛后的 end 生成整个信封。
 *
 * 🔴 `TEXT_CHUNK_CHARS` 是个静态常数，按「每个 UTF-16 单元最多 3 字节 UTF-8」推出来的。
 * 这个假设漏了一档：`JSON.stringify` 把控制字符转义成 `\uXXXX` 六字符形式——**6 字节/
 * 字符**，正好是那个上界的两倍。一段控制字符密集的正文（ASR 残留、解析失败的二进制
 * 片段）因此能把默认 64KB 预算的分片撑到 10 万字节以上。后果不只是「回包偏大」：
 * `next_offset` 是按字符长度算的，客户端若按字节截断，续读就从错位处开始，拼出来的
 * 正文是坏的。
 * 这里以真实 `JSON.stringify` 长度为准折半收敛——end 严格递减且有下界，必然终止。 */
export function fitByBytes(
  text: string,
  start: number,
  maxChars: number,
  build: (end: number) => Record<string, unknown>,
): Record<string, unknown> {
  // 🔴 收敛下界：**必须严格大于 start**。`alignSliceEnd` 会把落在代理对中间的 end 往回
  // 拨一格，折半折到只剩一两个字符、而 text[start] 恰好是代理对前半时，它会把 end 拨回
  // start —— 分片为空、`next_offset` 原地不动，调用方就在同一个 offset 上无限翻页。
  // 代理对是 2 个 UTF-16 单元，所以那种情况下最小步长是 2：宁可让这一片略超预算，
  // 也必须**前进**。
  const first = text.charCodeAt(start)
  const minEnd = Math.min(first >= 0xd800 && first <= 0xdbff ? start + 2 : start + 1, text.length)
  const clamp = (end: number) => Math.max(minEnd, alignSliceEnd(text, end))

  let end = clamp(Math.min(start + maxChars, text.length))
  let payload = build(end)
  // 迭代上界：折半最多要 log2(maxChars) ≈ 15 轮，64 在正常运行下不可能走到。
  // 🔴 它防的不是慢，是**挂死**：循环条件与 clamp 的下界必须是同一个值，一旦有人把其中
  // 一个改成别的（如把 `minEnd` 写回 `start + 1`），`end` 会卡在下界上恒真，整个 server
  // 就停在这里不返回了。有了这个上界，那种改动退化成「这一片略超预算」而不是进程挂死。
  for (let i = 0; i < 64 && end > minEnd && Buffer.byteLength(JSON.stringify(payload), "utf8") > INLINE_MAX_BYTES; i += 1) {
    end = clamp(start + Math.floor((end - start) / 2))
    payload = build(end)
  }
  return payload
}

const FIELDS_MAX = 50
const FIELD_NAME_MAX = 64
const UNKNOWN_FIELDS_ECHO_MAX = 20

/** 顶层投影。用 Object.hasOwn 读、Object.create(null) 造 ——
 *  防 __proto__/constructor 这类继承键被当成数据带出或污染原型。 */
function projectRow(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>
  for (const field of fields) {
    if (Object.hasOwn(row, field)) out[field] = row[field]
  }
  return out
}

/** 未知字段 = 在**全部行**里都不存在的请求字段。
 *  判定范围必须是全量，不是溢出指针那 20 行采样窗口 ——
 *  否则只出现在第 21 行的稀疏字段会被误判成拼写错误。
 *  逐行剔除待查集，常见情况第一行就查完并提前退出。 */
function findUnknownFields(list: unknown[], fields: string[]): string[] {
  const pending = new Set(fields)
  for (const row of list) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue
    for (const field of [...pending]) {
      if (Object.hasOwn(row as object, field)) pending.delete(field)
    }
    if (pending.size === 0) break
  }
  return [...pending]
}

/** 报错时回列的可用字段，取前若干行、最多 UNKNOWN_FIELDS_ECHO_MAX 个，防错误消息自身膨胀。 */
function sampleFieldNames(list: unknown[]): string[] {
  const names: string[] = []
  for (const row of list.slice(0, 20)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue
    for (const key of Object.keys(row as object)) {
      if (!names.includes(key)) names.push(key)
      if (names.length >= UNKNOWN_FIELDS_ECHO_MAX) return names
    }
  }
  return names
}

/** 上一次解析结果的单条缓存。
 *
 * 翻页是本工具的常态：一次全市场分片 K 线能溢出百万行，按 limit=50 翻完要上万次调用，
 * 而每次调用都要**整份读盘 + 整份 JSON.parse**——对同一个文件重复几万次，是
 * O(文件大小 × 页数)。缓存只留一条：翻页天然是对同一个文件的连续访问，留一条就把
 * 复杂度压回 O(文件大小 + 页数)，而多留几条只是按份数放大常驻内存。
 *
 * key 带 mtime+size：溢出文件写完就不再改，但真被改过时必须重解析而不是给出旧内容。
 *
 * 常驻内存的上界是**一份**已解析文档：读到别的文件就整条替换。这与 `buildToolContent`
 * 落盘时本来就要把整份载荷 `JSON.stringify` 到内存里是同一量级，没有抬高峰值。 */
// 🔴 判别联合，不是 `{raw, data}` 都留。解析成功后下游只用 `data`，而把整份源字符串
// 一起留着等于**常驻两份文档**：实测回读一个 21MiB 的 JSON，留 raw 时 heap +46.79MiB、
// RSS +61.00MiB，不留时 +25.71MiB / +39.55MiB，差值正好是那份源文件。百万行响应上这就是
// GC 抖动甚至 OOM。纯文本没有 `data`，它本来就只能留 raw。
type SpillCache =
  | { key: string; parsed: true; data: unknown }
  | { key: string; parsed: false; raw: string }
let parsedCache: SpillCache | null = null

/** 读盘次数，仅供测试断言「缓存真的省掉了 I/O」。
 * 🔴 没有它，缓存是**零护栏**的：把 cache-hit 那行删掉，输出完全不变，全套测试照样绿
 * （实测 45/45）—— 一次重构就能把优化静默撤掉而没人知道。断言行为不够，要断言 I/O。 */
export let spillReadCount = 0
export function resetSpillReadCount(): void { spillReadCount = 0 }

async function readSavedJson(savedTo: string): Promise<{ raw: string; data: unknown; parsed: boolean }> {
  let real: string
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    real = await fs.realpath(savedTo)
    stat = await fs.stat(real)
  } catch {
    throw new Error(`saved_to path not found: ${savedTo}`)
  }
  // Only files this server process wrote (gangtise-mcp- temp dirs created via
  // createManagedTempDir) are readable — blocks reading arbitrary tmp files.
  if (!isOwnedTempPath(real)) {
    throw new Error("saved_to must be a gangtise-mcp- temp file generated by this server process")
  }
  // Reading proves an active session still needs this spill dir. 两件事都要做，防的是
  // 两个不同的回收器：
  //  - `utimes` 刷**目录 mtime** → 挡住另一个实例启动时那轮 24h 清扫。
  //    （刷的是目录、缓存 key 取的是文件，互不影响，顺序无关。）
  //  - `touchOwnedTempDir` 把它移到 LRU 的 MRU 端 → 挡住**本进程**的 200 份上限淘汰。
  //    少了这一句，一份正在逐页回读的响应会被后续溢出挤掉、后面的页永久取不回来。
  await fs.utimes(path.dirname(real), new Date(), new Date()).catch(() => {})
  touchOwnedTempDir(real)

  const key = `${real}:${stat.mtimeMs}:${stat.size}`
  if (parsedCache?.key === key) {
    return parsedCache.parsed
      ? { raw: "", data: parsedCache.data, parsed: true }
      : { raw: parsedCache.raw, data: undefined, parsed: false }
  }

  const raw = await fs.readFile(real, "utf8")
  spillReadCount += 1
  try {
    const data = JSON.parse(raw)
    // 有意只存 data —— 见 SpillCache 的注释。`raw` 在 parsed 分支上无人使用。
    parsedCache = { key, parsed: true, data }
    return { raw, data, parsed: true }
  } catch {
    // 纯文本载荷（Markdown/HTML）同样入缓存。它不需要 parse，但**每页整份 readFile**
    // 一样是 O(文件大小 × 页数)——一份大 AI Markdown 翻几百页就重读几百遍。
    parsedCache = { key, parsed: false, raw }
    return { raw, data: undefined, parsed: false }
  }
}

export function registerResponseTools(server: McpServer, _client: GangtiseClient): void {
  server.registerTool(
    "gangtise_read_response",
    {
      description: withBilling(
        "gangtise_read_response",
        "读取被截断的大响应。当其他工具返回 `_truncated: true` 且包含 `_saved_to` 临时文件路径时，用此工具按 offset/limit 分片读取完整数据。仅可读取本进程在系统临时目录下生成的 gangtise-mcp- 前缀文件。",
      ),
      inputSchema: {
        saved_to: z
          .string()
          .describe("被截断响应的临时文件路径（来自其他工具响应中的 _saved_to 字段）"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("起始条目索引（从 0 开始），默认 0"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`本次返回的条目数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}`),
        fields: z
          .array(
            z
              .string()
              .trim()
              .min(1, "fields 项不能为空")
              .max(FIELD_NAME_MAX, `fields 单项最长 ${FIELD_NAME_MAX} 字符`),
          )
          .min(1)
          .max(FIELDS_MAX, `fields 最多 ${FIELDS_MAX} 项`)
          .refine((v) => new Set(v).size === v.length, "fields 不能重复")
          .optional()
          .describe("只返回这些顶层字段（不支持点路径）；宽表按需投影可显著减少回读进上下文的字节"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ saved_to, offset = 0, limit = DEFAULT_LIMIT, fields }) => {
      // 🔴 在**任何 await 之前**登记「有回读在飞」，淘汰因此在整段回读期间挂起。
      // 只靠 readSavedJson 里的 touchOwnedTempDir 不够：那一句要等 realpath/stat/utimes
      // 几个 await 才轮得到，并发的溢出可以在这中间把目标目录删掉。
      beginSpillRead()
      try {
        const { raw, data, parsed } = await readSavedJson(saved_to)

        if (!parsed) {
          // Raw text payload (Markdown/HTML) — slice by character offset.
          if (fields) throw new ValidationError("fields 仅适用于 JSON 列表响应，该文件是纯文本；去掉 fields 后重试。")
          const text = raw
          const total = text.length
          const start = Math.min(offset, total)
          const payload = fitByBytes(text, start, TEXT_CHUNK_CHARS, (end) => ({
            _text: text.slice(start, end),
            _saved_to: saved_to,
            _total_chars: total,
            _offset: start,
            _returned: end - start,
            has_more: end < total,
            next_offset: end < total ? end : null,
            _note: `纯文本分片：按字符 offset 读取，每次返回最多 ${TEXT_CHUNK_CHARS} 字符（转义后超字节预算时更少，以 next_offset 为准；limit 对文本无效）`,
          }))
          return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] }
        }

        let list: unknown[]
        let rest: Record<string, unknown> = {}
        if (Array.isArray(data)) {
          list = data
        } else if (
          data !== null &&
          typeof data === "object" &&
          Array.isArray((data as Record<string, unknown>).list)
        ) {
          const obj = data as Record<string, unknown>
          list = obj.list as unknown[]
          rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "list"))
        } else {
          if (fields) throw new ValidationError("fields 仅适用于 JSON 列表响应，该文件是非列表对象；去掉 fields 后重试。")
          // Non-list object. A small one is returned whole; a large one (e.g. a
          // object over INLINE_MAX_BYTES that was spilled with a metadata-only preview) is char-sliced
          // so read-back can't re-inline the whole blob and defeat the truncation.
          const objText = JSON.stringify(data)
          if (Buffer.byteLength(objText, "utf8") > INLINE_MAX_BYTES) {
            const total = objText.length
            const start = Math.min(offset, total)
            const payload = fitByBytes(objText, start, TEXT_CHUNK_CHARS, (end) => ({
              _json_chunk: objText.slice(start, end),
              _saved_to: saved_to,
              _total_chars: total,
              _offset: start,
              _returned: end - start,
              has_more: end < total,
              next_offset: end < total ? end : null,
              _note: `大对象按字符 offset 分片：每次最多 ${TEXT_CHUNK_CHARS} 字符（转义后超字节预算时更少，以 next_offset 为准），拼接各片得到完整 JSON（limit 对此形状无效）`,
            }))
            return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] }
          }
          const payload = {
            data,
            _saved_to: saved_to,
            _total_items: null,
            _offset: 0,
            _returned: 1,
            has_more: false,
            next_offset: null,
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] }
        }

        const total = list.length
        const start = Math.min(offset, total)
        const hardEnd = Math.min(start + limit, total)

        let unknownFields: string[] = []
        if (fields) {
          // 非对象检查扫**全量列表**（冻结契约 §四E 规则 2/3：非空数据必须全部为普通对象行，
          // 混合数组传 fields 即 isError）。这不是可窄化的实现细节：fields 是否可用应是**文件级**
          // 属性，对同一文件恒定——若只查本页窗口，同一文件会「第 0 页成功、翻到坏行的页才失败」，
          // 行为随 offset 变，调用方无法据此判断能否投影。异常数据 fail-fast 且一致，优于逐页碰运气。
          if (list.length > 0 && list.some((r) => r === null || typeof r !== "object" || Array.isArray(r))) {
            throw new ValidationError("fields 仅适用于对象行列表，该列表含非对象元素；去掉 fields 后重试。")
          }
          // 空列表无从判定字段合法性 —— 正常返回空结果，不判未知字段。
          if (list.length > 0) {
            unknownFields = findUnknownFields(list, fields)
            // 逐字段判定：部分未知照常返回并回显，只有全部未知才算调用错了。
            // 「全都没有才报错」会静默吞掉 ["securityCode","clsoe"] 里拼错的那个。
            if (unknownFields.length === fields.length) {
              throw new ValidationError(
                `fields 全部不存在于数据中：${unknownFields.join("、")}。可用字段（最多 ${UNKNOWN_FIELDS_ECHO_MAX} 个）：${sampleFieldNames(list).join("、")}`,
              )
            }
          }
        }

        // 🔴 采样必须发生在算预算**之前**，而且两者必须用同一份 rest。
        // 源响应的顶层元数据整份跟着每一页走，诊断数组（每失败一页/一片一条）多时，光元
        // 数据就能把单页顶过预算 —— 采样它们，并留下 `_..._sampled` 让读者看得出清单不全。
        // 只采样、不丢字段：这些键没有分页语义，丢了就是静默少数据。
        //
        // 两条各自会错的边：
        //  ① 拿**未采样**的 rest 算行预算、却发**采样后**的 payload —— 预算被一份根本不会
        //     发出去的胖 rest 吃掉，请求 5 行只装得下 1 行，而实到载荷才 1.4KB。
        //  ② 采样按整份 INLINE_MAX_BYTES 判 —— rest 自己 65,358B 不触发，拼上信封 65,570B
        //     已超；于是永远不采样，只落一个 `_oversized: true`。
        // 所以采样的 budget 要扣掉信封的固定部分，再留出至少一行的余地。
        const fixedEnvelopeBytes = Buffer.byteLength(
          JSON.stringify({
            list: [],
            _saved_to: saved_to,
            _total_items: total,
            _offset: start,
            _returned: hardEnd - start,
            has_more: false,
            next_offset: String(total).length >= 4 ? total : null,
            _note: pageNote(hardEnd - start),
            ...(fields ? { _fields: fields } : {}),
            ...(unknownFields.length > 0 ? { _unknown_fields: unknownFields } : {}),
          }),
          "utf8",
        )
        const sampledRest = sampleDiagnostics(rest, INLINE_MAX_BYTES - fixedEnvelopeBytes - MIN_ROW_ROOM)

        // 字节预算必须算上信封（...rest + _saved_to/_total_items/_note 等），
        // 不能只算行字节：单行 65,509B 未超限，拼上信封后 payload 65,779B 已超限 ——
        // 只算行的旧写法会让这类载荷整个溜过检查。信封按最宽情形估：_note 常驻、
        // 数字取最大位宽、has_more/next_offset 取真实两态（末页 vs 非末页）中更宽的
        // 一种，估多不估少，保证最终 payload 一定 ≤ 预算。
        const envelopeBytes = Buffer.byteLength(
          JSON.stringify({
            ...sampledRest,
            list: [],
            _saved_to: saved_to,
            _total_items: total,
            _offset: start,
            _returned: hardEnd - start,
            // 估多不估少：has_more 取 'false'(5B)、next_offset 取 'null'(4B) 与 total 位宽的较大者
            has_more: false,                                        // 5B > 'true' 的 4B
            next_offset: String(total).length >= 4 ? total : null,  // 取更宽的那个
            _note: pageNote(hardEnd - start),
            ...(fields ? { _fields: fields } : {}),
            ...(unknownFields.length > 0 ? { _unknown_fields: unknownFields } : {}),
          }),
          "utf8",
        )
        const rowBudget = INLINE_MAX_BYTES - envelopeBytes

        // 至少推进一条，翻页不会卡死。JSON 数组的分隔逗号也占字节，一并计入。
        // 投影先于预算：projectRow 后的行才拿去算字节，宽表窄投影因此每页能装更多行。
        let end = start
        let sliceBytes = 0
        const slice: unknown[] = []
        while (end < hardEnd) {
          const row = fields ? projectRow(list[end] as Record<string, unknown>, fields) : list[end]
          const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + (end > start ? 1 : 0)
          if (end > start && sliceBytes + rowBytes > rowBudget) break
          sliceBytes += rowBytes
          slice.push(row)
          end += 1
        }

        const payload: Record<string, unknown> = {
          ...sampledRest,
          list: slice,
          _saved_to: saved_to,
          _total_items: total,
          _offset: start,
          _returned: slice.length,
          has_more: end < total,
          next_offset: end < total ? end : null,
          ...(end < hardEnd ? { _note: pageNote(slice.length) } : {}),
          ...(fields ? { _fields: fields } : {}),
          ...(unknownFields.length > 0 ? { _unknown_fields: unknownFields } : {}),
        }

        // (b) 信封 + 最小一行仍超预算，或 (c) 零行但 rest 自己就超预算：
        // 原样返回并显式标记。不截断 rest（非列表、无分页语义，截了会静默丢数据），
        // 也不退化成 metadata-only（现状就是「返回一行」，改掉属破坏性变更）。
        if (Buffer.byteLength(JSON.stringify(payload), "utf8") > INLINE_MAX_BYTES) {
          payload._oversized = true
        }

        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true }
      } finally {
        endSpillRead()
      }
    },
  )
}
