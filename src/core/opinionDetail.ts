import { ApiError, ResponseShapeError } from "./errors.js"
import { markPartial, type PartialReason } from "./partial.js"

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
 *  那时手里什么都没有。
 *
 *  元素形状由端点的 `expects: "array"` 在 HTTP 层校验（元素须是对象或 `null`，校验时还握着信封，报错带
 *  traceId）。`null` 按「该 ID 没有正文」跳过，由对账记进 `missingIds`。混进数字、字符串、数组时说明
 *  形状变了：从异常的载荷里取回同批能认出 ID 的正文（已付费，丢掉就要重付），这一批其余的 ID 与后面
 *  各批记 `unfetchedIds`，不再往下发。 */
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
    const batch = unique.slice(i, i + OPINION_DETAIL_BATCH)
    let rows: unknown[]
    let malformed: ResponseShapeError | undefined
    try {
      rows = (await client.call(endpointKey, { [idListField]: batch })) as unknown[]
    } catch (error) {
      if (error instanceof ResponseShapeError && Array.isArray(error.payload)) {
        rows = error.payload
        malformed = error
      } else {
        if (i === 0) throw error
        unfetched = unique.slice(i)
        unfetchedError = describe(error)
        break
      }
    }
    const bodies = rows.filter(isRecord)
    list.push(...bodies)
    if (malformed) {
      if (i === 0 && bodies.length === 0) throw malformed
      const got = new Set(bodies.map((row) => String(row[idField])))
      unfetched = [...batch.filter((id) => !got.has(id)), ...unique.slice(i + OPINION_DETAIL_BATCH)]
      unfetchedError = describe(malformed)
      break
    }
  }
  const returned = new Set(list.map((row) => String(row[idField])))
  const missing = unique.filter((id) => !returned.has(id) && !unfetched.includes(id))
  const reasons: PartialReason[] = []
  const details: Record<string, unknown> = {}
  if (missing.length > 0) {
    reasons.push("missing_ids")
    details.missingIds = missing
  }
  if (unfetched.length > 0) {
    reasons.push("unfetched_ids")
    details.unfetchedIds = unfetched
    details.unfetchedError = unfetchedError
  }
  return markPartial({ total: list.length, list }, reasons, details, "details-first")
}

function isRecord(row: unknown): row is Record<string, unknown> {
  return row !== null && typeof row === "object" && !Array.isArray(row)
}

function describe(error: unknown): Record<string, unknown> {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof ApiError ? { code: error.code, traceId: error.traceId } : {}),
  }
}
