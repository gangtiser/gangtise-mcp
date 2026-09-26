import { z } from "zod"
import { ENDPOINTS, type EndpointTable } from "../core/endpoints.js"
import { normalizeRows } from "../core/normalize.js"
import { downloadToResult } from "../core/download.js"
import { ValidationError } from "../core/errors.js"
import { buildDownloadContent, buildToolContent } from "../core/present.js"
import type { Billing } from "./billing.js"
import type { ToolTextResult } from "./handler.js"
import type { CallContext } from "./invoke.js"

/** Zod raw shape（registerTool 的 inputSchema 也接受它）。 */
export type ZodShape = Record<string, z.ZodTypeAny>

/** 一个 MCP 工具的完整声明。只经 invokeOperation 调用（mcp/invoke.ts）。 */
export interface ToolSpec {
  name: string
  /** core = 默认列出；extended = 点名才列出；legacy = 被合并的旧工具，保留一个周期。 */
  tier: "core" | "extended" | "legacy"
  /** annotations 由它派生（register.ts）。 */
  access: "read" | "write" | "destructive"
  /** 写操作声明了才发 destructiveHint / idempotentHint。 */
  idempotent?: boolean
  /** 本工具的结果会指引调用方去调的工具（如异步提交超时后的 `_check`）：选中本工具时一并启用。 */
  requires?: string[]
  /** 固定端点时填；积分标签由它派生。 */
  endpoint?: string
  /** 本地工具、多端点工具的标签。与 `endpoint` 二者必有其一，给了就优先。 */
  billingLabel?: Billing
  description: string
  /** raw shape 会被收成 strict 对象；完整对象 schema 用来表达顶层互斥。 */
  input: ZodShape | z.AnyZodObject
  run: (ctx: CallContext, args: Record<string, unknown>) => Promise<ToolTextResult>
}

/** 一族工具。`endpoints` 与 core/endpoints.ts 汇总的是同一份表。 */
export interface FamilyModule {
  /** 也是 GANGTISE_MCP_TOOLS 里的族名。 */
  name: string
  /** 只在该族被加载时拼进 instructions。 */
  routingHint?: string
  endpoints: EndpointTable
  tools: ToolSpec[]
}

/** 只包 handler，其余自己写。 */
export function defineTool(spec: ToolSpec): ToolSpec {
  return spec
}

interface SpecBase {
  name: string
  tier: ToolSpec["tier"]
  description: string
  endpointKey: string
  inputSchema: ZodShape
}

export interface JsonToolSpec extends SpecBase {
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
   * 按参数选端点（如 withContent / full 切换两档价格的端点）。在 transformBody 之后调用，
   * 返回实际端点与去掉开关参数后的请求体——开关只决定打哪个端点，不进 body。
   * 同步、纯函数、返回新对象；没有它时用 endpointKey（也是标签取价的默认档）。
   */
  resolve?: (body: Record<string, unknown>) => { endpointKey: string; body: Record<string, unknown> }
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

export type DownloadToolSpec = SpecBase

export interface WriteToolSpec extends SpecBase {
  access: "write" | "destructive"
  idempotent: boolean
}

/** 端点键写错、类型不符、分页声明对不上，在定义时就炸——否则要等到第一次调用才暴露。 */
function endpointFor(spec: SpecBase, kind: "json" | "download") {
  const endpoint = ENDPOINTS[spec.endpointKey]
  if (!endpoint) throw new Error(`${spec.name}: unknown endpoint ${spec.endpointKey}`)
  if (endpoint.kind !== kind) throw new Error(`${spec.name}: ${spec.endpointKey} is a ${endpoint.kind} endpoint, not ${kind}`)
  return endpoint
}

export function defineJsonTool(spec: JsonToolSpec): ToolSpec {
  const endpoint = endpointFor(spec, "json")
  // 双向：分页工具必须打分页端点，打分页端点的工具也必须声明分页（否则静默丢掉 from/size/fetchAll）。
  if (Boolean(spec.paginated) !== (endpoint.pagination?.mode === "offset")) {
    throw new Error(`${spec.name}: paginated=${Boolean(spec.paginated)} disagrees with ${spec.endpointKey}`)
  }
  const input: ZodShape = spec.paginated
    ? {
        ...spec.inputSchema,
        // 三者的语义由 server.instructions 的「通用参数」行统一声明 —— 22 个分页工具
        // 各写一遍要付 22 遍，写在 instructions 只付一遍。别在这里加回描述。
        from: z.number().int().min(0).optional(),
        size: z.number().int().min(1).optional(),
        fetchAll: z.boolean().optional(),
      }
    : spec.inputSchema
  return {
    name: spec.name,
    tier: spec.tier,
    access: "read",
    endpoint: spec.endpointKey,
    description: spec.description,
    input,
    run: async (ctx, args) => {
      const { fetchAll, ...rest } = args
      const sanitized = sanitizeArgs(rest, { paginated: spec.paginated, fetchAll: Boolean(fetchAll) })
      assertDateOrder(sanitized)
      const transformed = spec.transformBody ? spec.transformBody(sanitized) : sanitized
      const { endpointKey, body } = spec.resolve ? spec.resolve(transformed) : { endpointKey: spec.endpointKey, body: transformed }
      const result = await ctx.client.call(endpointKey, body)
      return { content: await buildToolContent(normalizeRows(result), { nullMeansEmpty: spec.nullMeansEmpty, emptyHint: spec.emptyHint }) }
    },
  }
}

export function defineDownloadTool(spec: DownloadToolSpec): ToolSpec {
  const endpoint = endpointFor(spec, "download")
  return {
    name: spec.name,
    tier: spec.tier,
    access: "read",
    endpoint: spec.endpointKey,
    description: spec.description,
    input: spec.inputSchema,
    run: async (ctx, args) => {
      const result = await downloadToResult(ctx.client, endpoint, args as Record<string, string | number>)
      return { content: await buildDownloadContent(result) }
    },
  }
}

/** 写操作：入参原样作为请求体（`confirm` 只给确认闸门看，不下发）。确认闸门在 invokeOperation。 */
export function defineWriteTool(spec: WriteToolSpec): ToolSpec {
  endpointFor(spec, "json")
  return {
    name: spec.name,
    tier: spec.tier,
    access: spec.access,
    idempotent: spec.idempotent,
    endpoint: spec.endpointKey,
    description: spec.description,
    input: spec.inputSchema,
    run: async (ctx, args) => {
      const { confirm: _confirm, ...body } = args
      const result = await ctx.client.call(spec.endpointKey, body)
      return { content: await buildToolContent(normalizeRows(result)) }
    },
  }
}

interface SanitizeOptions {
  paginated?: boolean
  fetchAll?: boolean
}

/** 通用的「起止先后」校验。
 *
 * 🔴 起始晚于结束此前只有 `gangtise_knowledge_batch` 一处校验，其余带日期区间的工具全都
 * 直接下发。服务端有 `110002`「起始晚于结束」这个码，但**不是每个端点都用它**——有的
 * 端点把倒置区间当成空条件、返回未经筛选的结果，按条计费且从结果里看不出来。本地拒绝
 * 零成本、报错还能指名是哪一对。
 *
 * 只比较**同名前缀**的一对（startDate/endDate、startTime/endTime），按字符串比较即可：
 * 两个值到这里都已被 `dateString` / `dateTimeString` 归一成零填充的 `YYYY-MM-DD[ HH:mm:ss]`，
 * 字典序与时间序一致。混用 date 与 datetime 时按各自的日期部分比。 */
export function assertDateOrder(body: Record<string, unknown>): void {
  for (const [startKey, endKey] of [["startDate", "endDate"], ["startTime", "endTime"]] as const) {
    const start = body[startKey]
    const end = body[endKey]
    if (typeof start !== "string" || typeof end !== "string") continue
    const n = Math.min(start.length, end.length)
    if (start.slice(0, n) > end.slice(0, n)) {
      throw new ValidationError(`${startKey} (${start}) 晚于 ${endKey} (${end})：请检查区间的先后顺序。`)
    }
  }
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
