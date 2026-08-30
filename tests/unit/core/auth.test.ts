import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  isTokenCacheValid,
  normalizeToken,
  readTokenCache,
  requireAccessCredentials,
  writeTokenCache,
  readTokenCacheWithMtime,
  type TokenCache,
} from "../../../src/core/auth.js"

function cache(expiresAt: number): TokenCache {
  return { accessToken: "tok", expiresIn: 7200, time: 0, expiresAt }
}

const nowSec = () => Math.floor(Date.now() / 1000)

describe("writeTokenCache directory permissions", () => {
  it("creates the cache directory 0700 (owner-only), matching the 0600 file policy", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "gangtise-auth-test-"))
    const filePath = path.join(base, "nested", "token.json")

    await writeTokenCache(filePath, cache(nowSec() + 7200))

    const stat = await fs.stat(path.dirname(filePath))
    expect(stat.mode & 0o777).toBe(0o700)
    await fs.rm(base, { recursive: true, force: true })
  })
})

describe("isTokenCacheValid", () => {
  it("is valid when expiry is beyond the 300s buffer", () => {
    expect(isTokenCacheValid(cache(nowSec() + 600))).toBe(true)
  })

  it("is invalid within the 300s buffer", () => {
    expect(isTokenCacheValid(cache(nowSec() + 100))).toBe(false)
  })

  it("is invalid for null or empty/zero fields", () => {
    expect(isTokenCacheValid(null)).toBe(false)
    expect(isTokenCacheValid({ ...cache(nowSec() + 600), accessToken: "" })).toBe(false)
    expect(isTokenCacheValid(cache(0))).toBe(false)
  })

  it("honors a custom buffer", () => {
    expect(isTokenCacheValid(cache(nowSec() + 100), 50)).toBe(true)
    expect(isTokenCacheValid(cache(nowSec() + 100), 200)).toBe(false)
  })
})

describe("normalizeToken", () => {
  it("adds a Bearer prefix once and is idempotent", () => {
    expect(normalizeToken("abc")).toBe("Bearer abc")
    expect(normalizeToken("Bearer abc")).toBe("Bearer abc")
  })
})

describe("readTokenCache", () => {
  const tmpDirs: string[] = []
  afterEach(async () => {
    await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })))
    tmpDirs.length = 0
  })
  async function write(content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gangtise-mcp-authtest-"))
    tmpDirs.push(dir)
    const file = path.join(dir, "token.json")
    await fs.writeFile(file, content, "utf8")
    return file
  }

  it("returns a valid cache object", async () => {
    const file = await write(JSON.stringify(cache(123)))
    expect(await readTokenCache(file)).toMatchObject({ accessToken: "tok", expiresAt: 123 })
  })

  it("returns null for malformed JSON", async () => {
    expect(await readTokenCache(await write("{not json"))).toBeNull()
  })

  it("returns null when required fields are missing", async () => {
    expect(await readTokenCache(await write(JSON.stringify({ accessToken: "tok" })))).toBeNull()
  })

  it("returns null for a nonexistent file", async () => {
    expect(await readTokenCache("/no/such/gangtise-token.json")).toBeNull()
  })
})

describe("requireAccessCredentials", () => {
  it("returns the credentials when both are present", () => {
    expect(requireAccessCredentials("ak", "sk")).toEqual({ accessKey: "ak", secretKey: "sk" })
  })

  it("throws when either is missing", () => {
    expect(() => requireAccessCredentials(undefined, "sk")).toThrow()
    expect(() => requireAccessCredentials("ak", undefined)).toThrow()
  })
})

describe("writeTokenCache", () => {
  const tmpDirs: string[] = []
  afterEach(async () => {
    await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })))
    tmpDirs.length = 0
  })
  async function tmpFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gangtise-mcp-authwrite-"))
    tmpDirs.push(dir)
    return path.join(dir, "token.json")
  }

  // fs.writeFile's `mode` only applies on creation, so writing in place over an
  // existing token.json kept its lax perms. The atomic temp+rename must force 0600.
  it("forces 0600 even over a pre-existing world-readable file", async () => {
    const file = await tmpFile()
    await fs.writeFile(file, "stale", { mode: 0o644 })
    await fs.chmod(file, 0o644) // pin lax perms regardless of umask
    await writeTokenCache(file, cache(123))
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  it("round-trips the cache content", async () => {
    const file = await tmpFile()
    await writeTokenCache(file, cache(456))
    expect(await readTokenCache(file)).toMatchObject({ accessToken: "tok", expiresAt: 456 })
  })

  it("leaves no temp sibling behind on success", async () => {
    const file = await tmpFile()
    await writeTokenCache(file, cache(789))
    expect(await fs.readdir(path.dirname(file))).toEqual(["token.json"])
  })

  // The write can fail after the temp file is created (e.g. ENOSPC mid-write).
  // Cleanup must cover that, not only a failed rename.
  it("removes the temp file when the write itself fails, not only on rename", async () => {
    const file = await tmpFile()
    const realWriteFile = fs.writeFile.bind(fs)
    const spy = vi.spyOn(fs, "writeFile").mockImplementation((async (...args: unknown[]) => {
      await (realWriteFile as (...a: unknown[]) => Promise<void>)(...args) // temp file created…
      throw new Error("ENOSPC: no space left")                            // …then the write fails
    }) as unknown as typeof fs.writeFile)
    try {
      await expect(writeTokenCache(file, cache(1))).rejects.toThrow("ENOSPC")
      expect(await fs.readdir(path.dirname(file))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

// 🔴 内容与 mtime 必须来自**同一个 inode 快照**。
// 分两步读（`readFile(path)` 再 `stat(path)`）时，兄弟进程只要在两步之间原子 rename
// 一份新缓存，就会拿到「旧 token + 新文件的 mtime」；调用方据那个新 mtime 判定
// 「本次请求期间刷新过」，于是采用一个早已失效的旧 token，把每次请求仅有的一次自愈
// 额度烧掉，真正该发生的重新登录再也不会发生。
//
// 复核方压力实测：旧实现 1000 次里错配 265 次，fd 实现 0 次；**而恢复旧实现后
// auth/client 共 74 个测试全绿** —— 所以这条必须单独存在，行为断言覆盖不到它。
describe("readTokenCacheWithMtime takes one atomic snapshot", () => {
  it("never pairs stale content with a newer file's mtime under rename interleaving", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gt-auth-snapshot-"))
    const file = path.join(dir, "token.json")
    const token = (name: string) =>
      JSON.stringify({ accessToken: name, expiresIn: 7200, time: 1, expiresAt: Math.floor(Date.now() / 1000) + 7200 })

    // 🔴 判据必须与时间戳粒度无关。用「旧文件的 mtime 是否等于 rename 后路径的 mtime」
    // 当错配证据是错的：两个文件是连续写出来的，落在同一个时间戳刻度内就天然同值，
    // 而这个概率完全取决于文件系统 —— macOS/APFS 上 0/200，Linux CI 上 170/200，
    // 于是一个正确的实现在 CI 上被判成 170 次错配。
    // 改为**显式把两个文件的 mtime 拉开一小时**：此后「内容」与「mtime」各自唯一对应
    // 一个 inode，配错了一眼可辨，跟时钟精度再无关系。
    const OLD_MTIME_S = Math.floor(Date.now() / 1000) - 3600
    const NEW_MTIME_S = Math.floor(Date.now() / 1000)

    let mismatches = 0
    for (let i = 0; i < 200; i += 1) {
      await fs.writeFile(file, token("old-stale"))
      await fs.utimes(file, OLD_MTIME_S, OLD_MTIME_S)
      const tmp = `${file}.tmp`
      await fs.writeFile(tmp, token(`new-sibling-${i}`))
      await fs.utimes(tmp, NEW_MTIME_S, NEW_MTIME_S)
      // 读与 rename 交错
      const [snapshot] = await Promise.all([readTokenCacheWithMtime(file), fs.rename(tmp, file)])
      if (!snapshot.cache) continue
      // 坏形态：返回旧 inode 的内容，却带着新 inode 的 mtime
      const isStaleContent = snapshot.cache.accessToken.startsWith("old")
      const carriesNewMtime = Math.round(snapshot.mtimeMs / 1000) === NEW_MTIME_S
      if (isStaleContent && carriesNewMtime) mismatches += 1
    }

    expect(mismatches, "出现了「旧 token + 新 mtime」的错配快照").toBe(0)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
