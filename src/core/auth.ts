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
