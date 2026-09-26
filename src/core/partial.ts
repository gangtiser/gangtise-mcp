/** 结果不完整的标记：原因的唯一清单、各原因附带的明细字段，以及写标记的唯一写法。
 *
 * `_partial_reason` 是逗号拼接的多原因列表，一份结果可能先后被好几层标记（分页层、合并层、
 * 工具层）。每层都自己 `split(",")` 再 `push`，早晚有一层写成覆盖而不是追加，前面的原因就
 * 丢了。所以只留 `markPartial` 一种写法。
 *
 * 新增原因要同时加进 `PARTIAL_DETAILS` 与 README「结果不完整时的标记」表——
 * tests/docs/readme-partial-reasons.test.ts 双向对账。 */

/** 每种原因可能附带的明细字段。空数组 = 只有原因标记（或只附一条通用的 `_hint`）。 */
export const PARTIAL_DETAILS = {
  missing_fields: ["missingFields"],
  dropped_columns: ["_dropped_columns", "_dropped_columns_note"],
  limit_truncated: ["_truncated_shards", "_truncated_securities"],
  failed_shards: ["_failed_shards"],
  failed_securities: ["_failed_securities"],
  failed_pages: ["_failed_pages"],
  failed_items: ["failedItems"],
  malformed_shards: ["_malformed_shards"],
  malformed_securities: ["_malformed_securities"],
  part_partial: [],
  short_page: [],
  page_cap: ["_page_cap"],
  total_drift: [],
  total_capped: ["_total_capped"],
  window_cut: ["_window_cut"],
  duplicate_rows: ["_duplicate_rows"],
  changed_rows: ["_changed_rows"],
  unexpected_page_shape: ["_unexpected_page_shape"],
  omitted_indicators: ["omittedIndicators"],
  omitted_securities: ["omittedSecurities"],
  missing_ids: ["missingIds"],
  unfetched_ids: ["unfetchedIds", "unfetchedError"],
  security_only_row_cap: [],
} as const satisfies Record<string, readonly string[]>

export type PartialReason = keyof typeof PARTIAL_DETAILS

export const PARTIAL_REASONS = Object.keys(PARTIAL_DETAILS) as PartialReason[]

/** 全部明细字段。大响应落盘后，非列表对象的指针只带这些字段——正文沉进文件没关系，
 *  「这份结果完整吗」不能跟着沉下去。 */
export const PARTIAL_DETAIL_KEYS: readonly string[] = [...new Set(Object.values(PARTIAL_DETAILS).flat())]

/** 逐份（逐页 / 逐片 / 逐只）记录的明细数组。它们条数与失败份数成正比，大响应的预览里只
 *  采样前几条并如实标注总数（见 present.ts 的 sampleDiagnostics）。 */
export const PER_PART_DETAIL_KEYS: readonly string[] = [
  "_failed_pages",
  "_failed_shards", "_malformed_shards", "_truncated_shards",
  "_failed_securities", "_malformed_securities", "_truncated_securities",
]

/** 结果上已有的原因（逗号拼接串拆开）。 */
export function partialReasonsOf(result: unknown): string[] {
  if (!result || typeof result !== "object") return []
  const raw = (result as Record<string, unknown>)._partial_reason
  return typeof raw === "string" && raw ? raw.split(",") : []
}

/** 给结果标上不完整：原因追加到已有原因之后（去重），明细按给定顺序写入。返回新对象，不改入参。
 *
 *  键序是对外输出的一部分（结果按 JSON 原样交给模型），两种写法都在用：
 *  - `markers-first`（默认）：先 `_partial` / `_partial_reason`，再明细；
 *  - `details-first`：先明细，再 `_partial` / `_partial_reason`。
 *  已存在的键保留原位置，只更新值。`reasons` 为空时原样返回。 */
export function markPartial<T extends Record<string, unknown>>(
  result: T,
  reasons: PartialReason | readonly PartialReason[],
  details: Record<string, unknown> = {},
  order: "markers-first" | "details-first" = "markers-first",
): T {
  const added = typeof reasons === "string" ? [reasons] : reasons
  if (added.length === 0) return result
  const merged = partialReasonsOf(result)
  for (const reason of added) if (!merged.includes(reason)) merged.push(reason)
  const markers = { _partial: true, _partial_reason: merged.join(",") }
  return (order === "markers-first"
    ? { ...result, ...markers, ...details }
    : { ...result, ...details, ...markers }) as T
}

/** 去掉不完整标记（合并结果的元数据取自第一份，第一份自带的标记在合并完整时要清掉）。 */
export function clearPartial<T extends Record<string, unknown>>(result: T): T {
  const { _partial: _dropped, _partial_reason: _droppedReason, ...rest } = result
  return rest as T
}
