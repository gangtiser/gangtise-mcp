import type { EndpointDefinition } from "./endpoints.js"
import { ApiError } from "./errors.js"

/** 以错误码表示「零行」的端点（`emptyCodes`）：命中时给出一份合法的空结果，其余情况返回
 *  undefined，由调用方照常抛出。 */
export function emptyResultFor(endpoint: EndpointDefinition, error: unknown): { total: 0; list: [] } | undefined {
  if (!endpoint.emptyCodes?.length || !(error instanceof ApiError) || error.code === undefined) return undefined
  return endpoint.emptyCodes.includes(error.code) ? { total: 0, list: [] } : undefined
}
