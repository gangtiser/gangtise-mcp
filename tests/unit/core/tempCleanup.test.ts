import { describe, expect, it } from "vitest"
import { selectStaleTempDirs } from "../../../src/core/tempCleanup.js"

const DAY = 86_400_000
const now = 1_700_000_000_000

describe("selectStaleTempDirs", () => {
  it("selects prefixed dirs older than maxAge", () => {
    const entries = [
      { name: "gangtise-mcp-aaa", mtimeMs: now - 2 * DAY },
      { name: "gangtise-mcp-bbb", mtimeMs: now - 5 * DAY },
    ]
    expect(selectStaleTempDirs(entries, "gangtise-mcp-", now, DAY).sort()).toEqual([
      "gangtise-mcp-aaa",
      "gangtise-mcp-bbb",
    ])
  })

  it("keeps recent prefixed dirs", () => {
    const entries = [{ name: "gangtise-mcp-fresh", mtimeMs: now - 1000 }]
    expect(selectStaleTempDirs(entries, "gangtise-mcp-", now, DAY)).toEqual([])
  })

  it("ignores dirs that do not match the prefix", () => {
    const entries = [{ name: "other-prefix-aaa", mtimeMs: now - 10 * DAY }]
    expect(selectStaleTempDirs(entries, "gangtise-mcp-", now, DAY)).toEqual([])
  })
})
