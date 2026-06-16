import fs from "node:fs/promises"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GangtiseClient } from "../../../src/core/client.js"

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
})

describe("GangtiseClient noRetry endpoints", () => {
  it("does not retry an async-AI submit endpoint on a 5xx (avoids duplicate jobs)", async () => {
    let calls = 0
    requestMock.mockImplementation(() => {
      calls += 1
      return Promise.resolve(rawJsonResponse({ code: "500", msg: "server error" }, 500))
    })
    // 500 is otherwise retryable (see transport.test.ts); submit endpoints opt out via noRetry.
    await expect(
      tokenClient().call("ai.earnings-review.get-id", { securityCode: "600519.SH", period: "2025q1" }),
    ).rejects.toBeTruthy()
    expect(calls).toBe(1)
  })
})
