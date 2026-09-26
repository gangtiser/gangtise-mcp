import { describe, expect, it } from "vitest"
import { createRowTracker, planRemainingPages } from "../../../src/core/paginate.js"

describe("planRemainingPages", () => {
  it("splits the remaining range into maxPageSize chunks", () => {
    // first page already covered [20), fetch up to 100 with 50/page
    expect(planRemainingPages(20, 100, 50, 1000)).toEqual([
      { from: 20, size: 50 },
      { from: 70, size: 30 },
    ])
  })

  it("handles an exact multiple of the page size", () => {
    expect(planRemainingPages(50, 150, 50, 1000)).toEqual([
      { from: 50, size: 50 },
      { from: 100, size: 50 },
    ])
  })

  it("returns nothing when there is no remaining range", () => {
    expect(planRemainingPages(100, 100, 50, 1000)).toEqual([])
    expect(planRemainingPages(120, 100, 50, 1000)).toEqual([])
  })

  it("caps total pages (including the already-fetched first page) at maxPages", () => {
    // 0..1000 by 50 = 20 remaining requests; maxPages 3 → keep only 2 (first page is the 3rd)
    const reqs = planRemainingPages(0, 1000, 50, 3)
    expect(reqs).toHaveLength(2)
    expect(reqs[0]).toEqual({ from: 0, size: 50 })
    expect(reqs[1]).toEqual({ from: 50, size: 50 })
  })
})

// 上限此前是「先把整段区间的请求对象全部造出来，再截成 maxPages-1 条」。total 千万级时
// 那一步要临时分配几十 MB，而最终只留下几百条。上限必须在生成循环里生效。
describe("planRemainingPages allocation", () => {
  it("never builds more than the cap, however large the range", () => {
    const reqs = planRemainingPages(50, 50_000_000, 50, 1000)
    expect(reqs).toHaveLength(999)
    expect(reqs[0]).toEqual({ from: 50, size: 50 })
    expect(reqs[998]).toEqual({ from: 50 + 998 * 50, size: 50 })
  })

  it("allocates proportionally to the cap, not to the range", () => {
    // 峰值堆内存与「区间多大」无关。两个区间差 1000 倍，分配量必须同量级。
    const measure = (endFrom: number) => {
      global.gc?.()
      const before = process.memoryUsage().heapUsed
      const reqs = planRemainingPages(50, endFrom, 50, 1000)
      const after = process.memoryUsage().heapUsed
      return { grew: after - before, len: reqs.length }
    }
    const small = measure(100_000)
    const huge = measure(100_000_000)
    expect(small.len).toBe(999)
    expect(huge.len).toBe(999)
    // 旧写法在 1 亿这一档要先造 200 万个对象（数十 MB）；现在两档都只造 999 个。
    expect(huge.grew).toBeLessThan(8 * 1024 * 1024)
  })
})

describe("createRowTracker", () => {
  const row = (id: unknown, title = "t") => ({ reportId: id, title })

  it("drops a row seen again whole on a later page and counts it", () => {
    const t = createRowTracker("reportId")
    expect(t.filter([row("a"), row("b")])).toEqual([row("a"), row("b")])
    expect(t.filter([row("b"), row("c")])).toEqual([row("c")])
    expect(t.state).toEqual({ duplicateRows: 1, changedRows: 0, idIsRowKey: true })
  })

  it("keeps both versions when an id comes back with different content on a later page", () => {
    const t = createRowTracker("reportId")
    t.filter([row("a", "v1")])
    expect(t.filter([row("a", "v2")])).toEqual([row("a", "v2")])
    expect(t.state).toEqual({ duplicateRows: 0, changedRows: 1, idIsRowKey: true })
  })

  it("stops treating the field as a row key once one page carries two versions of an id", () => {
    const t = createRowTracker("reportId")
    expect(t.filter([row("a", "v1"), row("a", "v2")])).toHaveLength(2)
    expect(t.state.idIsRowKey).toBe(false)
    expect(t.state.changedRows).toBe(0)
  })

  it("always keeps rows without the field or with a null id", () => {
    const t = createRowTracker("reportId")
    expect(t.filter([{ title: "x" }, row(null), { title: "x" }, row(null)])).toHaveLength(4)
    expect(t.state.duplicateRows).toBe(0)
  })

  // 只和第一版比会漏：v1 → v2 → v2 时第三行是第二行的重复。
  it("drops a repeat of any version already seen, not just the first", () => {
    const t = createRowTracker("reportId")
    t.filter([row("a", "v1")])
    expect(t.filter([row("a", "v2")])).toEqual([row("a", "v2")])
    expect(t.filter([row("a", "v2")])).toEqual([])
    expect(t.filter([row("a", "v1")])).toEqual([])
    expect(t.state).toEqual({ duplicateRows: 2, changedRows: 1, idIsRowKey: true })
  })

  // 同页两版即非主键——哪怕两版都是之前见过的、都会被当重复去掉，这一页仍然说明了问题。
  it("stops treating the field as a row key when one page repeats two versions already seen", () => {
    const t = createRowTracker("reportId")
    t.filter([row("a", "v1")])
    t.filter([row("a", "v2")])
    expect(t.filter([row("a", "v1"), row("a", "v2")])).toEqual([])
    expect(t.state).toEqual({ duplicateRows: 2, changedRows: 1, idIsRowKey: false })
  })

  // 同页两版里只有一版是新的：照样非主键，新版保留、不计变动行。
  it("does not count a new version as changed when the same page already carried the id", () => {
    const t = createRowTracker("reportId")
    t.filter([row("a", "v1")])
    expect(t.filter([row("a", "v1"), row("a", "v2")])).toEqual([row("a", "v2")])
    expect(t.state).toEqual({ duplicateRows: 1, changedRows: 0, idIsRowKey: false })
  })

  // 同一行两次返回的字段顺序可能不同，内容相同就是同一版。
  it("treats rows that differ only in key order as the same version, nested objects included", () => {
    const t = createRowTracker("reportId")
    t.filter([{ reportId: "a", title: "t", author: { id: 1, name: "n" } }])
    expect(t.filter([{ author: { name: "n", id: 1 }, title: "t", reportId: "a" }])).toEqual([])
    expect(t.state).toEqual({ duplicateRows: 1, changedRows: 0, idIsRowKey: true })
  })

  it("keeps array order significant", () => {
    const t = createRowTracker("reportId")
    t.filter([{ reportId: "a", tags: ["x", "y"] }])
    expect(t.filter([{ reportId: "a", tags: ["y", "x"] }])).toHaveLength(1)
    expect(t.state.changedRows).toBe(1)
  })

  it("is a no-op without a rowId", () => {
    const t = createRowTracker(undefined)
    expect(t.filter([row("a"), row("a")])).toHaveLength(2)
    expect(t.state).toEqual({ duplicateRows: 0, changedRows: 0, idIsRowKey: true })
  })

  it("keys rows by a composite key, keeping rows with any part missing", () => {
    const t = createRowTracker(["securityCode", "tradeDate"])
    t.filter([{ securityCode: "600519.SH", tradeDate: "2026-09-25", close: 1 }])
    // 同证券不同日期是另一行；同证券同日期整行相同是重复；缺一段取不到键，照样保留。
    expect(t.filter([
      { securityCode: "600519.SH", tradeDate: "2026-09-26", close: 1 },
      { securityCode: "600519.SH", tradeDate: "2026-09-25", close: 1 },
      { securityCode: "600519.SH", tradeDate: null, close: 1 },
      { securityCode: "600519.SH", tradeDate: null, close: 1 },
    ])).toHaveLength(3)
    expect(t.state).toEqual({ duplicateRows: 1, changedRows: 0, idIsRowKey: true })
  })

  it("does not confuse composite parts that concatenate to the same text", () => {
    const t = createRowTracker(["a", "b"])
    t.filter([{ a: "x", b: "yz" }])
    expect(t.filter([{ a: "xy", b: "z" }])).toHaveLength(1)
    expect(t.state.duplicateRows).toBe(0)
  })

  it("keys rows by a key function, keeping rows it returns undefined for", () => {
    const t = createRowTracker((r) => {
      const id = (r.meta as { id?: number } | undefined)?.id
      return id === undefined ? undefined : String(id)
    })
    t.filter([{ meta: { id: 7 }, title: "t" }])
    expect(t.filter([{ meta: { id: 7 }, title: "t" }, { title: "no id" }, { title: "no id" }])).toHaveLength(2)
    expect(t.state).toEqual({ duplicateRows: 1, changedRows: 0, idIsRowKey: true })
  })
})
