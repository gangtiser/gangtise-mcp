import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import http from "node:http"
import type { AddressInfo } from "node:net"

import { describe, expect, it } from "vitest"

import { GangtiseClient } from "../../../src/core/client.js"

import { downloadToResult } from "../../../src/core/download.js"
import { isOwnedTempPath, ownedTempDirCount, resetOwnedTempDirs } from "../../../src/core/tempCleanup.js"
import type { GangtiseClient } from "../../../src/core/client.js"
import type { EndpointDefinition } from "../../../src/core/endpoints.js"

/** 等待 HTTP server 真正关完。`server.close()` 只发起关闭并立即返回。 */
const closed = (server: http.Server) => new Promise<void>((resolve) => server.close(() => resolve()))

const endpoint: EndpointDefinition = {
  key: "mock.download",
  method: "GET",
  path: "/mock/download",
  kind: "download",
  description: "Mock download",
}

describe("downloadToResult", () => {
  it("keeps content-disposition filenames inside the generated temp directory", async () => {
    const client = {
      download: async (_endpoint: EndpointDefinition, _query: Record<string, string | number>, options?: { streamTo?: string }) => {
        if (!options?.streamTo) throw new Error("missing stream destination")
        await fs.writeFile(options.streamTo, "payload")
        return {
          savedPath: options.streamTo,
          filename: "../escaped-report.pdf",
          contentType: "application/pdf",
        }
      },
    } as unknown as GangtiseClient

    const result = await downloadToResult(client, endpoint, {})
    try {
      expect(result.filename).toBe("escaped-report.pdf")
      expect(path.basename(result.savedPath ?? "")).toBe("escaped-report.pdf")
      expect(path.basename(path.dirname(result.savedPath ?? ""))).toMatch(/^gangtise-mcp-/)

      const tmpReal = await fs.realpath(os.tmpdir())
      const savedReal = await fs.realpath(result.savedPath ?? "")
      expect(savedReal.startsWith(tmpReal + path.sep)).toBe(true)
      expect(path.basename(path.dirname(savedReal))).toMatch(/^gangtise-mcp-/)
    } finally {
      if (result.savedPath) {
        const dir = path.dirname(result.savedPath)
        if (path.basename(dir).startsWith("gangtise-mcp-")) {
          await fs.rm(dir, { recursive: true, force: true })
        } else {
          await fs.rm(result.savedPath, { force: true })
        }
      }
    }
  })

  it("removes the temp dir when the streamed download fails mid-way", async () => {
    let streamedTo: string | undefined
    const client = {
      download: async (_endpoint: EndpointDefinition, _query: Record<string, string | number>, options?: { streamTo?: string }) => {
        streamedTo = options?.streamTo
        // simulate the truncated file a mid-stream failure leaves on disk
        if (streamedTo) await fs.writeFile(streamedTo, "partial bytes")
        throw new Error("stream boom")
      },
    } as unknown as GangtiseClient

    await expect(downloadToResult(client, endpoint, {})).rejects.toThrow("stream boom")

    // a failed download must not leave the temp dir or its partial file behind
    expect(streamedTo).toBeDefined()
    await expect(fs.access(path.dirname(streamedTo as string))).rejects.toThrow()
  })
})

// 下载族的 30x：对象存储签名 URL 常用这个形态。不跟随时客户端会把 redirect body 当成
// 正常文本结果交出去 —— 既拿不到文件，报错也不指向真因。
// 用真的本地 HTTP server 测，而不是 mock undici：要验的正是 undici 的重定向行为本身。
describe("download follows 30x redirects", () => {
  it("follows the redirect and returns the final body, without leaking the token cross-origin", async () => {
    const seen: Array<{ port: number; auth?: string }> = []
    const target = http.createServer((req, res) => {
      seen.push({ port: (target.address() as AddressInfo).port, auth: req.headers.authorization })
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="report.pdf"' })
      res.end("PDFBYTES")
    })
    await new Promise<void>((r) => target.listen(0, r))
    const targetPort = (target.address() as AddressInfo).port

    const redirector = http.createServer((req, res) => {
      seen.push({ port: (redirector.address() as AddressInfo).port, auth: req.headers.authorization })
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/file` })
      res.end("moved")
    })
    await new Promise<void>((r) => redirector.listen(0, r))
    const redirectPort = (redirector.address() as AddressInfo).port

    try {
      const client = new GangtiseClient({
        baseUrl: `http://127.0.0.1:${redirectPort}`,
        timeoutMs: 5_000,
        token: "secret-token",
        tokenCachePath: "/dev/null",
        asyncTimeoutMs: 5_000,
      })
      const result = await client.download(
        { key: "t", method: "GET", path: "/dl", kind: "download", description: "t" },
        {},
      )
      // 拿到的是最终文件，不是 redirect body
      expect(Buffer.from(result.data!).toString()).toBe("PDFBYTES")
      expect(result.filename).toBe("report.pdf")
      // 🔴 跨源那一跳不能带着令牌
      const finalHop = seen.find((s) => s.port === targetPort)
      expect(finalHop?.auth, "令牌被带到了重定向目标的域名上").toBeUndefined()
    } finally {
      // 🔴 `close()` 只是**发起**关闭，不等待。不 await 的话套接字可能还占着端口，
      // 而这条用例起的是真实 HTTP server —— 留一个确定的不稳定因素在那里没有意义。
      await Promise.all([closed(target), closed(redirector)])
    }
  })
})

// 🔴 单份下载不能把临时磁盘写满。
// 总字节配额（tempCleanup）救不了这一档：它的淘汰只能删**别的**目录，删不掉正在写的这一份。
// 所以拦截必须在落盘侧：先看 Content-Length，没有则靠流式计数中止。
//
// ⚠️ 只做「写完之后再清理」是不够的 —— 那时磁盘已经被写满了。
describe("a single download cannot fill the temp disk", () => {
  const serve = async (handler: http.RequestListener) => {
    const srv = http.createServer(handler)
    await new Promise<void>((r) => srv.listen(0, r))
    return { srv, port: (srv.address() as AddressInfo).port }
  }
  // 🔴 测试注入一个**小**上限。用真实的 1 GiB 会让每次跑测试都真写 1 GiB——CI 上
  // test + coverage × 3 个 Node 版本 ≈ 6 GiB I/O，纯浪费。验的是「超限会被拦住」这个行为，
  // 与阈值具体是多少无关，所以阈值本身做成可注入的（config.maxDownloadBytes）。
  const TEST_CAP = 8 * 1024 * 1024
  const clientFor = (port: number) =>
    new GangtiseClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 20_000, token: "t", tokenCachePath: "/dev/null", asyncTimeoutMs: 5_000, maxDownloadBytes: TEST_CAP })
  const endpoint = { key: "t", method: "GET" as const, path: "/dl", kind: "download" as const, description: "t" }

  // 🔴 超限时必须**主动销毁响应体**。undici 的连接要么读完、要么 destroy 才归还连接池；
  // 直接 throw 会把 socket 留着（服务端还在推流而我们不读了）。实测：不 destroy 时连打
  // 20 次超限下载会把 `connections: 16` 的池子占满并**死锁**（探针跑满 2 分钟超时）；
  // destroy 之后同样 20 次耗时 133ms、服务端 0 个存活 socket。
  it("destroys the response body so the connection is returned to the pool", async () => {
    const { srv, port } = await serve((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(TEST_CAP * 3),
        "content-disposition": 'attachment; filename="big.bin"',
      })
      const timer = setInterval(() => { if (!res.writableEnded) res.write("x".repeat(4096)) }, 5)
      res.on("close", () => clearInterval(timer))
    })
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gt-pool-"))
    try {
      // 连打 20 次，超过连接池的 16 槽 —— 不归还连接的话这里会挂住
      for (let i = 0; i < 20; i += 1) {
        await expect(clientFor(port).download(endpoint, {}, { streamTo: path.join(dir, `d${i}.bin`) })).rejects.toThrow(/超过单文件上限/)
      }
      // 服务端侧确认连接确实断了，而不是靠客户端「没报错」推断
      await new Promise((r) => setTimeout(r, 300))
      const live = await new Promise<number>((r) => srv.getConnections((_e, n) => r(n ?? 0)))
      expect(live, `服务端仍有 ${live} 个未关闭的连接，连接池槽位被占住了`).toBe(0)
    } finally {
      srv.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  // chunked（无 Content-Length）走的是另一条分支：流式计数中止。预检那条测不到它。
  it("aborts mid-stream when a chunked body exceeds the cap", async () => {
    const chunk = Buffer.alloc(512 * 1024, 0x41)
    const { srv, port } = await serve((_req, res) => {
      // 有意不给 content-length → chunked
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="stream.bin"' })
      let sent = 0
      const push = () => {
        if (res.writableEnded || sent > 200) { res.end(); return }
        sent += 1
        if (res.write(chunk)) setImmediate(push)
        else res.once("drain", push)
      }
      push()
    })
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gt-chunked-"))
    const dest = path.join(dir, "d.bin")
    try {
      await expect(clientFor(port).download(endpoint, {}, { streamTo: dest })).rejects.toThrow(/超过单文件上限/)
      // 落盘的字节数被卡在上限附近，而不是把 1.6 GiB 全写下来
      const size = await fs.stat(dest).then((st) => st.size).catch(() => 0)
      expect(size).toBeLessThanOrEqual(TEST_CAP + chunk.length)
    } finally {
      srv.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("refuses before writing anything when Content-Length declares an oversized body", async () => {
    const { srv, port } = await serve((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(TEST_CAP * 3),
        "content-disposition": 'attachment; filename="big.bin"',
      })
      res.end("x")
    })
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gt-cap-test-"))
    const dest = path.join(dir, "d.bin")
    try {
      await expect(clientFor(port).download(endpoint, {}, { streamTo: dest })).rejects.toThrow(/超过单文件上限/)
      // 关键：一个字节都没落盘
      await expect(fs.stat(dest)).rejects.toThrow()
    } finally {
      srv.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

// 🔴 `downloadToResult` 有六条会删掉临时目录的早退路径。每一条都必须**同时**做两件事：
// 删磁盘目录、从 owned 登记表摘除。只做前者会留下**墓碑**——磁盘上没了，登记表里还占着
// 一格，而保留上限数的是登记表大小，于是墓碑挤占的是活目录的名额。
//
// 上一版的回归测试直接调 `releaseOwnedTempDir()`，只证明了这个 helper 本身能用，
// 证明不了 download.ts 的每条分支真的调了它 —— 有人在某条分支上写回裸 `fs.rm` 就漏过去了。
// 这里表驱动地走**真实调用路径**。
describe("每条早退路径都释放登记表名额", () => {
  const cases: { name: string; raw: Record<string, unknown>; keepsDir: boolean }[] = [
    { name: "① 直链（url）", raw: { url: "https://example.com/a.pdf", filename: "a.pdf" }, keepsDir: false },
    { name: "② 文本正文（text）", raw: { text: "# hello", filename: "a.md", contentType: "text/markdown" }, keepsDir: false },
    { name: "④ 内存二进制（data）", raw: { data: new Uint8Array([1, 2, 3]), filename: "a.bin" }, keepsDir: true },
    { name: "⑤ 三者皆无 → 报错", raw: {}, keepsDir: false },
  ]

  for (const c of cases) {
    it(`${c.name}`, async () => {
      resetOwnedTempDirs()
      const client = { download: async () => c.raw } as unknown as GangtiseClient
      let saved: string | undefined
      try {
        const r = await downloadToResult(client, endpoint, {})
        saved = r.savedPath
      } catch {
        // ⑤ 走异常路径，同样要求目录与名额都已释放
      }

      // 清理放 finally：断言一旦抛出，写在它后面的 rm 就不会执行，
      // 于是每次测试跑红都在 tmpdir 里留一个目录 —— 下次排查泄漏时先被这些假阳性绊住。
      try {
      if (c.keepsDir) {
        // 保留结果的路径必须**仍然登记**——否则 gangtise_read_response 读不到它
        expect(saved, "保留二进制结果的路径没返回 savedPath").toBeDefined()
        expect(isOwnedTempPath(await fs.realpath(saved!)), "结果目录被错误地摘出了登记表").toBe(true)
        expect((await fs.stat(saved!)).isFile()).toBe(true)
      } else {
        // 早退路径：登记表必须回到 0。
        // 🔴 判据只能是这个计数——墓碑的定义就是「磁盘上没有、登记表里还有」，
        // 按 readdir(tmpdir) 遍历根本遍历不到它，那样写的断言恒真、抓不到任何回归。
        expect(ownedTempDirCount(), `${c.name} 删了目录却没释放登记表名额（墓碑）`).toBe(0)
      }
      } finally {
        if (saved) await fs.rm(path.dirname(saved), { recursive: true, force: true })
      }
    })
  }

  // 🔴 异常分支同样要释放名额，而且**只能靠运行时断言**：
  // 静态扫描抓得到「某处写回了裸 fs.rm」，抓不到「某个 catch 里整段 dropTempDir() 被删掉」——
  // 那种改法下源码里 fs.rm 的出现次数一点没变，扫描全绿而墓碑照留。
  //
  // 🔴 每个 mock 都要把 `streamTo` 记下来。被测代码正常时会自己删掉目录，但这些用例存在的
  // 意义就是「删除逻辑被改坏」——那时目录留在磁盘上，而 `resetOwnedTempDirs()` 只清登记表、
  // 不碰磁盘。拿不到路径的测试一旦跑红就漏一个目录，下次排查泄漏先被自己的假阳性绊住
  //（上一轮就是这么留下一个空目录的）。所以路径要记，清理要放 finally。
  const failures: { name: string; make: () => { client: GangtiseClient; dir: () => string | undefined } }[] = [
    {
      name: "client.download() 抛错（流中断/网络失败）",
      make: () => {
        let seen: string | undefined
        return {
          client: {
            download: async (_e: EndpointDefinition, _q: unknown, o?: { streamTo?: string }) => {
              seen = o?.streamTo
              throw new Error("boom")
            },
          } as unknown as GangtiseClient,
          dir: () => seen,
        }
      },
    },
    {
      name: "Case 3 落盘后处理抛错（rename / 配额）",
      make: () => {
        let seen: string | undefined
        return {
          client: {
            download: async (_e: EndpointDefinition, _q: unknown, o?: { streamTo?: string }) => {
              seen = o?.streamTo
              // 声明 savedPath 但不真的写文件 —— 后续 rename 必然 ENOENT
              return { savedPath: (o?.streamTo ?? "") + ".missing", filename: "a.pdf" }
            },
          } as unknown as GangtiseClient,
          dir: () => seen,
        }
      },
    },
    {
      name: "Case 4 内存写盘抛错",
      make: () => {
        let seen: string | undefined
        return {
          client: {
            download: async (_e: EndpointDefinition, _q: unknown, o?: { streamTo?: string }) => {
              seen = o?.streamTo
              // data 不是可写入的类型，fs.writeFile 抛 TypeError
              return { data: { not: "bytes" } as unknown as Uint8Array, filename: "a.bin" }
            },
          } as unknown as GangtiseClient,
          dir: () => seen,
        }
      },
    },
  ]

  for (const f of failures) {
    it(`异常分支：${f.name}`, async () => {
      resetOwnedTempDirs()
      const { client, dir } = f.make()
      try {
        await expect(downloadToResult(client, endpoint, {})).rejects.toThrow()
        expect(ownedTempDirCount(), `${f.name} 抛错后没释放登记表名额（墓碑）`).toBe(0)
      } finally {
        const streamTo = dir()
        if (streamTo) await fs.rm(path.dirname(streamTo), { recursive: true, force: true })
        resetOwnedTempDirs()
      }
    })
  }

  // 流式落盘（Case 3）与内存二进制（Case 4）都要在**写完之后**执行字节配额——
  // 建目录那一刻统计出来是 0，只在那时执行等于完全不设防。
  it("③④ 落盘后都执行字节配额", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("src/core/download.ts", "utf8")
    // Case 3 (savedPath) 与 Case 4 (data) 各有一次，且都传了 tempDir 做保护
    expect((src.match(/await enforceOwnedTempQuota\(tempDir\)/g) ?? []).length, "有落盘路径漏了写后配额").toBe(2)
    // `fs.rm(tempDir` 只该在 dropTempDir 内部出现这一次；多出来的就是绕过了释放。
    expect((src.match(/fs\.rm\(tempDir/g) ?? []).length, "有分支绕过 dropTempDir 直接 fs.rm").toBe(1)
  })
})
