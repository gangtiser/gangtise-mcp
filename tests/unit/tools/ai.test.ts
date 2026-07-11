import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerAiTools } from "../../../src/tools/ai.js"
import { ApiError } from "../../../src/core/errors.js"
import type { GangtiseClient } from "../../../src/core/client.js"

const SUBMIT = "ai.earnings-review.get-id"
const POLL = "ai.earnings-review.get-content"

// Submit always returns a dataId; the poll behavior is supplied per test.
function makeClient(poll: (body: Record<string, unknown>) => Promise<unknown>) {
  const call = vi.fn(async (key: string, body: Record<string, unknown>) => {
    if (key === SUBMIT) return { dataId: "d1" }
    if (key === POLL) return poll(body)
    return {}
  })
  return { call, download: vi.fn() } as unknown as GangtiseClient
}

async function connect(client: GangtiseClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerAiTools(server, client, { asyncTimeoutMs: 5_000 })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

function parse(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)
}
function text(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text
}

const args = { securityCode: "600519.SH", period: "2025annual" }

describe("gangtise_earnings_review (async submit→poll)", () => {
  it("returns the content when polling succeeds", async () => {
    const mcp = await connect(makeClient(async () => ({ content: "# 业绩点评" })))
    const result = await mcp.callTool({ name: "gangtise_earnings_review", arguments: { ...args, waitSeconds: 5 } })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain("业绩点评")
  })

  it("retains dataId and flags isError on a terminal 410111 failure", async () => {
    const mcp = await connect(makeClient(async () => { throw new ApiError("failed", "410111") }))
    const result = await mcp.callTool({ name: "gangtise_earnings_review", arguments: { ...args, waitSeconds: 5 } })
    expect(result.isError).toBe(true)
    expect(parse(result)).toMatchObject({ dataId: "d1", status: "failed" })
  })

  it("retains dataId on a transient mid-poll error (recoverable, not isError)", async () => {
    const mcp = await connect(makeClient(async () => { throw new ApiError("rate limited", "903301") }))
    const result = await mcp.callTool({ name: "gangtise_earnings_review", arguments: { ...args, waitSeconds: 5 } })
    expect(result.isError).toBeFalsy()
    const parsed = parse(result)
    expect(parsed).toMatchObject({ dataId: "d1", status: "error" })
    expect(parsed.hint).toContain("gangtise_earnings_review_check")
  })

  it("returns dataId with timeout status when not ready before the deadline", async () => {
    const mcp = await connect(makeClient(async () => ({}))) // never has content
    const result = await mcp.callTool({ name: "gangtise_earnings_review", arguments: { ...args, waitSeconds: 0 } })
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toMatchObject({ dataId: "d1", status: "timeout" })
  })

  it("waitSeconds=0 returns the dataId without spending a (billed) poll round-trip", async () => {
    // Absolute deadline from tool-call start: a zero wait budget must hand back
    // the dataId immediately — submit runs, the content endpoint never does.
    const client = makeClient(async () => ({})) // content endpoint must never be reached
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_earnings_review", arguments: { ...args, waitSeconds: 0 } })
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toMatchObject({ dataId: "d1", status: "timeout" })
    expect(client.call).toHaveBeenCalledTimes(1)
    expect(client.call).toHaveBeenCalledWith(SUBMIT, expect.anything())
    expect(client.call).not.toHaveBeenCalledWith(POLL, expect.anything())
  })
})

describe("gangtise_earnings_review_check", () => {
  it("reports pending on 410110", async () => {
    const mcp = await connect(makeClient(async () => { throw new ApiError("pending", "410110") }))
    const result = await mcp.callTool({ name: "gangtise_earnings_review_check", arguments: { dataId: "d1" } })
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toMatchObject({ status: "pending", dataId: "d1" })
  })

  it("reports failed (isError) on 410111", async () => {
    const mcp = await connect(makeClient(async () => { throw new ApiError("failed", "410111") }))
    const result = await mcp.callTool({ name: "gangtise_earnings_review_check", arguments: { dataId: "d1" } })
    expect(result.isError).toBe(true)
    // The failure reason must survive (code + hint), so the model can decide whether to re-submit.
    expect(parse(result)).toMatchObject({ status: "failed", dataId: "d1", error: expect.stringContaining("410111") })
  })

  it("returns the content once ready", async () => {
    const mcp = await connect(makeClient(async () => ({ content: "# 终稿" })))
    const result = await mcp.callTool({ name: "gangtise_earnings_review_check", arguments: { dataId: "d1" } })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain("终稿")
  })

  // content: "" means the task finished with empty output (the backend does
  // this — see the empty-content fallback for the sync AI tools). A truthiness
  // check used to report it as pending forever, making the billed task look
  // unrecoverable.
  it("treats empty-string content as done (friendly note), not pending", async () => {
    const mcp = await connect(makeClient(async () => ({ content: "" })))
    const result = await mcp.callTool({ name: "gangtise_earnings_review_check", arguments: { dataId: "d1" } })
    expect(result.isError).toBeFalsy()
    expect(text(result)).not.toContain("pending")
    expect(text(result)).toContain("内容为空")
  })
})

describe("schema validation (X5 tightening)", () => {
  it("rejects a non-quarter-end reportDate without calling the API", async () => {
    const client = makeClient(async () => ({}))
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_management_discuss_announcement",
      arguments: { securityCode: "600519.SH", reportDate: "2026-05-15", discussionDimension: "all" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("accepts an interim-report date and calls the API", async () => {
    const client = makeClient(async () => ({}))
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_management_discuss_announcement",
      arguments: { securityCode: "600519.SH", reportDate: "2026-06-30", discussionDimension: "all" },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it("rejects a date-only startTime on security_clue_list without calling the API", async () => {
    const client = makeClient(async () => ({}))
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_security_clue_list",
      arguments: { startTime: "2026-06-01", endTime: "2026-06-30 23:59:59", queryMode: "bySecurity" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })
})

describe("empty-content completion via submit→poll", () => {
  it("returns the friendly empty-content note instead of an empty text block", async () => {
    const mcp = await connect(makeClient(async () => ({ content: "" })))
    const result = await mcp.callTool({ name: "gangtise_earnings_review", arguments: { ...args, waitSeconds: 5 } })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain("内容为空")
  })
})

describe("schema tightening (billing + ID guards)", () => {
  it("rejects a blank viewpoint before submitting the billed debate task", async () => {
    const client = makeClient(async () => ({}))
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_viewpoint_debate", arguments: { viewpoint: "   " } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects a securityList over the 6000 cap without calling the API", async () => {
    const client = makeClient(async () => ({}))
    const mcp = await connect(client)
    const big = Array.from({ length: 6001 }, (_, i) => `x${i}`)
    const result = await mcp.callTool({ name: "gangtise_stock_summary", arguments: { securityList: big } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects a blank securityCode on a content-generating tool", async () => {
    const client = makeClient(async () => ({}))
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_one_pager", arguments: { securityCode: "  " } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects a blank sourceId on the knowledge resource download", async () => {
    const client = makeClient(async () => ({}))
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_knowledge_resource_download", arguments: { resourceType: 10, sourceId: "" } })
    expect(result.isError).toBe(true)
    expect(client.download).not.toHaveBeenCalled()
  })

  it("rejects an out-of-set resourceType on the knowledge resource download", async () => {
    const client = makeClient(async () => ({}))
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_knowledge_resource_download", arguments: { resourceType: 999, sourceId: "abc" } })
    expect(result.isError).toBe(true)
    expect(client.download).not.toHaveBeenCalled()
  })
})
