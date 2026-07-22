import { ApiError, attachEnvelopeTraceId } from "./errors.js"

export interface Envelope<T> {
  code?: string | number
  msg?: string
  status?: boolean
  success?: boolean
  data?: T
  /** 2026-07-17 信封新增：Gangtise 侧唯一能回溯一次失败的关联 id。 */
  traceId?: string | number
}

export function isEnvelope<T>(parsed: unknown): parsed is Envelope<T> {
  if (!parsed || typeof parsed !== "object") return false
  const obj = parsed as Record<string, unknown>
  if (!("code" in obj)) return false
  return "msg" in obj || "data" in obj || "success" in obj || "status" in obj
}

export function unwrapEnvelope<T>(parsed: Envelope<T>, statusCode?: number, retryAfterMs?: number): T {
  if (!isEnvelope<T>(parsed)) {
    return parsed as T
  }

  const code = parsed.code === undefined ? undefined : String(parsed.code)
  const ok = parsed.status === true || parsed.success === true || code === "000000" || code === "0"

  if (!ok) {
    // Gangtise also returns errors inside HTTP 200 envelopes — carry Retry-After
    // through, or a 200-wrapped rate limit loses its backoff window.
    throw new ApiError(parsed.msg || "API request failed", code, statusCode, parsed, retryAfterMs)
  }

  if ("data" in parsed) {
    // Carry the envelope's traceId onto the payload: the EDE endpoints wrap a
    // second envelope inside `data` and only fail when THAT one is peeled, at
    // which point this is the only traceId in reach.
    return attachEnvelopeTraceId(parsed.data, parsed.traceId) as T
  }

  return parsed as T
}
