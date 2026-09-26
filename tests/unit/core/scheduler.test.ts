import { describe, expect, it } from "vitest"

import { ConcurrencyGate, CALL_LIMITS } from "../../../src/core/scheduler.js"
import { MAX_GLOBAL_CONCURRENCY, resolveGlobalConcurrency } from "../../../src/core/config.js"

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("ConcurrencyGate", () => {
  it("never runs more than its limit at once and serves waiters first-in first-out", async () => {
    const gate = new ConcurrencyGate(2)
    let running = 0
    let peak = 0
    const order: number[] = []
    const releases: Array<() => void> = []
    const jobs = [0, 1, 2, 3, 4].map((n) =>
      gate.run(async () => {
        running++
        peak = Math.max(peak, running)
        order.push(n)
        await new Promise<void>((r) => releases.push(r))
        running--
      }),
    )
    await tick()
    expect(order).toEqual([0, 1])
    expect(gate.stats()).toEqual({ active: 2, queued: 3, limit: 2 })
    while (releases.length > 0) {
      releases.shift()!()
      await tick()
    }
    await Promise.all(jobs)
    expect(peak).toBe(2)
    expect(order).toEqual([0, 1, 2, 3, 4])
    expect(gate.stats()).toEqual({ active: 0, queued: 0, limit: 2 })
  })

  it("drops a cancelled waiter from the queue without taking a slot", async () => {
    const gate = new ConcurrencyGate(1)
    let release!: () => void
    const holder = gate.run(() => new Promise<void>((r) => (release = r)))
    const controller = new AbortController()
    const waiting = gate.run(async () => "should not run", controller.signal)
    await tick()
    expect(gate.stats().queued).toBe(1)
    controller.abort(new Error("cancelled"))
    await expect(waiting).rejects.toThrow("cancelled")
    expect(gate.stats()).toEqual({ active: 1, queued: 0, limit: 1 })
    release()
    await holder
    expect(gate.stats()).toEqual({ active: 0, queued: 0, limit: 1 })
    expect(await gate.run(async () => "next")).toBe("next")
  })

  it("rejects at once when the signal is already aborted", async () => {
    const gate = new ConcurrencyGate(1)
    const controller = new AbortController()
    controller.abort(new Error("gone"))
    await expect(gate.run(async () => 1, controller.signal)).rejects.toThrow("gone")
    expect(gate.stats().active).toBe(0)
  })

  it("releases the slot when the job throws", async () => {
    const gate = new ConcurrencyGate(1)
    await expect(gate.run(async () => { throw new Error("boom") })).rejects.toThrow("boom")
    expect(await gate.run(async () => "ok")).toBe("ok")
  })
})

describe("GANGTISE_MCP_GLOBAL_CONCURRENCY", () => {
  it("defaults to max(16, page concurrency), clamps, and ignores bad input", () => {
    expect(resolveGlobalConcurrency(undefined, 5)).toBe(16)
    expect(resolveGlobalConcurrency(undefined, 24)).toBe(24)
    expect(resolveGlobalConcurrency("8", 5)).toBe(8)
    expect(resolveGlobalConcurrency("8.9", 5)).toBe(8)
    expect(resolveGlobalConcurrency("1000", 5)).toBe(MAX_GLOBAL_CONCURRENCY)
    for (const bad of ["0", "-1", "abc", ""]) expect(resolveGlobalConcurrency(bad, 5), bad).toBe(16)
  })
})

describe("CALL_LIMITS", () => {
  it("keeps the existing per-call caps", () => {
    expect(CALL_LIMITS).toEqual({ maxPages: 1000, maxShards: 180 })
  })
})
