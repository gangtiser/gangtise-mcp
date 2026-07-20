import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerResponseTools, TEXT_CHUNK_CHARS } from "../../../src/tools/response.js"
import { buildToolContent } from "../../../src/tools/registry.js"
import { createManagedTempDir } from "../../../src/core/tempCleanup.js"
import { INLINE_MAX_BYTES } from "../../../src/core/config.js"
import type { GangtiseClient } from "../../../src/core/client.js"

const mockClient = { call: async () => ({}), download: async () => ({}) } as unknown as GangtiseClient

async function makeConnectedPair() {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerResponseTools(server, mockClient)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

async function writeTmpJson(payload: unknown): Promise<string> {
  const dir = await createManagedTempDir()
  const file = path.join(dir, "response.json")
  await fs.writeFile(file, JSON.stringify(payload), "utf8")
  return file
}

async function writeTmpText(text: string): Promise<string> {
  const dir = await createManagedTempDir()
  const file = path.join(dir, "response.md")
  await fs.writeFile(file, text, "utf8")
  return file
}

function parseText(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)
}

describe("gangtise_read_response ownership guard", () => {
  // The 0.1.28 fix replaced prefix matching with a per-process allowlist
  // (ownedTempDirs). The only case that distinguishes the two is a
  // gangtise-mcp-* dir created by ANOTHER process — pin it so a "simpler"
  // prefix check can't silently regress the security property.
  it("rejects a gangtise-mcp-prefixed temp dir created outside this process", async () => {
    const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), "gangtise-mcp-"))
    const file = path.join(foreignDir, "response.json")
    await fs.writeFile(file, JSON.stringify({ list: [1] }), "utf8")
    const client = await makeConnectedPair()

    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: file },
    })

    expect(result.isError).toBe(true)
    await fs.rm(foreignDir, { recursive: true, force: true })
  })
})

describe("gangtise_read_response byte budget & boundaries", () => {
  // Rows can be tens of KB each (announcement full text): an item-count window
  // alone can inline megabytes and defeat the 256KB truncation contract.
  it("caps a list page by byte budget instead of inlining megabytes", async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: String(i), content: "内容".repeat(400) }))
    const savedTo = await writeTmpJson({ list: items, total: 500 })
    const client = await makeConnectedPair()

    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo, offset: 0, limit: 500 },
    })

    expect(result.isError).toBeFalsy()
    const parsed = parseText(result)
    const returned = parsed._returned as number
    expect(returned).toBeGreaterThan(0)
    expect(returned).toBeLessThan(500)
    expect(parsed.has_more).toBe(true)
    expect(parsed.next_offset).toBe(returned)
    expect(Buffer.byteLength(JSON.stringify(parsed.list), "utf8")).toBeLessThanOrEqual(INLINE_MAX_BYTES + 10_000)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("does not split a surrogate pair at the text chunk boundary", async () => {
    // Emoji straddles the chunk boundary: its high surrogate sits at
    // TEXT_CHUNK_CHARS-1, so the slice must trim to TEXT_CHUNK_CHARS-1 rather
    // than emit a lone surrogate.
    const savedTo = await writeTmpText("x".repeat(TEXT_CHUNK_CHARS - 1) + "😀" + "yy")
    const client = await makeConnectedPair()

    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo },
    })

    const parsed = parseText(result)
    const chunk = parsed._text as string
    const lastCode = chunk.charCodeAt(chunk.length - 1)
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true)
    expect(parsed.next_offset).toBe(TEXT_CHUNK_CHARS - 1)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  // A second server instance's 24h startup sweep must not reclaim a spill dir
  // that a long-lived session is still actively reading.
  it("refreshes the spill dir mtime on read", async () => {
    const savedTo = await writeTmpJson({ list: [{ id: 1 }], total: 1 })
    const dir = path.dirname(savedTo)
    const old = new Date(Date.now() - 48 * 3600 * 1000)
    await fs.utimes(dir, old, old)
    const client = await makeConnectedPair()

    await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo } })

    const stat = await fs.stat(dir)
    expect(Date.now() - stat.mtimeMs).toBeLessThan(60_000)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe("gangtise_read_response", () => {
  it("reads a slice of a paginated { list, ...rest } payload", async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: String(i), v: i }))
    const savedTo = await writeTmpJson({ list: items, total: 500, extra: "meta" })
    const client = await makeConnectedPair()

    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo, offset: 100, limit: 50 },
    })

    expect(result.isError).toBeFalsy()
    const parsed = parseText(result)
    expect(parsed._total_items).toBe(500)
    expect(parsed._offset).toBe(100)
    expect(parsed._returned).toBe(50)
    expect(parsed.has_more).toBe(true)
    expect(parsed.next_offset).toBe(150)
    expect((parsed.list as Array<{ id: string }>)[0]).toEqual({ id: "100", v: 100 })
    expect((parsed.list as unknown[]).length).toBe(50)
    expect(parsed.total).toBe(500)
    expect(parsed.extra).toBe("meta")

    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("reads a top-level array payload", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i)
    const savedTo = await writeTmpJson(items)
    const client = await makeConnectedPair()

    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo, offset: 0, limit: 10 },
    })
    const parsed = parseText(result)
    expect(parsed._total_items).toBe(100)
    expect(parsed._returned).toBe(10)
    expect(parsed.next_offset).toBe(10)
    expect(parsed.list).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("signals end of data when slice reaches total", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: String(i) }))
    const savedTo = await writeTmpJson({ list: items, total: 30 })
    const client = await makeConnectedPair()

    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo, offset: 20, limit: 50 },
    })
    const parsed = parseText(result)
    expect(parsed._returned).toBe(10)
    expect(parsed.has_more).toBe(false)
    expect(parsed.next_offset).toBeNull()

    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("returns the whole payload for non-list shapes", async () => {
    const savedTo = await writeTmpJson({ scalar: 42, nested: { ok: true } })
    const client = await makeConnectedPair()
    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo },
    })
    const parsed = parseText(result)
    expect(parsed._total_items).toBeNull()
    expect(parsed.has_more).toBe(false)
    expect((parsed.data as Record<string, unknown>).scalar).toBe(42)

    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("returns a mid-size non-list object whole (over the char window, under the byte budget)", async () => {
    // More chars than the per-chunk window but under the byte budget, so the byte-based
    // decision returns it whole rather than needlessly char-slicing it.
    const blobLen = Math.floor((TEXT_CHUNK_CHARS + INLINE_MAX_BYTES) / 2)
    const savedTo = await writeTmpJson({ blob: "a".repeat(blobLen) })
    const client = await makeConnectedPair()
    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo },
    })
    expect(result.isError).toBeFalsy()
    const parsed = parseText(result)
    expect((parsed.data as Record<string, unknown>).blob).toBe("a".repeat(blobLen))
    expect(parsed._json_chunk).toBeUndefined()

    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("chunks a large non-list object instead of inlining the whole blob", async () => {
    // A >256KB object that normalizeRows didn't shape into { list } gets spilled with
    // a metadata-only preview; read-back must not dump the whole thing back into context.
    const savedTo = await writeTmpJson({ report: "数".repeat(200_000), meta: { ok: true } })
    const client = await makeConnectedPair()

    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo, offset: 0 },
    })

    expect(result.isError).toBeFalsy()
    const rawText = (result.content as Array<{ text: string }>)[0].text
    // The point of chunking: the read-back response must stay within the inline byte
    // budget. 100K Chinese chars would serialize to ~300KB and blow it.
    expect(Buffer.byteLength(rawText, "utf8")).toBeLessThanOrEqual(INLINE_MAX_BYTES)
    const parsed = JSON.parse(rawText)
    expect(typeof parsed._json_chunk).toBe("string")
    expect(parsed.has_more).toBe(true)
    expect(typeof parsed.next_offset).toBe("number")
    expect(parsed.data).toBeUndefined() // not inlined whole

    // continuation reads further into the JSON
    const tail = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo, offset: parsed.next_offset as number },
    })
    expect((parseText(tail)._json_chunk as string).length).toBeGreaterThan(0)

    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("reads a raw text (markdown) payload as character slices", async () => {
    const text = "天".repeat(250_000) // raw, non-JSON content
    const savedTo = await writeTmpText(text)
    const client = await makeConnectedPair()

    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo, offset: 0 },
    })

    expect(result.isError).toBeFalsy()
    expect(Buffer.byteLength((result.content as Array<{ text: string }>)[0].text, "utf8")).toBeLessThanOrEqual(INLINE_MAX_BYTES)
    const parsed = parseText(result)
    expect(parsed._total_chars).toBe(250_000)
    expect(parsed._offset).toBe(0)
    expect(typeof parsed._text).toBe("string")
    expect((parsed._text as string).length).toBeGreaterThan(0)
    expect(parsed.has_more).toBe(true)
    expect(typeof parsed.next_offset).toBe("number")

    // continuation reads the tail
    const tail = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo, offset: parsed.next_offset as number },
    })
    const tailParsed = parseText(tail)
    expect((tailParsed._text as string).length).toBeGreaterThan(0)

    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("rejects paths outside the system tmpdir", async () => {
    const client = await makeConnectedPair()
    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: "/etc/passwd" },
    })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/server process|gangtise-mcp-/)
  })

  it("rejects tmpdir paths whose parent does not match the gangtise-mcp- prefix", async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "other-prefix-"))
    const file = path.join(otherDir, "response.json")
    await fs.writeFile(file, JSON.stringify({ list: [] }), "utf8")

    const client = await makeConnectedPair()
    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: file },
    })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("gangtise-mcp-")

    await fs.rm(otherDir, { recursive: true, force: true })
  })

  it("round-trips with buildToolContent output", async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: String(i), content: "a".repeat(600) }))
    const data = { list: items, total: 500 }
    const content = await buildToolContent(data)
    const truncated = JSON.parse(content[0].text) as Record<string, unknown>
    expect(truncated._truncated).toBe(true)
    expect(truncated._read_with).toBe("gangtise_read_response")

    const client = await makeConnectedPair()
    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: truncated._saved_to as string, offset: 0, limit: 5 },
    })
    const parsed = parseText(result)
    expect(parsed._total_items).toBe(500)
    expect(parsed._returned).toBe(5)
    expect((parsed.list as Array<{ id: string }>)[0].id).toBe("0")

    await fs.rm(path.dirname(truncated._saved_to as string), { recursive: true, force: true })
  })
})

describe("gangtise_read_response byte contracts", () => {
  // 造一行恰好 targetBytes 的 ASCII 行
  function rowOfBytes(id: string, targetBytes: number) {
    const overhead = Buffer.byteLength(JSON.stringify({ id, c: "" }), "utf8")
    return { id, c: "a".repeat(targetBytes - overhead) }
  }

  // (a) 完整 payload（含信封）必须 ≤ 预算，不只是行字节 ≤ 预算
  it("(a) keeps the whole serialized payload within the budget, envelope included", async () => {
    const items = Array.from({ length: 40 }, (_, i) => rowOfBytes(String(i), 4_000))
    const savedTo = await writeTmpJson({ list: items, total: 40, extra: "x".repeat(2_000) })
    const client = await makeConnectedPair()
    const result = await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo, limit: 500 } })

    const raw = (result.content as Array<{ text: string }>)[0].text
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(INLINE_MAX_BYTES)
    expect(JSON.parse(raw)._oversized).toBeUndefined()
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  // (b)① 只有这一行 —— 行本身就远超预算
  it("(b) returns exactly one row and ends paging when the sole row overflows", async () => {
    const savedTo = await writeTmpJson({ list: [rowOfBytes("0", INLINE_MAX_BYTES + 5_000)], total: 1 })
    const client = await makeConnectedPair()
    const parsed = parseText(await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo } }))

    expect(parsed._returned).toBe(1)
    expect(parsed.has_more).toBe(false)
    expect(parsed.next_offset).toBeNull()
    expect(parsed._oversized).toBe(true)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  // (b)② 后面还有行 —— next_offset 必须前进，翻页不能卡死
  it("(b) still advances next_offset when an oversized row is not the last one", async () => {
    const savedTo = await writeTmpJson({ list: [rowOfBytes("0", INLINE_MAX_BYTES + 5_000), { id: "1" }], total: 2 })
    const client = await makeConnectedPair()
    const parsed = parseText(await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo } }))

    expect(parsed._returned).toBe(1)
    expect(parsed.has_more).toBe(true)
    expect(parsed.next_offset).toBe(1)
    expect(parsed._oversized).toBe(true)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  // (b)③ 关键一态：行本身**不超限**，是信封把它推过线。
  // 按「单行超限」判据写的实现会整个漏掉这一态 —— 实测 65,509B 行 → 65,779B payload。
  it("(b) catches the row-fits-but-envelope-overflows state", async () => {
    const row = rowOfBytes("0", 65_509)
    expect(Buffer.byteLength(JSON.stringify(row), "utf8")).toBeLessThanOrEqual(INLINE_MAX_BYTES) // 行没超
    const savedTo = await writeTmpJson({ list: [row], total: 1 })
    const client = await makeConnectedPair()
    const result = await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo } })
    const parsed = parseText(result)

    // 但拼上信封的完整 payload 超了 —— 必须被标出来
    expect(Buffer.byteLength((result.content as Array<{ text: string }>)[0].text, "utf8")).toBeGreaterThan(INLINE_MAX_BYTES)
    expect(parsed._returned).toBe(1)
    expect(parsed._oversized).toBe(true)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  // (c) 零行、rest 自己超限 —— 原样返回，绝不截断 rest
  it("(c) returns an oversized non-list sibling whole rather than silently truncating it", async () => {
    const savedTo = await writeTmpJson({ list: [], total: 0, summary: "数".repeat(23_000) })
    const client = await makeConnectedPair()
    const parsed = parseText(await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo } }))

    expect(parsed._returned).toBe(0)
    expect((parsed.summary as string).length).toBe(23_000)
    expect(parsed._oversized).toBe(true)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })
})
