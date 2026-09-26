import http from "node:http"
import type { AddressInfo } from "node:net"

import { ENDPOINTS } from "../../src/core/endpoints.js"

/** 本机起一个假的 Gangtise OpenAPI：记录每个到达的 HTTP 请求，并按端点给出默认应答。
 *
 * 为什么是真 socket 而不是 mock `undici.request`：请求黄金用例要钉的是「客户端真正发出去
 * 的东西」——方法、路径、query、JSON body，经过真实的 client（鉴权头、gzip 协商、重试、
 * 分页扇出、分片）。mock 掉 `request` 会把这一层整个绕过。 */

export interface RecordedRequest {
  /** 由 path 反查的端点键；查不到时是 path 本身。只用于默认应答与报错定位，断言以 path 为准。 */
  endpoint: string
  method: string
  path: string
  query?: Record<string, string>
  body?: unknown
}

export interface UpstreamReply {
  status?: number
  headers?: Record<string, string>
  /** 业务数据：自动包成 `{code:"000000", msg:"ok", data}` 信封。 */
  data?: unknown
  /** 原样作为 JSON 响应体（不再包信封），用于构造错误信封 / 异形响应。 */
  json?: unknown
  /** 原样作为文本响应体（下载类）。 */
  text?: string
  /** 二进制响应体（下载类）。 */
  bytes?: Uint8Array
  /** 本次应答前的等待，用于性能基线与取消场景。 */
  delayMs?: number
  /** 不应答、直接断开连接（故障注入：连接被重置）。 */
  destroy?: true
}

/** 返回 undefined 表示走默认应答。`index` 是该请求在本次记录里的序号（从 0 起）。 */
export type Responder = (req: RecordedRequest, index: number) => UpstreamReply | undefined | Promise<UpstreamReply | undefined>

const PATH_TO_KEY = new Map<string, string>()
for (const def of Object.values(ENDPOINTS)) {
  if (!PATH_TO_KEY.has(def.path)) PATH_TO_KEY.set(def.path, def.key)
}

export function endpointKeyOf(path: string): string {
  return PATH_TO_KEY.get(path) ?? path
}

export function envelope(data: unknown): { code: string; msg: string; data: unknown } {
  return { code: "000000", msg: "ok", data }
}

/** EDE 内层信封。取数端点在它外面还有一层通用信封，由 `data` 字段自动补上。 */
export function edeInner(data: unknown): { code: string; status: boolean; data: unknown } {
  return { code: "000000", status: true, data }
}

const EMPTY_MATRIX = { securityCodeList: [], securityNameList: [], indicatorList: [], values: [] }

/** 各端点的默认应答：让每个工具都能以「零行 / 空内容」正常走完，不触发额外的探针请求。
 *  需要特定形状的用例在 responder 里覆盖。 */
export function defaultReply(req: RecordedRequest): UpstreamReply {
  const def = ENDPOINTS[req.endpoint]
  if (def?.kind === "download") return { text: "mock download body", headers: { "content-type": "text/plain; charset=utf-8" } }
  switch (req.endpoint) {
    case "indicator.search":
      return { data: edeInner([]) }
    case "indicator.cross-section":
    case "indicator.screener":
      return { data: edeInner(EMPTY_MATRIX) }
    case "indicator.time-series":
      return { data: edeInner({ ...EMPTY_MATRIX, dates: [] }) }
    case "ai.earnings-review.get-id":
    case "ai.viewpoint-debate.get-id":
      return { data: { dataId: "mock-data-id" } }
    case "ai.earnings-review.get-content":
    case "ai.viewpoint-debate.get-content":
    case "ai.one-pager":
    case "ai.investment-logic":
    case "ai.peer-comparison":
    case "ai.research-outline":
      return { data: { content: "mock content" } }
    case "alternative.edb-data":
      return { data: { fieldList: [], dataList: [] } }
    default:
      return { data: { total: 0, list: [] } }
  }
}

export interface MockUpstream {
  baseUrl: string
  /** 按到达顺序记录的全部请求。 */
  requests: RecordedRequest[]
  setResponder(responder: Responder | undefined): void
  /** 所有应答前统一附加的等待（毫秒）。 */
  setDelay(ms: number): void
  /** 同时在飞的请求数峰值（自上次 reset 起）。验证并发闸用。 */
  maxInFlight(): number
  reset(): void
  close(): Promise<void>
}

export async function startMockUpstream(responder?: Responder): Promise<MockUpstream> {
  const requests: RecordedRequest[] = []
  let current = responder
  let delayMs = 0
  let inFlight = 0
  let peak = 0

  const server = http.createServer((req, res) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    res.on("close", () => {
      inFlight -= 1
    })
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const raw = Buffer.concat(chunks).toString("utf8")
      const recorded: RecordedRequest = {
        endpoint: endpointKeyOf(url.pathname),
        method: req.method ?? "GET",
        path: url.pathname,
      }
      if ([...url.searchParams.keys()].length > 0) recorded.query = Object.fromEntries(url.searchParams)
      if (raw.length > 0) {
        try {
          recorded.body = JSON.parse(raw)
        } catch {
          recorded.body = raw
        }
      }
      const index = requests.length
      requests.push(recorded)

      let reply: UpstreamReply
      try {
        reply = (await current?.(recorded, index)) ?? defaultReply(recorded)
      } catch (err) {
        reply = { status: 500, json: { code: "999999", msg: `mock responder threw: ${String(err)}` } }
      }
      const wait = (reply.delayMs ?? 0) + delayMs
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      if (res.destroyed) return
      if (reply.destroy) {
        req.socket.destroy()
        return
      }

      const status = reply.status ?? 200
      if (reply.bytes !== undefined) {
        res.writeHead(status, { "content-type": "application/octet-stream", ...reply.headers })
        res.end(Buffer.from(reply.bytes))
      } else if (reply.text !== undefined) {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...reply.headers })
        res.end(reply.text)
      } else {
        const payload = reply.json !== undefined ? reply.json : envelope(reply.data)
        res.writeHead(status, { "content-type": "application/json", ...reply.headers })
        res.end(JSON.stringify(payload))
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setResponder(next) {
      current = next
    },
    setDelay(ms) {
      delayMs = ms
    },
    maxInFlight() {
      return peak
    },
    reset() {
      requests.length = 0
      current = responder
      delayMs = 0
      peak = inFlight
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
