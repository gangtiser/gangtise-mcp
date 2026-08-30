import { createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { gunzipSync } from "node:zlib"

import { request } from "undici"

import { DEFAULT_MAX_DOWNLOAD_BYTES, PAGE_CONCURRENCY, type CliConfig } from "./config.js"
import { isTokenCacheValid, normalizeToken, readTokenCache, readTokenCacheWithMtime, requireAccessCredentials, writeTokenCache, type TokenCache } from "./auth.js"
import { ApiError, DownloadError, ValidationError, errorMessage } from "./errors.js"
import { ENDPOINTS, type EndpointDefinition } from "./endpoints.js"
import { Envelope, isEnvelope, unwrapEnvelope } from "./envelope.js"
import { getLookupData } from "./lookupData/index.js"
import { getDispatcher, getDownloadDispatcher, isVerbose, logTiming, markRetryable, runWithConcurrency, withRetry } from "./transport.js"

// Error codes that warrant one forced token refresh + retry:
//   8000014 / 8000015 — access/secret key errors (arrive as HTTP 200 envelopes)
//   0000001008 — "token is invalid" (HTTP 401): a cached token rejected
//     server-side even though not locally expired (e.g. the session was
//     superseded by a newer login elsewhere).
//   999002 — the 2026-07-17 renumbering of 0000001008. Listed ahead of the
//     switchover: without it the self-heal silently stops working the day the
//     token filter migrates, surfacing as a hard auth failure to the user.
// 999011 (AK/SK mismatch) is deliberately absent — bad credentials never heal,
// and transport's NON_RETRYABLE_API_CODES stops it being replayed on a 5xx either.
const AUTH_RETRY_CODES = new Set(["8000014", "8000015", "0000001008", "999002"])

/** 一次「凭据被拒」的判据：带码的按 AUTH_RETRY_CODES，**没有码的裸 HTTP 401 也算**。
 *
 * 🔴 只认码会漏掉下载链路。信封形态的错误才有 `code`，而下载响应可能根本不是信封：
 * 跟随 30x 之后落到对象存储域名，它拒绝过期凭据时返回的是自家的 HTML / XML；网关直接
 * 挡下时返回的可能是空体。这些路径构造出的 `ApiError` 的 `code` 是 `undefined`，于是
 * 自愈整个不发生 —— 缓存里那个已失效的 token 会一直用到本地时钟判定它过期为止，期间
 * 每一次下载都失败，而 JSON 接口因为走信封反而是好的，现象上像「只有下载坏了」。
 *
 * 401 的语义本身就是「这个凭据不被接受」，据此刷新一次是安全的：`authState.retried`
 * 保证每个请求只自愈一次，AK/SK 不对的情况会在第二次以同样的 401 结束、不成环。 */
function isAuthRejection(error: ApiError): boolean {
  if (error.code) return AUTH_RETRY_CODES.has(error.code)
  return error.statusCode === 401
}

const MAX_PAGES = 1000

/** 流式字节上限：超出即中止整条 pipeline。 */
function capBytes(limit: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length
      if (seen > limit) {
        cb(new DownloadError(`下载内容超过单文件上限 ${(limit / 1048576).toFixed(0)} MB，已中止以免占满临时磁盘。`))
        return
      }
      cb(null, chunk)
    },
  })
}

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
  let cursor = nextFrom
  while (cursor < endFrom) {
    const size = Math.min(maxPageSize, endFrom - cursor)
    reqs.push({ from: cursor, size })
    cursor += size
  }
  // +1 accounts for the first page that was already fetched serially.
  if (reqs.length + 1 > maxPages) {
    reqs.length = Math.max(0, maxPages - 1)
  }
  return reqs
}

export interface DownloadResponse {
  data?: Uint8Array
  text?: string
  url?: string
  contentType?: string
  filename?: string
  /** When set, the response body has been streamed directly to this path (no in-memory buffer). */
  savedPath?: string
}

const TOTAL_CAPPED_NOTE =
  "服务端返回的 total 是上限值而非真实计数，实际条数更多；本次只取到了上限内的部分"

export class GangtiseClient {
  private refreshPromise: Promise<string> | null = null
  private memoCache: TokenCache | null = null

  constructor(private readonly config: CliConfig) {}

  private async getAuthorizationHeader(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      if (isTokenCacheValid(this.memoCache)) {
        return normalizeToken(this.memoCache!.accessToken)
      }
      if (this.config.token) {
        return normalizeToken(this.config.token)
      }
      const cache = await readTokenCache(this.config.tokenCachePath)
      if (isTokenCacheValid(cache)) {
        this.memoCache = cache
        return normalizeToken(cache!.accessToken)
      }
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.doTokenRefresh().finally(() => { this.refreshPromise = null })
    }
    return this.refreshPromise
  }

  private async doTokenRefresh(): Promise<string> {
    const credentials = requireAccessCredentials(this.config.accessKey, this.config.secretKey)

    const envelope = await this.requestJson<{
      accessToken: string
      expiresIn: number
      uid?: number
      userName?: string
      tenantId?: number
      time: number
    }>(ENDPOINTS["auth.login"], {
      accessKey: credentials.accessKey,
      secretKey: credentials.secretKey,
    }, false)

    const accessToken = normalizeToken(envelope.accessToken)
    const expiresAt = Math.floor(Date.now() / 1000) + envelope.expiresIn

    const cache: TokenCache = { ...envelope, accessToken, expiresAt }
    this.memoCache = cache
    // Persisting to disk is a cross-process cache optimization — this token is
    // already valid in memoCache. A write failure (read-only home, ENOSPC) must
    // not fail the in-flight request that triggered the refresh, nor its
    // concurrent waiters on refreshPromise; the next process just re-logs in.
    await writeTokenCache(this.config.tokenCachePath, cache).catch((err) => {
      if (isVerbose()) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[gangtise] token cache write failed (token still valid in memory): ${msg}\n`)
      }
    })

    return accessToken
  }

  /**
   * On a recoverable auth error (expired/invalid token codes), force a one-time
   * token refresh and re-throw as retryable so withRetry replays the request.
   * Otherwise — or once we've already retried this request — it's a no-op and
   * the caller re-throws the original error. `authState` persists across the
   * withRetry attempts so we only refresh once per logical request.
   */
  private async refreshAuthIfRecoverable(error: unknown, useAuth: boolean, authState: { retried: boolean; startedAt: number }, usedAuthorization?: string): Promise<void> {
    if (
      useAuth
      && !authState.retried
      && error instanceof ApiError
      && isAuthRejection(error)
      && this.config.accessKey
      && this.config.secretKey
    ) {
      authState.retried = true
      this.memoCache = null
      // The sibling gangtise CLI shares the token cache file. If it refreshed
      // while this request was in flight, adopt that token instead of logging in
      // again — a new login supersedes the sibling's session server-side and
      // would bounce its requests right back.
      //
      // 🔴 判据必须是「这个缓存**在本次请求期间**被写过」，不能只看「盘上的 token 与
      // 刚失败的那个不同」。不同有两种来源，处置完全相反：
      //   ① 兄弟进程刚刷新 → 采用它（本条优化的全部意义）。
      //   ② 盘上本来就躺着一个**早已写入、按本地时钟还没过期、但服务端已失效**的旧
      //      token（最典型的是配了 GANGTISE_TOKEN 时，磁盘缓存根本不是本次请求的凭据
      //      来源）→ 采用它等于拿另一个死 token 重试一次，把每次请求仅有的一次自愈名
      //      额白白烧掉，而真正该做的 AK/SK 登录再也不会发生。
      // 两者的 token 都「不等于失败的那个」，只有写入时间能把它们分开。
      const { cache: fileCache, mtimeMs } = await readTokenCacheWithMtime(this.config.tokenCachePath)
      const refreshedDuringThisRequest = mtimeMs >= authState.startedAt
      if (
        isTokenCacheValid(fileCache)
        && refreshedDuringThisRequest
        && usedAuthorization !== undefined
        && normalizeToken(fileCache!.accessToken) !== usedAuthorization
      ) {
        this.memoCache = fileCache
      } else {
        try {
          await this.getAuthorizationHeader(true)
        } catch {
          // Refresh itself failed (bad keys / network) — surface the ORIGINAL api
          // error to the caller (which re-throws it), not the secondary refresh error.
          return
        }
      }
      throw markRetryable(new ApiError(error.message, error.code, error.statusCode, error.details))
    }
  }

  /** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, or undefined. */
  private parseRetryAfterMs(raw: string | string[] | undefined): number | undefined {
    const value = Array.isArray(raw) ? raw[0] : raw
    if (!value) return undefined
    const seconds = Number(value)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const date = Date.parse(value)
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
  }

  private throwHttpError(parsed: unknown, statusCode: number, retryAfterMs?: number): never {
    if (isEnvelope(parsed)) {
      const code = parsed.code === undefined ? undefined : String(parsed.code)
      throw new ApiError(parsed.msg || `API request failed (HTTP ${statusCode})`, code, statusCode, parsed, retryAfterMs)
    }

    throw new ApiError(`API request failed (HTTP ${statusCode})`, undefined, statusCode, parsed, retryAfterMs)
  }

  private async readLocalLookup(endpoint: EndpointDefinition) {
    const keyMapping: Record<string, Parameters<typeof getLookupData>[0]> = {
      "lookup.broker-orgs.list": "broker-orgs",
      "lookup.meeting-orgs.list": "meeting-orgs",
    }

    const lookupKey = keyMapping[endpoint.key]
    if (lookupKey) {
      return getLookupData(lookupKey)
    }

    throw new ApiError(`Unsupported local lookup endpoint: ${endpoint.key}`)
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
  private isPaginatedListResponse(value: unknown): value is Record<string, unknown> & { total: number; list?: unknown } {
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
  private pageRows(page: Record<string, unknown> & { list?: unknown }): unknown[] {
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
  private async probeBeyondTotal(
    endpoint: EndpointDefinition,
    initialBody: Record<string, unknown>,
    total: number,
  ): Promise<"capped" | "drift" | "clean"> {
    // ⚠️ 别按 `retry === "no-replay"` 跳过本探针。两个理由：`no-replay` 治的是「重放一个
    // 服务端可能已执行的请求」，而探针是一次**新**请求，不是重放；且唯一同时分页 + no-replay
    // 的 ai.hot-topic 在 BILLING_CATALOG 里是 fixed(50, "article") —— 与 insight.opinion*
    // 同为按行计费，空探针零行零积分，跳过换不来省钱，只会让全库唯一的 search 型分页端点
    // 失去封顶检测。撞到封顶时那一行的成本，正是发现「你拿到的是截断数据」的代价。
    try {
      const beyond = await this.requestJson<Record<string, unknown>>(endpoint, { ...initialBody, from: total, size: 1 })
      if (!this.isPaginatedListResponse(beyond)) return "clean"
      // 顺序要紧：**先比 total，再看有没有行**。
      //  - total 变了（涨或跌）→ 数据集在翻页期间动过 = `total_drift`。跌的那一档
      //    （100 → 99）探针必然返回 0 行，若先按「0 行 = clean」短路就漏报了。
      //  - total 没变、上限之外还有行 → `total` 本身就是上限 = `total_capped`。
      //  - total 没变、上限之外没有行 → 干净。
      // 不比 total 就会把每个正在增长的分页数据集误标成封顶；只看 total 不看行数，
      // 又会把「真计数」误标成封顶。两个维度都要看。
      if (beyond.total !== total) return "drift"
      return this.pageRows(beyond).length > 0 ? "capped" : "clean"
    } catch {
      // 探针失败不能反过来污染主结果：宁可不标，也不要因为一次网络抖动就把
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
  private flagUnexpectedPageShape(page: unknown): unknown {
    if (!page || typeof page !== "object") return page
    const marker = {
      _partial: true,
      _partial_reason: "unexpected_page_shape",
      _unexpected_page_shape: "本接口标记为分页，但返回的首包不是 {total, list} 结构；已原样返回，未进行翻页——这份结果可能只是第一页，也可能是筛选条件未生效，不要当作完整结果使用",
    }
    if (Array.isArray(page)) return { list: page, ...marker }
    return { ...(page as Record<string, unknown>), ...marker }
  }

  private async requestPaginated(endpoint: EndpointDefinition, body?: unknown) {
    const initialBody = body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {}

    if ('from' in initialBody && (typeof initialBody.from !== 'number' || !Number.isFinite(initialBody.from) || initialBody.from < 0)) {
      throw new ValidationError('Invalid from: expected a non-negative number')
    }
    if ('size' in initialBody && initialBody.size !== undefined && (typeof initialBody.size !== 'number' || !Number.isFinite(initialBody.size) || initialBody.size <= 0)) {
      throw new ValidationError('Invalid size: expected a positive number')
    }

    const startFrom = typeof initialBody.from === 'number' && Number.isFinite(initialBody.from) ? initialBody.from : 0
    const requestedSize = typeof initialBody.size === 'number' && Number.isFinite(initialBody.size) ? initialBody.size : undefined
    const maxPageSize = endpoint.pagination?.maxPageSize ?? requestedSize ?? 20

    // First page: serial — we need total before deciding how many more requests to fan out.
    const firstPageSize = requestedSize === undefined ? maxPageSize : Math.min(maxPageSize, requestedSize)
    const firstPage = await this.requestJson<Record<string, unknown>>(endpoint, {
      ...initialBody,
      from: startFrom,
      size: firstPageSize,
    })

    if (!this.isPaginatedListResponse(firstPage)) return this.flagUnexpectedPageShape(firstPage)
    // 合法空结果的两种写法（`list: []` 与 `list: null`）在这里合流，后面一律按数组处理。
    // 写回一次，让后面每一处 `...firstPage` 展开都带着归一后的数组。
    const firstRows = this.pageRows(firstPage)
    firstPage.list = firstRows

    const total = firstPage.total
    const collected: unknown[] = [...firstRows]

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
      if (returned < expectable) {
        shortResult._partial = true
        shortResult._partial_reason = "short_page"
        return shortResult
      }
      // 短页**恰好覆盖了 reported total** = 调用方以为拿到了全部，和下面「取满 target」
      // 是同一种处境，同样要探。上限比单页还小、或记录全落在首屏时会走这条路径——
      // 早期实现在这里直接 return，于是那两种情形拿不到任何 _partial 标记。
      // 触发条件不是「没限 size」，而是「**这次请求已经覆盖到 reported end**」——
      // 显式传 size=200 而 total=100 时，调用方同样以为自己取全了，漏探就漏标。
      const coversReportedEnd =
        requestedSize === undefined || (typeof total === "number" && startFrom + requestedSize >= total)
      if (coversReportedEnd && typeof total === "number" && total > 0) {
        const verdict = await this.probeBeyondTotal(endpoint, initialBody, total)
        if (verdict !== "clean") {
          shortResult._partial = true
          shortResult._partial_reason = verdict === "capped" ? "total_capped" : "total_drift"
          if (verdict === "capped") shortResult._total_capped = { reportedTotal: total, note: TOTAL_CAPPED_NOTE }
        }
      }
      return shortResult
    }

    const available = Math.max(total - startFrom, 0)
    const target = requestedSize === undefined ? available : Math.min(requestedSize, available)

    if (collected.length >= target) {
      const early: Record<string, unknown> = {
        ...firstPage,
        total,
        list: requestedSize === undefined ? collected : collected.slice(0, requestedSize),
      }
      // 触发条件是「本次请求**已覆盖 reported end**」——只有没覆盖到尾部的请求
      // （size 小于剩余量）才不探，因为那种调用方本来就没声称取全。
      // 注意 size 大小本身说明不了问题：size=200/total=100 覆盖到了，
      // size=20/total=10 也覆盖到了，两者都要探。
      if ((requestedSize === undefined || startFrom + requestedSize >= total) && total > 0) {
        const verdict = await this.probeBeyondTotal(endpoint, initialBody, total)
        if (verdict !== "clean") {
          early._partial = true
          early._partial_reason = verdict === "capped" ? "total_capped" : "total_drift"
          if (verdict === "capped") early._total_capped = { reportedTotal: total, note: TOTAL_CAPPED_NOTE }
        }
      }
      return early
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
    const pages = await runWithConcurrency(pageRequests, PAGE_CONCURRENCY, async (req) => {
      try {
        const page = await this.requestJson<Record<string, unknown>>(endpoint, {
          ...initialBody,
          from: req.from,
          size: req.size,
        })
        if (!this.isPaginatedListResponse(page)) {
          unexpectedShape = true
          return [] as unknown[]
        }
        if (page.total !== total) totalDrift = true
        return this.pageRows(page)
      } catch (err) {
        // Collect the failure instead of fail-fasting the whole batch: return the
        // pages we did get, flagged _partial — same loud-partial contract as
        // quoteSharding, so a dropped page never masquerades as complete data.
        failedPages.push({ from: req.from, size: req.size, error: errorMessage(err) })
        return [] as unknown[]
      }
    })

    for (const list of pages) {
      if (list.length === 0) continue
      collected.push(...list)
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

    const partialReasons: string[] = []
    if (hitPageCap) {
      partialReasons.push("page_cap")
      response._page_cap = {
        maxPages: MAX_PAGES,
        targetItems: target,
        returnedItems: returnedList.length,
      }
    }
    if (unexpectedShape) partialReasons.push("unexpected_page_shape")
    if (totalDrift) partialReasons.push("total_drift")
    // total 封顶：翻页目标是按 total 算的，封顶时会「正好取满」而不触发任何其他标记。
    // 只在真的把 target 取满（= 调用方以为拿到了全部）时才探。
    if ((requestedSize === undefined || startFrom + requestedSize >= total) && total > 0 && returnedList.length >= target && failedPages.length === 0) {
      const verdict = await this.probeBeyondTotal(endpoint, initialBody, total)
      if (verdict === "capped") {
        partialReasons.push("total_capped")
        response._total_capped = { reportedTotal: total, note: TOTAL_CAPPED_NOTE }
      } else if (verdict === "drift" && !partialReasons.includes("total_drift")) {
        partialReasons.push("total_drift")
      }
    }
    if (failedPages.length > 0) {
      partialReasons.push("failed_pages")
      response._failed_pages = failedPages
    }
    // Pages all succeeded and no cap was hit, yet fewer rows than target arrived
    // — the server under-filled pages. Same loud-partial contract.
    if (partialReasons.length === 0 && returnedList.length < target) partialReasons.push("short_page")
    if (partialReasons.length > 0) {
      response._partial = true
      response._partial_reason = partialReasons.join(",")
    }

    return response
  }

  async login() {
    const authorization = await this.getAuthorizationHeader()
    const cache = await readTokenCache(this.config.tokenCachePath)
    return {
      authorization,
      cache,
    }
  }

  async requestJson<T>(endpoint: EndpointDefinition, body?: unknown, useAuth = true): Promise<T> {
    if (endpoint.path.startsWith('/guide/')) {
      return this.readLocalLookup(endpoint) as Promise<T>
    }

    const dispatcher = getDispatcher()
    const url = new URL(endpoint.path, this.config.baseUrl)
    const authState = { retried: false, startedAt: Date.now() }
    // Endpoint floor wins over the configured default, but an explicitly larger
    // GANGTISE_TIMEOUT_MS still applies (slow synchronous AI generation would
    // otherwise abort at 30s — billed, with the result thrown away).
    const timeoutMs = Math.max(this.config.timeoutMs, endpoint.timeoutMs ?? 0)

    const attemptOnce = async (): Promise<T> => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        // undici does not auto-decompress; the gunzip below handles it. Server-side
        // gzip cuts JSON payloads ~3-10x (CLI measured 3.6x on constant-list).
        'accept-encoding': 'gzip',
      }
      if (useAuth) {
        headers.Authorization = await this.getAuthorizationHeader()
      }

      const startedAt = Date.now()
      const response = await request(url, {
        method: endpoint.method,
        headers,
        body: endpoint.method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        dispatcher,
      })
      // Only buffer + gunzip when the server actually compressed; an unencoded
      // response reads as text directly.
      const encodingHeader = response.headers['content-encoding']
      const gzipped = (Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader)?.toLowerCase().trim() === 'gzip'
      let text: string
      if (gzipped) {
        const bytes = Buffer.from(await response.body.arrayBuffer())
        try {
          text = gunzipSync(bytes).toString('utf8')
        } catch (error) {
          // A proxy/middlebox can declare gzip and deliver garbage — surface it
          // with request context instead of a bare zlib Z_DATA_ERROR.
          const detail = error instanceof Error ? error.message : String(error)
          throw new ApiError(`Failed to decode gzip response for ${endpoint.method} ${endpoint.path}: ${detail}`, undefined, response.statusCode)
        }
      } else {
        text = await response.body.text()
      }
      logTiming(`${endpoint.method} ${endpoint.path}`, Date.now() - startedAt, `${response.statusCode}, ${text.length}B`)
      // Parsed regardless of status: Gangtise also returns errors (including rate
      // limits) inside HTTP 200 envelopes, and gating this on >= 400 dropped the
      // server's backoff window on exactly those.
      const retryAfterMs = this.parseRetryAfterMs(response.headers['retry-after'])

      let parsed: Envelope<T>
      try {
        parsed = JSON.parse(text) as Envelope<T>
      } catch {
        const message = response.statusCode >= 400
          ? `API request failed (HTTP ${response.statusCode})`
          : 'Failed to parse API response'
        throw new ApiError(message, undefined, response.statusCode, text.slice(0, 500), retryAfterMs)
      }

      try {
        if (response.statusCode >= 400) {
          this.throwHttpError(parsed, response.statusCode, retryAfterMs)
        }
        return unwrapEnvelope(parsed, response.statusCode, retryAfterMs)
      } catch (error) {
        // Run through auth recovery for BOTH 4xx (e.g. 401 token-invalid) and
        // 200-envelope auth errors, so a server-rejected cached token refreshes.
        await this.refreshAuthIfRecoverable(error, useAuth, authState, headers.Authorization)
        throw error
      }
    }

    // The policy decides per error what is safe to resend: under "no-replay"
    // only connect-phase failures, 429 and the token-self-heal mark retry — an
    // auth-rejected request never reached the backend handler, so no separate
    // replay path is needed.
    return withRetry(attemptOnce, {
      policy: endpoint.retry,
      onRetry: (attempt: number, error: unknown, delay: number) => {
        if (!isVerbose()) return
        const msg = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[gangtise] retry ${attempt} after ${delay.toFixed(0)}ms: ${msg.slice(0, 120)}\n`)
      },
    })
  }

  async download(endpoint: EndpointDefinition, query: Record<string, string | number>, options?: { streamTo?: string }): Promise<DownloadResponse> {
    // 下载专用 dispatcher：跟随 30x（见 getDownloadDispatcher）。
    const dispatcher = getDownloadDispatcher()
    const url = new URL(endpoint.path, this.config.baseUrl)
    Object.entries(query).forEach(([key, value]) => {
      url.searchParams.set(key, String(value))
    })
    const authState = { retried: false, startedAt: Date.now() }
    const timeoutMs = Math.max(this.config.timeoutMs, endpoint.timeoutMs ?? 0)

    return withRetry(async () => {
      const authorization = await this.getAuthorizationHeader()
      const startedAt = Date.now()
      const response = await request(url, {
        method: endpoint.method,
        headers: { Authorization: authorization },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        dispatcher,
      })

      const contentType = Array.isArray(response.headers['content-type']) ? response.headers['content-type'][0] : response.headers['content-type']
      const contentDisposition = Array.isArray(response.headers['content-disposition'])
        ? response.headers['content-disposition'][0]
        : response.headers['content-disposition']
      const retryAfterMs = this.parseRetryAfterMs(response.headers['retry-after'])

      /** 非信封形态的下载失败：构造错误 → **先过一次鉴权自愈** → 再抛。
       *
       * 🔴 自愈这一步不能只挂在信封分支上。下载响应有四种形态（JSON 信封、JSON 但解析
       * 失败、text/html、二进制），只有第一种能解出 `code`；其余三种此前直接 throw，
       * 401 就此穿过自愈逻辑。跟随 30x 落到对象存储域名之后，恰恰是后三种最常见。 */
      const failDownload = async (text: string): Promise<never> => {
        const error = new ApiError(
          `Download failed (HTTP ${response.statusCode}): ${text.trim().slice(0, 200)}`,
          undefined,
          response.statusCode,
          text,
          retryAfterMs,
        )
        await this.refreshAuthIfRecoverable(error, true, authState, authorization)
        throw error
      }

      // A JSON body carrying content-disposition is a real file attachment (e.g.
      // a user-stored .json in the vault drive), not an API envelope — fall
      // through to the binary path so its bytes are returned untouched.
      if (contentType?.includes('application/json') && !contentDisposition) {
        const text = await response.body.text()
        logTiming(`GET ${endpoint.path} (json)`, Date.now() - startedAt, `${response.statusCode}, ${text.length}B`)
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          if (response.statusCode >= 400) await failDownload(text)
          return { text, contentType }
        }

        let data: unknown
        try {
          if (response.statusCode >= 400) {
            this.throwHttpError(parsed, response.statusCode, retryAfterMs)
          }
          data = unwrapEnvelope(parsed as Envelope<unknown>, response.statusCode, retryAfterMs)
        } catch (error) {
          await this.refreshAuthIfRecoverable(error, true, authState, authorization)
          throw error
        }
        if (data && typeof data === 'object' && 'url' in (data as Record<string, unknown>) && typeof (data as Record<string, unknown>).url === 'string') {
          return { url: String((data as Record<string, unknown>).url), contentType }
        }
        return { text: JSON.stringify(data), contentType }
      }

      if (contentType?.includes('text/plain') || contentType?.includes('text/html')) {
        const text = await response.body.text()
        logTiming(`GET ${endpoint.path} (text)`, Date.now() - startedAt, `${response.statusCode}, ${text.length}B`)
        if (response.statusCode >= 400) await failDownload(text)
        return { text, contentType }
      }

      if (response.statusCode >= 400) await failDownload(await response.body.text())

      const filenameMatch = contentDisposition?.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i)
      // RFC 6266: plain filename= is not percent-encoded — a literal % (common
      // in report titles like 盈利增长50%点评.pdf) makes decodeURIComponent
      // throw, which must not fail the download; fall back to the raw name.
      let filename: string | undefined
      if (filenameMatch) {
        const rawName = filenameMatch[1] || filenameMatch[2]
        try {
          filename = decodeURIComponent(rawName)
        } catch {
          filename = rawName
        }
      }

      // Stream directly to disk when caller already knows the destination
      if (options?.streamTo) {
        const maxBytes = this.config.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
        // 🔴 落盘前先看 Content-Length：声明就超上限的直接拒，不浪费带宽也不碰磁盘。
        const declared = Number(Array.isArray(response.headers['content-length']) ? response.headers['content-length'][0] : response.headers['content-length'])
        if (Number.isFinite(declared) && declared > maxBytes) {
          // 🔴 抛错之前必须**主动销毁响应体**。undici 的连接要么被读完、要么被 destroy
          // 才会归还连接池；直接 throw 会把 socket 留在那儿，服务端还在推流而我们已经
          // 不读了。连续几次超限下载就能占满 `connections: 16` 的池子，之后所有请求排队。
          response.body.destroy()
          throw new DownloadError(
            `下载内容 ${(declared / 1048576).toFixed(0)} MB 超过单文件上限 ${(maxBytes / 1048576).toFixed(0)} MB，已拒绝以免占满临时磁盘。请改用返回下载直链的方式，或联系客户经理确认该资源是否应当这么大。`,
          )
        }
        await fs.mkdir(path.dirname(options.streamTo), { recursive: true })
        // 没有 Content-Length（chunked）时靠流式计数兜底：超限即中止，`pipeline` 会销毁
        // 两端并把错误抛出来，上层 downloadToResult 随即删掉整个临时目录。
        // 只做**事后清理**是不够的——那时磁盘已经被写满了。
        await pipeline(response.body, capBytes(maxBytes), createWriteStream(options.streamTo))
        logTiming(`GET ${endpoint.path} (stream)`, Date.now() - startedAt, `${response.statusCode}`)
        return { contentType, filename, savedPath: options.streamTo }
      }

      const buffer = await response.body.arrayBuffer()
      logTiming(`GET ${endpoint.path} (binary)`, Date.now() - startedAt, `${response.statusCode}, ${buffer.byteLength}B`)
      return {
        data: new Uint8Array(buffer),
        contentType,
        filename,
      }
    }, {
      policy: endpoint.retry,
      onRetry: (attempt, error, delay) => {
        if (!isVerbose()) return
        const msg = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[gangtise] download retry ${attempt} after ${delay.toFixed(0)}ms: ${msg.slice(0, 120)}\n`)
      },
    })
  }

  async call(endpointKey: string, body?: unknown, query?: Record<string, string | number>, options?: { streamTo?: string }) {
    const endpoint = ENDPOINTS[endpointKey]
    if (!endpoint) {
      throw new ApiError(`Unknown endpoint key: ${endpointKey}`)
    }

    if (endpoint.kind === 'download') {
      return this.download(endpoint, query ?? {}, options)
    }

    if (endpoint.kind === 'json' && endpoint.pagination?.enabled) {
      return this.requestPaginated(endpoint, body)
    }

    return this.requestJson(endpoint, body)
  }
}
