import { ENDPOINTS, type Billing } from "../core/endpoints.js"

/**
 * 积分标签渲染。单价写在端点上（core/endpoints.ts 的 `billing`），工具的标签由它打的端点派生：
 * spec 驱动的工具取 `endpointKey`（按参数选端点的取默认档），直接注册的工具在调用点指明端点；
 * 本地工具传 `LOCAL`。
 *
 * 计分表给的是「标准产品数据窗口」，实际取数范围随账号权限变化 —— 这里只渲染单价，不记窗口，
 * 也不据此做任何本地拦截。
 */

export type { Billing }

export const LOCAL: Billing = { kind: "local" }

const PER_UNIT = { call: "次", page: "页", row: "条", document: "条" } as const

/** 端点的计费。端点键写错直接 throw：启动即炸，好过静默按「单价以平台计费为准」展示。 */
export function endpointBilling(endpointKey: string): Billing | undefined {
  const endpoint = ENDPOINTS[endpointKey]
  if (!endpoint) throw new Error(`billing: unknown endpoint ${endpointKey}`)
  return endpoint.billing
}

function resolve(source: string | Billing): Billing | undefined {
  return typeof source === "string" ? endpointBilling(source) : source
}

/**
 * 紧凑积分标签，是描述的**最后一段**。免费档返回空串 ——
 * instructions 末行已声明「未标注即免费」。缺失 `billing` 按 `unknown` 渲染：未确认 ≠ 免费。
 *
 * 取值是冻结的词表之一，`amplify` **绝不进这里** —— 它走 billingSuffix()。
 */
export function billingLabel(source: string | Billing): string {
  const billing = resolve(source)
  switch (billing?.kind) {
    case "free":
      return ""
    case "local":
      return "【本地工具，不消耗 OpenAPI 积分】"
    case "fixed":
      return `【积分：${billing.price}/${billing.unit ?? PER_UNIT[billing.per]}】`
    case "downstream":
      return "【积分：按下游资源类型】"
    case "variable":
      return "【积分：按所选指标】"
    case "unknown":
    case undefined:
      return "【积分：单价以平台计费为准】"
  }
}

/**
 * 标签**之外**的生成式计费尾注：目前只有高放大提示（分页 fetchAll 警示已上收到
 * server.instructions）。排在标签之前 —— 因此 listTools 门禁的顺序是「先剥标签 → 再剥本尾注 →
 * 最后扫残留」。
 */
export function billingSuffix(source: string | Billing): string {
  const billing = resolve(source)
  return billing && "amplify" in billing && billing.amplify ? `${billing.amplify}。` : ""
}

/** 描述 + 生成式尾注 + 积分标签。`source` 是端点键或工具自己的计费。标签必须留在最后 ——
 *  门禁按尾部逐段剥离。 */
export function withBilling(description: string, source: string | Billing): string {
  return description + billingSuffix(source) + billingLabel(source)
}
