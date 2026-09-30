import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GangtiseClient } from "../../../src/core/client.js"
import { credentialFingerprint } from "../../../src/core/auth.js"

// 读盘是真实 I/O，时序排不出来：包一层 readTokenCache，让指定的那次读取先读到盘上的内容、再卡住，
// 直到测试放行才返回——模拟「读盘始于刷新之前、返回于刷新之中」。
const { requestMock, readGate } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  readGate: { calls: 0, holdCall: 0, hold: Promise.resolve(), reached: () => {} },
}))

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici")
  return { ...actual, request: requestMock }
})

vi.mock("../../../src/core/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/auth.js")>()
  return {
    ...actual,
    readTokenCache: async (filePath: string) => {
      const n = ++readGate.calls
      const value = await actual.readTokenCache(filePath)
      if (n === readGate.holdCall) {
        readGate.reached()
        await readGate.hold
      }
      return value
    },
  }
})

const json = (payload: unknown) => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: { text: vi.fn().mockResolvedValue(JSON.stringify(payload)) },
})

let dir: string
let cachePath: string

beforeEach(async () => {
  requestMock.mockReset()
  readGate.calls = 0
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gangtise-read-race-"))
  cachePath = path.join(dir, "token.json")
  // 盘上躺着一枚按本地时钟没过期、服务端已判失效的旧 token（请求开始前就写好）。
  await fs.writeFile(cachePath, JSON.stringify({
    accessToken: "stale", expiresIn: 7200, time: 1, expiresAt: Math.floor(Date.now() / 1000) + 7200,
    issuedFor: credentialFingerprint("ak", "https://open.gangtise.com"),
  }), "utf8")
  await new Promise((r) => setTimeout(r, 5))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("token read that started before a refresh and returns during it", () => {
  it("waits for the refresh instead of putting the stale token back into memory", async () => {
    let releaseLogin!: () => void
    const loginHeld = new Promise<void>((r) => { releaseLogin = r })
    let loginStarted!: () => void
    const loginSeen = new Promise<void>((r) => { loginStarted = r })
    let releaseRead!: () => void
    readGate.holdCall = 2
    readGate.hold = new Promise<void>((r) => { releaseRead = r })
    const readHeld = new Promise<void>((r) => { readGate.reached = r })

    const seen: string[] = []
    requestMock.mockImplementation(async (url: unknown, options?: { headers?: Record<string, string> }) => {
      if (String(url).includes("/loginV2")) {
        loginStarted()
        await loginHeld
        return json({ code: "000000", data: { accessToken: "fresh", expiresIn: 7200, time: 1 } })
      }
      const auth = options?.headers?.Authorization ?? ""
      seen.push(auth)
      return auth === "Bearer stale" ? json({ code: "8000014", msg: "access key error" }) : json({ code: "000000", msg: "ok", data: { ok: 1 } })
    })

    const client = new GangtiseClient({ baseUrl: "https://open.gangtise.com", timeoutMs: 30_000, accessKey: "ak", secretKey: "sk", tokenCachePath: cachePath, asyncTimeoutMs: 60_000, maxDownloadBytes: 1024 * 1024 * 1024 })
    // 两个请求同时进来、内存都是空的，各读一次盘：第一次立刻返回（带着 stale 去请求、失败、触发刷新），
    // 第二次读到 stale 后卡住。
    const first = client.call("ai.one-pager", { securityCode: "600519.SH" })
    const second = client.call("ai.one-pager", { securityCode: "000858.SZ" })
    await readHeld
    await loginSeen
    // 刷新已开始、还没结束：放行第二次读盘。
    releaseRead()
    await new Promise((r) => setTimeout(r, 20))
    // 刷新期间再进来一个请求：内存里不该有 stale 可用。
    const third = client.call("ai.one-pager", { securityCode: "300750.SZ" })
    await new Promise((r) => setTimeout(r, 20))
    releaseLogin()
    await Promise.all([first, second, third])

    // 只有第一个请求带过 stale；第二、第三个都等到了 fresh。
    expect(seen).toEqual(["Bearer stale", "Bearer fresh", "Bearer fresh", "Bearer fresh"])
  })
})
