import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

import { ConfigError } from "./errors.js"

export interface TokenCache {
  accessToken: string
  expiresIn: number
  time: number
  expiresAt: number
  uid?: number
  userName?: string
  tenantId?: number
  /** 这枚 token 是用哪套凭证、对着哪个 host 换来的。没有这个字段时缓存只是「某个还
   * 没过期的 token」：换掉 GANGTISE_ACCESS_KEY 之后，上一个账号**尚未过期**的 token
   * 会继续被发出去，请求带的是上一个账号的身份、取到的也是它的数据——股票池写操作
   * 一旦撞上，改的就是别人的池，而删池不可恢复。缓存文件与 gangtise CLI 共用，所以
   * 另一个账号的 token 躺在那里并不是假想情形。
   * 存的是指纹不是 key 本身：足够分辨两个账号，而 0600 文件万一被读走也不泄露凭证。
   * 该字段出现之前写的旧缓存没有这一项，按来源不明处理。 */
  issuedFor?: string
}

/** 「哪套凭证 + 哪个 host」的稳定、不可逆标识。只有 accessKey 参与——secret 没有参与
 * 的必要，把它排除在外意味着缓存文件即使泄露也帮不上对 secret 的离线猜测。 */
export function credentialFingerprint(accessKey: string, baseUrl: string): string {
  return createHash("sha256").update(`${accessKey}\u0000${baseUrl}`).digest("hex").slice(0, 16)
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

/** `expectedFingerprint` 为 `undefined` 时不做归属比对——没有配 AK/SK 的部署里不存在
 * 第二个账号，此时拒绝缓存只会破坏「仅有 token 缓存」这种正常用法。 */
export function isTokenCacheValid(cache: TokenCache | null, bufferSeconds = 300, expectedFingerprint?: string): boolean {
  if (!cache?.accessToken || !cache.expiresAt) {
    return false
  }

  // 属于别的凭证（或写在 issuedFor 出现之前、来源不明）的缓存一律当作不可用：
  // 重新登录的代价是一次免费请求，用错账号的代价是一份别人的数据。
  if (expectedFingerprint !== undefined && cache.issuedFor !== expectedFingerprint) {
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
