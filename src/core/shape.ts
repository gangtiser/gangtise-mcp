import { ENDPOINTS, type EndpointDefinition } from "./endpoints.js"
import { ApiError } from "./errors.js"
import { unwrapIndicatorData } from "./indicatorMatrix.js"

/** 按端点声明把载荷归一成业务数据。外层信封在 HTTP 层已经剥掉；这里只处理端点自己声明的
 *  特殊形状，让调用方不必记得「这个端点要多剥一层」。 */

/** `envelope: "double"` 的端点（EDE）在 `data` 里还包着一层 `{code, status, data}`：剥掉它，
 *  内层的失败码照常抛出。其余端点原样返回。 */
export function unwrapPayload(endpoint: EndpointDefinition | string, raw: unknown): unknown {
  const def = typeof endpoint === "string" ? ENDPOINTS[endpoint] : endpoint
  return def?.envelope === "double" ? unwrapIndicatorData(raw) : raw
}

/** 以错误码表示「零行」的端点（`emptyCodes`）：命中时给出一份合法的空结果，其余情况返回
 *  undefined，由调用方照常抛出。 */
export function emptyResultFor(endpoint: EndpointDefinition, error: unknown): { total: 0; list: [] } | undefined {
  if (!endpoint.emptyCodes?.length || !(error instanceof ApiError) || error.code === undefined) return undefined
  return endpoint.emptyCodes.includes(error.code) ? { total: 0, list: [] } : undefined
}
