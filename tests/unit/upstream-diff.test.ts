import { describe, expect, it } from "vitest"
import { ENDPOINTS } from "../../src/core/endpoints.js"
// @ts-expect-error — 纯 JS 脚本，没有类型声明
import { diffEndpoints, loadFixtures, normalizeEndpoint } from "../../scripts/upstream-diff.mjs"

// 与 gangtise-openapi-cli 固定版本的端点契约对比（夹具由 `node scripts/upstream-diff.mjs --refresh` 导出）。
// 有意的差异写进 tests/fixtures/sync-exceptions.json 并说明理由；清单外的差异、以及已经不成立的例外都判红。
describe("upstream endpoint contract", () => {
  const { upstream, exceptions } = loadFixtures()

  it("has no difference outside the exception list, and no stale exception", () => {
    const { unexplained, stale } = diffEndpoints(ENDPOINTS, upstream.endpoints, exceptions)
    expect(unexplained).toEqual([])
    expect(stale).toEqual([])
  })

  it("gives every exception a reason", () => {
    for (const e of exceptions) expect(e.reason, `${e.key} ${e.field}`).toMatch(/\S{4,}/)
  })

  it("flags a field that drifts and an exception that no longer holds", () => {
    const drifted = { ...ENDPOINTS, "insight.research.list": { ...ENDPOINTS["insight.research.list"], retry: "no-replay" as const } }
    const { unexplained } = diffEndpoints(drifted, upstream.endpoints, exceptions)
    expect(unexplained).toEqual([{ key: "insight.research.list", field: "retry", ours: "no-replay", upstream: undefined }])

    const ported = { ...ENDPOINTS, "tool.web-search": { key: "tool.web-search", ...upstream.endpoints["tool.web-search"], description: "t" } }
    const { stale } = diffEndpoints(ported, upstream.endpoints, exceptions)
    expect(stale.map((e: { key: string }) => e.key)).toEqual(["tool.web-search"])
  })

  it("compares only fixed prices and the presence of a destructive marker", () => {
    expect(normalizeEndpoint({ method: "POST", path: "/x", kind: "json", billing: { kind: "free" } })).toEqual({ method: "POST", path: "/x", kind: "json" })
    expect(normalizeEndpoint({ method: "POST", path: "/x", kind: "json", billing: { kind: "fixed", per: "row", price: 0.5, maxUnits: Number.POSITIVE_INFINITY, unit: "张" }, destructive: { warning: "w" } }))
      .toEqual({ method: "POST", path: "/x", kind: "json", billing: { per: "row", price: 0.5, maxUnits: "Infinity" }, destructive: true })
  })
})
