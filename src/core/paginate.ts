import { createHash } from "node:crypto"

import { PAGE_CONCURRENCY } from "./config.js"
import { ApiError, ValidationError, errorMessage } from "./errors.js"
import { markPartial, type PartialReason } from "./partial.js"
import type { EndpointDefinition, RowId } from "./endpoints.js"
import { currentSignal } from "./requestContext.js"
import { CALL_LIMITS } from "./scheduler.js"
import { isVerbose, runWithConcurrency } from "./transport.js"

/** 分页：规划、扇出、total 探针、跨页去重与各种不完整判定。只依赖 HTTP 层的一次 JSON 请求。 */
export interface PageFetcher {
  requestJson<T>(endpoint: EndpointDefinition, body?: unknown, useAuth?: boolean): Promise<T>
}

const MAX_PAGES = CALL_LIMITS.maxPages

export interface PageRequest {
  from: number
  size: number
}

/**
 * Plans the page requests needed to cover [nextFrom, endFrom) in maxPageSize
 * chunks, capping the total page count (including the already-fetched first
 * page) at maxPages. Pure — extracted from requestPaginated for testing.
 */
export function planRemainingPages(nextFrom: number, endFrom: number, maxPageSize: number, maxPages: number): PageRequest[] {
  const reqs: PageRequest[] = []
  // -1 accounts for the first page that was already fetched serially. 上限写进循环条件，
  // 而不是先把整段区间的请求对象全部造出来再截——total 是千万级时那一步要临时分配几十 MB。
  const room = Math.max(0, maxPages - 1)
  let cursor = nextFrom
  while (cursor < endFrom && reqs.length < room) {
    const size = Math.min(maxPageSize, endFrom - cursor)
    reqs.push({ from: cursor, size })
    cursor += size
  }
  return reqs
}

const TOTAL_CAPPED_NOTE =
  "服务端返回的 total 是上限值而非真实计数，实际条数更多；本次只取到了上限内的部分"

/** 列表端点拒绝越界偏移时用的两个码：群消息列表回 140002，声明了 maxWindow 的 insight 列表回
 *  100006。封顶探针被这两个码拒绝，说明 total 处有一道没声明的偏移窗口；其他失败（重试耗尽的
 *  503、断连）对 total 什么也说明不了，照旧不标。 */
const OFFSET_REFUSAL_CODES = new Set(["140002", "100006"])

/** `total` 可能是上限值时写进结果的详情。三种来源各有自己的说明。 */
function totalCappedDetail(kind: "rows_beyond" | "refused" | "window", total: number, maxWindow?: number): Record<string, unknown> {
  if (kind === "rows_beyond") return { reportedTotal: total, note: TOTAL_CAPPED_NOTE }
  if (kind === "refused") {
    return { reportedTotal: total, note: "本接口拒绝返回 total 之后的那一行，多半是 total 处有偏移窗口：窗口外可能还有行，既取不到也数不到。请缩小查询范围（如缩短时间区间）分段拉取" }
  }
  return { reportedTotal: total, maxWindow, note: `本接口只能按偏移取到前 ${maxWindow} 行，total 已触及这个窗口：窗口外可能还有行，既取不到也数不到。请缩小查询范围（如缩短时间区间）分段拉取` }
}

/** 与字段顺序无关的序列化：对象键排序、数组保持原序。同一行的两次返回字段顺序可能不同，
 *  直接 `JSON.stringify` 会把内容相同的两行判成两个版本。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** 行的主键值；取不到（字段缺失或为 null、函数返回 undefined）时为 undefined。复合键把各字段值
 *  按 JSON 数组拼成一个串，任一字段取不到即整行取不到。 */
function rowKeyOf(rowId: RowId, row: Record<string, unknown>): string | undefined {
  if (typeof rowId === "function") return rowId(row)
  const fields = typeof rowId === "string" ? [rowId] : rowId
  const values = fields.map((field) => row[field])
  if (values.some((value) => value === undefined || value === null)) return undefined
  return typeof rowId === "string" ? String(values[0]) : JSON.stringify(values)
}

/** 翻页的跨页重复 / 变动检测（端点声明了 `rowId` 才生效）。
 *
 *  按非唯一键（`msgTime` / `publishTime`）排序的列表，同一时间点的一组行在两次翻页请求之间会
 *  换顺序：相邻两页各拿到其中一部分，于是有的行出现两次、有的一次都没出现，总行数却仍等于 total。
 *
 *  - 同一 ID 再次出现且与**已见过的任一版本**整行相同 → 重复，丢掉（`duplicate_rows`）。少掉的
 *    行数就是漏掉的行数。只比第一版会漏：v1 → v2 → v2 时第三行与第二行重复。
 *  - 同一 ID 在**后面的页**上出现新版本 → 翻页期间列表在变，各版都留（`changed_rows`）。
 *  - 同一 ID 在**同一页**里出现两版 → 这个字段不是本列表的行主键，此后不再报变动行。
 *  - 没有该字段、或值为 null 的行一律保留。只存 ID 与各版本的摘要，不存整行；摘要与字段顺序无关。 */
export function createRowTracker(rowId: RowId | undefined) {
  const seen = rowId ? new Map<string, Set<string>>() : undefined
  const state = { duplicateRows: 0, changedRows: 0, idIsRowKey: true }
  const filter = (rows: unknown[]): unknown[] => {
    if (!seen || !rowId) return rows
    // 本页每个 ID 出现过的版本。「同一页里一个 ID 有两版」要先于跨页去重单独判：两版都是已见过的
    // 版本时它们都会被当重复去掉，但这一页仍然证明了这个字段不是行主键。
    const onThisPage = new Map<string, Set<string>>()
    return rows.filter((row) => {
      const key = row && typeof row === "object" ? rowKeyOf(rowId, row as Record<string, unknown>) : undefined
      if (key === undefined) return true
      const digest = createHash("sha1").update(stableStringify(row)).digest("base64")
      const pageVersions = onThisPage.get(key)
      if (pageVersions === undefined) onThisPage.set(key, new Set([digest]))
      else {
        if (!pageVersions.has(digest)) state.idIsRowKey = false
        pageVersions.add(digest)
      }
      const versions = seen.get(key)
      if (versions === undefined) {
        seen.set(key, new Set([digest]))
        return true
      }
      if (versions.has(digest)) {
        state.duplicateRows++
        return false
      }
      // 本页已出现过这个 ID 的新版本不算「后面的页上变了」——那是同页两版，上面已判过。
      if (pageVersions === undefined) state.changedRows++
      versions.add(digest)
      return true
    })
  }
  return { filter, state }
}

/** 🔴 `{total: 0, list: null}` 是**合法的空结果**，不是异形。
 *
 * 相当一部分分页端点就是这么编码空结果的（summary / 三个公告 list / 财报日历 / 热点话题
 * 等），另一部分用 `{total: 0, list: []}`（research / official-account / qa / vault 系）。
 * 两种写法都得当空结果收——把前者当异形会在**正常的零命中查询**上打出「结果不完整、
 * 不要当作完整结果使用」，而调用方对这句话的自然反应是放宽条件重查，在按条计费的端点上
 * 直接就是钱。`normalizeRows` 下游本来也会把 `list: null` 归一成 `[]`。
 *
 * 判据只放宽这一格：`total === 0` 且 `list` 为 null/undefined。`total` 非 0 却没有 list，
 * 仍然是异形（那是真的丢了数据）。 */
export function isPaginatedListResponse(value: unknown): value is Record<string, unknown> & { total: number; list?: unknown } {
  if (!value || typeof value !== 'object') return false
  const { total, list } = value as { total?: unknown; list?: unknown }
  if (typeof total !== 'number') return false
  if (Array.isArray(list)) return true
  return total === 0 && (list === null || list === undefined)
}

/** The rows of a page that already passed `isPaginatedListResponse`.
 *
 * 🔴 该判据**有意**把 `{total: 0, list: null}` 收成合法空结果（见它的注释），所以
 * 「通过判据」并不保证 `list` 是数组——归一必须在**每一页**上做，不能只做首页。
 * 少了这一步，后续页拿到那个形状就会在合并循环里 `null.length` 抛 TypeError：
 * 已取到的行连同 `_partial` 标记一起丢掉，换来一句读不懂的 JS 报错，而 summary /
 * 三个公告 list / 财报日历 / 热点话题正是用这个形状编码空结果的。 */
function pageRows(page: Record<string, unknown> & { list?: unknown }): unknown[] {
  return Array.isArray(page.list) ? page.list : []
}

/** `total` 是否是**上限值**而不是真实计数。
 *
 * 这个形状曾出现在三个 opinion 系列上：`total` 被钉在一个固定上限，继续用更大的
 * `from` 翻页仍能取到真实记录、发布时间单调变老，说明真实条数远大于它。这是
 * Elasticsearch `track_total_hits` 默认值的典型形态。⚠️ **那三个端点现已返回真实
 * 计数**，本探针留着是防回归、也覆盖尚未验过的端点——它只可能给响应加元数据、
 * 不会拒绝查询，所以「当前没有端点命中」不是撤掉它的理由。
 *
 * 危害在于它**静默**：`requestPaginated` 用 `total - startFrom` 决定翻页目标，
 * total 封顶时正好取满、每页都是满页，`short_page` / `page_cap` / `total_drift`
 * 一个都不触发——调用方拿到的是一段截断数据，读起来却像完整集。
 *
 * 判据不写死那个上限值（服务端换个配置就失效，也不该把某个具体数字当契约）：
 * **直接探一行 `from = total`**，并**同时比对探针自己的 `total`**：total 没变且还有行
 * → 是上限；total 变了（涨或跌）→ 数据集动过（`total_drift`）；total 没变且没有行
 * → 是真计数。
 * 一次 size=1 的额外请求，只在调用方**以为自己取全了**时才发（见调用点）。 */
async function probeBeyondTotal(
  http: PageFetcher,
  endpoint: EndpointDefinition,
  initialBody: Record<string, unknown>,
  total: number,
): Promise<"capped" | "refused" | "drift" | "clean"> {
  // ⚠️ 别按 `retry === "no-replay"` 跳过本探针。两个理由：`no-replay` 治的是「重放一个
  // 服务端可能已执行的请求」，而探针是一次**新**请求，不是重放；且同时分页 + no-replay 的
  // ai.hot-topic 与两个带正文的观点列表都是按行计费，空探针零行零积分，跳过换不来省钱，
  // 只会让这几个端点失去封顶检测。撞到封顶时那一行的成本，正是发现「你拿到的是截断数据」的代价。
  try {
    const beyond = await http.requestJson<Record<string, unknown>>(endpoint, { ...initialBody, from: total, size: 1 })
    if (!isPaginatedListResponse(beyond)) return "clean"
    // 顺序要紧：**先比 total，再看有没有行**。
    //  - total 变了（涨或跌）→ 数据集在翻页期间动过 = `total_drift`。跌的那一档
    //    （100 → 99）探针必然返回 0 行，若先按「0 行 = clean」短路就漏报了。
    //  - total 没变、上限之外还有行 → `total` 本身就是上限 = `total_capped`。
    //  - total 没变、上限之外没有行 → 干净。
    // 不比 total 就会把每个正在增长的分页数据集误标成封顶；只看 total 不看行数，
    // 又会把「真计数」误标成封顶。两个维度都要看。
    if (beyond.total !== total) return "drift"
    return pageRows(beyond).length > 0 ? "capped" : "clean"
  } catch (error) {
    // 服务端**拒绝**了 total 之后那一行，与请求没送达不是一回事：total 之前的行都给了，
    // 恰好在 total 处被拒，这是没声明的偏移窗口的样子——按封顶保守处理。
    if (error instanceof ApiError && error.code !== undefined && OFFSET_REFUSAL_CODES.has(error.code)) return "refused"
    // 其他失败不能反过来污染主结果：宁可不标，也不要因为一次网络抖动就把
    // 一份完整数据标成 partial。
    return "clean"
  }
}

/** 分页端点的首包不是 `{total, list}` 时标记它。
 *
 * 这些端点的真实空结果是 `{total: 0, list: []}`，形状不对就说明本次翻页**没有发生**：
 * 拿到的只是第一页，而调用方无从分辨「这个筛选确实没命中」和「这个筛选没生效」。
 * 最隐蔽的一档是 `total` 漂成字符串这类——fetchAll 会被截断成第 1 页，结果看着却完整。
 *
 * 三种载荷分三条路：
 *  - 普通对象 → 原样展开再挂标记。
 *  - **裸数组 → 包成 `{list, _partial…}`**。直接挂属性会在序列化时消失，于是一个
 *    「端点不再包信封」的漂移会以一份看着完整的行数组交出去，静默且无从分辨。包一层
 *    是唯一能让标记活着到达调用方的写法，`normalizeRows` 下游照常把它摊回列表。
 *  - `null` / 标量 → 原样返回：`null` 由工具层的 `nullMeansEmpty` 契约处理（没开就
 *    响亮失败），而标量不可能被误读成一批行。 */
function flagUnexpectedPageShape(page: unknown): unknown {
  if (!page || typeof page !== "object") return page
  const detail = {
    _unexpected_page_shape: "本接口标记为分页，但返回的首包不是 {total, list} 结构；已原样返回，未进行翻页——这份结果可能只是第一页，也可能是筛选条件未生效，不要当作完整结果使用",
  }
  const base = Array.isArray(page) ? { list: page } : (page as Record<string, unknown>)
  return markPartial(base, "unexpected_page_shape", detail)
}

export async function requestPaginated(http: PageFetcher, endpoint: EndpointDefinition, body?: unknown) {
  const initialBody = body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {}

  if ('from' in initialBody && (typeof initialBody.from !== 'number' || !Number.isFinite(initialBody.from) || initialBody.from < 0)) {
    throw new ValidationError('Invalid from: expected a non-negative number')
  }
  if ('size' in initialBody && initialBody.size !== undefined && (typeof initialBody.size !== 'number' || !Number.isFinite(initialBody.size) || initialBody.size <= 0)) {
    throw new ValidationError('Invalid size: expected a positive number')
  }

  const startFrom = typeof initialBody.from === 'number' && Number.isFinite(initialBody.from) ? initialBody.from : 0
  const requestedSize = typeof initialBody.size === 'number' && Number.isFinite(initialBody.size) ? initialBody.size : undefined
  const offset = endpoint.pagination?.mode === "offset" ? endpoint.pagination : undefined
  const maxPageSize = offset?.maxPageSize ?? requestedSize ?? 20
  // 偏移窗口：服务端拒绝 from + size 超过它的任何一页，与 total 多大无关。页只在窗口内规划——
  // 跨窗口的那一页会让整段尾巴失败；窗口外的行取不到，结果标 window_cut。
  const maxWindow = offset?.maxWindow
  if (maxWindow !== undefined && startFrom >= maxWindow) {
    throw new ValidationError(`本接口只能按偏移取到第 ${maxWindow} 行为止（from + size ≤ ${maxWindow}），from=${startFrom} 已越过：请缩小查询范围（如缩短时间区间）分段拉取，而不是继续往后翻页。`)
  }
  const windowRoom = maxWindow === undefined ? Number.POSITIVE_INFINITY : maxWindow - startFrom

  // First page: serial — we need total before deciding how many more requests to fan out.
  const firstPageSize = Math.min(requestedSize === undefined ? maxPageSize : Math.min(maxPageSize, requestedSize), windowRoom)
  const firstPage = await http.requestJson<Record<string, unknown>>(endpoint, {
    ...initialBody,
    from: startFrom,
    size: firstPageSize,
  })

  if (!isPaginatedListResponse(firstPage)) return flagUnexpectedPageShape(firstPage)
  // 合法空结果的两种写法（`list: []` 与 `list: null`）在这里合流，后面一律按数组处理。
  // 写回一次，让后面每一处 `...firstPage` 展开都带着归一后的数组。
  const firstRows = pageRows(firstPage)
  firstPage.list = firstRows

  const total = firstPage.total
  const tracker = createRowTracker(endpoint.rowId)
  const collected: unknown[] = tracker.filter(firstRows)
  const available = Math.max(total - startFrom, 0)
  const wanted = requestedSize === undefined ? available : Math.min(requestedSize, available)
  const target = Math.min(wanted, windowRoom)
  // total 触及窗口时探针那一行本身就在窗口外，服务端必拒——不必花这个请求。
  const probeFits = maxWindow === undefined || total + 1 <= maxWindow

  /** total 是不是上限值：窗口已知时直接判，否则探一行。返回要追加的原因与详情。 */
  const checkTotalCap = async (): Promise<{ reason: "total_capped" | "total_drift"; detail?: Record<string, unknown> } | undefined> => {
    if (!probeFits) return { reason: "total_capped", detail: totalCappedDetail("window", total, maxWindow) }
    const verdict = await probeBeyondTotal(http, endpoint, initialBody, total)
    if (verdict === "capped") return { reason: "total_capped", detail: totalCappedDetail("rows_beyond", total) }
    if (verdict === "refused") return { reason: "total_capped", detail: totalCappedDetail("refused", total) }
    if (verdict === "drift") return { reason: "total_drift" }
    return undefined
  }

  // 取键函数没有可展示的名字，明细里不写。
  const rowIdLabel = typeof endpoint.rowId === "function" ? undefined : endpoint.rowId

  /** 本轮新增的三种不完整原因，排在各路径既有原因之后。 */
  const flagRowIssues = (reasons: PartialReason[], details: Record<string, unknown>): void => {
    if (target < wanted) {
      reasons.push("window_cut")
      details._window_cut = {
        maxWindow,
        requestedRows: wanted,
        fetchableRows: target,
        note: `本接口只能按偏移取到第 ${maxWindow} 行为止，请求的行里有 ${wanted - target} 行在窗口之外、未取回：请缩小查询范围（如缩短时间区间）分段拉取`,
      }
    }
    const { duplicateRows, changedRows, idIsRowKey } = tracker.state
    if (duplicateRows > 0) {
      reasons.push("duplicate_rows")
      details._duplicate_rows = {
        count: duplicateRows,
        rowId: rowIdLabel,
        note: "同一行在相邻两页各出现一次（翻页排序键不唯一，同一时间点的一组行在两次请求间换了顺序）：重复的已去掉，同样多的行一次都没出现、未取回。缩短时间范围后重查可以取全",
      }
    }
    if (changedRows > 0 && idIsRowKey && !endpoint.rowIdUnverified) {
      reasons.push("changed_rows")
      details._changed_rows = {
        count: changedRows,
        rowId: rowIdLabel,
        note: "同一 ID 在后面的页上内容变了：翻页期间列表在变化，两版都已保留（按 ID 去重会只剩一版），相邻的行也可能漏了。重查一次可取到一致的结果",
      }
    }
  }

  // Last page reached on first request
  if (firstRows.length < firstPageSize) {
    const shortResult: Record<string, unknown> = {
      ...firstPage,
      total,
      list: requestedSize === undefined ? collected : collected.slice(0, requestedSize),
    }
    // A short page normally means "no more data" — but when total says the
    // range holds more, the server's effective page size is smaller than the
    // declared maxPageSize and the hole must carry the loud-partial marker.
    const returned = (shortResult.list as unknown[]).length
    const expectable = Math.min(
      typeof total === "number" ? Math.max(total - startFrom, 0) : returned,
      requestedSize ?? Number.POSITIVE_INFINITY,
    )
    const reasons: PartialReason[] = []
    const details: Record<string, unknown> = {}
    // 被当成重复丢掉的行不算短页：服务端把行都给了，只是有的给了两遍（见 duplicate_rows）。
    if (returned + tracker.state.duplicateRows < expectable) {
      reasons.push("short_page")
      flagRowIssues(reasons, details)
      return markPartial(shortResult, reasons, details)
    }
    // 短页**恰好覆盖了 reported total** = 调用方以为拿到了全部，和下面「取满 target」
    // 是同一种处境，同样要探。上限比单页还小、或记录全落在首屏时会走这条路径——
    // 早期实现在这里直接 return，于是那两种情形拿不到任何 _partial 标记。
    // 触发条件不是「没限 size」，而是「**这次请求已经覆盖到 reported end**」——
    // 显式传 size=200 而 total=100 时，调用方同样以为自己取全了，漏探就漏标。
    const coversReportedEnd =
      requestedSize === undefined || (typeof total === "number" && startFrom + requestedSize >= total)
    if (coversReportedEnd && typeof total === "number" && total > 0) {
      const cap = await checkTotalCap()
      if (cap) {
        reasons.push(cap.reason)
        if (cap.detail) details._total_capped = cap.detail
      }
    }
    flagRowIssues(reasons, details)
    return markPartial(shortResult, reasons, details)
  }

  if (firstRows.length >= target) {
    const early: Record<string, unknown> = {
      ...firstPage,
      total,
      list: requestedSize === undefined ? collected : collected.slice(0, requestedSize),
    }
    // 触发条件是「本次请求**已覆盖 reported end**」——只有没覆盖到尾部的请求
    // （size 小于剩余量）才不探，因为那种调用方本来就没声称取全。
    // 注意 size 大小本身说明不了问题：size=200/total=100 覆盖到了，
    // size=20/total=10 也覆盖到了，两者都要探。
    // 窗口截掉了请求的行时不探：那种结果已经标了 window_cut，探针也只会落在窗口外。
    const reasons: PartialReason[] = []
    const details: Record<string, unknown> = {}
    if ((requestedSize === undefined || startFrom + requestedSize >= total) && total > 0 && target === wanted) {
      const cap = await checkTotalCap()
      if (cap) {
        reasons.push(cap.reason)
        if (cap.detail) details._total_capped = cap.detail
      }
    }
    flagRowIssues(reasons, details)
    return markPartial(early, reasons, details)
  }

  // Build remaining page requests
  const nextFrom = startFrom + firstRows.length
  const endFrom = startFrom + target
  const pageRequests = planRemainingPages(nextFrom, endFrom, maxPageSize, MAX_PAGES)
  const plannedEndFrom = pageRequests.length === 0
    ? nextFrom
    : pageRequests[pageRequests.length - 1].from + pageRequests[pageRequests.length - 1].size
  const hitPageCap = plannedEndFrom < endFrom

  let unexpectedShape = false
  let totalDrift = false
  const failedPages: Array<{ from: number; size: number; error: string }> = []
  // 客户端取消后不再派发剩余页：取消的请求结果到不了调用方，多拉的每一页都是白花的
  // 请求与（按行计费端点上的）积分。
  const signal = currentSignal()
  const pages = await runWithConcurrency(pageRequests, PAGE_CONCURRENCY, async (req) => {
    try {
      const page = await http.requestJson<Record<string, unknown>>(endpoint, {
        ...initialBody,
        from: req.from,
        size: req.size,
      })
      if (!isPaginatedListResponse(page)) {
        unexpectedShape = true
        return [] as unknown[]
      }
      if (page.total !== total) totalDrift = true
      return pageRows(page)
    } catch (err) {
      // 取消不是「这一页失败了」，是整个请求作废。这里照常记进 _failed_pages 没关系：
      // `runWithConcurrency` 收尾时看到 signal 已 abort 会直接抛，这份 _partial 结果
      // 根本不会被返回（`clientCancel.test.ts` 钉住这条）。
      // Collect the failure instead of fail-fasting the whole batch: return the
      // pages we did get, flagged _partial — same loud-partial contract as
      // quoteSharding, so a dropped page never masquerades as complete data.
      failedPages.push({ from: req.from, size: req.size, error: errorMessage(err) })
      return [] as unknown[]
    }
  }, signal)

  // 按页序合并，去重也按页序做：「后面的页」才谈得上变动行。
  for (const list of pages) {
    if (list.length === 0) continue
    collected.push(...tracker.filter(list))
  }

  if (unexpectedShape && isVerbose()) {
    process.stderr.write(`[gangtise] warning: a page response had unexpected shape; results may be incomplete\n`)
  }
  if (totalDrift && isVerbose()) {
    process.stderr.write(`[gangtise] warning: 'total' changed across pages (data shifted during fetch)\n`)
  }

  const returnedList = requestedSize === undefined ? collected : collected.slice(0, requestedSize)
  const response: Record<string, unknown> = {
    ...firstPage,
    total,
    list: returnedList,
  }

  const partialReasons: PartialReason[] = []
  const details: Record<string, unknown> = {}
  if (hitPageCap) {
    partialReasons.push("page_cap")
    details._page_cap = {
      maxPages: MAX_PAGES,
      targetItems: target,
      returnedItems: returnedList.length,
    }
  }
  if (unexpectedShape) partialReasons.push("unexpected_page_shape")
  if (totalDrift) partialReasons.push("total_drift")
  // total 封顶：翻页目标是按 total 算的，封顶时会「正好取满」而不触发任何其他标记。
  // 只在真的把 target 取满（= 调用方以为拿到了全部）时才探；只因去重而少了的也算取满。
  const shortByRepeatsOnly = returnedList.length < target && returnedList.length + tracker.state.duplicateRows >= target
  if ((requestedSize === undefined || startFrom + requestedSize >= total) && total > 0 && target === wanted && (returnedList.length >= target || shortByRepeatsOnly) && failedPages.length === 0) {
    const cap = await checkTotalCap()
    if (cap?.reason === "total_capped") {
      partialReasons.push("total_capped")
      details._total_capped = cap.detail
    } else if (cap?.reason === "total_drift" && !partialReasons.includes("total_drift")) {
      partialReasons.push("total_drift")
    }
  }
  if (failedPages.length > 0) {
    partialReasons.push("failed_pages")
    details._failed_pages = failedPages
  }
  // Pages all succeeded and no cap was hit, yet fewer rows than target arrived
  // — the server under-filled pages. Same loud-partial contract.
  if (partialReasons.length === 0 && returnedList.length < target && !shortByRepeatsOnly) partialReasons.push("short_page")
  flagRowIssues(partialReasons, details)
  return markPartial(response, partialReasons, details, "details-first")
}
