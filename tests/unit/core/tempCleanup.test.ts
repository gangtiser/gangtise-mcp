import fs from "node:fs/promises"
import fsSync from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it, vi } from "vitest"
import { selectStaleTempDirs, createManagedTempDir, isOwnedTempPath, resetOwnedTempDirs, releaseOwnedTempDir, touchOwnedTempDir, enforceOwnedTempQuota, beginSpillRead, endSpillRead, ownedTempDirCount, ownedTempBookkeepingSizes, MAX_OWNED_TEMP_DIRS, MAX_OWNED_TEMP_BYTES } from "../../../src/core/tempCleanup.js"

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

// 配额检查此前每次落盘都对全部（上限 200 个）目录递归 stat 一遍。溢出文件写完即不变，
// 只有刚写完的那一份需要重量。
describe("byte-quota accounting caches per-dir sizes", () => {
  it("does not re-stat every owned dir on each spill", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    for (let i = 0; i < 8; i += 1) {
      const dir = await createManagedTempDir()
      await fs.writeFile(path.join(dir, "response.json"), "x".repeat(1024), "utf8")
      await enforceOwnedTempQuota(dir)
      dirs.push(dir)
    }
    const spy = vi.spyOn(fs, "readdir")
    const fresh = await createManagedTempDir()
    await fs.writeFile(path.join(fresh, "response.json"), "y".repeat(1024), "utf8")
    await enforceOwnedTempQuota(fresh)
    // 只重量刚写完的那一份；缓存失效时这里会是 9 次（每个已登记目录一次）。
    const scanned = spy.mock.calls.length
    spy.mockRestore()
    expect(scanned).toBeLessThanOrEqual(2)
    expect(dirs.length).toBe(8)
  })
})

// 🔴 一次下载还在流式写盘时，另一次 createManagedTempDir 会顺带把它量一遍——那是写到
// 一半的读数。旧实现按「不是 0 就缓存」把它固化下来，而唯一会重新量它的那次调用
// （写完后的 enforceOwnedTempQuota(自己)）一旦撞上回读期就提前返回，半成品读数便永久
// 留下：此后每次总量都少算这一份，磁盘早已超配额而检查一路放行。
describe("byte quota is not fooled by a size measured mid-write", () => {
  const GiB = 1024 * 1024 * 1024
  const sizeOf = async (dir: string) => {
    try { return (await fs.stat(path.join(dir, "part.bin"))).size } catch { return 0 }
  }

  it("re-measures a dir that finished writing during a read-back", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    try {
      // a 先只写 1 字节；创建 b 时会顺带把 a 量成 1 字节。
      const a = await createManagedTempDir(); dirs.push(a)
      await fs.writeFile(path.join(a, "part.bin"), "x")
      const b = await createManagedTempDir(); dirs.push(b)
      await fs.writeFile(path.join(b, "part.bin"), "x")
      await fs.truncate(path.join(b, "part.bin"), 0.75 * GiB)
      await enforceOwnedTempQuota(b)
      const c = await createManagedTempDir(); dirs.push(c)
      await fs.writeFile(path.join(c, "part.bin"), "x")
      await fs.truncate(path.join(c, "part.bin"), 0.75 * GiB)
      await enforceOwnedTempQuota(c)

      // a 在回读期间写完：这次配额检查会被跳过，但 a 的旧读数必须当场作废。
      beginSpillRead()
      try {
        await fs.truncate(path.join(a, "part.bin"), 0.75 * GiB)
        await enforceOwnedTempQuota(a)
      } finally {
        await endSpillRead()   // 最后一个读者离开 → 补跑被跳过的那次配额
      }

      const retained = (await Promise.all(dirs.map(sizeOf))).reduce((sum, n) => sum + n, 0)
      expect(retained, "3 × 0.75 GiB 全留着就是 2.25 GiB，超过 2 GiB 配额").toBeLessThanOrEqual(MAX_OWNED_TEMP_BYTES)
      // 刚写完的 a 是本次 protect 的对象，补跑时不能把它当成最久未用的一个删掉。
      expect(await sizeOf(a), "刚写完、显式保护的目录被淘汰了").toBe(0.75 * GiB)
    } finally {
      for (const dir of dirs) { await fs.rm(dir, { recursive: true, force: true }); releaseOwnedTempDir(dir) }
      resetOwnedTempDirs()
    }
  })

  // 「结算时作废旧读数」救不了**尚未结算**的目录：一份正在流式写盘的下载会被别人顺带量到，
  // 而它自己的结算还没到来。这段窗口里若把那个半成品读数缓存下来，期间每次配额检查都少算
  // 它一份 —— 所以判据必须是「结算过才缓存」，不是「量到的不是 0 就缓存」。
  it("never caches the size of a dir that has not settled yet", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    try {
      // a 一直在写，**从不调用 enforceOwnedTempQuota(a)**（模拟下载还没落完）。
      const a = await createManagedTempDir(); dirs.push(a)
      await fs.writeFile(path.join(a, "part.bin"), "x")

      // b 结算时会顺带量一次 a —— 此刻 a 只有 1 字节。
      const b = await createManagedTempDir(); dirs.push(b)
      await fs.writeFile(path.join(b, "part.bin"), "x")
      await fs.truncate(path.join(b, "part.bin"), 0.75 * GiB)
      await enforceOwnedTempQuota(b)

      // a 继续长到 1.5 GiB，仍未结算。
      await fs.truncate(path.join(a, "part.bin"), 1.5 * GiB)

      // c 结算：这次统计必须重新量 a（1.5 GiB），合计 3 GiB 超配额。
      const c = await createManagedTempDir(); dirs.push(c)
      await fs.writeFile(path.join(c, "part.bin"), "x")
      await fs.truncate(path.join(c, "part.bin"), 0.75 * GiB)
      await enforceOwnedTempQuota(c)

      const retained = (await Promise.all(dirs.map(sizeOf))).reduce((sum, n) => sum + n, 0)
      expect(retained, "把未结算目录写到一半的读数当成了最终大小").toBeLessThanOrEqual(MAX_OWNED_TEMP_BYTES)
      expect(await sizeOf(c), "刚结算的那一份不该被淘汰").toBe(0.75 * GiB)
    } finally {
      for (const dir of dirs) { await fs.rm(dir, { recursive: true, force: true }); releaseOwnedTempDir(dir) }
      resetOwnedTempDirs()
    }
  })

  // `enforceOwnedTempQuota(dir)` 的契约是「这一份的内容刚定下来」，所以它必须**作废**该目录
  // 之前的任何读数。缓存只在「上一次结算」到「下一次结算」之间有效——只靠「已结算才缓存」
  // 是不够的：目录一旦结算过就进了缓存，再写入时若不作废，用的还是上一版的大小。
  it("invalidates a settled dir's cached size when it is settled again", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    try {
      // 先写两份小的并结算，让它们进缓存。
      const a = await createManagedTempDir(); dirs.push(a)
      await fs.writeFile(path.join(a, "part.bin"), "x")
      await enforceOwnedTempQuota(a)
      const b = await createManagedTempDir(); dirs.push(b)
      await fs.writeFile(path.join(b, "part.bin"), "x")
      await fs.truncate(path.join(b, "part.bin"), 1.5 * GiB)
      await enforceOwnedTempQuota(b)

      // a 二次写入后再次结算：这次必须按 1.5 GiB 计，合计 3 GiB 超配额。
      await fs.truncate(path.join(a, "part.bin"), 1.5 * GiB)
      await enforceOwnedTempQuota(a)

      const retained = (await Promise.all(dirs.map(sizeOf))).reduce((sum, n) => sum + n, 0)
      expect(retained, "二次结算沿用了上一版的大小，总量少算了这一份").toBeLessThanOrEqual(MAX_OWNED_TEMP_BYTES)
      expect(await sizeOf(a), "刚结算的那一份不该被淘汰").toBe(1.5 * GiB)
    } finally {
      for (const dir of dirs) { await fs.rm(dir, { recursive: true, force: true }); releaseOwnedTempDir(dir) }
      resetOwnedTempDirs()
    }
  })

  it("runs the skipped quota pass once the last reader leaves", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    try {
      // a、b 在回读之前写完：合计 1.5 GiB，配额之内，不该淘汰谁。
      for (let i = 0; i < 2; i += 1) {
        const dir = await createManagedTempDir(); dirs.push(dir)
        await fs.writeFile(path.join(dir, "part.bin"), "x")
        await fs.truncate(path.join(dir, "part.bin"), 0.75 * GiB)
        await enforceOwnedTempQuota(dir)
      }
      expect((await Promise.all(dirs.map(sizeOf))).reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(MAX_OWNED_TEMP_BYTES)

      // c 落在回读期：它这次的配额检查被整个跳过，磁盘就此超额。
      beginSpillRead()
      const c = await createManagedTempDir(); dirs.push(c)
      await fs.writeFile(path.join(c, "part.bin"), "x")
      await fs.truncate(path.join(c, "part.bin"), 0.75 * GiB)
      await enforceOwnedTempQuota(c)
      expect(
        (await Promise.all(dirs.map(sizeOf))).reduce((s, n) => s + n, 0),
        "回读期间本就该推迟淘汰，这一步不该已经清理",
      ).toBeGreaterThan(MAX_OWNED_TEMP_BYTES)

      // 最后一个读者离开 → 补跑那次被跳过的检查。
      await endSpillRead()
      const retained = (await Promise.all(dirs.map(sizeOf))).reduce((sum, n) => sum + n, 0)
      expect(retained, "回读结束后没有补跑配额检查").toBeLessThanOrEqual(MAX_OWNED_TEMP_BYTES)
      // 补跑同样要认 protect：c 是刚写完的那一份，不能被当成淘汰对象。
      expect(await sizeOf(c), "补跑时把刚写完的目录删了").toBe(0.75 * GiB)
    } finally {
      for (const dir of dirs) { await fs.rm(dir, { recursive: true, force: true }); releaseOwnedTempDir(dir) }
      resetOwnedTempDirs()
    }
  })
})

// 入口查一次读者计数是不够的：入口到 fs.rm 之间隔着若干次异步 I/O，新回读能在这中间
// 登记完毕。下面三条把「检查」与「删除」之间的那个窗口逐段钉住。
//
// 🔴 挂钩子必须用 **realpath**：`ownedTempDirs` 里登记的是 realpath 解析后的路径
// （macOS 的 /var 是 /private/var 的符号链接），而 `createManagedTempDir` 返回的是
// mkdtemp 原路径。按后者匹配，钩子永远不触发，竞态根本没造出来而测试照样绿。
const GiB = 1024 * 1024 * 1024
const partOf = (dir: string) => path.join(dir, "part.bin")
const bytesOf = async (dir: string) => {
  try { return (await fsSync.stat(partOf(dir))).size } catch { return 0 }
}
async function fill(dir: string, bytes: number): Promise<void> {
  await fs.writeFile(partOf(dir), "x")
  await fs.truncate(partOf(dir), bytes)
}

describe("eviction yields to a reader that registers mid-scan", () => {
  it("stops deleting once a new reader appears after the entry check", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    try {
      // A、B 各 0.75 GiB 并结算：合计 1.5 GiB **在配额之内**，此前不会有任何淘汰。
      // （`createManagedTempDir` 自己也跑一轮配额，先把总量压在线下，才能保证后面
      // 观察到的删除只可能来自那次与读者赛跑的扫描。）
      for (let i = 0; i < 2; i += 1) {
        const dir = await createManagedTempDir(); dirs.push(dir)
        await fill(dir, 0.75 * GiB)
        await enforceOwnedTempQuota(dir)
      }
      const c = await createManagedTempDir(); dirs.push(c)
      await fill(c, 0.75 * GiB)   // 总量 2.25 GiB：C 的这次检查一定要淘汰点什么

      // 读者在**检查已经开始之后**登记：同步前缀先跑完（入口看到 0 个读者），
      // 扫描随后在 dirBytes 的 await 上让出，这时读者才登记上。
      const racing = enforceOwnedTempQuota(c)
      beginSpillRead()
      await racing

      for (const dir of dirs) {
        expect(await bytesOf(dir), `${dir} 在有读者时被删了`).toBe(0.75 * GiB)
      }

      await endSpillRead()
      const sizes = await Promise.all(dirs.map(bytesOf))
      expect(sizes.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(MAX_OWNED_TEMP_BYTES)
    } finally {
      for (const dir of dirs) { await fs.rm(dir, { recursive: true, force: true }); releaseOwnedTempDir(dir) }
      resetOwnedTempDirs()
    }
  })

  // 让路时必须把当时要保护的目录记下来，否则补跑那一轮 keeps 为空——刚写完的那一份
  // 若恰好是**最久未用**的，就会被当成头号淘汰对象删掉，调用方前一刻拿到的 _saved_to
  // 当场作废。所以这条特意让受保护的目录排在最前面。
  it("carries the protected dir into the deferred pass after yielding", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    try {
      const a = await createManagedTempDir(); dirs.push(a)   // 最久未用的那一个
      for (let i = 0; i < 2; i += 1) {
        const dir = await createManagedTempDir(); dirs.push(dir)
        await fill(dir, 0.75 * GiB)
        await enforceOwnedTempQuota(dir)
      }
      await fill(a, 0.75 * GiB)   // A 最后才写完，但在插入序里最老

      const racing = enforceOwnedTempQuota(a)
      beginSpillRead()
      await racing
      await endSpillRead()

      expect(await bytesOf(a), "补跑丢了 protect，把刚写完的那一份删了").toBe(0.75 * GiB)
      const sizes = await Promise.all(dirs.map(bytesOf))
      expect(sizes.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(MAX_OWNED_TEMP_BYTES)
    } finally {
      for (const dir of dirs) { await fs.rm(dir, { recursive: true, force: true }); releaseOwnedTempDir(dir) }
      resetOwnedTempDirs()
    }
  })

  // 数量淘汰是一串 `await fs.rm`，读者能在两次删除之间登记。要一次删掉多份，只有
  // 「回读期间目录攒过了上限、补跑时批量清」这一种路径——逐个创建时每轮最多削一个，
  // 那样第一次删除前的入口检查就够了，测不到循环里这一处。
  it("stops the count-cap sweep when a reader appears between two deletions", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    const realRm = fs.rm
    try {
      for (let i = 0; i < MAX_OWNED_TEMP_DIRS; i += 1) dirs.push(await createManagedTempDir())
      // 回读期间再造 3 个：淘汰全被推迟，登记表因此超出上限 3 个。
      beginSpillRead()
      for (let i = 0; i < 3; i += 1) dirs.push(await createManagedTempDir())
      expect(ownedTempDirCount()).toBe(MAX_OWNED_TEMP_DIRS + 3)

      let removed = 0
      ;(fs as { rm: typeof fs.rm }).rm = (async (target: string, options?: object) => {
        removed += 1
        if (removed === 1) beginSpillRead()   // 第一次删除之后，新读者才登记
        return realRm(target, options as never)
      }) as typeof fs.rm
      await endSpillRead()                     // 补跑：本该一次削掉 3 个
      ;(fs as { rm: typeof fs.rm }).rm = realRm

      expect(removed, "补跑一次都没删，用例前提不成立").toBeGreaterThan(0)
      expect(removed, "新读者登记后仍在继续删").toBe(1)
      expect(ownedTempDirCount(), "只应削掉让路前的那一个").toBe(MAX_OWNED_TEMP_DIRS + 2)
    } finally {
      ;(fs as { rm: typeof fs.rm }).rm = realRm
      endSpillRead()
      for (const dir of dirs) { await realRm(dir, { recursive: true, force: true }); releaseOwnedTempDir(dir) }
      resetOwnedTempDirs()
    }
  })
})

// 🔴 「结算时 delete 缓存」挡不住**在途的旧扫描**：它在 await 之前就取到了旧尺寸，
// 恢复时才去看是否已结算——于是把一个测量期间已被作废的读数重新写回去。
describe("an in-flight scan cannot resurrect a size it measured before a settle", () => {
  it("discards a measurement taken before the dir settled", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    const realStat = fs.stat
    let resume: () => void = () => {}
    let reached: () => void = () => {}
    const gate = new Promise<void>((r) => { resume = r })
    const observed = new Promise<void>((r) => { reached = r })
    let paused = false
    try {
      const a = await createManagedTempDir(); dirs.push(a)
      await fs.writeFile(partOf(a), "x")                       // A 先只有 1 字节
      const realPart = path.join(await fs.realpath(a), "part.bin")

      // 返回真实 stat 结果，但把**这一次**扫描卡住，直到 A 写完并结算完毕。
      ;(fs as { stat: typeof fs.stat }).stat = (async (target: string, ...rest: never[]) => {
        const result = await (realStat as (...args: never[]) => Promise<unknown>)(target as never, ...rest)
        if (String(target) === realPart && !paused) { paused = true; reached(); await gate }
        return result
      }) as typeof fs.stat

      const creatingB = createManagedTempDir()                 // 这次创建会顺带扫描并量到 A
      await observed
      await fs.truncate(partOf(a), 0.75 * GiB)
      await enforceOwnedTempQuota(a)                           // A 结算：作废旧读数
      resume()
      const b = await creatingB; dirs.push(b)
      ;(fs as { stat: typeof fs.stat }).stat = realStat
      expect(paused, "钩子没触发，竞态根本没造出来").toBe(true)

      await fill(b, 0.75 * GiB)
      await enforceOwnedTempQuota(b)
      const c = await createManagedTempDir(); dirs.push(c)
      await fill(c, 0.75 * GiB)
      await enforceOwnedTempQuota(c)

      const sizes = await Promise.all(dirs.map(async (d) => {
        try { return (await realStat(partOf(d))).size } catch { return 0 }
      }))
      expect(sizes.reduce((sum, n) => sum + n, 0), "旧扫描把 1 字节写回缓存，总量因此少算了 A")
        .toBeLessThanOrEqual(MAX_OWNED_TEMP_BYTES)
    } finally {
      resume()
      ;(fs as { stat: typeof fs.stat }).stat = realStat
      for (const dir of dirs) { await fs.rm(dir, { recursive: true, force: true }); releaseOwnedTempDir(dir) }
      resetOwnedTempDirs()
    }
  })
})

// `settledBefore` 只挡得住「量的时候压根没结算过」。**已经结算过、量到一半又结算了一次**
// 是另一档：那时 `settledBefore` 为真，没有世代号就会把上一轮的旧读数当成有效结果写回，
// 把刚做的作废覆盖掉。本仓的契约允许同一目录多次结算（见上面的二次结算用例），
// 所以这一档是够得着的。
describe("a measurement is void if the dir settled again while it was being taken", () => {
  it("discards a reading taken between two settles of the same dir", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    const realStat = fs.stat
    let resume: () => void = () => {}
    let reached: () => void = () => {}
    const gate = new Promise<void>((r) => { resume = r })
    const observed = new Promise<void>((r) => { reached = r })
    let paused = false
    try {
      const a = await createManagedTempDir(); dirs.push(a)
      await fs.writeFile(partOf(a), "x")
      await enforceOwnedTempQuota(a)                    // 结算 ①：A 以 1 字节进缓存
      const realPart = path.join(await fs.realpath(a), "part.bin")

      ;(fs as { stat: typeof fs.stat }).stat = (async (target: string, ...rest: never[]) => {
        const result = await (realStat as (...args: never[]) => Promise<unknown>)(target as never, ...rest)
        if (String(target) === realPart && !paused) { paused = true; reached(); await gate }
        return result
      }) as typeof fs.stat

      // 结算 ②：作废缓存后重新量——此刻 A 还是 1 字节，这次读数就此卡住。
      const staleSettle = enforceOwnedTempQuota(a)
      await observed
      // A 真正写满并结算 ③：缓存被作废并写入 0.75 GiB 的新读数。
      await fs.truncate(partOf(a), 0.75 * GiB)
      await enforceOwnedTempQuota(a)
      resume()
      await staleSettle                                  // 结算 ② 的旧读数不得回填
      ;(fs as { stat: typeof fs.stat }).stat = realStat
      expect(paused, "钩子没触发，竞态根本没造出来").toBe(true)

      for (let i = 0; i < 2; i += 1) {
        const dir = await createManagedTempDir(); dirs.push(dir)
        await fill(dir, 0.75 * GiB)
        await enforceOwnedTempQuota(dir)
      }

      const sizes = await Promise.all(dirs.map(async (d) => {
        try { return (await realStat(partOf(d))).size } catch { return 0 }
      }))
      expect(sizes.reduce((sum, n) => sum + n, 0), "旧读数被写回，总量少算了 A")
        .toBeLessThanOrEqual(MAX_OWNED_TEMP_BYTES)
    } finally {
      resume()
      ;(fs as { stat: typeof fs.stat }).stat = realStat
      for (const dir of dirs) { await fs.rm(dir, { recursive: true, force: true }); releaseOwnedTempDir(dir) }
      resetOwnedTempDirs()
    }
  })
})

// 🔴 `settleEpoch` 只增不删是两个问题，不是一个：
//  ① 表随进程单调增长（实跑 510 个目录全部释放后仍残留 510 条）；
//  ② **在途的旧扫描恢复时世代号没变**，会把一个已经释放的目录的缓存重新写回来。
// 所以判据不能只看「有没有内存泄漏」，要连回填那条路一起堵。
describe("bookkeeping is released together with the dir", () => {
  it("leaves nothing behind after release, either kind of eviction, or reset", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    try {
      // 释放
      for (let i = 0; i < 5; i += 1) {
        const dir = await createManagedTempDir(); dirs.push(dir)
        await fs.writeFile(partOf(dir), "x")
        await enforceOwnedTempQuota(dir)
      }
      expect(ownedTempBookkeepingSizes().epochs).toBe(5)
      for (const dir of dirs) { await fs.rm(dir, { recursive: true, force: true }); releaseOwnedTempDir(dir) }
      expect(ownedTempBookkeepingSizes(), "释放没有清掉辅助结构")
        .toEqual({ cached: 0, settled: 0, epochs: 0 })

      // 数量淘汰：造到超上限，被削掉的那些也要清干净
      dirs.length = 0
      for (let i = 0; i < MAX_OWNED_TEMP_DIRS + 5; i += 1) {
        const dir = await createManagedTempDir(); dirs.push(dir)
        await fs.writeFile(partOf(dir), "x")
        await enforceOwnedTempQuota(dir)
      }
      const afterCount = ownedTempBookkeepingSizes()
      expect(ownedTempDirCount()).toBe(MAX_OWNED_TEMP_DIRS)
      expect(afterCount.epochs, "数量淘汰漏清世代号").toBe(MAX_OWNED_TEMP_DIRS)
      expect(afterCount.settled).toBe(MAX_OWNED_TEMP_DIRS)

      // reset
      resetOwnedTempDirs()
      expect(ownedTempBookkeepingSizes(), "reset 没有清掉世代号表")
        .toEqual({ cached: 0, settled: 0, epochs: 0 })
    } finally {
      for (const dir of dirs) { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}) }
      resetOwnedTempDirs()
    }
  })

  it("clears bookkeeping for a dir dropped by the byte quota", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    try {
      for (let i = 0; i < 3; i += 1) {
        const dir = await createManagedTempDir(); dirs.push(dir)
        await fill(dir, 0.75 * GiB)
        await enforceOwnedTempQuota(dir)
      }
      // 2.25 GiB 超配额 → 削掉一份，登记表应同步降到 2
      expect(ownedTempDirCount()).toBe(2)
      expect(ownedTempBookkeepingSizes(), "字节淘汰漏清辅助结构")
        .toEqual({ cached: 2, settled: 2, epochs: 2 })
    } finally {
      for (const dir of dirs) { await fs.rm(dir, { recursive: true, force: true }); releaseOwnedTempDir(dir) }
      resetOwnedTempDirs()
    }
  })

  // 释放把世代号一并删掉，于是旧扫描恢复时 `epochBefore` 对不上，写回被挡住。
  it("an in-flight scan cannot re-cache a dir that was released meanwhile", async () => {
    resetOwnedTempDirs()
    const dirs: string[] = []
    const realStat = fs.stat
    let resume: () => void = () => {}
    let reached: () => void = () => {}
    const gate = new Promise<void>((r) => { resume = r })
    const observed = new Promise<void>((r) => { reached = r })
    let paused = false
    try {
      const a = await createManagedTempDir(); dirs.push(a)
      await fs.writeFile(partOf(a), "x")
      await enforceOwnedTempQuota(a)                     // A 已结算，进缓存
      const realPart = path.join(await fs.realpath(a), "part.bin")

      ;(fs as { stat: typeof fs.stat }).stat = (async (target: string, ...rest: never[]) => {
        const result = await (realStat as (...args: never[]) => Promise<unknown>)(target as never, ...rest)
        if (String(target) === realPart && !paused) { paused = true; reached(); await gate }
        return result
      }) as typeof fs.stat

      // 再结算一次：缓存作废后重新量 A，这次读数卡住。
      const scan = enforceOwnedTempQuota(a)
      await observed
      await fs.rm(a, { recursive: true, force: true })   // 期间 A 被删除并释放
      releaseOwnedTempDir(a)
      resume()
      await scan
      ;(fs as { stat: typeof fs.stat }).stat = realStat

      expect(paused, "钩子没触发，竞态根本没造出来").toBe(true)
      expect(ownedTempBookkeepingSizes(), "旧扫描把已释放目录的缓存写了回来")
        .toEqual({ cached: 0, settled: 0, epochs: 0 })
    } finally {
      resume()
      ;(fs as { stat: typeof fs.stat }).stat = realStat
      for (const dir of dirs) { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); releaseOwnedTempDir(dir) }
      resetOwnedTempDirs()
    }
  })
})
