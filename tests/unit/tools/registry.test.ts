import fs from "node:fs/promises"
import path from "node:path"

import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerJsonTool, registerDownloadTool, sanitizeArgs, buildToolContent, buildTextResult } from "../../../src/tools/registry.js"
import { INLINE_MAX_BYTES } from "../../../src/core/config.js"
import type { GangtiseClient } from "../../../src/core/client.js"

function makeMockClient(responseData: unknown = { list: [{ id: "1" }], total: 1 }) {
  return {
    call: vi.fn().mockResolvedValue(responseData),
    download: vi.fn(),
  } as unknown as GangtiseClient
}

async function makeConnectedPair(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

describe("sanitizeArgs", () => {
  it("removes fetchAll from body", () => {
    const result = sanitizeArgs({ fetchAll: true, keyword: "test" }, { paginated: true, fetchAll: true })
    expect(result).not.toHaveProperty("fetchAll")
    expect(result).toHaveProperty("keyword", "test")
  })

  it("adds size: 20 for paginated endpoints when size omitted", () => {
    const result = sanitizeArgs({ keyword: "test" }, { paginated: true, fetchAll: false })
    expect(result).toHaveProperty("size", 20)
  })

  it("does not add size for non-paginated endpoints", () => {
    const result = sanitizeArgs({ securityCode: "600519.SH" }, { paginated: false })
    expect(result).not.toHaveProperty("size")
  })

  it("removes size when fetchAll is true", () => {
    const result = sanitizeArgs({ size: 50 }, { paginated: true, fetchAll: true })
    expect(result).not.toHaveProperty("size")
  })

  it("respects explicit size when not fetchAll", () => {
    const result = sanitizeArgs({ size: 100 }, { paginated: true, fetchAll: false })
    expect(result).toHaveProperty("size", 100)
  })
})

function makeLargeItems(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: String(i), content: "a".repeat(600) }))
}

describe("buildToolContent", () => {
  it("small response returns unchanged JSON", async () => {
    const data = { list: [{ id: "1" }], total: 1 }
    const content = await buildToolContent(data)
    expect(content).toHaveLength(1)
    expect(JSON.parse(content[0].text)).toEqual(data)
  })

  it("large { list, total } response truncates list and writes file", async () => {
    const items = makeLargeItems(500)
    const data = { list: items, total: 500, extra: "meta" }
    const content = await buildToolContent(data)
    const result = JSON.parse(content[0].text)

    expect(result._truncated).toBe(true)
    expect(result._total_items).toBe(500)
    expect(result._preview_count).toBe(20)
    expect(result.list).toHaveLength(20)
    expect(result.total).toBe(500)
    expect(result.extra).toBe("meta")
    expect(result.has_more).toBe(true)
    expect(result).not.toHaveProperty("next_from")
    expect(result._total_bytes).toBe(Buffer.byteLength(JSON.stringify(data), "utf8"))
    expect(typeof result._saved_to).toBe("string")

    const savedTo = result._saved_to as string
    const fileContent = await fs.readFile(savedTo, "utf8")
    expect(JSON.parse(fileContent)).toEqual(data)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("large top-level array wraps into { list, ... } with metadata", async () => {
    const items = makeLargeItems(500)
    const content = await buildToolContent(items)
    const result = JSON.parse(content[0].text)

    expect(result._truncated).toBe(true)
    expect(result._total_items).toBe(500)
    expect(result._preview_count).toBe(20)
    expect(result.list).toHaveLength(20)
    expect(result.has_more).toBe(true)
    expect(result).not.toHaveProperty("next_from")
    expect(result._total_bytes).toBe(Buffer.byteLength(JSON.stringify(items), "utf8"))
    expect(typeof result._saved_to).toBe("string")

    const savedTo = result._saved_to as string
    const fileContent = await fs.readFile(savedTo, "utf8")
    expect(JSON.parse(fileContent)).toEqual(items)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("large-row preview exceeds cap: shrinks the sample to fit instead of emptying it", async () => {
    // 20 items × ~15KB Chinese text ≈ 300KB — the full 20-row preview blows the
    // inline budget, so the guard halves the sample until it fits.
    const items = Array.from({ length: 20 }, (_, i) => ({ id: String(i), content: "中".repeat(5_000) }))
    const data = { list: items, total: 500 }
    const content = await buildToolContent(data)
    const result = JSON.parse(content[0].text)

    expect(result._truncated).toBe(true)
    expect(result.total).toBe(500)       // server-side total preserved via ...rest
    expect(result._total_items).toBe(20) // items in file, not server total
    // A nonempty sample survives (not the old all-or-nothing 0), and it fits the budget.
    expect(result._preview_count).toBeGreaterThan(0)
    expect(result._preview_count).toBeLessThan(20)
    expect((result.list as unknown[]).length).toBe(result._preview_count)
    expect(Buffer.byteLength(content[0].text, "utf8")).toBeLessThanOrEqual(INLINE_MAX_BYTES)
    // File still holds all 20 — has_more/next_offset must point past the sample.
    expect(result.has_more).toBe(true)
    expect(result.next_offset).toBe(result._preview_count)

    await fs.rm(path.dirname(result._saved_to as string), { recursive: true, force: true })
  })

  it("a single row larger than the cap falls back to metadata-only with _first_item_keys", async () => {
    // One row that alone blows the budget can't be sampled — but the model still
    // needs the field names, so surface the first row's keys.
    const items = [{ id: "0", name: "巨行", content: "中".repeat(30_000) }] // ~90KB single row
    const content = await buildToolContent({ list: items, total: 1 })
    const result = JSON.parse(content[0].text)

    expect(result._truncated).toBe(true)
    expect(result._preview_count).toBe(0)
    expect(result.list).toBeUndefined()
    expect(result._first_item_keys).toEqual(["id", "name", "content"])
    expect(result.has_more).toBe(true) // the file still holds the row; page it via read_response

    await fs.rm(path.dirname(result._saved_to as string), { recursive: true, force: true })
  })

  it("empty array result gets a disambiguating _hint instead of a bare []", async () => {
    const content = await buildToolContent([])
    const result = JSON.parse(content[0].text)
    expect(result.list).toEqual([])
    expect(result._hint).toContain("参数不匹配")
  })

  it("empty { list, total } result keeps meta and gets a _hint", async () => {
    const content = await buildToolContent({ list: [], total: 0 })
    const result = JSON.parse(content[0].text)
    expect(result.list).toEqual([])
    expect(result.total).toBe(0)
    expect(result._hint).toContain("gangtise_securities_search")
  })

  it("list: null is coerced to [] and gets a _hint", async () => {
    const content = await buildToolContent({ list: null })
    const result = JSON.parse(content[0].text)
    expect(result.list).toEqual([])
    expect(result._hint).toBeDefined()
  })

  it("non-empty result carries no _hint", async () => {
    const content = await buildToolContent({ list: [{ id: "1" }], total: 1 })
    const result = JSON.parse(content[0].text)
    expect(result).not.toHaveProperty("_hint")
  })

  it("truncated preview exposes next_offset so read-back skips the previewed items", async () => {
    const content = await buildToolContent({ list: makeLargeItems(500), total: 500 })
    const result = JSON.parse(content[0].text)
    expect(result.next_offset).toBe(20) // == PREVIEW_ITEMS; read_response(offset: 20) continues past the preview
    await fs.rm(path.dirname(result._saved_to as string), { recursive: true, force: true })
  })
})

describe("buildTextResult", () => {
  it("returns short text inline unchanged", async () => {
    const content = await buildTextResult("# 一页纸\n\n小内容")
    expect(content).toHaveLength(1)
    expect(content[0].text).toBe("# 一页纸\n\n小内容")
  })

  it("writes oversized text to a temp .md file and returns a preview pointer", async () => {
    const big = "# 报告\n\n" + "段落内容。".repeat(60_000) // well over 256KB
    const content = await buildTextResult(big)
    const meta = JSON.parse(content[0].text)

    expect(meta._truncated).toBe(true)
    expect(meta._read_with).toBe("gangtise_read_response")
    expect(typeof meta._saved_to).toBe("string")
    expect((meta._saved_to as string).endsWith(".md")).toBe(true)
    expect(meta._total_chars).toBe(big.length)
    expect(typeof meta._preview).toBe("string")
    expect((meta._preview as string).length).toBeLessThan(big.length)

    const fileContent = await fs.readFile(meta._saved_to as string, "utf8")
    expect(fileContent).toBe(big)
    await fs.rm(path.dirname(meta._saved_to as string), { recursive: true, force: true })
  })
})

describe("buildTextResult boundaries", () => {
  it("does not split a surrogate pair at the text preview boundary", async () => {
    // Leading "x" shifts every emoji pair to straddle the even 4000-char preview cut.
    const big = "x" + "😀".repeat(120_000)
    const content = await buildTextResult(big)
    const meta = JSON.parse(content[0].text)
    const preview = meta._preview as string
    const lastCode = preview.charCodeAt(preview.length - 1)
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true)
    await fs.rm(path.dirname(meta._saved_to as string), { recursive: true, force: true })
  })
})

describe("registerDownloadTool", () => {
  function makeDownloadServer(downloadResponse: unknown) {
    const mockClient = {
      call: vi.fn(),
      download: vi.fn().mockResolvedValue(downloadResponse),
    } as unknown as GangtiseClient
    const server = new McpServer({ name: "test", version: "0.0.0" })
    registerDownloadTool(server, mockClient, {
      name: "gangtise_research_download",
      description: "Test download",
      endpointKey: "insight.research.download",
      inputSchema: { reportId: z.string() },
    })
    return server
  }

  it("returns small text results inline as full JSON", async () => {
    const server = makeDownloadServer({ text: "# 小文档", contentType: "text/markdown" })
    const mcpClient = await makeConnectedPair(server)
    const result = await mcpClient.callTool({ name: "gangtise_research_download", arguments: { reportId: "r1" } })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed.text).toBe("# 小文档")
    expect(parsed.contentType).toBe("text/markdown")
  })

  it("spills oversized text results to a temp file instead of inlining them", async () => {
    const big = "研报内容。".repeat(60_000) // ~900KB, well over the 256KB inline cap
    const server = makeDownloadServer({ text: big, contentType: "text/markdown" })
    const mcpClient = await makeConnectedPair(server)
    const result = await mcpClient.callTool({ name: "gangtise_research_download", arguments: { reportId: "r1" } })
    expect(result.isError).toBeFalsy()

    const raw = (result.content as Array<{ text: string }>)[0].text
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(256_000)

    const parsed = JSON.parse(raw)
    expect(parsed._truncated).toBe(true)
    expect(parsed._read_with).toBe("gangtise_read_response")
    expect(typeof parsed._saved_to).toBe("string")
    expect(parsed.contentType).toBe("text/markdown")
    expect(parsed.text).toBeUndefined()
    expect(typeof parsed._preview).toBe("string")

    const fileContent = await fs.readFile(parsed._saved_to as string, "utf8")
    expect(fileContent).toBe(big)
    await fs.rm(path.dirname(parsed._saved_to as string), { recursive: true, force: true })
  })
})

describe("registerJsonTool", () => {
  it("returns normalized JSON for list response", async () => {
    const mockClient = makeMockClient({ list: [{ id: "abc", name: "test" }], total: 1 })
    const server = new McpServer({ name: "test", version: "0.0.0" })
    registerJsonTool(server, mockClient, {
      name: "gangtise_opinion_list",
      description: "Test tool",
      endpointKey: "insight.opinion.list",
      paginated: true,
      inputSchema: { keyword: z.string().optional() },
    })
    const mcpClient = await makeConnectedPair(server)
    const result = await mcpClient.callTool({ name: "gangtise_opinion_list", arguments: { keyword: "foo" } })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed).toHaveProperty("list")
    expect(parsed).toHaveProperty("total", 1)
  })

  it("passes size: 20 default for paginated endpoint", async () => {
    const mockClient = makeMockClient()
    const server = new McpServer({ name: "test", version: "0.0.0" })
    registerJsonTool(server, mockClient, {
      name: "gangtise_opinion_list",
      description: "Test",
      endpointKey: "insight.opinion.list",
      paginated: true,
      inputSchema: {},
    })
    const mcpClient = await makeConnectedPair(server)
    await mcpClient.callTool({ name: "gangtise_opinion_list", arguments: {} })
    expect(mockClient.call).toHaveBeenCalledWith(
      "insight.opinion.list",
      expect.objectContaining({ size: 20 }),
    )
  })

  it("does not pass size for non-paginated endpoint", async () => {
    const mockClient = makeMockClient({ securityCode: "600519.SH" })
    const server = new McpServer({ name: "test", version: "0.0.0" })
    registerJsonTool(server, mockClient, {
      name: "gangtise_one_pager",
      description: "Test",
      endpointKey: "ai.one-pager",
      paginated: false,
      inputSchema: { securityCode: z.string() },
    })
    const mcpClient = await makeConnectedPair(server)
    await mcpClient.callTool({ name: "gangtise_one_pager", arguments: { securityCode: "600519.SH" } })
    const callArg = (mockClient.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(callArg).not.toHaveProperty("size")
  })

  it("returns isError: true on API failure", async () => {
    const mockClient = {
      call: vi.fn().mockRejectedValue(new Error("API down")),
    } as unknown as GangtiseClient
    const server = new McpServer({ name: "test", version: "0.0.0" })
    registerJsonTool(server, mockClient, {
      name: "gangtise_opinion_list",
      description: "Test",
      endpointKey: "insight.opinion.list",
      paginated: false,
      inputSchema: {},
    })
    const mcpClient = await makeConnectedPair(server)
    const result = await mcpClient.callTool({ name: "gangtise_opinion_list", arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("API down")
  })

  it("runs transformBody after sanitizeArgs so pagination defaults are already injected", async () => {
    const mockClient = makeMockClient()
    const server = new McpServer({ name: "test", version: "0.0.0" })
    const seen: Array<Record<string, unknown>> = []
    registerJsonTool(server, mockClient, {
      name: "gangtise_drive_list",
      description: "Test",
      endpointKey: "vault.drive.list",
      paginated: true,
      inputSchema: { keyword: z.string().optional() },
      transformBody: (body) => {
        seen.push(body)
        return { ...body, marker: true }
      },
    })
    const mcpClient = await makeConnectedPair(server)
    await mcpClient.callTool({ name: "gangtise_drive_list", arguments: { keyword: "x" } })

    // hook 看到的 body 已含分页默认 size，且不含 fetchAll
    expect(seen[0]).toMatchObject({ keyword: "x", size: 20 })
    expect(seen[0]).not.toHaveProperty("fetchAll")
    // hook 的返回值才是真正发出去的 body，pagination 默认值未被 hook 吞掉
    expect(mockClient.call).toHaveBeenCalledWith("vault.drive.list", expect.objectContaining({ size: 20, marker: true }))
  })
})

describe("paginated param text", () => {
  async function paginatedProps(name: string, endpointKey: string) {
    const server = new McpServer({ name: "test", version: "0.0.0" })
    registerJsonTool(server, makeMockClient(), { name, description: "x", endpointKey, paginated: true, inputSchema: {} })
    const mcpClient = await makeConnectedPair(server)
    const { tools } = await mcpClient.listTools()
    return {
      props: (tools[0].inputSchema as { properties: Record<string, { description?: string }> }).properties,
      description: tools[0].description ?? "",
    }
  }

  it("keeps the three pagination param descriptions within 120 bytes per tool", async () => {
    const { props } = await paginatedProps("gangtise_drive_list", "vault.drive.list")
    const bytes = ["from", "size", "fetchAll"].reduce((a, k) => a + Buffer.byteLength(props[k].description ?? "", "utf8"), 0)
    expect(bytes).toBeLessThanOrEqual(120)
    // 缩短但不能丢语义：0-based、默认 20、fetchAll 覆盖 size
    expect(props.from.description).toContain("0-based")
    expect(props.size.description).toContain("20")
    expect(props.fetchAll.description).toContain("size")
  })

  it("still puts the fetchAll billing warning on paid paginated tools, label last", async () => {
    const { description } = await paginatedProps("gangtise_opinion_list", "insight.opinion.list")
    expect(description).toContain("fetchAll=true 按全部实际返回条目计费")
    expect(description.endsWith("【积分：30/条】")).toBe(true)
  })

  it("leaves free paginated tools with a bare description", async () => {
    const { description } = await paginatedProps("gangtise_drive_list", "vault.drive.list")
    expect(description).toBe("x")
  })
})
