import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerResponseTools } from "../../../src/tools/response.js"
import { buildToolContent } from "../../../src/tools/registry.js"
import { createManagedTempDir } from "../../../src/core/tempCleanup.js"
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

  it("reads a raw text (markdown) payload as character slices", async () => {
    const text = "天".repeat(250_000) // raw, non-JSON content
    const savedTo = await writeTmpText(text)
    const client = await makeConnectedPair()

    const result = await client.callTool({
      name: "gangtise_read_response",
      arguments: { saved_to: savedTo, offset: 0 },
    })

    expect(result.isError).toBeFalsy()
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
