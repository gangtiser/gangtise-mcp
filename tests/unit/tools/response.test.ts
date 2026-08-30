import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerResponseTools, TEXT_CHUNK_CHARS, pageNote, fitByBytes, spillReadCount, resetSpillReadCount } from "../../../src/tools/response.js"
import { buildToolContent } from "../../../src/tools/registry.js"
import { createManagedTempDir, resetOwnedTempDirs, MAX_OWNED_TEMP_DIRS } from "../../../src/core/tempCleanup.js"
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
  // alone can inline megabytes and defeat the 64KB truncation contract.
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
    // A >64KB object that normalizeRows didn't shape into { list } gets spilled with
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

    // 复刻修复**前**的信封估算（has_more:true + next_offset:total），反推出「旧代码
    // 恰好还能塞下第二行」的字节边界。_note 用源码导出的真 pageNote，不再逐字复刻 ——
    // 否则文案一改，本地副本与源码漂移，用例会误红或悄悄退化成普通分页测试。
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
          _note: pageNote(total),
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

  it("rejects fields consistently for a mixed array regardless of which page is requested", async () => {
    // Frozen contract §四E rule 2/3: a non-object anywhere makes the whole list
    // non-projectable — fields validity is a file-level property, not per-page.
    // A stray non-object at row 900 must reject even when page 0 would look clean,
    // so the answer can't flip with offset.
    const list: unknown[] = rows(1_000)
    list[900] = null
    const savedTo = await writeTmpJson({ list, total: 1_000 })
    for (const offset of [0, 895]) {
      const result = await call({ saved_to: savedTo, offset, limit: 10, fields: ["close"] })
      expect(result.isError, `offset ${offset} must reject`).toBe(true)
      expect((result.content as Array<{ text: string }>)[0].text).toContain("非对象元素")
    }
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
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


// 🔴 `TEXT_CHUNK_CHARS` 按「每个 UTF-16 单元最多 3 字节 UTF-8」推出来，漏了一档：
// `JSON.stringify` 把控制字符转义成 6 字符的 \uXXXX —— 是那个上界的两倍。默认 64KB
// 预算下，一段控制字符密集的正文能把单个分片序列化到 10 万字节以上，而 next_offset
// 仍按字符长度算，客户端按字节截断后续读就错位。
const ESCAPE_HEAVY = String.fromCharCode(1).repeat(TEXT_CHUNK_CHARS * 3)

describe("read_response chunk stays inside the byte budget for escape-heavy text", () => {
  it("shrinks a control-character-dense text chunk to fit", async () => {
    const savedTo = await writeTmpText(ESCAPE_HEAVY)
    const client = await makeConnectedPair()

    const result = await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo } })
    const rawText = (result.content as Array<{ text: string }>)[0].text
    expect(Buffer.byteLength(rawText, "utf8")).toBeLessThanOrEqual(INLINE_MAX_BYTES)

    const parsed = JSON.parse(rawText)
    // 收敛后 next_offset 必须与实际返回的字符数一致，否则续读错位
    expect(parsed._returned).toBe((parsed._text as string).length)
    expect(parsed.next_offset).toBe(parsed._offset + parsed._returned)
    expect(parsed._returned).toBeLessThan(TEXT_CHUNK_CHARS)

    // 续读能接上
    const tail = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo, offset: parsed.next_offset as number },
    })
    const tailText = (tail.content as Array<{ text: string }>)[0].text
    expect(JSON.parse(tailText)._offset).toBe(parsed.next_offset)
    expect(Buffer.byteLength(tailText, "utf8")).toBeLessThanOrEqual(INLINE_MAX_BYTES)

    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("shrinks an escape-heavy large-object chunk too", async () => {
    const savedTo = await writeTmpJson({ blob: ESCAPE_HEAVY })
    const client = await makeConnectedPair()
    const result = await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo } })
    const rawText = (result.content as Array<{ text: string }>)[0].text
    expect(Buffer.byteLength(rawText, "utf8")).toBeLessThanOrEqual(INLINE_MAX_BYTES)
    const parsed = JSON.parse(rawText)
    expect(parsed._returned).toBe((parsed._json_chunk as string).length)
    expect(parsed.next_offset).toBe(parsed._offset + parsed._returned)
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })
})

// 溢出指针里的 has_more 是调用方决定要不要回读的唯一依据。非列表大对象此前写
// `has_more: false`，与同一条里的 `_truncated: true` / `_read_with` 直接矛盾 ——
// 调用方就此停手，整份载荷丢在盘上。
describe("non-list spill pointer advertises that there IS more to read", () => {
  it("sets has_more true and next_offset 0 on a metadata-only pointer", async () => {
    const content = await buildToolContent({ report: "数".repeat(200_000), meta: { ok: true } })
    const pointer = JSON.parse(content[0].text)

    expect(pointer._truncated).toBe(true)
    expect(pointer._read_with).toBe("gangtise_read_response")
    expect(pointer.has_more).toBe(true)
    expect(pointer.next_offset).toBe(0)

    // 而且照着这个 next_offset 回读确实拿得到内容
    const client = await makeConnectedPair()
    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: pointer._saved_to as string, offset: pointer.next_offset as number },
    })
    expect(result.isError).toBeFalsy()
    expect(typeof JSON.parse((result.content as Array<{ text: string }>)[0].text)._json_chunk).toBe("string")

    await fs.rm(path.dirname(pointer._saved_to as string), { recursive: true, force: true })
  })
})

// 翻页每次都整份读盘 + 整份 JSON.parse，是 O(文件大小 × 页数)。加了单条解析缓存后，
// 正确性必须不变：同一文件连续翻页要拿到正确的分页，文件被改写后要重新解析。
describe("read_response parse cache preserves correctness", () => {
  it("returns correct pages across repeated reads of the same file", async () => {
    const savedTo = await writeTmpJson({ list: Array.from({ length: 300 }, (_, i) => ({ i })) })
    const client = await makeConnectedPair()

    const page = async (offset: number) =>
      parseText(await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo, offset, limit: 50 } }))

    const p0 = await page(0)
    const p1 = await page(50)
    const p0again = await page(0)

    expect((p0.list as Array<{ i: number }>)[0].i).toBe(0)
    expect((p1.list as Array<{ i: number }>)[0].i).toBe(50)
    expect(p0again).toEqual(p0)
    expect(p0.next_offset).toBe(50)

    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })

  it("re-parses after the file is rewritten instead of serving stale content", async () => {
    const savedTo = await writeTmpJson({ list: [{ v: "before" }] })
    const client = await makeConnectedPair()
    const read = async () => parseText(await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo } }))

    expect((await read()).list).toEqual([{ v: "before" }])
    // 改写并确保 mtime/size 变化
    await new Promise((r) => setTimeout(r, 10))
    await fs.writeFile(savedTo, JSON.stringify({ list: [{ v: "after-rewrite-longer" }] }), "utf8")
    expect((await read()).list).toEqual([{ v: "after-rewrite-longer" }])

    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })
})


// 🔴 折半收敛的**下界**：分片必须严格前进。`alignSliceEnd` 会把落在代理对中间的 end
// 往回拨一格；折到只剩一两个字符、而切点处正好是代理对前半时，它会把 end 拨回 start ——
// 分片为空、next_offset 原地不动，调用方在同一个 offset 上无限翻页。
//
// ⚠️ 这一组**必须直接驱动 fitByBytes**。第一版是通过工具喂特制正文写的，跑起来全绿，
// 但把下界钳制去掉之后**照样全绿**——64KB 预算下折半根本压不到下界，那组用例连一次
// 收敛都没触发。绿而无效比没有更糟。这里用一个恒定超预算的 build 回调把循环逼到底。
describe("fitByBytes always advances past `start`", () => {
  const alwaysTooBig = (text: string, start: number) => (end: number) => ({
    _text: text.slice(start, end),
    _returned: end - start,
    next_offset: end,
    _pad: "x".repeat(INLINE_MAX_BYTES * 2), // 恒定超预算 → 一路折到下界
  })

  it("returns a non-empty slice even when every candidate blows the budget", () => {
    for (const text of ["\u{1F600}".repeat(40), "abc".repeat(40), "\u{1F600}a\u{1F600}b"]) {
      for (const start of [0, 1, 2, 3]) {
        if (start >= text.length) continue
        const out = fitByBytes(text, start, 16, alwaysTooBig(text, start))
        expect(out._returned as number, `text=${JSON.stringify(text.slice(0, 6))} start=${start} 返回了空分片`).toBeGreaterThan(0)
        expect(out.next_offset as number, `start=${start} next_offset 没有前进`).toBeGreaterThan(start)
      }
    }
  })

  it("never splits a surrogate pair while advancing", () => {
    const text = "\u{1F600}".repeat(40)
    const out = fitByBytes(text, 0, 16, alwaysTooBig(text, 0))
    // 代理对是 2 个 UTF-16 单元：要么整对取走，要么不取
    expect((out._returned as number) % 2).toBe(0)
    expect(JSON.stringify(out._text)).not.toContain("\\ud83d\"")
  })

  it("stays within budget when a normal-sized chunk fits", () => {
    const text = "数".repeat(1000)
    const out = fitByBytes(text, 0, 100, (end) => ({ _text: text.slice(0, end), _returned: end, next_offset: end }))
    expect(out._returned).toBe(100)
  })
})



// 🔴 端到端：**回读本身**必须把溢出目录移到 LRU 的 MRU 端。
// tempCleanup 那边测的是 `touchOwnedTempDir` 这个函数；这里测的是 read_response 有没有
// 真的调它 —— 少了这一条，把 response.ts 里那行删掉，函数级测试照样全绿（实测）。
//
// ⚠️ 场景要排对：「先读一次、再产生 200 份新溢出」**并不能**让它活下来 —— LRU 下它照样
// 是最久未用的那个。真正区分 LRU 与 FIFO 的是：**它和另一份同期创建、但从没被读过的目录，
// 谁先被淘汰。** 第一版没排对，两种实现都绿。
describe("reading a spill keeps it alive against the in-session cap", () => {
  it("evicts a never-read sibling before the one that was paged", async () => {
    resetOwnedTempDirs()
    const savedTo = await writeTmpJson({ list: Array.from({ length: 300 }, (_, i) => ({ i })) })
    const neverRead = await createManagedTempDir()      // 同期创建、从不回读
    const client = await makeConnectedPair()

    // 回读第一页 —— 这一步应当把 savedTo 的目录移到 MRU 端
    const first = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo, offset: 0, limit: 50 },
    })
    expect(first.isError).toBeFalsy()

    // 补到刚好超出上限 1 个：只淘汰一份，才看得出淘汰的是哪一份
    // 🔴 收集起来，最后逐个删——不然每跑一次就在系统临时目录留下 199 个 gangtise-mcp-*
    const spills: string[] = []
    for (let i = 0; i < MAX_OWNED_TEMP_DIRS - 1; i += 1) spills.push(await createManagedTempDir())

    // 没被读过的那份先走
    await expect(fs.stat(neverRead)).rejects.toThrow()
    // 翻过页的那份还能续读
    const second = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo, offset: 50, limit: 50 },
    })
    expect(second.isError, `续读失败了：${(second.content as Array<{ text: string }>)[0]?.text}`).toBeFalsy()
    expect((parseText(second).list as Array<{ i: number }>)[0].i).toBe(50)

    for (const d of spills) await fs.rm(d, { recursive: true, force: true })
    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })
})

// 🔴 缓存必须断言 **I/O 次数**，不能只断言输出相同。
// 只验输出的话，把 cache-hit 那行删掉输出完全一致，全套测试照样绿（实测 45/45）——
// 一次重构就能把优化静默撤掉。JSON 与纯文本两条路都要覆盖：纯文本此前没进缓存，
// 而 CHANGELOG 却宣称「不再每页重读整个文件」，说法与实现对不上。
describe("spill reads are actually deduplicated (I/O, not just output)", () => {
  it.each([
    ["JSON", async () => writeTmpJson({ list: Array.from({ length: 300 }, (_, i) => ({ i })) })],
    ["纯文本", async () => writeTmpText("上下文".repeat(60_000))],
  ])("%s: paging the same file reads it from disk exactly once", async (_label, make) => {
    const savedTo = await make()
    const client = await makeConnectedPair()
    resetSpillReadCount()

    await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo, offset: 0 } })
    const afterFirst = spillReadCount
    await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo, offset: 1 } })
    await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: savedTo, offset: 2 } })

    expect(afterFirst, "第一次读必须真的读盘").toBe(1)
    expect(spillReadCount, "同一个文件的后续页不应再读盘").toBe(1)

    await fs.rm(path.dirname(savedTo), { recursive: true, force: true })
  })
})

// 🔴 回读页会带上源响应的顶层元数据。诊断数组（每失败一页一条）多时，光元数据就能把
// 单页顶过字节预算 —— 而这些键没有分页语义，直接截断是静默丢数据。所以走采样：留下
// `_..._sampled: {shown, total}` 让读者看得出清单不全，完整版在溢出文件里。
describe("回读页对诊断元数据采样而不是静默截断", () => {
  it("samples _failed_pages on every page and says how many were dropped", async () => {
    const dir = await createManagedTempDir()
    try {
      const saved = path.join(dir, "response.json")
      await fs.writeFile(saved, JSON.stringify({
        list: Array.from({ length: 40 }, (_, i) => ({ id: i, v: "x".repeat(200) })),
        _partial: true,
        _failed_pages: Array.from({ length: 900 }, (_, i) => ({ from: i * 50, size: 50, reason: "y".repeat(120) })),
      }))

      const client = await makeConnectedPair()
      const result = await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: saved, limit: 5 } })
      const page = JSON.parse((result.content as { text: string }[])[0].text)

      expect(Buffer.byteLength(JSON.stringify(page), "utf8"), "回读页超出字节预算").toBeLessThanOrEqual(65536)
      expect(page._failed_pages.length, "诊断数组没有被采样").toBeLessThan(900)
      expect(page._failed_pages_sampled, "采样了却没标注，读者看不出清单不全").toMatchObject({ total: 900 })
      expect(page._partial, "采样不该动其他元数据").toBe(true)
      expect(page._saved_to).toBe(saved)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

// 🔴 采样与预算必须同源。两条各自会错的边：
describe("回读页：采样与行预算用同一份 rest", () => {
  it("fills the requested rows instead of budgeting against a rest it never sends", async () => {
    const dir = await createManagedTempDir()
    try {
      const saved = path.join(dir, "response.json")
      await fs.writeFile(saved, JSON.stringify({
        list: Array.from({ length: 40 }, (_, i) => ({ id: i, v: "x".repeat(200) })),
        _failed_pages: Array.from({ length: 900 }, (_, i) => ({ from: i * 50, size: 50, reason: "y".repeat(120) })),
      }))
      const client = await makeConnectedPair()
      const result = await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: saved, limit: 5 } })
      const page = JSON.parse((result.content as { text: string }[])[0].text)

      // 拿未采样的胖 rest 算预算时，这里只装得下 1 行 —— 而实到载荷才 1.4KB。
      expect(page._returned, "行预算被一份根本不会发出去的 rest 吃掉了").toBe(5)
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(65536)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("samples when rest alone fits but rest + envelope does not", async () => {
    const dir = await createManagedTempDir()
    try {
      const saved = path.join(dir, "response.json")
      // 让 _failed_pages 把 rest 顶到「自己没超、加上信封就超」那条缝里。
      const entry = (i: number) => ({ from: i, reason: "z".repeat(60) })
      let n = 1
      while (Buffer.byteLength(JSON.stringify({ _failed_pages: Array.from({ length: n }, (_, i) => entry(i)) }), "utf8") < 65000) n += 1
      await fs.writeFile(saved, JSON.stringify({
        list: [{ id: 1 }],
        _failed_pages: Array.from({ length: n }, (_, i) => entry(i)),
      }))
      const client = await makeConnectedPair()
      const result = await client.callTool({ name: "gangtise_read_response", arguments: { saved_to: saved, limit: 1 } })
      const page = JSON.parse((result.content as { text: string }[])[0].text)

      expect(page._failed_pages_sampled, "rest 自己没超就不采样，于是只落一个 _oversized").toBeDefined()
      expect(page._failed_pages_sampled.total).toBe(n)
      expect(page._oversized, "采样生效后不该还标 _oversized").toBeUndefined()
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(65536)
      expect(page._returned).toBe(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
