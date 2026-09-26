import fs from "node:fs"

import { describe, expect, it } from "vitest"

import { PARTIAL_REASONS } from "../../src/core/partial.js"

/** README「结果不完整时的标记」表与代码里的原因清单双向对账：代码新增原因而 README 没写，
 *  客户看到一个查不到的标记；README 写了而代码不再产生，客户会等一个永远不出现的信号。 */
function readmeReasons(): string[] {
  const text = fs.readFileSync("README.md", "utf8")
  const start = text.indexOf("## 结果不完整时的标记")
  const end = text.indexOf("\n## ", start + 1)
  expect(start, "README 缺少「结果不完整时的标记」一节").toBeGreaterThan(-1)
  const section = text.slice(start, end)
  const reasons: string[] = []
  for (const line of section.split("\n")) {
    const cells = line.split("|")
    if (cells.length < 4 || !line.startsWith("| `")) continue
    for (const [, code] of cells[1].matchAll(/`([a-z_]+)`/g)) reasons.push(code)
  }
  return reasons
}

describe("README partial-reason table", () => {
  it("lists exactly the reasons the code can produce", () => {
    const documented = new Set(readmeReasons())
    const produced = new Set<string>(PARTIAL_REASONS)
    expect([...produced].filter((r) => !documented.has(r)).sort(), "代码会产生、README 没写").toEqual([])
    expect([...documented].filter((r) => !produced.has(r)).sort(), "README 写了、代码不会产生").toEqual([])
  })
})
