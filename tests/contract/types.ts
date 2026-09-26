import type { Responder } from "../helpers/mockUpstream.js"

/** 一条发到服务端的 HTTP 请求。`body` 是 JSON 解析后的请求体，`query` 是 GET 的查询串
 *  （值一律是字符串——线上就是字符串）。比较时整条序列按规范化字符串排序，因为分页扇出 /
 *  分片 / 逐只拆分是并发发出的，到达顺序不确定。 */
export interface ExpectedRequest {
  method: "GET" | "POST"
  path: string
  body?: unknown
  query?: Record<string, string>
}

/** 一条契约示例：入参 → 期望的 HTTP 请求序列，或期望被本地拒绝。
 *
 *  - `requests`：调用成功，且发到服务端的请求恰好是这些（多一个少一个都红）。
 *  - `rejects`：调用以错误结束、错误文本匹配该正则；同时给了 `requests` 时还要求那几个请求
 *    确实发出过（先发请求、再因响应报错），没给则要求**一个请求都没发**（零成本本地拒绝）。
 *  - `upstream`：覆盖默认的服务端应答（分页扇出、探针这类依赖响应形状的序列才需要）。 */
export interface ContractExample {
  title: string
  args: Record<string, unknown>
  upstream?: Responder
  expect: { requests: ExpectedRequest[]; rejects?: undefined } | { rejects: RegExp; requests?: ExpectedRequest[] }
}
