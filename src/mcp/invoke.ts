import type { GangtiseClient } from "../core/client.js"
import { ENDPOINTS } from "../core/endpoints.js"
import { ValidationError } from "../core/errors.js"
import { runWithCostConfirmation } from "../core/requestContext.js"
import type { ToolSpec } from "./define.js"
import type { ToolTextResult } from "./handler.js"

/** 一次调用的上下文，由 MCP handler 构造。`operations` 是本服务注册的全部工具。 */
export interface CallContext {
  client: GangtiseClient
  signal?: AbortSignal
  operations: ReadonlyMap<string, ToolSpec>
}

/** 唯一调用入口：任何入口调工具都走这里，确认闸门只有一份。
 *
 *  MCP 入口的入参已由 SDK 按同一份 strict schema 校验过，这里不再解析第二遍（zod 的转换
 *  不保证幂等）；将来别的入口进来时要先校验。 */
export async function invokeOperation(op: string, args: Record<string, unknown>, ctx: CallContext): Promise<ToolTextResult> {
  const spec = ctx.operations.get(op)
  if (!spec) throw new ValidationError(`未知工具：${op}`)
  // 按这次调用实际要打的端点判：网关的动作可逆与否随参数而定。
  const endpoint = spec.endpointFor?.(args) ?? spec.endpoint
  if (endpoint) assertConfirmed(endpoint, args.confirm === true)
  // 费用确认只进本次调用的上下文、不进请求体；分页层据此放行积分预估保护（core/paginate.ts）。
  const { confirmCost, ...rest } = args
  return runWithCostConfirmation(confirmCost === true, () => spec.run(ctx, rest))
}

/** 不可逆端点的确认闸门。文案取自 `ENDPOINTS[key].destructive`，所以「这个请求会做什么」
 *  只有一份事实。校验在取得任何网络资源之前，被拒时一个请求都不会发出去。 */
function assertConfirmed(endpointKey: string, confirmed: boolean): void {
  const destructive = ENDPOINTS[endpointKey]?.destructive
  if (!destructive || confirmed) return
  throw new ValidationError(`${destructive.warning}确认要执行请把 confirm 置为 true。`)
}
