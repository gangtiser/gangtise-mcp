import { createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"

import { request } from "undici"

import { PAGE_CONCURRENCY, type CliConfig } from "./config.js"
import { isTokenCacheValid, normalizeToken, readTokenCache, requireAccessCredentials, writeTokenCache, type TokenCache } from "./auth.js"
import { ApiError, ValidationError, errorMessage } from "./errors.js"
import { ENDPOINTS, type EndpointDefinition } from "./endpoints.js"
import { Envelope, isEnvelope, unwrapEnvelope } from "./envelope.js"
import { getLookupData } from "./lookupData/index.js"
import { getDispatcher, isVerbose, logTiming, markRetryable, runWithConcurrency, withRetry } from "./transport.js"

// Error codes that warrant one forced token refresh + retry:
//   8000014 / 8000015 — access/secret key errors (arrive as HTTP 200 envelopes)
//   0000001008 — "token is invalid" (HTTP 401): a cached token rejected
//     server-side even though not locally expired (e.g. the session was
//     superseded by a newer login elsewhere).
const AUTH_RETRY_CODES = new Set(["8000014", "8000015", "0000001008"])
const MAX_PAGES = 1000

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
  private async refreshAuthIfRecoverable(error: unknown, useAuth: boolean, authState: { retried: boolean }, usedAuthorization?: string): Promise<void> {
    if (
      useAuth
      && !authState.retried
      && error instanceof ApiError
      && error.code
      && AUTH_RETRY_CODES.has(error.code)
      && this.config.accessKey
      && this.config.secretKey
    ) {
      authState.retried = true
      this.memoCache = null
      // The sibling gangtise CLI shares the token cache file. If it refreshed
      // while this request was in flight, adopt that token instead of logging in
      // again — a new login supersedes the sibling's session server-side and
      // would bounce its requests right back.
      const fileCache = await readTokenCache(this.config.tokenCachePath)
      if (isTokenCacheValid(fileCache) && usedAuthorization !== undefined && normalizeToken(fileCache!.accessToken) !== usedAuthorization) {
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

  private isPaginatedListResponse(value: unknown): value is Record<string, unknown> & { total: number; list: unknown[] } {
    return Boolean(
      value
      && typeof value === 'object'
      && typeof (value as { total?: unknown }).total === 'number'
      && Array.isArray((value as { list?: unknown[] }).list),
    )
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

    if (!this.isPaginatedListResponse(firstPage)) return firstPage

    const total = firstPage.total
    const collected: unknown[] = [...firstPage.list]

    // Last page reached on first request
    if (firstPage.list.length < firstPageSize) {
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
      }
      return shortResult
    }

    const available = Math.max(total - startFrom, 0)
    const target = requestedSize === undefined ? available : Math.min(requestedSize, available)

    if (collected.length >= target) {
      return {
        ...firstPage,
        total,
        list: requestedSize === undefined ? collected : collected.slice(0, requestedSize),
      }
    }

    // Build remaining page requests
    const nextFrom = startFrom + firstPage.list.length
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
        return page.list
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
    const authState = { retried: false }
    // Endpoint floor wins over the configured default, but an explicitly larger
    // GANGTISE_TIMEOUT_MS still applies (slow synchronous AI generation would
    // otherwise abort at 30s — billed, with the result thrown away).
    const timeoutMs = Math.max(this.config.timeoutMs, endpoint.timeoutMs ?? 0)

    const attemptOnce = async (): Promise<T> => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
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
      const text = await response.body.text()
      logTiming(`${endpoint.method} ${endpoint.path}`, Date.now() - startedAt, `${response.statusCode}, ${text.length}B`)
      const retryAfterMs = response.statusCode >= 400 ? this.parseRetryAfterMs(response.headers['retry-after']) : undefined

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
        return unwrapEnvelope(parsed, response.statusCode)
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
    const dispatcher = getDispatcher()
    const url = new URL(endpoint.path, this.config.baseUrl)
    Object.entries(query).forEach(([key, value]) => {
      url.searchParams.set(key, String(value))
    })
    const authState = { retried: false }
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
      const retryAfterMs = response.statusCode >= 400 ? this.parseRetryAfterMs(response.headers['retry-after']) : undefined

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
          if (response.statusCode >= 400) {
            throw new ApiError(`Download failed (HTTP ${response.statusCode}): ${text.trim().slice(0, 200)}`, undefined, response.statusCode, text, retryAfterMs)
          }
          return { text, contentType }
        }

        let data: unknown
        try {
          if (response.statusCode >= 400) {
            this.throwHttpError(parsed, response.statusCode, retryAfterMs)
          }
          data = unwrapEnvelope(parsed as Envelope<unknown>, response.statusCode)
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
        if (response.statusCode >= 400) {
          throw new ApiError(`Download failed (HTTP ${response.statusCode}): ${text.trim().slice(0, 200)}`, undefined, response.statusCode, text, retryAfterMs)
        }
        return { text, contentType }
      }

      if (response.statusCode >= 400) {
        const text = await response.body.text()
        throw new ApiError(`Download failed (HTTP ${response.statusCode}): ${text.trim().slice(0, 200)}`, undefined, response.statusCode, text, retryAfterMs)
      }

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
        await fs.mkdir(path.dirname(options.streamTo), { recursive: true })
        await pipeline(response.body, createWriteStream(options.streamTo))
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
