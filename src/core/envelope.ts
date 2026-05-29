import { ApiError } from "./errors.js"

export interface Envelope<T> {
  code?: string | number
  msg?: string
  status?: boolean
  success?: boolean
  data?: T
}

export function isEnvelope<T>(parsed: unknown): parsed is Envelope<T> {
  if (!parsed || typeof parsed !== "object") return false
  const obj = parsed as Record<string, unknown>
  if (!("code" in obj)) return false
  return "msg" in obj || "data" in obj || "success" in obj || "status" in obj
}

export function unwrapEnvelope<T>(parsed: Envelope<T>, statusCode?: number): T {
  if (!isEnvelope<T>(parsed)) {
    return parsed as T
  }

  const code = parsed.code === undefined ? undefined : String(parsed.code)
  const ok = parsed.status === true || parsed.success === true || code === "000000" || code === "0"

  if (!ok) {
    throw new ApiError(parsed.msg || "API request failed", code, statusCode, parsed)
  }

  if ("data" in parsed) {
    return parsed.data as T
  }

  return parsed as T
}
