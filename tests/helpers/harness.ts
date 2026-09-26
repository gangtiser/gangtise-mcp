import os from "node:os"
import path from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { GangtiseClient } from "../../src/core/client.js"
import { DEFAULT_ASYNC_TIMEOUT_MS } from "../../src/core/config.js"
import { createGangtiseMcpServer } from "../../src/server.js"
import { startMockUpstream, type MockUpstream, type RecordedRequest, type Responder } from "./mockUpstream.js"

/** 一整条真实调用链：MCP Client ⇄ InMemoryTransport ⇄ McpServer（含 strict 校验与 schema
 *  出站钩子）→ 真实 GangtiseClient → 本机 HTTP 桩。只有服务端是假的。 */
export interface Harness {
  mcp: Client
  upstream: MockUpstream
  /** tools/list 的**原始出站**结果（server 的 normalizePublishedSchemas 处理之后、client 解析之前）。 */
  rawToolsList(): Promise<unknown[]>
  instructions(): string | undefined
  call(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CallOutcome>
  close(): Promise<void>
}

export interface CallOutcome {
  isError: boolean
  text: string
  /** 本次调用期间发到服务端的请求。 */
  requests: RecordedRequest[]
}

export interface HarnessOptions {
  responder?: Responder
  asyncTimeoutMs?: number
  /** 单个 HTTP 请求超时。 */
  timeoutMs?: number
  maxDownloadBytes?: number
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const upstream = await startMockUpstream(options.responder)
  const client = new GangtiseClient({
    baseUrl: upstream.baseUrl,
    timeoutMs: options.timeoutMs ?? 10_000,
    token: "test-token",
    // token 已给定，client 不会读这个路径；指向一个不存在的文件以防万一。
    tokenCachePath: path.join(os.tmpdir(), `gangtise-mcp-harness-${process.pid}-nonexistent.json`),
    asyncTimeoutMs: options.asyncTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS,
    maxDownloadBytes: options.maxDownloadBytes ?? 64 * 1024 * 1024,
  })
  const server = createGangtiseMcpServer(client, { asyncTimeoutMs: options.asyncTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "contract-harness", version: "0.0.0" })
  await mcp.connect(clientTransport)

  // 在 client 解析之前抓下原始消息：tools/list 的字节预算与快照都以线上实际发出的为准。
  const rawResults = new Map<string | number, string>()
  const onmessage = clientTransport.onmessage
  clientTransport.onmessage = (message, extra) => {
    const msg = message as { id?: string | number; result?: unknown }
    if (msg.id !== undefined && msg.result !== undefined) rawResults.set(msg.id, JSON.stringify(msg.result))
    onmessage?.(message, extra)
  }

  return {
    mcp,
    upstream,
    async rawToolsList() {
      const before = new Set(rawResults.keys())
      await mcp.listTools()
      const id = [...rawResults.keys()].find((key) => !before.has(key))
      if (id === undefined) throw new Error("未抓到 tools/list 的原始响应")
      return (JSON.parse(rawResults.get(id)!) as { tools: unknown[] }).tools
    },
    instructions() {
      return mcp.getInstructions()
    },
    async call(name, args, callOptions) {
      const start = upstream.requests.length
      try {
        const result = await mcp.callTool({ name, arguments: args }, undefined, {
          signal: callOptions?.signal,
          timeout: callOptions?.timeoutMs ?? 60_000,
        })
        const content = (result.content ?? []) as Array<{ type: string; text?: string }>
        return {
          isError: result.isError === true,
          text: content.map((c) => c.text ?? "").join("\n"),
          requests: upstream.requests.slice(start),
        }
      } catch (err) {
        // 协议层错误（-32602 等）与工具层 isError 同样算「被拒」。
        return { isError: true, text: err instanceof Error ? err.message : String(err), requests: upstream.requests.slice(start) }
      }
    },
    async close() {
      await mcp.close()
      await server.close()
      await upstream.close()
    },
  }
}
