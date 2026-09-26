/** 契约示例：每个工具至少一条，钉「入参 → 发到服务端的 HTTP 请求序列」。示例写在族旁的
 *  `tools/<族>.examples.ts`，由 tests/contract/request-bodies.test.ts 走真实的 MCP 校验路径逐条执行。
 *  `*.examples.ts` 只给测试用，不编译进发布包（tsconfig 的 exclude）。 */

/** 一条发到服务端的 HTTP 请求。`body` 是 JSON 解析后的请求体，`query` 是 GET 的查询串
 *  （值一律是字符串——线上就是字符串）。比较时整条序列按规范化字符串排序，因为分页扇出 /
 *  分片 / 逐只拆分是并发发出的，到达顺序不确定。 */
export interface ExpectedRequest {
  method: "GET" | "POST"
  path: string
  body?: unknown
  query?: Record<string, string>
}

/** 测试桩收到的请求。`endpoint` 是由 path 反查的端点键。 */
export interface ExampleRequest {
  endpoint: string
  method: string
  path: string
  query?: Record<string, string>
  body?: unknown
}

/** 覆盖测试桩的默认应答；返回 undefined 走默认应答。`data` 自动包成成功信封，`json` 原样作为响应体。 */
export type ExampleResponder = (req: ExampleRequest, index: number) => { data?: unknown; json?: unknown; status?: number } | undefined

/** 一条契约示例：入参 → 期望的 HTTP 请求序列，或期望被本地拒绝。
 *
 *  - `requests`：调用成功，且发到服务端的请求恰好是这些（多一个少一个都红）。
 *  - `rejects`：调用以错误结束、错误文本匹配该正则；同时给了 `requests` 时还要求那几个请求
 *    确实发出过（先发请求、再因响应报错），没给则要求**一个请求都没发**（零成本本地拒绝）。
 *  - `upstream`：覆盖默认的服务端应答（分页扇出、探针这类依赖响应形状的序列才需要）。 */
export interface ContractExample {
  title: string
  args: Record<string, unknown>
  upstream?: ExampleResponder
  expect: { requests: ExpectedRequest[]; rejects?: undefined } | { rejects: RegExp; requests?: ExpectedRequest[] }
}

export type Examples = [ContractExample, ...ContractExample[]]

/** 工具名 → 该工具的示例。 */
export type ToolExamples = Record<string, Examples>

/** 分页端点：按请求体里的 from/size 切一段 `total` 行的虚拟数据集。 */
export function paged(total: number, only?: string): ExampleResponder {
  return (req) => {
    if (only && req.endpoint !== only) return undefined
    const body = (req.body ?? {}) as { from?: number; size?: number }
    const from = body.from ?? 0
    const size = body.size ?? 20
    const n = Math.max(0, Math.min(size, total - from))
    return { data: { total, list: Array.from({ length: n }, (_, i) => ({ id: `row-${from + i}` })) } }
  }
}

/** 行情端点：每个请求回一行列式数据，保证合并路径有 header 可用。 */
export function oneQuoteRow(): ExampleResponder {
  return (req) => {
    if (!req.endpoint.startsWith("quote.")) return undefined
    return { data: { total: 1, fieldList: ["securityCode", "tradeDate", "close"], list: [["600519.SH", "2026-09-01", 1]] } }
  }
}
