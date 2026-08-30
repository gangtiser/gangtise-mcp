import fs from "node:fs/promises"
import fsSync from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { selectStaleTempDirs, createManagedTempDir, isOwnedTempPath, resetOwnedTempDirs, releaseOwnedTempDir, touchOwnedTempDir, enforceOwnedTempQuota, MAX_OWNED_TEMP_DIRS } from "../../../src/core/tempCleanup.js"

const DAY = 86_400_000
const now = 1_700_000_000_000

describe("selectStaleTempDirs", () => {
  it("selects prefixed dirs older than maxAge", () => {
    const entries = [
      { name: "gangtise-mcp-aaa", mtimeMs: now - 2 * DAY },
      { name: "gangtise-mcp-bbb", mtimeMs: now - 5 * DAY },
    ]
    expect(selectStaleTempDirs(entries, "gangtise-mcp-", now, DAY).sort()).toEqual([
      "gangtise-mcp-aaa",
      "gangtise-mcp-bbb",
    ])
  })

  it("keeps recent prefixed dirs", () => {
    const entries = [{ name: "gangtise-mcp-fresh", mtimeMs: now - 1000 }]
    expect(selectStaleTempDirs(entries, "gangtise-mcp-", now, DAY)).toEqual([])
  })

  it("ignores dirs that do not match the prefix", () => {
    const entries = [{ name: "other-prefix-aaa", mtimeMs: now - 10 * DAY }]
    expect(selectStaleTempDirs(entries, "gangtise-mcp-", now, DAY)).toEqual([])
  })
})

describe("createManagedTempDir / isOwnedTempPath", () => {
  it("treats files in a process-created temp dir as owned and rejects others", async () => {
    const dir = await createManagedTempDir()
    const file = path.join(dir, "response.json")
    await fs.writeFile(file, "{}", "utf8")
    expect(isOwnedTempPath(await fs.realpath(file))).toBe(true)
    expect(isOwnedTempPath(await fs.realpath(os.tmpdir()))).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

// 🔴 溢出目录此前**在整个进程生命周期内只增不减**：唯一的回收是启动时扫 24h 前的目录，
// 一个常驻数天的 server 因此永远等不到自己的清理。
describe("createManagedTempDir: in-session retention cap", () => {
  it("evicts the oldest dirs past the cap, from disk and from the owned set", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    try {
    for (let i = 0; i < MAX_OWNED_TEMP_DIRS + 3; i += 1) dirs.push(await createManagedTempDir())
    // realpath 要在被挤掉**之前**取：淘汰会把目录从磁盘删掉，事后 realpath 直接 ENOENT。
    const oldest = dirs[0]

    // 被挤掉的：既不在 owned 集合里（不再可读），磁盘上也没了
    expect(isOwnedTempPath(oldest)).toBe(false)
    await expect(fs.stat(oldest)).rejects.toThrow()

    // 最新的仍然完好
    const newest = await fs.realpath(dirs[dirs.length - 1])
    expect(isOwnedTempPath(newest)).toBe(true)
    expect((await fs.stat(newest)).isDirectory()).toBe(true)

    } finally {
      // 🔴 测试创建的目录必须全部清掉。第一版只删了「存活的那批」，每跑一次就在系统临时
      // 目录留下几百个 gangtise-mcp-*；跑了一轮复核后实测积压到 6000+ 个。
      for (const d of dirs) await fs.rm(d, { recursive: true, force: true })
    }
  })
})

// 🔴 200 份上限必须按 **LRU** 淘汰，不是 FIFO。差别是致命的：一份正在被逐页回读的溢出
// 响应会随新溢出被挤到队头，然后在读到一半时被删掉——后续页永久不可恢复，若原结果来自
// 计费端点就只能重新付费再查。跨 session 复核用端到端探针复现过（第二次回读报
// "saved_to path not found"）。
describe("owned temp dirs evict by LRU, not FIFO", () => {
  it("keeps a dir that was touched by a read, even when 200 newer dirs appear", async () => {
    resetOwnedTempDirs()
    const created: string[] = []
    const track = async () => { const d = await createManagedTempDir(); created.push(d); return d }
    try {
    const touched = await track()
    const neverRead = await track()
    // realpath 要在淘汰**之前**取：被淘汰的目录已从磁盘删掉，事后 realpath 直接 ENOENT。
    const touchedReal = await fs.realpath(touched)

    // 模拟一次成功回读：response.ts 读到之后调用 touchOwnedTempDir
    touchOwnedTempDir(touchedReal)

    // 补到刚好超出上限 1 个 —— 只淘汰一份，才能看出淘汰的是哪一份。
    // （补满 MAX 会超出 2 份、两份都被淘汰，测什么都看不出来。）
    for (let i = 0; i < MAX_OWNED_TEMP_DIRS - 1; i += 1) await track()

    // 被淘汰的是**没被读过**的那份；回读过的那份因为 touch 移到了 MRU 端而存活
    expect(isOwnedTempPath(neverRead), "LRU 该淘汰没读过的那份").toBe(false)
    await expect(fs.stat(neverRead)).rejects.toThrow()
    expect(isOwnedTempPath(touchedReal), "回读过的目录被 FIFO 挤掉了").toBe(true)
    expect((await fs.stat(touchedReal)).isDirectory()).toBe(true)
    } finally {
      for (const d of created) await fs.rm(d, { recursive: true, force: true })
    }
  })
})

// 🔴 数量上限之外还有**总字节配额**：200 个目录里若有几个是几百 MB 的下载，数量远没到
// 上限而磁盘已经满了。用**稀疏文件**造体积——不实际占用磁盘块，跑得快也不吃 CI 的盘。
describe("owned temp dirs also honour a byte quota", () => {
  /** 造一个逻辑大小为 size 的稀疏文件（实际占用接近 0）。 */
  const sparse = async (file: string, size: number) => {
    const fh = await fsSync.open(file, "w")
    try {
      await fh.truncate(size)
    } finally {
      await fh.close()
    }
  }

  it("evicts the least-recently-used dirs until the total is back under quota", async () => {
    resetOwnedTempDirs()
    const created: string[] = []
    try {
      // 三份各 0.8 GiB，合计 2.4 GiB > 2 GiB 配额
      const chunk = Math.floor(0.8 * 1024 * 1024 * 1024)
      // ⚠️ isOwnedTempPath 比对的是 **realpath**（macOS 上 /var → /private/var），
      // 而 createManagedTempDir 返回的是未解析的路径 —— 断言前要先 realpath。
      const mk = async (name: string) => {
        const dir = await createManagedTempDir()
        created.push(dir)
        await sparse(path.join(dir, name), chunk)
        return fsSync.realpath(dir)
      }
      const oldest = await mk("a.bin")
      await mk("b.bin")
      const newest = await mk("c.bin")

      // 配额在**写完之后**执行 —— 创建目录那一刻它还是空的，只在那时统计等于不设防
      await enforceOwnedTempQuota()

      // 最久未用的先走；最新的那份（多半就是刚写完的）不参与淘汰
      expect(isOwnedTempPath(oldest), "超配额时最久未用的那份应被淘汰").toBe(false)
      await expect(fsSync.stat(oldest)).rejects.toThrow()
      expect(isOwnedTempPath(newest), "刚写完的那份不该被淘汰——否则调用方刚拿到的路径立刻作废").toBe(true)
      expect((await fsSync.stat(newest)).isDirectory()).toBe(true)
    } finally {
      for (const d of created) await fsSync.rm(d, { recursive: true, force: true })
    }
  }, 30_000)

  // 🔴 淘汰**永远不碰最近使用的那一份**：它多半就是调用方刚写完、刚拿到路径的那个，
  // 删它等于把刚返回的 _saved_to 立刻作废。哪怕它自己就超配额也不删——那一档由落盘侧的
  // 单文件上限拦（client.download 的 MAX_SPILL_BYTES），不是靠事后淘汰。
  it("never evicts the most-recently-used dir, even when it alone exceeds the quota", async () => {
    resetOwnedTempDirs()
    const created: string[] = []
    try {
      const older = await createManagedTempDir(); created.push(older)
      await sparse(path.join(older, "a.bin"), 512 * 1024 * 1024)
      const olderReal = await fsSync.realpath(older)

      const newest = await createManagedTempDir(); created.push(newest)
      // 这一份自己就超过 2 GiB 配额
      await sparse(path.join(newest, "huge.bin"), 3 * 1024 * 1024 * 1024)
      const newestReal = await fsSync.realpath(newest)

      await enforceOwnedTempQuota()

      // 旧的被清掉了（能腾就腾），但最新的那份必须留着
      expect(isOwnedTempPath(olderReal), "该腾的没腾").toBe(false)
      expect(isOwnedTempPath(newestReal), "把调用方刚拿到的那份删了——路径立刻作废").toBe(true)
      expect((await fsSync.stat(newestReal)).isDirectory()).toBe(true)
    } finally {
      for (const d of created) await fsSync.rm(d, { recursive: true, force: true })
    }
  }, 30_000)

  it("leaves everything alone when the total is under quota", async () => {
    resetOwnedTempDirs()
    const created: string[] = []
    try {
      const reals: string[] = []
      for (let i = 0; i < 3; i += 1) {
        const d = await createManagedTempDir()
        created.push(d)
        await sparse(path.join(d, "small.bin"), 1024 * 1024)
        reals.push(await fsSync.realpath(d))
      }
      await enforceOwnedTempQuota()
      for (const d of reals) expect(isOwnedTempPath(d), "没超配额不该淘汰任何东西").toBe(true)
    } finally {
      for (const d of created) await fsSync.rm(d, { recursive: true, force: true })
    }
  })
})

// 🔴 删掉的目录必须同时从登记表摘除，否则留下的**墓碑**会挤占活目录的名额：
// 上限数的是集合大小，而下载走「返回直链」「文本正文」两条路径时目录建了就删。
describe("deleting an owned temp dir releases its registry slot", () => {
  it("keeps a live spill alive across MAX_OWNED tombstones", async () => {
    resetOwnedTempDirs()
    const created: string[] = []
    try {
      // 先建一份「真实溢出」：它创建得最早，所以在插入序里排在所有墓碑之前 ——
      // 正是墓碑不摘除时会被优先淘汰的那一份。
      const live = await createManagedTempDir()
      created.push(live)
      const liveReal = await fs.realpath(live)

      // 再走 MAX_OWNED_TEMP_DIRS 次「建了就删」，每次都配对 release。
      for (let i = 0; i < MAX_OWNED_TEMP_DIRS; i += 1) {
        const d = await createManagedTempDir()
        await fs.rm(d, { recursive: true, force: true })
        releaseOwnedTempDir(d)
      }

      expect(isOwnedTempPath(liveReal), "墓碑挤掉了仍在等回读的溢出目录").toBe(true)
      expect((await fs.stat(liveReal)).isDirectory()).toBe(true)
    } finally {
      for (const d of created) await fs.rm(d, { recursive: true, force: true })
    }
  })

  it("release matches the registry entry even when realpath differs from mkdtemp", async () => {
    resetOwnedTempDirs()
    // macOS 上 os.tmpdir() 是 /var/... 而登记的是 /private/var/...；按原样 delete
    // 会静默失配，墓碑照留。这条钉住 basename 兜底。
    const dir = await createManagedTempDir()
    const real = await fs.realpath(dir)
    await fs.rm(dir, { recursive: true, force: true })
    releaseOwnedTempDir(dir)
    expect(isOwnedTempPath(real), "release 没能对上登记的 realpath").toBe(false)
  })
})

// 🔴 字节淘汰要保护的是**刚写完的那一份**，不能靠「集合最后一项」——并发下载或另一条
// 路径新建的目录都会让最后一项不是它，保护就落到别人头上。
describe("byte-quota eviction protects the dir the caller names", () => {
  it("keeps the just-written dir even when a newer dir was inserted after it", async () => {
    resetOwnedTempDirs()
    const created: string[] = []
    const sparse = async (dir: string, size: number) => {
      const fh = await fsSync.open(path.join(dir, "big.bin"), "w")
      await fh.truncate(size)
      await fh.close()
    }
    try {
      const mine = await createManagedTempDir()
      created.push(mine)
      const mineReal = await fs.realpath(mine)
      await sparse(mine, 1.5 * 1024 ** 3)

      // 并发的另一次调用在我之后插入了一个目录 —— 它成了「集合最后一项」。
      const other = await createManagedTempDir()
      created.push(other)
      await sparse(other, 1.5 * 1024 ** 3)

      // 我显式点名保护自己那一份；总量 3 GiB 超 2 GiB 配额，必然要淘汰一个。
      await enforceOwnedTempQuota(mine)

      expect(isOwnedTempPath(mineReal), "保护落到了集合最后一项而不是点名的那份").toBe(true)
    } finally {
      for (const d of created) await fs.rm(d, { recursive: true, force: true })
    }
  })
})
