import fs from "node:fs/promises"
import path from "node:path"

import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerJsonTool, registerDownloadTool, sanitizeArgs, buildToolContent, buildTextResult } from "../../../src/tools/registry.js"
import { INLINE_MAX_BYTES } from "../../../src/core/config.js"
import { createGangtiseMcpServer } from "../../../src/server.js"
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

  it("a single row larger than the cap falls back to metadata-only, with field names from _available_fields", async () => {
    // One row that alone blows the budget can't be sampled — but the model still
    // needs the field names. They come from _available_fields (capped), not an
    // unbounded first-row key dump that could itself exceed the byte budget.
    const items = [{ id: "0", name: "巨行", content: "中".repeat(30_000) }] // ~90KB single row
    const content = await buildToolContent({ list: items, total: 1 })
    const result = JSON.parse(content[0].text)

    expect(result._truncated).toBe(true)
    expect(result._preview_count).toBe(0)
    expect(result.list).toBeUndefined()
    expect(result._first_item_keys).toBeUndefined()
    expect(result._available_fields).toEqual(["id", "name", "content"])
    expect(result.has_more).toBe(true) // the file still holds the row; page it via read_response

    await fs.rm(path.dirname(result._saved_to as string), { recursive: true, force: true })
  })

  it("keeps the metadata-only pointer within budget when one row has thousands of fields", async () => {
    // The fallback fires precisely for pathologically large rows; a wide row must
    // not make the pointer itself exceed the inline budget via an unbounded key dump.
    const wide: Record<string, string> = {}
    for (let i = 0; i < 8_000; i += 1) wide[`field_${i}`] = "x".repeat(10)
    const content = await buildToolContent({ list: [wide], total: 1 })
    const result = JSON.parse(content[0].text)

    expect(result._preview_count).toBe(0)
    expect(Buffer.byteLength(content[0].text, "utf8")).toBeLessThanOrEqual(INLINE_MAX_BYTES)
    expect(result._first_item_keys).toBeUndefined()
    expect((result._available_fields as string[]).length).toBe(50) // capped, so the pointer stays small
    expect(result._available_fields_truncated).toBe(true)

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
    const big = "# 报告\n\n" + "段落内容。".repeat(60_000) // well over 64KB
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
    const big = "研报内容。".repeat(60_000) // ~900KB, well over the 64KB inline cap
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

  // 分页三参的说明**已搬进 `server.instructions` 的「通用参数」行**：22 个分页工具各写
  // 一遍要付 22 遍，写在 instructions 只付一遍。所以这里钉两件事：
  //   ① schema 侧确实不再重复（省下的字节是真省了）；
  //   ② 语义**没有丢**，只是换了地方——instructions 里三个都得在。
  // 只钉 ① 会让「把语义整个删掉」也变绿，那才是真正的回退。
  it("does not repeat the pagination params per tool", async () => {
    const { props } = await paginatedProps("gangtise_drive_list", "vault.drive.list")
    const bytes = ["from", "size", "fetchAll"].reduce((a, k) => a + Buffer.byteLength(props[k].description ?? "", "utf8"), 0)
    expect(bytes, "分页三参的说明又被写回每个工具的 schema 了").toBe(0)
  })

  it("declares the pagination param semantics once, in server instructions", async () => {
    const server = createGangtiseMcpServer(makeMockClient(), { version: "0.0.0-test" })
    const instructions = (server as unknown as { server: { _instructions?: string } }).server._instructions ?? ""
    expect(instructions).toContain("from=0-based")
    expect(instructions).toContain("size=总行数上限")
    expect(instructions).toContain("fetchAll=true")
  })

  // 分页计费声明已上收到 instructions；描述里只剩逐工具不同的放大提示 + 标签，标签在最后。
  it("keeps only the per-tool amplification hint and the label on a paid paginated tool", async () => {
    const { description } = await paginatedProps("gangtise_opinion_list", "insight.opinion.list")
    expect(description).not.toContain("按全部实际返回条目计费")
    expect(description).toContain("单次约 600 积分")
    expect(description.endsWith("【积分：30/条】")).toBe(true)
  })

  it("leaves free paginated tools with a bare description", async () => {
    const { description } = await paginatedProps("gangtise_drive_list", "vault.drive.list")
    expect(description).toBe("x")
  })
})

describe("_local_hint on spill pointers", () => {
  it("attaches the JSON hint to a paginated spill", async () => {
    const content = await buildToolContent({ list: makeLargeItems(500), total: 500 })
    const result = JSON.parse(content[0].text)
    expect(result._local_hint).toContain("完整 JSON")
    await fs.rm(path.dirname(result._saved_to as string), { recursive: true, force: true })
  })

  it("attaches the JSON hint to a bare-array spill", async () => {
    const content = await buildToolContent(makeLargeItems(500))
    const result = JSON.parse(content[0].text)
    expect(result._local_hint).toContain("完整 JSON")
    await fs.rm(path.dirname(result._saved_to as string), { recursive: true, force: true })
  })

  it("attaches the text hint to a text spill", async () => {
    const content = await buildTextResult("段落内容。".repeat(60_000))
    const meta = JSON.parse(content[0].text)
    expect(meta._local_hint).toContain("完整正文")
    await fs.rm(path.dirname(meta._saved_to as string), { recursive: true, force: true })
  })

  // 注入点必须在字节预算收缩之前 —— metadata-only 回退把 list 丢掉后，
  // _local_hint 必须还在（回退用 ...metaOnly 展开，会保留提前注入的字段）。
  it("survives the metadata-only fallback when even one row blows the budget", async () => {
    const items = [{ id: "0", content: "中".repeat(30_000) }]
    const content = await buildToolContent({ list: items, total: 1 })
    const result = JSON.parse(content[0].text)
    expect(result._preview_count).toBe(0)
    expect(result._local_hint).toContain("完整 JSON")
    await fs.rm(path.dirname(result._saved_to as string), { recursive: true, force: true })
  })
})

describe("_available_fields on spill pointers", () => {
  it("samples the preview window and reports how many rows it scanned", async () => {
    const content = await buildToolContent({ list: makeLargeItems(500), total: 500 })
    const result = JSON.parse(content[0].text)
    expect(result._available_fields).toEqual(["id", "content"])
    expect(result._available_fields_sampled).toBe(20) // 数字，不是 boolean —— 读者要能和 _total_items 比
    expect(result._available_fields_truncated).toBeUndefined()
    await fs.rm(path.dirname(result._saved_to as string), { recursive: true, force: true })
  })

  // 成对契约：一行字段都没采到时也要两个字段都在，否则读者分不清
  // 「采了 20 行确实没字段」与「压根没采样」。
  it("still emits both fields when the sampled rows carry no keys at all", async () => {
    const content = await buildToolContent({ list: Array.from({ length: 400 }, () => ({})), total: 400, blob: "x".repeat(70_000) })
    const result = JSON.parse(content[0].text)
    expect(result._available_fields).toEqual([])
    expect(result._available_fields_sampled).toBe(20)
    await fs.rm(path.dirname(result._saved_to as string), { recursive: true, force: true })
  })

  it("caps the list at 50 names and flags the truncation", async () => {
    const wide = Array.from({ length: 300 }, () =>
      Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`f${k}`, "y".repeat(40)])),
    )
    const content = await buildToolContent({ list: wide, total: 300 })
    const result = JSON.parse(content[0].text)
    expect((result._available_fields as string[]).length).toBe(50)
    expect(result._available_fields_truncated).toBe(true)
    await fs.rm(path.dirname(result._saved_to as string), { recursive: true, force: true })
  })
})

// 🔴 溢出指针必须是**硬上限**，不是尽力而为。
// 收缩逻辑此前只动 `list`，而分页/分片层的诊断元数据是原样 `...rest` 展开的：一份 900 条
// `_failed_pages` 的响应，行削光了指针仍有 25 万字节。加了采样之后仍有两种形态超限
// （每条错误很长、以及超大的非数组元数据），当时只补了个 `_oversized: true` —— 那不叫
// 收敛：调用方的上下文已经被撑爆，标记来不及起作用。
describe("spill pointer is a HARD byte cap", () => {
  const wideRow = () => {
    const row: Record<string, number> = {}
    for (let i = 0; i < 50; i += 1) row[`字段名称非常长的一个列名_${i}`] = i
    return row
  }
  const cases: Array<[string, Record<string, unknown>]> = [
    ["900 条短诊断", { total: 45000, list: Array.from({ length: 3000 }, (_, i) => ({ id: i, name: "某某科技" })), _partial: true, _failed_pages: Array.from({ length: 900 }, (_, i) => ({ from: i, size: 50, error: "HTTP 503" })) }],
    ["900 条长诊断", { total: 45000, list: Array.from({ length: 3000 }, (_, i) => ({ id: i })), _partial: true, _failed_pages: Array.from({ length: 900 }, (_, i) => ({ from: i, size: 50, error: "x".repeat(300) })) }],
    ["超大非数组元数据", { total: 5, list: Array.from({ length: 3000 }, wideRow), _partial: true, _note_blob: "报错原文".repeat(20000) }],
    ["180 个坏分片", { total: 9, list: Array.from({ length: 3000 }, (_, i) => ({ i })), _partial: true, _malformed_shards: Array.from({ length: 180 }, (_, i) => ({ startDate: `2026-0${(i % 9) + 1}-01`, endDate: `2026-0${(i % 9) + 1}-02`, error: "y".repeat(400) })) }],
  ]

  // 每个用例都会落一份溢出文件——测试自己创建的临时资源要清掉，否则每跑一次留 10 个。
  const spilled = async (payload: Record<string, unknown>) => {
    const parsed = JSON.parse((await buildToolContent(payload))[0].text)
    return { parsed, cleanup: () => fs.rm(path.dirname(String(parsed._saved_to)), { recursive: true, force: true }) }
  }

  // 🔴 复核方两次在这里找到漏网形态：第一次是「只削 list」，第二次是「兜底层原样保留
  // POINTER_KEYS、返回前不再量一次」。两次我都写了「保证回到预算内」，两次都不成立。
  // **一个自己没验证过的保证就是假话**，所以这张表要覆盖到「指针字段自己就超长」那一档。
  const pathological: Array<[string, Record<string, unknown>]> = [
    ["超长 _partial_reason", { total: 5, list: Array.from({ length: 3000 }, (_, i) => ({ id: i })), _partial: true, _partial_reason: "failed_pages,".repeat(9000) }],
    ["超长字段名", (() => {
      const wide: Record<string, number> = {}
      for (let i = 0; i < 50; i += 1) wide[`超长字段名`.repeat(200) + i] = i
      return { total: 5, list: Array.from({ length: 3000 }, () => ({ ...wide })), _partial: true }
    })()],
  ]

  it.each(pathological)("%s still stays within the budget and stays readable back", async (_label, payload) => {
    const [content] = await buildToolContent(payload)
    const size = Buffer.byteLength(content.text, "utf8")
    expect(size, `指针 ${size} 字节，超过 ${INLINE_MAX_BYTES}`).toBeLessThanOrEqual(INLINE_MAX_BYTES)
    const parsed = JSON.parse(content.text)
    // 收缩到极限也必须留下能回读的指针，否则这份数据就永久取不回来了
    expect(typeof parsed._saved_to, "兜底层把 _saved_to 也丢了，数据取不回来").toBe("string")
    expect((parsed._saved_to as string).length).toBeGreaterThan(0)
    expect(parsed._read_with).toBe("gangtise_read_response")
    await fs.rm(path.dirname(String(parsed._saved_to)), { recursive: true, force: true })
  })

  it.each(cases)("%s stays within the inline budget", async (_label, payload) => {
    const [content] = await buildToolContent(payload)
    const size = Buffer.byteLength(content.text, "utf8")
    expect(size, `指针 ${size} 字节，超过 ${INLINE_MAX_BYTES}`).toBeLessThanOrEqual(INLINE_MAX_BYTES)
    await fs.rm(path.dirname(String(JSON.parse(content.text)._saved_to)), { recursive: true, force: true })
  })

  it.each(cases)("%s keeps the pointer usable and the partial flag intact", async (_label, payload) => {
    const { parsed, cleanup } = await spilled(payload)
    expect(parsed._truncated).toBe(true)
    expect(typeof parsed._saved_to).toBe("string")
    expect(parsed._read_with).toBe("gangtise_read_response")
    expect(parsed._partial, "收缩不能把 _partial 丢掉——那会让一份残缺数据读起来完整").toBe(true)
    await cleanup()
  })

  // 🔴 收缩只许动**白名单里的诊断字段**。按 `_` 前缀扫会顺手采样 `_available_fields`，
  // 并把 `_available_fields_sampled` 从**数字**（采样行数）覆盖成 `{shown,total}` 对象，
  // 破坏一个已有契约：读者靠 `_available_fields_sampled < _total_items` 判断字段清单是否完整。
  it("never rewrites _available_fields_sampled, which is a number by contract", async () => {
    const wide = Array.from({ length: 3000 }, wideRow)
    const { parsed, cleanup } = await spilled({ total: 5, list: wide, _partial: true, _note_blob: "报错原文".repeat(20000) })
    if (parsed._available_fields_sampled !== undefined) {
      expect(typeof parsed._available_fields_sampled, "_available_fields_sampled 被收缩逻辑改写成了对象").toBe("number")
    }
    await cleanup()
  })

  // 采样必须**如实标注**：只留几条而不说总数，读者会以为只失败了这几页。
  it("reports how many diagnostic entries were withheld", async () => {
    const { parsed, cleanup } = await spilled({
      total: 45000, list: Array.from({ length: 3000 }, (_, i) => ({ id: i })), _partial: true,
      _failed_pages: Array.from({ length: 900 }, (_, i) => ({ from: i, size: 50, error: "x".repeat(300) })),
    })
    expect(parsed._failed_pages_sampled).toMatchObject({ total: 900 })
    expect((parsed._failed_pages as unknown[]).length).toBeLessThan(900)
    await cleanup()
  })
})
