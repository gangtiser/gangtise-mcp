import http from "node:http"
import net, { type AddressInfo } from "node:net"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { EndpointDefinition } from "../../../src/core/endpoints.js"

// 真客户端 → 本机只做隧道（CONNECT）的正向代理 → 本机接口桩。连接池在 transport.ts 里按模块缓存、建池时读
// GANGTISE_PROXY，所以每条用例先设环境变量、再 resetModules 后重新导入。

// GANGTISE_TIMEOUT_MS 一并保存：代理应答隧道的时限取它与 10 秒中较小的那个。
const PROXY_VARS = ["GANGTISE_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "GANGTISE_TIMEOUT_MS"]
const saved = new Map<string, string | undefined>()

const json: EndpointDefinition = { key: "t.json", method: "POST", path: "/q", kind: "json", description: "t" }
const file: EndpointDefinition = { key: "t.file", method: "GET", path: "/dl", kind: "download", description: "t" }

let api: http.Server
let apiHost: string
let apiHits = 0
let proxy: http.Server
let proxyHost: string
const tunnels: Array<{ target: string; authorization: string | undefined }> = []
/** 设了就对 CONNECT 回这个状态码，不开隧道；`refuseFirst` 大于 0 时只拒前这么多次，之后照常接通。 */
let refuseWith: number | undefined
let refuseFirst = 0

const listen = (server: net.Server) => new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
const close = (server: net.Server) => new Promise<void>((r) => server.close(() => r()))

beforeAll(async () => {
  api = http.createServer((req, res) => {
    apiHits += 1
    if (req.url === "/dl") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("file body")
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ code: "000000", msg: "ok", data: { ok: 1 } }))
  })
  await listen(api)
  apiHost = `127.0.0.1:${(api.address() as AddressInfo).port}`

  proxy = http.createServer((_req, res) => {
    res.statusCode = 400
    res.end()
  })
  proxy.on("connect", (req, socket, head) => {
    tunnels.push({ target: req.url ?? "", authorization: req.headers["proxy-authorization"] })
    if (refuseWith && (refuseFirst === 0 || tunnels.length <= refuseFirst)) {
      socket.end(`HTTP/1.1 ${refuseWith} Refused\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const [host, port] = (req.url ?? "").split(":")
    const upstream = net.connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on("error", () => socket.destroy())
    socket.on("error", () => upstream.destroy())
  })
  await listen(proxy)
  proxyHost = `127.0.0.1:${(proxy.address() as AddressInfo).port}`
})

afterAll(async () => {
  proxy.closeAllConnections()
  api.closeAllConnections()
  await Promise.all([close(proxy), close(api)])
})

beforeEach(() => {
  for (const name of PROXY_VARS) {
    saved.set(name, process.env[name])
    delete process.env[name]
  }
  tunnels.length = 0
  apiHits = 0
  refuseWith = undefined
  refuseFirst = 0
})

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

/** 按当前环境变量建一套新的连接池。 */
async function freshClient(env: Record<string, string>, baseUrl = `http://${apiHost}`) {
  Object.assign(process.env, env)
  vi.resetModules()
  const { GangtiseClient } = await import("../../../src/core/client.js")
  const { errorResult } = await import("../../../src/mcp/handler.js")
  const client = new GangtiseClient({ baseUrl, timeoutMs: 5_000, token: "t", tokenCachePath: "/dev/null", asyncTimeoutMs: 5_000, maxDownloadBytes: 1024 * 1024 * 1024 })
  const failure = async (run: Promise<unknown>) => errorResult(await run.then(() => { throw new Error("expected a failure") }, (e: unknown) => e)).content[0].text
  return { client, failure }
}

describe("GANGTISE_PROXY", () => {
  it("tunnels queries and downloads through the proxy, sending the account written into its URL", async () => {
    const { client } = await freshClient({ GANGTISE_PROXY: `http://${proxyHost}` })
    expect(await client.requestJson(json, {})).toEqual({ ok: 1 })
    expect((await client.download(file, {})).text).toBe("file body")
    // 查询与下载各走各的连接池，各开一条隧道
    expect(tunnels).toEqual([{ target: apiHost, authorization: undefined }, { target: apiHost, authorization: undefined }])

    tunnels.length = 0
    const withAccount = await freshClient({ GANGTISE_PROXY: `http://user:p%40ss@${proxyHost}` })
    await withAccount.client.requestJson(json, {})
    expect(tunnels).toEqual([{ target: apiHost, authorization: `Basic ${Buffer.from("user:p@ss").toString("base64")}` }])

    // 只写用户名（以它为凭据的代理）也要发出去
    tunnels.length = 0
    const userOnly = await freshClient({ GANGTISE_PROXY: `http://tok3n@${proxyHost}` })
    await userOnly.client.requestJson(json, {})
    expect(tunnels).toEqual([{ target: apiHost, authorization: `Basic ${Buffer.from("tok3n:").toString("base64")}` }])

    // 只写密码同样发出去，不悄悄改成匿名连接
    tunnels.length = 0
    const passwordOnly = await freshClient({ GANGTISE_PROXY: `http://:s3cret@${proxyHost}` })
    await passwordOnly.client.requestJson(json, {})
    expect(tunnels).toEqual([{ target: apiHost, authorization: `Basic ${Buffer.from(":s3cret").toString("base64")}` }])
  })

  // 那几个变量常是为别的流量设的；跟随它们会悄悄改掉请求的出口。
  it("goes direct when only the standard proxy variables are set", async () => {
    const url = `http://${proxyHost}`
    const { client } = await freshClient({ HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url, ALL_PROXY: url, all_proxy: url })
    expect(await client.requestJson(json, {})).toEqual({ ok: 1 })
    expect(tunnels).toEqual([])
    expect(apiHits).toBe(1)
  })

  it("refuses at startup a value that is not an http(s) URL, without showing it", async () => {
    Object.assign(process.env, { GANGTISE_PROXY: `user:s3cret@${proxyHost}` })
    vi.resetModules()
    const { loadConfig } = await import("../../../src/core/config.js")
    expect(() => loadConfig()).toThrow("GANGTISE_PROXY is not an http(s) proxy URL")
    expect(() => loadConfig()).not.toThrow("s3cret")
    process.env.GANGTISE_PROXY = "socks5://127.0.0.1:1080"
    expect(() => loadConfig()).toThrow("GANGTISE_PROXY is not an http(s) proxy URL")
    // 连接池只收协议 + 主机 + 端口：PAC 文件地址、查询串到第一次调用才会报 invalid url
    for (const value of [`http://${proxyHost}/proxy.pac`, `http://${proxyHost}/?x=1`, `http://${proxyHost}/#a`]) {
      process.env.GANGTISE_PROXY = value
      expect(() => loadConfig(), value).toThrow("only the scheme, host and port")
    }
    // 密码里没编码的 %：否则到第一次调用才报裸的 URI malformed
    process.env.GANGTISE_PROXY = `http://user:p%ss@${proxyHost}`
    expect(() => loadConfig()).toThrow("not valid URL encoding")
    expect(() => loadConfig()).not.toThrow("p%ss")
  })

  it("says what to check when the proxy will not open the tunnel, or cannot be reached", async () => {
    refuseWith = 407
    const unauthenticated = await freshClient({ GANGTISE_PROXY: `http://${proxyHost}` })
    expect(await unauthenticated.failure(unauthenticated.client.requestJson(json, {}))).toContain("要求认证")
    expect(apiHits).toBe(0)
    // 认证失败不会自己好，不重试
    expect(tunnels).toHaveLength(1)
    // 写了账号仍被拒：说的是账号不对，而不是「把账号写进地址」
    const rejected = await freshClient({ GANGTISE_PROXY: `http://user:wrong@${proxyHost}` })
    const rejectedText = await rejected.failure(rejected.client.requestJson(json, {}))
    expect(rejectedText).toContain("拒绝了地址里的账号")
    expect(rejectedText).not.toContain("把账号写进地址")

    refuseWith = 403
    const blocked = await freshClient({ GANGTISE_PROXY: `http://${proxyHost}` })
    expect(await blocked.failure(blocked.client.requestJson(json, {}))).toContain("返回 403")

    // 127.0.0.1:1 上没有服务：连代理本身被拒。报错不带 URL 里的密码。
    const down = await freshClient({ GANGTISE_PROXY: "http://user:s3cret@127.0.0.1:1" })
    const text = await down.failure(down.client.requestJson(json, {}))
    expect(text).toContain("连不上 GANGTISE_PROXY 指向的代理")
    expect(text).not.toContain("s3cret")
  })

  // 代理临时拒开隧道（自身故障 / 限流）：请求还没发往服务端，按现有退避重试，不重放的端点也一样。
  it.each([503, 429])("retries a tunnel the proxy refused with a temporary %i", async (status) => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    try {
      refuseWith = status
      refuseFirst = 1
      const { client } = await freshClient({ GANGTISE_PROXY: `http://${proxyHost}` })
      const billed: EndpointDefinition = { ...json, retry: "no-replay" }
      expect(await client.requestJson(billed, {})).toEqual({ ok: 1 })
      expect(tunnels).toHaveLength(2)
      expect(apiHits).toBe(1)
    } finally {
      vi.restoreAllMocks()
    }
  })

  // 收下 CONNECT 却一直不应答：隧道请求按时限（这里 1 秒）放弃，三次尝试后报错，而不是等 undici 几分钟的默认值。
  it("gives up on a proxy that takes the tunnel request and never answers, within the deadline", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    let connections = 0
    const silent = net.createServer((socket) => {
      connections += 1
      // 读掉请求、从不应答。不读的话，客户端断开后这一端收不到 end，server.close() 会一直等下去。
      socket.resume()
      socket.on("error", () => {})
    })
    await listen(silent)
    try {
      const { client, failure } = await freshClient({ GANGTISE_PROXY: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, GANGTISE_TIMEOUT_MS: "1000" })
      const startedAt = Date.now()
      expect(await failure(client.requestJson(json, {}))).toContain("在限时内没有应答")
      // 三次各 1 秒 + 退避 0.4 + 0.8 秒
      expect(Date.now() - startedAt).toBeLessThan(8_000)
      expect(connections).toBe(3)
    } finally {
      vi.restoreAllMocks()
      await close(silent)
    }
  }, 15_000)

  // 只开 SOCKS 的端口收下 CONNECT 就断开：undici 会把它当作值得重连的连接无限重连，请求既不失败也不超时。
  it("gives up after three attempts on a port that drops the tunnel request", async () => {
    let connections = 0
    const dropper = net.createServer((socket) => {
      connections += 1
      socket.once("data", () => socket.destroy())
    })
    await listen(dropper)
    try {
      const { client, failure } = await freshClient({ GANGTISE_PROXY: `http://127.0.0.1:${(dropper.address() as AddressInfo).port}` })
      expect(await failure(client.requestJson(json, {}))).toContain("没有按 HTTP 代理应答")
      expect(connections).toBe(3)
    } finally {
      await close(dropper)
    }
  })

  it("names a standard proxy variable that is set when the API cannot be reached directly", async () => {
    const { client, failure } = await freshClient({ HTTPS_PROXY: "http://user:s3cret@10.0.0.1:3128" }, "http://127.0.0.1:1")
    const text = await failure(client.requestJson(json, {}))
    expect(text).toContain("环境里设了 HTTPS_PROXY")
    expect(text).not.toContain("s3cret")
  })
})
