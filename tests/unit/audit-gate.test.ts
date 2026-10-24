import { describe, expect, it } from "vitest"
// @ts-expect-error — 纯 JS 脚本，没有类型声明
import { ALLOWED, advisoriesOf, auditGate } from "../../scripts/audit-gate.mjs"

/** 最小的 `npm audit --json` 报告：每条公告挂在它所在的包下，另带一个只经传递关系出现的包。 */
const report = (...advisories: Array<{ id: string; pkg: string; severity: string }>) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    ...Object.fromEntries(advisories.map((a) => [a.pkg, { name: a.pkg, severity: a.severity, via: [{ source: 1, name: a.pkg, title: `t-${a.id}`, url: `https://github.com/advisories/${a.id}`, severity: a.severity }] }])),
    "some-parent": { name: "some-parent", severity: "high", via: advisories.map((a) => a.pkg) },
  },
})
const ZOD = { id: "GHSA-mrhx-c7xc-m3w5", pkg: "zod", severity: "high" }
const ALLOW = [{ id: ZOD.id, package: "zod", reason: "r", expires: "2026-12-31" }]

describe("audit gate", () => {
  it("passes an allowed high advisory before its expiry, and ignores moderate ones", () => {
    const result = auditGate(report(ZOD, { id: "GHSA-mod", pkg: "hono", severity: "moderate" }), ALLOW, "2026-12-31")
    expect(result.blocking).toEqual([])
    expect(result.expired).toEqual([])
    expect(result.stale).toEqual([])
    expect(result.excused.map((a: { id: string }) => a.id)).toEqual([ZOD.id])
  })

  it("blocks any high or critical advisory that is not allowed", () => {
    const result = auditGate(report(ZOD, { id: "GHSA-new", pkg: "undici", severity: "high" }, { id: "GHSA-crit", pkg: "qs", severity: "critical" }), ALLOW, "2026-10-24")
    expect(result.blocking.map((a: { id: string }) => a.id)).toEqual(["GHSA-new", "GHSA-crit"])
  })

  it("fails an allowance the day after it expires", () => {
    const result = auditGate(report(ZOD), ALLOW, "2027-01-01")
    expect(result.expired.map((a: { id: string }) => a.id)).toEqual([ZOD.id])
    expect(result.excused).toEqual([])
  })

  it("fails an allowance whose advisory is no longer reported", () => {
    expect(auditGate(report(), ALLOW, "2026-10-24").stale.map((a: { id: string }) => a.id)).toEqual([ZOD.id])
  })

  it("refuses a report it cannot read instead of passing it", () => {
    expect(() => advisoriesOf({ error: { code: "ENOAUDIT", summary: "no audit endpoint" } })).toThrow(/可读的报告/)
    expect(() => advisoriesOf({})).toThrow(/可读的报告/)
  })

  it("gives every allowance a reason and a calendar expiry", () => {
    for (const a of ALLOWED) {
      expect(a.reason, a.id).toMatch(/\S{8,}/)
      expect(a.expires, a.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
