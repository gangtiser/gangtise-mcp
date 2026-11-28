import { describe, it, expect } from "vitest"
import { costConfirmed, currentSignal, runWithCostConfirmation, runWithRequestContext } from "../../../src/core/requestContext.js"

// 嵌套换信号（异步轮询的截止、报表单查的时限）只换信号，本次调用的费用确认要留着。
describe("runWithRequestContext", () => {
  it("swaps the signal and keeps the cost confirmation when nested", async () => {
    const outer = new AbortController()
    const inner = new AbortController()
    await runWithRequestContext(outer.signal, () =>
      runWithCostConfirmation(true, () =>
        runWithRequestContext(inner.signal, async () => {
          expect(currentSignal()).toBe(inner.signal)
          expect(costConfirmed()).toBe(true)
        }),
      ),
    )
  })
})
