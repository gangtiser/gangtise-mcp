import { ApiError, ResponseShapeError } from "./errors.js"

/** 分批取正文只需要 client 的这一个方法，测试可以不经 HTTP 驱动它。 */
export interface DetailClient {
  call(endpointKey: string, body?: unknown): Promise<unknown>
}

/** 两个 detail 端点单次最多收 20 个 ID。 */
export const OPINION_DETAIL_BATCH = 20

/** 按 ID 取观点正文。
 *
 *  服务端对没有正文的 ID **直接跳过、不报错**（ID 写错、超出账号的取数窗口、刚发布的都可能），
 *  所以必须拿请求与返回对账：没回来的记 `missingIds`，结果标 `_partial`。
 *
 *  每批按返回的正文计费，因此串行发、且某一批失败时**保留已经付费的正文**：未取的 ID 记
 *  `unfetchedIds` + `unfetchedError`，调用方只需重跑这几个。只有第一批就失败才整体报错——
 *  那时手里什么都没有。数组形状由端点的 `expects: "array"` 在 client 里保证、元素是不是对象在这里
 *  逐批校验，形状不对时整批按失败处理，而不会把已付费的正文报成「缺正文」或整次丢掉。 */
export async function fetchOpinionDetails(
  client: DetailClient,
  endpointKey: string,
  idListField: string,
  idField: string,
  ids: string[],
): Promise<Record<string, unknown>> {
  const unique = [...new Set(ids)]
  const list: Record<string, unknown>[] = []
  let unfetched: string[] = []
  let unfetchedError: Record<string, unknown> | undefined
  for (let i = 0; i < unique.length; i += OPINION_DETAIL_BATCH) {
    try {
      const rows = await client.call(endpointKey, { [idListField]: unique.slice(i, i + OPINION_DETAIL_BATCH) })
      // 数组形状由端点的 expects 保证，元素还得逐个是对象，才能按 ID 对账。有异常元素的一批按形状
      // 不符处理：走下面的失败路径，前面批次已付费的正文照常保留。
      if (!Array.isArray(rows) || !rows.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) {
        throw new ResponseShapeError("观点正文的返回里有不是对象的元素（形状可能已变更），这一批无法按 ID 逐条对上。请重试；持续出现请带上工具名与入参报障。", undefined, undefined, rows)
      }
      list.push(...(rows as Record<string, unknown>[]))
    } catch (error) {
      if (i === 0) throw error
      unfetched = unique.slice(i)
      unfetchedError = {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ApiError ? { code: error.code, traceId: error.traceId } : {}),
      }
      break
    }
  }
  const returned = new Set(list.map((row) => String(row[idField])))
  const missing = unique.filter((id) => !returned.has(id) && !unfetched.includes(id))
  const out: Record<string, unknown> = { total: list.length, list }
  const reasons: string[] = []
  if (missing.length > 0) {
    reasons.push("missing_ids")
    out.missingIds = missing
  }
  if (unfetched.length > 0) {
    reasons.push("unfetched_ids")
    out.unfetchedIds = unfetched
    out.unfetchedError = unfetchedError
  }
  if (reasons.length > 0) {
    out._partial = true
    out._partial_reason = reasons.join(",")
  }
  return out
}
