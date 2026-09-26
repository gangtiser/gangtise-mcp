import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { withBilling } from "./billing.js"
import type { FamilyModule, ToolSpec, ZodShape } from "./define.js"
import { toolHandler } from "./handler.js"
import { invokeOperation } from "./invoke.js"

/** 按顺序注册各族的全部工具。handler 只做一件事：调 invokeOperation。 */
export function registerFamilies(server: McpServer, client: GangtiseClient, families: FamilyModule[]): void {
  registerTools(server, client, families.flatMap((family) => family.tools))
}

export function registerTools(server: McpServer, client: GangtiseClient, specs: ToolSpec[]): void {
  const operations = new Map<string, ToolSpec>()
  for (const spec of specs) {
    if (operations.has(spec.name)) throw new Error(`duplicate tool name: ${spec.name}`)
    operations.set(spec.name, spec)
  }
  for (const spec of specs) {
    const billing = spec.billingLabel ?? spec.endpoint
    if (billing === undefined) throw new Error(`${spec.name}: endpoint 与 billingLabel 必有其一`)
    server.registerTool(
      spec.name,
      { description: withBilling(spec.description, billing), inputSchema: strictInput(spec.input), annotations: annotationsFor(spec) },
      // toolHandler 统一错误形状，并把取消信号带进调用链（见 handler.ts）。
      toolHandler((args: Record<string, unknown>, extra) => invokeOperation(spec.name, args, { client, signal: extra?.signal, operations })),
    )
  }
}

/** 只读 → readOnlyHint；写操作声明了幂等性时一并给出 destructiveHint / idempotentHint。
 *  全部 openWorldHint:false（只访问本平台）。 */
function annotationsFor(spec: ToolSpec) {
  if (spec.access === "read") return { readOnlyHint: true, openWorldHint: false }
  if (spec.idempotent === undefined) return { readOnlyHint: false, openWorldHint: false }
  return { readOnlyHint: false, destructiveHint: spec.access === "destructive", idempotentHint: spec.idempotent, openWorldHint: false }
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
 * 已经是对象 schema 的原样放行（由声明方自己决定 strict 与顶层 refine）。
 * 对已发布的 tools/list schema 表面无影响（strict 只改解析行为，不加字段）。 */
function strictInput(input: ZodShape | z.AnyZodObject) {
  return input instanceof z.ZodType ? input : z.object(input).strict()
}
