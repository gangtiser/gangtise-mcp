import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  isTokenCacheValid,
  normalizeToken,
  readTokenCache,
  requireAccessCredentials,
  type TokenCache,
} from "../../../src/core/auth.js"

function cache(expiresAt: number): TokenCache {
  return { accessToken: "tok", expiresIn: 7200, time: 0, expiresAt }
}

const nowSec = () => Math.floor(Date.now() / 1000)

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
