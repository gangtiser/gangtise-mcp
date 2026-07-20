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

  // (d) 信封估算的 has_more/next_offset 必须按「真实两态（末页 vs 非末页）中更宽的
  // 一种」估，不能用 has_more:true(4B) + next_offset:total 顶替 —— 否则末页时预算
  // 多算 5-digitWidth(total) 字节，多放一行进页面。用未修复前的公式反推出「恰好卡
  // 在旧预算边界」的第二行：total=2（位宽 1，差值拉满 4B），旧预算下两行都收（判定
  // 为末页），新预算比旧预算少 4B，必须把第二行推到下一页。
  it("(d) reserves the wider has_more/next_offset form so the last page can't admit an extra row", async () => {
    const dir = await createManagedTempDir()
    const file = path.join(dir, "response.json")

    // 逐字复刻源码 pageNote 的文案 —— 它的字节数直接决定本用例的边界
    function pageNoteLocal(returned: number): string {
      return `本页按 ${Math.round(INLINE_MAX_BYTES / 1024)}KB 字节预算返回 ${returned} 条（少于请求的 limit），用 next_offset 继续翻页`
    }
    // 复刻修复前的信封估算（has_more:true + next_offset:total），反推出「旧代码
    // 恰好还能塞下第二行」的字节边界
    function oldEnvelopeBytes(total: number): number {
      return Buffer.byteLength(
        JSON.stringify({
          list: [],
          _saved_to: file,
          _total_items: total,
          _offset: 0,
          _returned: total,
          has_more: true,
          next_offset: total,
          _note: pageNoteLocal(total),
        }),
        "utf8",
      )
    }

    const total = 2
    const rowBudgetOld = INLINE_MAX_BYTES - oldEnvelopeBytes(total)

    const row0 = { id: "0" }
    const row0Bytes = Buffer.byteLength(JSON.stringify(row0), "utf8")
    // 两行拼起来恰好等于旧预算上限（+1 是 row1 前面的数组分隔逗号）
    const row1 = rowOfBytes("1", rowBudgetOld - row0Bytes - 1)

    await fs.writeFile(file, JSON.stringify([row0, row1]), "utf8")
    const client = await makeConnectedPair()
    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: file, offset: 0 },
    })
    const parsed = parseText(result)

    // 修复后的预算比旧预算少 4B：第二行必须被拒收，推到下一页
    expect(parsed._returned).toBe(1)
    expect(parsed.has_more).toBe(true)
    expect(parsed.next_offset).toBe(1)
    expect(parsed._oversized).toBeUndefined()

    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe("gangtise_read_response fields projection", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ securityCode: `${i}.SH`, close: i, volume: i * 10, extra: "x".repeat(200) }))

  async function call(args: Record<string, unknown>) {
    const client = await makeConnectedPair()
    return client.callTool({ name: "gangtise_read_response", arguments: args })
  }

  it("projects the requested top-level fields and echoes _fields", async () => {
    const savedTo = await writeTmpJson({ list: rows(10), total: 10 })
    const parsed = parseText(await call({ saved_to: savedTo, fields: ["securityCode", "close"] }))
    expect(parsed._fields).toEqual(["securityCode", "close"])
    expect((parsed.list as Array<Record<string, unknown>>)[0]).toEqual({ securityCode: "0.SH", close: 0 })
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("works on a bare top-level array too", async () => {
    const savedTo = await writeTmpJson(rows(10))
    const parsed = parseText(await call({ saved_to: savedTo, fields: ["close"] }))
    expect((parsed.list as Array<Record<string, unknown>>)[0]).toEqual({ close: 0 })
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("fits more rows per page because projection precedes the byte budget", async () => {
    const savedTo = await writeTmpJson({ list: rows(2_000), total: 2_000 })
    const wide = parseText(await call({ saved_to: savedTo, limit: 500 }))
    const narrow = parseText(await call({ saved_to: savedTo, limit: 500, fields: ["close"] }))
    expect(narrow._returned as number).toBeGreaterThan(wide._returned as number)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("keeps _offset / next_offset on original row indices", async () => {
    const savedTo = await writeTmpJson({ list: rows(100), total: 100 })
    const parsed = parseText(await call({ saved_to: savedTo, offset: 30, limit: 10, fields: ["close"] }))
    expect(parsed._offset).toBe(30)
    expect(parsed.next_offset).toBe(40)
    expect((parsed.list as Array<{ close: number }>)[0].close).toBe(30)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("reports a partly-misspelled field set without silently dropping it", async () => {
    const savedTo = await writeTmpJson({ list: rows(10), total: 10 })
    const result = await call({ saved_to: savedTo, fields: ["securityCode", "clsoe"] })
    expect(result.isError).toBeFalsy()
    const parsed = parseText(result)
    expect(parsed._unknown_fields).toEqual(["clsoe"])
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("errors when every requested field is unknown, echoing the available ones", async () => {
    const savedTo = await writeTmpJson({ list: rows(10), total: 10 })
    const result = await call({ saved_to: savedTo, fields: ["nope", "alsoNope"] })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("securityCode")
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  // 未知字段判定必须扫全量，不能只看前 20 行的采样窗口
  it("does not mistake a field that first appears on row 21 for a typo", async () => {
    const list: Array<Record<string, unknown>> = rows(30)
    for (let i = 0; i < 30; i += 1) delete list[i].close
    list[20].close = 42
    const savedTo = await writeTmpJson({ list, total: 30 })
    const result = await call({ saved_to: savedTo, fields: ["close"] })
    expect(result.isError).toBeFalsy()
    const parsed = parseText(result)
    expect(parsed._unknown_fields).toBeUndefined()
    expect((parsed.list as Array<Record<string, unknown>>)[20]).toEqual({ close: 42 })
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("keeps every row when a field exists on only some of them", async () => {
    const list = [{ a: 1, b: 2 }, { a: 3 }, { a: 4, b: 5 }]
    const savedTo = await writeTmpJson({ list, total: 3 })
    const parsed = parseText(await call({ saved_to: savedTo, fields: ["b"] }))
    expect(parsed._returned).toBe(3)
    expect(parsed.list).toEqual([{ b: 2 }, {}, { b: 5 }])
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("returns an empty list without judging field validity", async () => {
    const savedTo = await writeTmpJson({ list: [], total: 0 })
    const result = await call({ saved_to: savedTo, fields: ["whatever"] })
    expect(result.isError).toBeFalsy()
    expect(parseText(result)._unknown_fields).toBeUndefined()
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("rejects fields on a raw-text payload instead of silently ignoring it", async () => {
    const savedTo = await writeTmpText("天".repeat(250_000))
    const result = await call({ saved_to: savedTo, fields: ["a"] })
    expect(result.isError).toBe(true)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("rejects fields on a small non-list object", async () => {
    const savedTo = await writeTmpJson({ scalar: 42 })
    const result = await call({ saved_to: savedTo, fields: ["scalar"] })
    expect(result.isError).toBe(true)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("rejects fields on a large char-sliced non-list object", async () => {
    const savedTo = await writeTmpJson({ report: "数".repeat(200_000) })
    const result = await call({ saved_to: savedTo, fields: ["report"] })
    expect(result.isError).toBe(true)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("rejects fields on a primitive array and on a mixed array", async () => {
    const prim = await writeTmpJson([1, 2, 3])
    expect((await call({ saved_to: prim, fields: ["a"] })).isError).toBe(true)
    const mixed = await writeTmpJson([{ a: 1 }, 2])
    expect((await call({ saved_to: mixed, fields: ["a"] })).isError).toBe(true)
    await fs.rm(path.dirname(prim), { recursive: true, force: true })
    await fs.rm(path.dirname(mixed), { recursive: true, force: true })
  })

  it("rejects duplicate, blank, over-long and over-count field lists at the schema boundary", async () => {
    const savedTo = await writeTmpJson({ list: rows(3), total: 3 })
    expect((await call({ saved_to: savedTo, fields: ["a", "a"] })).isError).toBe(true)
    expect((await call({ saved_to: savedTo, fields: ["   "] })).isError).toBe(true)
    expect((await call({ saved_to: savedTo, fields: ["x".repeat(65)] })).isError).toBe(true)
    expect((await call({ saved_to: savedTo, fields: Array.from({ length: 51 }, (_, i) => `f${i}`) })).isError).toBe(true)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("never lets a __proto__ key leak through the projection", async () => {
    // 经 JSON.parse 构造，才是真的 own property "__proto__"（对象字面量会改写原型，测不出问题）
    const savedTo = await writeTmpJson(JSON.parse('[{"__proto__":{"polluted":true},"a":1}]'))
    // __proto__ 必须真的出现在 fields 里 —— 否则 projectRow 里那条被保护的赋值行永远不会执行，
    // 测不出 Object.create(null) 和 {} 的区别（此前的版本只传了 fields:["a"]，是个假阳性）
    const parsed = parseText(await call({ saved_to: savedTo, fields: ["__proto__", "a"] }))
    const row0 = (parsed.list as Array<Record<string, unknown>>)[0]

    // 没有污染全局原型
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // __proto__ 作为普通数据字段完整地经 JSON 往返存活下来，而不是被内置 setter 吞成原型槽
    expect(Object.keys(row0).sort()).toEqual(["__proto__", "a"])
    expect(row0["__proto__"]).toEqual({ polluted: true })
    expect(row0.a).toBe(1)

    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("leaves data content, row order and offset semantics untouched when fields is omitted", async () => {
    const list = rows(50)
    const savedTo = await writeTmpJson({ list, total: 50 })
    const parsed = parseText(await call({ saved_to: savedTo, offset: 10, limit: 5 }))
    expect(parsed.list).toEqual(list.slice(10, 15))
    expect(parsed._offset).toBe(10)
    expect(parsed.next_offset).toBe(15)
    expect(parsed._fields).toBeUndefined()
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })
})
