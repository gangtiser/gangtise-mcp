import type { RecordedRequest, Responder } from "../helpers/mockUpstream.js"

/** 分页端点：按请求体里的 from/size 切一段 `total` 行的虚拟数据集。 */
export function paged(total: number, only?: string): Responder {
  return (req: RecordedRequest) => {
    if (only && req.endpoint !== only) return undefined
    const body = (req.body ?? {}) as { from?: number; size?: number }
    const from = body.from ?? 0
    const size = body.size ?? 20
    const n = Math.max(0, Math.min(size, total - from))
    return { data: { total, list: Array.from({ length: n }, (_, i) => ({ id: `row-${from + i}` })) } }
  }
}

/** 行情端点：每个请求回一行列式数据，保证合并路径有 header 可用。 */
export function oneQuoteRow(): Responder {
  return (req: RecordedRequest) => {
    if (!req.endpoint.startsWith("quote.")) return undefined
    return { data: { total: 1, fieldList: ["securityCode", "tradeDate", "close"], list: [["600519.SH", "2026-09-01", 1]] } }
  }
}
