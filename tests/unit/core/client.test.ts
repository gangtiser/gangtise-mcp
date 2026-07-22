import fs from "node:fs/promises"
import { gzipSync } from "node:zlib"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GangtiseClient } from "../../../src/core/client.js"
import { ENDPOINTS } from "../../../src/core/endpoints.js"

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici")
  return { ...actual, request: requestMock }
})

function rawJsonResponse(payload: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: { text: vi.fn().mockResolvedValue(JSON.stringify(payload)) },
  }
}

function jsonResponse(data: unknown) {
  return rawJsonResponse({ code: "000000", msg: "ok", data })
}

function binaryResponse(data: Uint8Array) {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="report.pdf"',
    },
    body: {
      arrayBuffer: vi.fn().mockResolvedValue(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
      text: vi.fn(),
    },
  }
}

const tokenCachePath = `/tmp/gangtise-mcp-client-test-${process.pid}.json`

function keyClient() {
  return new GangtiseClient({
    baseUrl: "https://open.gangtise.com",
    timeoutMs: 30_000,
    accessKey: "ak",
    secretKey: "sk",
    tokenCachePath,
    asyncTimeoutMs: 60_000,
  })
}

function tokenClient() {
  return new GangtiseClient({
    baseUrl: "https://open.gangtise.com",
    timeoutMs: 30_000,
    token: "test-token",
    tokenCachePath,
    asyncTimeoutMs: 60_000,
  })
}

beforeEach(() => requestMock.mockReset())
afterEach(async () => {
  await fs.unlink(tokenCachePath).catch(() => {})
})

describe("GangtiseClient.requestJson", () => {
  it("unwraps the data field of a success envelope", async () => {
    requestMock.mockResolvedValue(jsonResponse({ answer: 42 }))
    const client = new GangtiseClient({
      baseUrl: "https://open.gangtise.com",
      timeoutMs: 30_000,
      token: "test-token",
      tokenCachePath,
      asyncTimeoutMs: 60_000,
    })
    expect(await client.call("ai.one-pager", { securityCode: "600519.SH" })).toEqual({ answer: 42 })
  })

  it("surfaces the Retry-After header on a rate-limited (429) ApiError", async () => {
    // 429 is retried under every policy (the server rejected the request before
    // processing it), so drive the Retry-After backoff sleeps with fake timers.
    vi.useFakeTimers()
    try {
      requestMock.mockResolvedValue({
        statusCode: 429,
        headers: { "content-type": "application/json", "retry-after": "10" },
        body: { text: vi.fn().mockResolvedValue(JSON.stringify({ code: "429", msg: "rate limited" })) },
      })
      const promise = tokenClient().call("ai.earnings-review.get-id", { securityCode: "600519.SH" })
      const expectation = expect(promise).rejects.toMatchObject({ statusCode: 429, retryAfterMs: 10_000 })
      await vi.advanceTimersByTimeAsync(50_000) // 2 retries × ≤15s capped Retry-After backoff
      await expectation
    } finally {
      vi.useRealTimers()
    }
  })

  it("succeeds even when the token cache write fails (token stays valid in memory)", async () => {
    requestMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "Bearer live-token", expiresIn: 3600, time: 0 })) // login
      .mockResolvedValueOnce(jsonResponse({ answer: 7 })) // the actual request
    const client = new GangtiseClient({
      baseUrl: "https://open.gangtise.com",
      timeoutMs: 30_000,
      accessKey: "ak",
      secretKey: "sk",
      tokenCachePath: "/dev/null/nope/token.json", // mkdir under a file → ENOTDIR, so the cache write throws
      asyncTimeoutMs: 60_000,
    })
    expect(await client.call("ai.one-pager", { securityCode: "600519.SH" })).toEqual({ answer: 7 })
  })
})

describe("GangtiseClient auth recovery", () => {
  it("recovers a JSON request from an auth error by refreshing the token once", async () => {
    let listCalls = 0
    requestMock.mockImplementation((url: unknown) => {
      if (String(url).includes("/loginV2")) {
        return Promise.resolve(rawJsonResponse({ code: "000000", data: { accessToken: "fresh", expiresIn: 7200, time: 1 } }))
      }
      listCalls += 1
      if (listCalls === 1) return Promise.resolve(rawJsonResponse({ code: "8000014", msg: "access key error" }))
      return Promise.resolve(jsonResponse({ answer: 42 }))
    })

    const result = await keyClient().call("ai.one-pager", { securityCode: "600519.SH" })
    expect(result).toEqual({ answer: 42 })
    expect(listCalls).toBe(2)
  })

  it("recovers from an HTTP 401 token-invalid (0000001008) by refreshing once", async () => {
    let listCalls = 0
    requestMock.mockImplementation((url: unknown) => {
      if (String(url).includes("/loginV2")) {
        return Promise.resolve(rawJsonResponse({ code: "000000", data: { accessToken: "fresh", expiresIn: 7200, time: 1 } }))
      }
      listCalls += 1
      if (listCalls === 1) return Promise.resolve(rawJsonResponse({ code: "0000001008", msg: "token is invalid" }, 401))
      return Promise.resolve(jsonResponse({ answer: 42 }))
    })

    const result = await keyClient().call("ai.one-pager", { securityCode: "600519.SH" })
    expect(result).toEqual({ answer: 42 })
    expect(listCalls).toBe(2)
  })

  it("recovers a download from an auth error by refreshing the token once", async () => {
    const bytes = new Uint8Array([7, 8, 9])
    let downloadCalls = 0
    requestMock.mockImplementation((url: unknown) => {
      if (String(url).includes("/loginV2")) {
        return Promise.resolve(rawJsonResponse({ code: "000000", data: { accessToken: "fresh", expiresIn: 7200, time: 1 } }))
      }
      downloadCalls += 1
      if (downloadCalls === 1) return Promise.resolve(rawJsonResponse({ code: "8000015", msg: "secret key error" }))
      return Promise.resolve(binaryResponse(bytes))
    })

    const result = await keyClient().call("insight.research.download", undefined, { reportId: "123" }) as { data?: Uint8Array }
    expect(result.data).toEqual(bytes)
    expect(downloadCalls).toBe(2)
  })

  it("does not retry a download auth error when credentials are absent", async () => {
    let downloadCalls = 0
    requestMock.mockImplementation(() => {
      downloadCalls += 1
      return Promise.resolve(rawJsonResponse({ code: "8000015", msg: "secret key error" }))
    })

    const client = new GangtiseClient({
      baseUrl: "https://open.gangtise.com",
      timeoutMs: 30_000,
      token: "test-token",
      tokenCachePath,
      asyncTimeoutMs: 60_000,
    })
    await expect(client.call("insight.research.download", undefined, { reportId: "123" })).rejects.toMatchObject({ code: "8000015" })
    expect(downloadCalls).toBe(1)
  })

  it("uses the refreshed token on retry even when an explicit token was configured", async () => {
    const seenAuthorization: string[] = []
    requestMock.mockImplementation((url: unknown, options?: { headers?: Record<string, string> }) => {
      if (String(url).includes("/loginV2")) {
        return Promise.resolve(rawJsonResponse({ code: "000000", data: { accessToken: "fresh", expiresIn: 7200, time: 1 } }))
      }
      seenAuthorization.push(options?.headers?.Authorization ?? "")
      if (seenAuthorization.length === 1) {
        return Promise.resolve(rawJsonResponse({ code: "8000014", msg: "access key error" }))
      }
      return Promise.resolve(jsonResponse({ answer: 42 }))
    })

    const client = new GangtiseClient({
      baseUrl: "https://open.gangtise.com",
      timeoutMs: 30_000,
      token: "stale",
      accessKey: "ak",
      secretKey: "sk",
      tokenCachePath,
      asyncTimeoutMs: 60_000,
    })

    expect(await client.call("ai.one-pager", { securityCode: "600519.SH" })).toEqual({ answer: 42 })
    expect(seenAuthorization).toEqual(["Bearer stale", "Bearer fresh"])
  })
})

describe("GangtiseClient pagination", () => {
  it("marks a fetch-all result partial when the page cap truncates the target range", async () => {
    requestMock.mockImplementation((_url: unknown, options?: { body?: string }) => {
      const body = JSON.parse(options?.body ?? "{}") as { from: number; size: number }
      return Promise.resolve(jsonResponse({
        total: 60_000,
        list: Array.from({ length: body.size }, (_, i) => ({ id: body.from + i })),
      }))
    })

    const client = new GangtiseClient({
      baseUrl: "https://open.gangtise.com",
      timeoutMs: 30_000,
      token: "test-token",
      tokenCachePath,
      asyncTimeoutMs: 60_000,
    })

    const result = await client.call("insight.opinion.list", {}) as Record<string, unknown> & { list: unknown[] }

    expect(result.list).toHaveLength(50_000)
    expect(result._partial).toBe(true)
    expect(result._partial_reason).toBe("page_cap")
    expect(result._page_cap).toEqual({
      maxPages: 1000,
      targetItems: 60_000,
      returnedItems: 50_000,
    })
  })

  it("flags the result partial when a later page returns an unexpected shape", async () => {
    requestMock.mockImplementation((_url: unknown, options?: { body?: string }) => {
      const body = JSON.parse(options?.body ?? "{}") as { from: number; size: number }
      if (body.from === 0) {
        return Promise.resolve(jsonResponse({
          total: 100,
          list: Array.from({ length: body.size }, (_, i) => ({ id: body.from + i })),
        }))
      }
      return Promise.resolve(jsonResponse({ note: "broken" }))
    })

    const result = await tokenClient().call("insight.opinion.list", {}) as Record<string, unknown> & { list: unknown[] }

    expect(result.list).toHaveLength(50)
    expect(result._partial).toBe(true)
    expect(result._partial_reason).toContain("unexpected_page_shape")
  })

  it("returns the pages it got and flags partial when a later page hard-fails", async () => {
    requestMock.mockImplementation((_url: unknown, options?: { body?: string }) => {
      const body = JSON.parse(options?.body ?? "{}") as { from: number; size: number }
      if (body.from === 0) {
        return Promise.resolve(jsonResponse({
          total: 100,
          list: Array.from({ length: body.size }, (_, i) => ({ id: body.from + i })),
        }))
      }
      // Later page fails with a non-retryable error — must not sink the whole batch.
      return Promise.resolve(rawJsonResponse({ code: "400", msg: "boom" }, 400))
    })

    const result = await tokenClient().call("insight.opinion.list", {}) as Record<string, unknown> & {
      list: unknown[]
      _failed_pages: unknown[]
    }

    expect(result.list).toHaveLength(50)
    expect(result._partial).toBe(true)
    expect(result._partial_reason).toContain("failed_pages")
    expect(result._failed_pages).toHaveLength(1)
  })
})

describe("GangtiseClient auth replay and freshness", () => {
  // "no-replay" blocks transport retries (billed, non-idempotent submits), but an
  // auth-rejected request never reached the backend handler — after a successful
  // token refresh it must be replayed once, not surfaced as an auth error.
  it("replays a no-replay submit once after a successful token refresh", async () => {
    let submitCalls = 0
    requestMock.mockImplementation((url: unknown) => {
      if (String(url).includes("/loginV2")) {
        return Promise.resolve(rawJsonResponse({ code: "000000", data: { accessToken: "fresh", expiresIn: 7200, time: 1 } }))
      }
      submitCalls += 1
      if (submitCalls === 1) return Promise.resolve(rawJsonResponse({ code: "8000014", msg: "access key error" }))
      return Promise.resolve(jsonResponse({ dataId: "d9" }))
    })

    const result = await keyClient().call("ai.earnings-review.get-id", { securityCode: "600519.SH", period: "2025q1" })
    expect(result).toEqual({ dataId: "d9" })
    expect(submitCalls).toBe(2)
  })

  // The MCP server and the gangtise CLI share the token cache file. When the
  // sibling already refreshed it, logging in again would supersede the sibling's
  // session server-side — adopt the fresh cached token instead.
  it("adopts a fresh cached token written by a sibling process instead of logging in again", async () => {
    let loginCalls = 0
    const seenAuth: string[] = []
    requestMock.mockImplementation(async (url: unknown, options?: { headers?: Record<string, string> }) => {
      if (String(url).includes("/loginV2")) {
        loginCalls += 1
        return rawJsonResponse({ code: "000000", data: { accessToken: "fresh", expiresIn: 7200, time: 1 } })
      }
      seenAuth.push(options?.headers?.Authorization ?? "")
      if (seenAuth.length === 1) {
        // Sibling CLI refreshes the shared cache while this request is in flight.
        await fs.writeFile(tokenCachePath, JSON.stringify({
          accessToken: "sibling-fresh", expiresIn: 7200, time: 1,
          expiresAt: Math.floor(Date.now() / 1000) + 7200,
        }), "utf8")
        return rawJsonResponse({ code: "0000001008", msg: "token is invalid" }, 401)
      }
      return jsonResponse({ answer: 1 })
    })

    const client = new GangtiseClient({
      baseUrl: "https://open.gangtise.com",
      timeoutMs: 30_000,
      token: "stale",
      accessKey: "ak",
      secretKey: "sk",
      tokenCachePath,
      asyncTimeoutMs: 60_000,
    })

    expect(await client.call("ai.one-pager", { securityCode: "600519.SH" })).toEqual({ answer: 1 })
    expect(loginCalls).toBe(0)
    expect(seenAuth).toEqual(["Bearer stale", "Bearer sibling-fresh"])
  })
})

describe("GangtiseClient concurrent token refresh", () => {
  // refreshPromise single-flight is the only barrier against a login storm
  // (each login supersedes the previous session server-side).
  it("deduplicates concurrent token refreshes into a single login", async () => {
    let loginCalls = 0
    requestMock.mockImplementation((url: unknown) => {
      if (String(url).includes("/loginV2")) {
        loginCalls += 1
        return new Promise((resolve) =>
          setTimeout(() => resolve(rawJsonResponse({ code: "000000", data: { accessToken: "fresh", expiresIn: 7200, time: 1 } })), 50),
        )
      }
      return Promise.resolve(jsonResponse({ ok: 1 }))
    })

    const client = keyClient()
    await Promise.all(Array.from({ length: 5 }, () => client.call("ai.one-pager", { securityCode: "600519.SH" })))
    expect(loginCalls).toBe(1)
  })
})

describe("GangtiseClient short-page detection", () => {
  // A first page shorter than the requested page size normally means "no more
  // data" — but when total says the range has much more, the silent hole must
  // carry the same loud-partial marker as every other degraded path.
  it("flags a short first page as partial when total says more data exists", async () => {
    requestMock.mockResolvedValue(jsonResponse({
      total: 2000,
      list: Array.from({ length: 7 }, (_, i) => ({ id: i })),
    }))

    const result = await tokenClient().call("insight.opinion.list", {}) as Record<string, unknown> & { list: unknown[] }
    expect(result.list).toHaveLength(7)
    expect(result._partial).toBe(true)
    expect(result._partial_reason).toContain("short_page")
  })
})

describe("GangtiseClient download content handling", () => {
  // RFC 6266 plain filename= is not percent-encoded; research-report titles with
  // a literal % ("盈利增长50%点评.pdf") used to throw URIError inside
  // decodeURIComponent and fail the whole download before any byte was saved.
  it("keeps a literal-% filename instead of failing the download with URIError", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    requestMock.mockResolvedValue({
      statusCode: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="盈利增长50%点评.pdf"',
      },
      body: {
        arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer.slice(0)),
        text: vi.fn(),
      },
    })

    const result = await tokenClient().call("insight.research.download", undefined, { reportId: "1" }) as { filename?: string; data?: Uint8Array }
    expect(result.filename).toBe("盈利增长50%点评.pdf")
    expect(result.data).toEqual(bytes)
  })

  // A JSON *file attachment* (content-disposition present) must be returned
  // verbatim — vault drive files can be arbitrary .json that merely looks like
  // an API envelope and used to get unwrapped (content rewritten) or, with a
  // non-success code shape, rejected as an ApiError.
  it("returns a JSON file attachment verbatim instead of unwrapping it as an envelope", async () => {
    const fileJson = JSON.stringify({ code: "000000", data: { note: "user file" } })
    const fileBytes = new TextEncoder().encode(fileJson)
    requestMock.mockResolvedValue({
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="export.json"',
      },
      body: {
        text: vi.fn().mockResolvedValue(fileJson),
        arrayBuffer: vi.fn().mockResolvedValue(fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength)),
      },
    })

    const result = await tokenClient().call("insight.research.download", undefined, { reportId: "1" }) as { filename?: string; data?: Uint8Array; text?: string }
    expect(result.filename).toBe("export.json")
    expect(result.data).toBeDefined()
    expect(new TextDecoder().decode(result.data)).toBe(fileJson)
  })

  // A non-JSON download failure (e.g. 404 reportId, 403 permission) used to throw
  // a bare "Download failed" with the status/body only in unread ApiError fields;
  // the message must now carry the HTTP status + a body preview so the model can
  // tell "wrong id" from "no permission".
  it("surfaces the HTTP status and body preview when a download fails", async () => {
    requestMock.mockResolvedValue({
      statusCode: 404,
      headers: { "content-type": "text/plain" },
      body: {
        text: vi.fn().mockResolvedValue("Report 999 not found"),
        arrayBuffer: vi.fn(),
      },
    })

    await expect(
      tokenClient().call("insight.research.download", undefined, { reportId: "999" }),
    ).rejects.toThrow(/Download failed \(HTTP 404\): Report 999 not found/)
  })

  it("surfaces the Retry-After header on a rate-limited (429) download", async () => {
    // 429 is retryable, so a persistent one runs the full 2-retry backoff — fake
    // timers fast-forward the (8s each) rate-limit waits so the test stays instant.
    vi.useFakeTimers()
    try {
      requestMock.mockResolvedValue({
        statusCode: 429,
        headers: { "content-type": "text/plain", "retry-after": "8" },
        body: { text: vi.fn().mockResolvedValue("rate limited"), arrayBuffer: vi.fn() },
      })
      const settled = tokenClient()
        .call("insight.research.download", undefined, { reportId: "1" })
        .then(() => null, (e) => e as { statusCode?: number; retryAfterMs?: number })
      await vi.runAllTimersAsync()
      expect(await settled).toMatchObject({ statusCode: 429, retryAfterMs: 8_000 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("GangtiseClient no-replay endpoints", () => {
  it("does not retry an async-AI submit endpoint on a 5xx (avoids duplicate billed jobs)", async () => {
    let calls = 0
    requestMock.mockImplementation(() => {
      calls += 1
      return Promise.resolve(rawJsonResponse({ code: "500", msg: "server error" }, 500))
    })
    // 500 is otherwise retryable (see transport.test.ts); billed endpoints opt out via retry: "no-replay".
    await expect(
      tokenClient().call("ai.earnings-review.get-id", { securityCode: "600519.SH", period: "2025q1" }),
    ).rejects.toBeTruthy()
    expect(calls).toBe(1)
  })

  it("retries a no-replay submit on a connect-phase failure (request never sent)", async () => {
    let calls = 0
    requestMock.mockImplementation(() => {
      calls += 1
      if (calls === 1) return Promise.reject(Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }))
      return Promise.resolve(jsonResponse({ dataId: "d1" }))
    })
    const result = await tokenClient().call("ai.earnings-review.get-id", { securityCode: "600519.SH", period: "2025q1" })
    expect(result).toEqual({ dataId: "d1" })
    expect(calls).toBe(2)
  })

  it("does not retry a no-replay download on a 5xx (billed per download)", async () => {
    let calls = 0
    requestMock.mockImplementation(() => {
      calls += 1
      return Promise.resolve(rawJsonResponse({ code: "500", msg: "server error" }, 500))
    })
    await expect(tokenClient().download(ENDPOINTS["insight.summary.download"], { summaryId: "s1" })).rejects.toBeTruthy()
    expect(calls).toBe(1)
  })

  it("does not retry an indicator endpoint on 999999 (no-data sentinel, not transient)", async () => {
    let calls = 0
    requestMock.mockImplementation(() => {
      calls += 1
      return Promise.resolve(rawJsonResponse({ code: "999999", msg: "system error" }, 500))
    })
    await expect(tokenClient().call("indicator.search", { indicatorName: "PE" })).rejects.toBeTruthy()
    expect(calls).toBe(1)
  })
})

describe("GangtiseClient gzip", () => {
  function gzipJsonResponse(payload: unknown) {
    const gz = gzipSync(Buffer.from(JSON.stringify({ code: "000000", msg: "ok", data: payload })))
    return {
      statusCode: 200,
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: {
        arrayBuffer: vi.fn().mockResolvedValue(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength)),
        text: vi.fn(),
      },
    }
  }

  it("requests gzip and decompresses a gzip-encoded JSON response", async () => {
    requestMock.mockResolvedValue(gzipJsonResponse({ answer: 42 }))
    const result = await tokenClient().call("ai.one-pager", { securityCode: "600519.SH" })
    expect(result).toEqual({ answer: 42 })
    const options = requestMock.mock.calls[0][1] as { headers: Record<string, string> }
    expect(options.headers["accept-encoding"]).toBe("gzip")
  })

  it("wraps a corrupt gzip body as an ApiError with request context (no bare zlib error)", async () => {
    requestMock.mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: {
        arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer),
        text: vi.fn(),
      },
    })
    await expect(tokenClient().call("ai.one-pager", { securityCode: "600519.SH" }))
      .rejects.toMatchObject({ name: "ApiError", message: expect.stringContaining("gzip") })
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it("still reads an unencoded response as plain text", async () => {
    requestMock.mockResolvedValue(jsonResponse({ plain: true }))
    expect(await tokenClient().call("ai.one-pager", { securityCode: "600519.SH" })).toEqual({ plain: true })
  })
})

describe("GangtiseClient per-endpoint timeout floor", () => {
  it("passes the 120s endpoint floor to slow synchronous AI generation requests", async () => {
    requestMock.mockResolvedValue(jsonResponse({ content: "ok" }))
    await tokenClient().call("ai.one-pager", { securityCode: "600519.SH" })
    const options = requestMock.mock.calls[0][1] as { headersTimeout: number; bodyTimeout: number }
    expect(options.headersTimeout).toBe(120_000)
    expect(options.bodyTimeout).toBe(120_000)
  })

  it("keeps a larger configured timeout when it exceeds the endpoint floor", async () => {
    requestMock.mockResolvedValue(jsonResponse({ content: "ok" }))
    const client = new GangtiseClient({
      baseUrl: "https://open.gangtise.com",
      timeoutMs: 300_000,
      token: "test-token",
      tokenCachePath,
      asyncTimeoutMs: 60_000,
    })
    await client.call("ai.one-pager", { securityCode: "600519.SH" })
    const options = requestMock.mock.calls[0][1] as { headersTimeout: number }
    expect(options.headersTimeout).toBe(300_000)
  })
})

// 2026-07-17 重排把 token 失效码从 0000001008 改成 999002。切码那天若不认新码，
// token 自愈会静默停摆，用户直接撞上硬认证失败。
describe("GangtiseClient auth recovery across the 2026-07-17 renumbering", () => {
  it("recovers from the new 999002 token-invalid code by refreshing once", async () => {
    let listCalls = 0
    requestMock.mockImplementation((url: unknown) => {
      if (String(url).includes("/loginV2")) {
        return Promise.resolve(rawJsonResponse({ code: "000000", data: { accessToken: "fresh", expiresIn: 7200, time: 1 } }))
      }
      listCalls += 1
      if (listCalls === 1) return Promise.resolve(rawJsonResponse({ code: "999002", msg: "token is invalid" }, 401))
      return Promise.resolve(jsonResponse({ answer: 42 }))
    })

    const result = await keyClient().call("ai.one-pager", { securityCode: "600519.SH" })
    expect(result).toEqual({ answer: 42 })
    expect(listCalls).toBe(2)
  })

  // 999011 是凭证本身写错，不会自愈：既不该刷 token，也不该在 5xx 上被状态码规则重放。
  it("does not refresh or replay on 999011 (AK/SK mismatch)", async () => {
    let listCalls = 0
    let loginCalls = 0
    requestMock.mockImplementation((url: unknown) => {
      if (String(url).includes("/loginV2")) {
        loginCalls += 1
        return Promise.resolve(rawJsonResponse({ code: "000000", data: { accessToken: "t", expiresIn: 7200, time: 1 } }))
      }
      listCalls += 1
      return Promise.resolve(rawJsonResponse({ code: "999011", msg: "credential invalid" }, 500))
    })

    await expect(keyClient().call("ai.one-pager", { securityCode: "600519.SH" })).rejects.toMatchObject({ code: "999011" })
    expect(listCalls).toBe(1)
    expect(loginCalls).toBe(1) // 仅初次登录，没有自愈重刷
  })
})

// Gangtise 也用 HTTP 200 信封返回错误（含限流），此前 Retry-After 只在 >=400 时解析，
// 200 形态的退避窗口被丢弃。
describe("GangtiseClient Retry-After on 200-wrapped errors", () => {
  // 限流走的是耐心退避（秒级）。真等会把这一组拖成 8 秒，用假时钟推完即可。
  // 循环推进：登录握手等异步步骤会让退避定时器在第一次推进之后才排上，
  // 单次 advance 推不到它。
  async function drainRetries<T>(promise: Promise<T>): Promise<unknown> {
    const settled = promise.then((v) => v, (e) => e)
    let done = false
    void settled.then(() => { done = true })
    for (let i = 0; i < 20 && !done; i++) {
      await vi.advanceTimersByTimeAsync(30_000)
    }
    return settled
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps the server's Retry-After when the error arrives inside a 200 envelope", async () => {
    requestMock.mockImplementation((url: unknown) => {
      if (String(url).includes("/loginV2")) {
        return Promise.resolve(rawJsonResponse({ code: "000000", data: { accessToken: "t", expiresIn: 7200, time: 1 } }))
      }
      return Promise.resolve({
        statusCode: 200,
        headers: { "content-type": "application/json", "retry-after": "3" },
        body: { text: vi.fn().mockResolvedValue(JSON.stringify({ code: "999006", msg: "rate limited" })) },
      })
    })

    await expect(keyClient().call("ai.one-pager", { securityCode: "600519.SH" }))
      .rejects.toMatchObject({ code: "999006", retryAfterMs: 3_000 })
  })

  // 下载走独立的 JSON 分支，与主路径同样要保住这个 header。
  it("keeps it on the download JSON path too", async () => {
    vi.useFakeTimers()
    requestMock.mockImplementation(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json", "retry-after": "2" },
      body: { text: vi.fn().mockResolvedValue(JSON.stringify({ code: "999006", msg: "rate limited" })) },
    }))

    await expect(drainRetries(tokenClient().call("insight.research.download", undefined, { reportId: "1" })))
      .resolves.toMatchObject({ code: "999006", retryAfterMs: 2_000 })
  })

  // 光带上 header 不算修好 —— 得真的重放。此前 999006@200 一次即败，
  // 解析出来的退避窗口无人使用。
  // 用 tokenClient（静态 token、不登录）：假时钟要推进上百秒才能走完退避，
  // 而 keyClient 的登录令牌带 300s 过期缓冲，推进量会跨过它触发二次登录，测试变 flaky。
  it("actually replays the request instead of failing on the first attempt", async () => {
    let calls = 0
    requestMock.mockImplementation(() => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve({
          statusCode: 200,
          headers: { "content-type": "application/json", "retry-after": "0" },
          body: { text: vi.fn().mockResolvedValue(JSON.stringify({ code: "999006", msg: "rate limited" })) },
        })
      }
      return Promise.resolve(jsonResponse({ answer: 42 }))
    })

    // research.list 走默认重试策略（按次计费的 no-replay 端点仍不重放，另有用例覆盖）。
    vi.useFakeTimers()
    const result = await drainRetries(tokenClient().call("insight.research.list", { from: 0, size: 1 }))
    expect(result).toEqual({ answer: 42 })
    expect(calls).toBe(2)
  })
})
