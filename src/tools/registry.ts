import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { ENDPOINTS } from "../core/endpoints.js"
import { normalizeRows } from "../core/normalize.js"
import { downloadToResult } from "../core/download.js"
import { ValidationError } from "../core/errors.js"
import { buildDownloadContent, buildToolContent } from "../core/present.js"
import { withBilling } from "./billing.js"
import { toolHandler } from "./helpers.js"

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
   * 按参数选端点（如 withContent / full 切换两档价格的端点）。在 transformBody 之后调用，
   * 返回实际端点与去掉开关参数后的请求体——开关只决定打哪个端点，不进 body。
   * 同步、纯函数、返回新对象；没有它时用 endpointKey。
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
        // 三者的语义由 server.instructions 的「通用参数」行统一声明 —— 22 个分页工具
        // 各写一遍要付 22 遍，写在 instructions 只付一遍。别在这里加回描述。
        from: z.number().int().min(0).optional(),
        size: z.number().int().min(1).optional(),
        fetchAll: z.boolean().optional(),
      }
    : spec.inputSchema

  server.registerTool(
    spec.name,
    { description: withBilling(spec.description, spec.endpointKey), inputSchema: strictSchema(schema), annotations: { readOnlyHint: true, openWorldHint: false } },
    // toolHandler 统一错误形状，并把取消信号带进分页扇出（见 helpers.ts）。
    toolHandler(async (args: Record<string, unknown>) => {
      const { fetchAll, ...rest } = args
      const sanitized = sanitizeArgs(rest, { paginated: spec.paginated, fetchAll: Boolean(fetchAll) })
      assertDateOrder(sanitized)
      const transformed = spec.transformBody ? spec.transformBody(sanitized) : sanitized
      const { endpointKey, body } = spec.resolve ? spec.resolve(transformed) : { endpointKey: spec.endpointKey, body: transformed }
      const result = await client.call(endpointKey, body)
      return { content: await buildToolContent(normalizeRows(result), { nullMeansEmpty: spec.nullMeansEmpty, emptyHint: spec.emptyHint }) }
    }),
  )
}

export function registerDownloadTool(server: McpServer, client: GangtiseClient, spec: DownloadToolSpec): void {
  server.registerTool(
    spec.name,
    { description: withBilling(spec.description, spec.endpointKey), inputSchema: strictSchema(spec.inputSchema), annotations: { readOnlyHint: true, openWorldHint: false } },
    toolHandler(async (args: Record<string, unknown>) => {
      const endpoint = ENDPOINTS[spec.endpointKey]
      if (!endpoint) throw new Error(`Unknown endpoint: ${spec.endpointKey}`)
      const query = args as Record<string, string | number>
      const result = await downloadToResult(client, endpoint, query)
      return { content: await buildDownloadContent(result) }
    }),
  )
}
