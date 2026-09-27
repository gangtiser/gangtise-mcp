import { describe, expect, it } from "vitest"
import { resolveCostLimit } from "../../../src/core/config.js"
import type { Billing, EndpointDefinition } from "../../../src/core/endpoints.js"
import { requestPaginated, type PageFetcher } from "../../../src/core/paginate.js"
import { runWithCostConfirmation } from "../../../src/core/requestContext.js"

// 多页拉取的积分预估保护（core/paginate.ts）。桩按请求体的 from/size 切一段 total 行的数据集，
// 并记下每个请求——「被拒时花了几条」就是请求序列本身。

function endpoint(billing: Billing, maxPageSize = 50, maxWindow?: number): EndpointDefinition {
  return { key: "test.list", method: "POST", path: "/list", kind: "json", billing, pagination: { mode: "offset", maxPageSize, maxWindow } }
}

function server(total: number | (() => number)) {
  const requests: Array<{ from: number; size: number }> = []
  const http: PageFetcher = {
    async requestJson<T>(_endpoint: EndpointDefinition, body?: unknown): Promise<T> {
      const { from = 0, size = 20 } = (body ?? {}) as { from?: number; size?: number }
      requests.push({ from, size })
      const t = typeof total === "function" ? total() : total
      const n = Math.max(0, Math.min(size, t - from))
      return { total: t, list: Array.from({ length: n }, (_, i) => ({ id: from + i })) } as T
    },
  }
  return { http, requests }
}

const CHEAP = endpoint({ kind: "fixed", per: "row", price: 0.1 })
const PRICEY = endpoint({ kind: "fixed", per: "row", price: 20 })

describe("cost guard on per-row billed multi-page fetches", () => {
  it("refuses a costly fetchAll after the first page brought back total, before fanning out", async () => {
    const { http, requests } = server(20_000)
    const error = await requestPaginated(http, CHEAP, {}, 1000).catch((e: Error) => e)
    expect(String(error)).toMatch(/预计取 20000 条（0\.1 积分\/条），约 2000 积分.*已取 50 条.*confirmCost: true/)
    expect(requests).toEqual([{ from: 0, size: 50 }])
  })

  it("probes one row first where a full page alone costs more than 50 credits, and pays only that row when refused", async () => {
    const { http, requests } = server(100)
    const error = await requestPaginated(http, PRICEY, {}, 1000).catch((e: Error) => e)
    expect(String(error)).toMatch(/预计取 100 条（20 积分\/条），约 2000 积分.*已取 1 条/)
    expect(requests).toEqual([{ from: 0, size: 1 }])
  })

  it("refetches from the same offset at full page size once the probe passes, and notes the row billed twice", async () => {
    const { http, requests } = server(30)
    const result = (await requestPaginated(http, PRICEY, { from: 0 }, 1000)) as Record<string, unknown>
    expect((result.list as unknown[]).length).toBe(30)
    expect(result._cost_probe).toMatchObject({ rows: 1 })
    expect(requests.slice(0, 2)).toEqual([{ from: 0, size: 1 }, { from: 0, size: 50 }])
  })

  it("uses the probe as the first page when it already holds everything left", async () => {
    for (const total of [0, 1]) {
      const { http, requests } = server(total)
      const result = (await requestPaginated(http, PRICEY, {}, 1000)) as Record<string, unknown>
      expect((result.list as unknown[]).length).toBe(total)
      expect(result._cost_probe).toBeUndefined()
      expect(requests[0]).toEqual({ from: 0, size: 1 })
      expect(requests.filter((r) => r.from === 0)).toHaveLength(1)
    }
  })

  it("re-checks before fanning out when total grew past the line between probe and first page", async () => {
    let calls = 0
    const { http, requests } = server(() => (++calls === 1 ? 40 : 400))
    const error = await requestPaginated(http, PRICEY, {}, 1000).catch((e: Error) => e)
    expect(String(error)).toMatch(/预计取 400 条.*约 8000 积分.*已取 51 条/)
    expect(requests).toEqual([{ from: 0, size: 1 }, { from: 0, size: 50 }])
  })

  it("passes single-page calls whatever they cost: a guard on multi-page fetches, not a per-call cap", async () => {
    const withContent = endpoint({ kind: "fixed", per: "row", price: 30 })
    const { http, requests } = server(100_000)
    const result = (await requestPaginated(http, withContent, { size: 50 }, 1000)) as Record<string, unknown>
    expect((result.list as unknown[]).length).toBe(50)
    expect(requests).toEqual([{ from: 0, size: 50 }])
  })

  it("does not guard or probe an explicit size that cannot reach the limit, however large total is", async () => {
    const fivePerRow = endpoint({ kind: "fixed", per: "row", price: 5 })
    const { http, requests } = server(100_000)
    const result = (await requestPaginated(http, fivePerRow, { size: 120 }, 1000)) as Record<string, unknown>
    expect((result.list as unknown[]).length).toBe(120)
    expect(requests[0]).toEqual({ from: 0, size: 50 })
  })

  it("prices an explicit size by the rows it will actually fetch, not by total", async () => {
    const { http } = server(100_000)
    const error = await requestPaginated(http, PRICEY, { size: 60 }, 1000).catch((e: Error) => e)
    expect(String(error)).toMatch(/预计取 60 条（20 积分\/条），约 1200 积分/)
  })

  it("prices by rows left after from, capped by the offset window and by the page cap", async () => {
    const windowed = endpoint({ kind: "fixed", per: "row", price: 0.2 }, 50, 10_000)
    expect(String(await requestPaginated(server(1_000_000).http, windowed, { from: 2_000 }, 1000).catch((e: Error) => e)))
      .toMatch(/预计取 8000 条.*约 1600 积分/)
    expect(String(await requestPaginated(server(10_000_000).http, CHEAP, {}, 1000).catch((e: Error) => e)))
      .toMatch(/预计取 50000 条.*约 5000 积分/)
    expect(String(await requestPaginated(server(20_000).http, CHEAP, { from: 15_000 }, 1000).catch((e: Error) => e)))
      .not.toMatch(/预计取/)
  })

  it("uses the endpoint's own unit", async () => {
    const perArticle = endpoint({ kind: "fixed", per: "row", price: 50, unit: "篇" }, 20)
    const error = await requestPaginated(server(100).http, perArticle, {}, 1000).catch((e: Error) => e)
    expect(String(error)).toMatch(/预计取 100 篇（50 积分\/篇），约 5000 积分.*已取 1 篇/)
  })

  it("lets a confirmed call through, and a confirmation never leaks into a concurrent call", async () => {
    const confirmed = server(20_000)
    const plain = server(20_000)
    const [ok, refused] = await Promise.all([
      runWithCostConfirmation(true, () => requestPaginated(confirmed.http, CHEAP, {}, 1000)),
      runWithCostConfirmation(false, () => requestPaginated(plain.http, CHEAP, {}, 1000)).catch((e: Error) => e),
    ])
    expect(((ok as Record<string, unknown>).list as unknown[]).length).toBe(20_000)
    expect(String(refused)).toMatch(/confirmCost/)
    expect(plain.requests).toHaveLength(1)
  })

  it("is off at limit 0, and never applies to free, per-call or unpriced endpoints", async () => {
    expect(((await requestPaginated(server(20_000).http, CHEAP, {}, 0)) as { list: unknown[] }).list).toHaveLength(20_000)
    for (const billing of [{ kind: "free" }, { kind: "unknown", note: "x" }, { kind: "fixed", per: "call", price: 500 }] as Billing[]) {
      expect(((await requestPaginated(server(20_000).http, endpoint(billing), {}, 1000)) as { list: unknown[] }).list).toHaveLength(20_000)
    }
  })
})

describe("GANGTISE_MCP_COST_LIMIT", () => {
  it("defaults to 1000, takes 0 as off, and falls back to the default on anything else", () => {
    expect(resolveCostLimit(undefined)).toBe(1000)
    expect(resolveCostLimit("")).toBe(1000)
    expect(resolveCostLimit("0")).toBe(0)
    expect(resolveCostLimit("2500")).toBe(2500)
    expect(resolveCostLimit("-1")).toBe(1000)
    expect(resolveCostLimit("abc")).toBe(1000)
  })
})
