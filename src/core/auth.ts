import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { ConfigError } from "./errors.js"

export interface TokenCache {
  accessToken: string
  expiresIn: number
  time: number
  expiresAt: number
  uid?: number
  userName?: string
  tenantId?: number
}

export async function readTokenCache(filePath: string): Promise<TokenCache | null> {
  try {
    const content = await fs.readFile(filePath, "utf8")
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === "object" && typeof parsed.accessToken === "string" && typeof parsed.expiresAt === "number") {
      return parsed as TokenCache
    }
    return null
  } catch {
    return null
  }
}

/** `readTokenCache` plus the file's mtime, for the auth-recovery path only.
 *
 * That path has to tell two look-alikes apart: a sibling process that refreshed the
 * shared cache **while this request was in flight** (adopt it — logging in again would
 * supersede the sibling's session server-side), and a cache file that was already
 * sitting there, stale, before the request began (do NOT adopt — it is just as likely
 * to be dead, and adopting it burns the one self-heal we get per request).
 * Token inequality alone cannot separate them; the mtime can.
 *
 * `mtimeMs: 0` on a stat failure means "cannot prove it is fresh", which the caller
 * reads as not-a-sibling-refresh — the safe direction (a real login instead). */
export async function readTokenCacheWithMtime(filePath: string): Promise<{ cache: TokenCache | null; mtimeMs: number }> {
  // 🔴 内容与 mtime 必须来自**同一个快照**，所以走 open → read → fstat 这一个 fd，
  // 而不是 `readFile(path)` 再 `stat(path)`。
  //
  // 分两步读的话，兄弟进程只要在这两步之间 rename 一份新缓存（写缓存本来就是
  // 写临时文件 + 原子 rename），就会拿到「**旧 token + 新文件的 mtime**」：
  // 调用方据那个新 mtime 判定「本次请求期间刷新过」，于是采用一个早已失效的旧 token，
  // 把每次请求仅有的一次自愈额度烧掉，真正该发生的重新登录再也不会发生。
  // 同一个 fd 上 fstat 读到的是**这个 inode** 的时间，rename 换掉的是路径指向的 inode，
  // 两者不会错配。
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(filePath, "r")
    const [content, stat] = await Promise.all([handle.readFile("utf8"), handle.stat()])
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === "object" && typeof parsed.accessToken === "string" && typeof parsed.expiresAt === "number") {
      return { cache: parsed as TokenCache, mtimeMs: stat.mtimeMs }
    }
    return { cache: null, mtimeMs: 0 }
  } catch {
    return { cache: null, mtimeMs: 0 }
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function writeTokenCache(filePath: string, cache: TokenCache): Promise<void> {
  // 0700 to match the 0600 file policy — the default (umask) 755 would let other
  // local users list the dir and stat the token file's metadata. Applies to
  // newly created dirs only; an existing dir keeps its mode.
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  // Write to a fresh 0600 temp file then rename over the target. Writing in place
  // would (a) keep an existing file's lax perms — `mode` only applies on creation —
  // and (b) risk a truncated file on crash. A temp file is 0600 from the first byte
  // and rename is atomic, carrying the 0600 perms over. (Mirrors gangtise CLI v0.21.0.)
  const tmp = `${filePath}.tmp-${randomUUID()}`
  try {
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 })
    await fs.rename(tmp, filePath)
  } catch (error) {
    // Covers a failed write (temp may be half-created, e.g. ENOSPC) as well as a
    // failed rename — never leave the temp sibling behind.
    await fs.unlink(tmp).catch(() => {})
    throw error
  }
}

export function isTokenCacheValid(cache: TokenCache | null, bufferSeconds = 300): boolean {
  if (!cache?.accessToken || !cache.expiresAt) {
    return false
  }

  const now = Math.floor(Date.now() / 1000)
  return cache.expiresAt - bufferSeconds > now
}

export function normalizeToken(token: string): string {
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`
}

export function requireAccessCredentials(accessKey?: string, secretKey?: string): { accessKey: string; secretKey: string } {
  if (!accessKey || !secretKey) {
    throw new ConfigError("Missing GANGTISE_ACCESS_KEY or GANGTISE_SECRET_KEY")
  }

  return { accessKey, secretKey }
}
