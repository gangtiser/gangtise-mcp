import fs from "node:fs/promises"
import path from "node:path"

import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

// 状态目录在家目录下、config.ts 加载时就定了：指到临时目录，测试既不依赖也不碰真的 ~/.config/gangtise。
vi.mock("../../../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/config.js")>()
  const { mkdtempSync, mkdirSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const state = join(mkdtempSync(join(tmpdir(), "gangtise-statepaths-")), "state")
  mkdirSync(state)
  const tokenCache = join(state, "token.json")
  return { ...actual, DEFAULT_TOKEN_CACHE_PATH: tokenCache, loadConfig: () => ({ ...actual.loadConfig(), tokenCachePath: process.env.GANGTISE_TOKEN_CACHE_PATH || tokenCache }) }
})

const { DEFAULT_TOKEN_CACHE_PATH } = await import("../../../src/core/config.js")
const { assertNotStatePath } = await import("../../../src/core/statePaths.js")

const stateDir = path.dirname(DEFAULT_TOKEN_CACHE_PATH)
const root = path.dirname(stateDir)
const outside = path.join(root, "outside")
await fs.mkdir(outside, { recursive: true })
await fs.writeFile(DEFAULT_TOKEN_CACHE_PATH, "{}")

const refused = (target: string) => expect(assertNotStatePath(target, "filePath")).rejects.toThrow(/filePath .* 指向本服务存放访问令牌的位置/)
const allowed = (target: string) => expect(assertNotStatePath(target, "filePath")).resolves.toBeUndefined()

afterEach(() => {
  delete process.env.GANGTISE_TOKEN_CACHE_PATH
})
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("assertNotStatePath", () => {
  it("refuses the token cache and any path in the state directory, existing or not", async () => {
    await refused(DEFAULT_TOKEN_CACHE_PATH)
    await refused(path.join(stateDir, "title-cache.json"))
    await refused(path.join(stateDir, "new", "deeper.json"))
    await refused(stateDir)
  })

  it("takes a path outside it", async () => {
    await allowed(path.join(outside, "export.csv"))
    await allowed(path.join(root, "state-like", "token.json"))
  })

  it("follows a symlink to the token cache, and a symlinked directory before `..`", async () => {
    const link = path.join(outside, "token-link.json")
    await fs.symlink(DEFAULT_TOKEN_CACHE_PATH, link)
    await refused(link)
    // outside/sub-link → state/sub: the OS reads outside/sub-link/../token.json as state/token.json,
    // while folding `..` as text would read it as outside/token.json.
    await fs.mkdir(path.join(stateDir, "sub"))
    await fs.symlink(path.join(stateDir, "sub"), path.join(outside, "sub-link"))
    await refused(`${path.join(outside, "sub-link")}${path.sep}..${path.sep}token.json`)
  })

  it("refuses a token cache moved with GANGTISE_TOKEN_CACHE_PATH, before it exists too", async () => {
    const moved = path.join(outside, "moved", "token.json")
    process.env.GANGTISE_TOKEN_CACHE_PATH = moved
    await refused(moved)
    await fs.mkdir(path.dirname(moved))
    await fs.writeFile(moved, "{}")
    await refused(moved)
    // Its siblings are not state.
    await allowed(path.join(outside, "moved", "export.csv"))
  })
})
