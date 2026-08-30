import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { isVerbose } from "./transport.js"

const TMP_DIR_PREFIX = "gangtise-mcp-"
/** Temp dirs from truncated responses / downloads older than this are swept on startup. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Realpath-resolved temp dirs created by THIS process via createManagedTempDir.
 * gangtise_read_response consults this so it only ever reads files this server
 * run produced — not arbitrary gangtise-mcp-* files another process left in tmp.
 *
 * Insertion-ordered (Set guarantees it). `touchOwnedTempDir` re-inserts on access,
 * which turns that insertion order into a true LRU order without a second structure.
 */
const ownedTempDirs = new Set<string>()

/** Move a dir to the MRU end. `gangtise_read_response` calls this on every successful
 * read.
 *
 * 🔴 少了它，淘汰是 **FIFO 而不是 LRU**，而这两者在本场景里差别是致命的：一份正在被
 * 逐页回读的溢出响应会随着新溢出不断产生被挤到队头，然后**在读到一半时被删掉** ——
 * 后续页永久不可恢复，若原结果来自计费端点就只能重新付费再查一次。
 * （曾经的注释写着「反复读的是同一个目录，不会被自己挤掉」，那句话是错的：回读只刷新
 * 了目录的 mtime，没有动集合顺序。） */
export function touchOwnedTempDir(realPath: string): void {
  for (const dir of ownedTempDirs) {
    if (realPath === dir || realPath.startsWith(dir + path.sep)) {
      ownedTempDirs.delete(dir)
      ownedTempDirs.add(dir)
      return
    }
  }
}

/** 本进程同时保留的溢出目录上限。
 *
 * 🔴 少了它，溢出目录**在整个进程生命周期内只增不减**：每个超过 64KB 的响应留一份
 * `response.json`，每个下载留一份原文件，而唯一的回收在 `cleanupStaleTempDirs` —— 那是
 * **启动时**扫 24 小时前的目录。一个常驻跑几天的 MCP server 因此永远等不到自己的清理：
 * 磁盘上的 response.json 一直堆着，`ownedTempDirs` 这个 Set 也跟着单调增长。
 *
 * 200 份足够覆盖任何真实的翻页会话——**前提是淘汰按 LRU**：回读会把该目录移到 MRU 端
 * （见 `touchOwnedTempDir`），所以正在翻页的那一份不会被后来的溢出挤掉。 */
export const MAX_OWNED_TEMP_DIRS = 200

/** 本进程溢出目录的**总字节**配额。
 *
 * 🔴 只限数量挡不住磁盘：200 个目录里若有几个是几百 MB 的下载（研报 PDF、原始音频），
 * 数量远没到上限而磁盘已经满了。两个维度都要有——数量挡「小文件积攒」，字节挡「大文件
 * 少数几个就占满」。
 *
 * 2 GiB：单个下载再大也很少超过几百 MB，留得下十几份；同时对开发机/容器的临时区是个
 * 不至于填满的量级。淘汰仍按 LRU，正在回读的那份不会被挤掉。 */
export const MAX_OWNED_TEMP_BYTES = 2 * 1024 * 1024 * 1024

/** 目录占用字节（递归）。失败按 0 计——配额是尽力而为的housekeeping，
 * 不能因为一次 stat 失败就把创建溢出这件事搞砸。 */
async function dirBytes(dir: string): Promise<number> {
  let total = 0
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) total += await dirBytes(full)
      else total += (await fs.stat(full)).size
    }
  } catch {
    // ignore
  }
  return total
}

/** Creates a unique gangtise-mcp- temp dir and records it as owned by this process.
 *
 * Evicts the oldest dirs beyond MAX_OWNED_TEMP_DIRS — both from disk and from the
 * owned set, so a path that no longer exists also stops being readable. Eviction is
 * best-effort and never fails the caller: the spill this call is about to write
 * matters more than reclaiming an old one. */
export async function createManagedTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), TMP_DIR_PREFIX))
  ownedTempDirs.add(await fs.realpath(dir))
  await evictOldestOwned()
  return dir
}

/** 正在进行中的溢出回读数。
 *
 * 🔴 `touchOwnedTempDir` 要在 `realpath`/`stat`/`utimes` 几个 await 之后才轮得到调用，
 * 而并发的另一次工具调用可以在这中间产生新溢出并触发淘汰 —— 复核方用暂停钩子在既有的
 * `utimes` 等待点确定性复现了：目标目录被删，回读以 ENOENT 结束、后续页永久丢失。
 * 「移到 MRU 端」是**淘汰时**的排序，救不了「排序还没来得及更新」的那个窗口。
 *
 * 处置是**读期间整体挂起淘汰**，而不是给每个目录记引用计数：回读很短，推迟一轮淘汰没有
 * 代价（下一次溢出创建会把积压的一并清掉），而引用计数要配对释放、漏一次就永久泄漏一格。 */
let activeSpillReads = 0

export function beginSpillRead(): void { activeSpillReads += 1 }
export function endSpillRead(): void { activeSpillReads = Math.max(0, activeSpillReads - 1) }

/** 目录已被删除时，把它从登记表里一并摘掉。**每个 `fs.rm(tempDir)` 都必须配对调用。**
 *
 * 🔴 少了它，删除留下的是**墓碑**：磁盘上没有了，`ownedTempDirs` 里还占着一格。而
 * `MAX_OWNED_TEMP_DIRS` 数的是这个集合的大小，于是墓碑挤占的是**活目录**的名额 ——
 * 下载走「返回直链」或「文本正文」两条路径时目录建了就删，攒够 200 个墓碑后，一次真实
 * 溢出就会把**先于它们创建、仍在等回读**的那份挤出去（淘汰按插入序取最旧的一批，墓碑
 * 是最旧的没错，但活目录若创建得更早就排在它们前面）。调用方随后回读得到 ENOENT，
 * 若原结果来自计费端点就只能重新付费再查。
 *
 * 幂等：不在集合里就是 no-op。 */
export function releaseOwnedTempDir(dir: string): void {
  const owned = resolveOwned(dir)
  if (owned) ownedTempDirs.delete(owned)
}

/** 把调用方手上的路径对回集合里登记的那一条。
 *
 * 🔴 两者可以不相等：`mkdtemp` 返回 `/var/folders/...`，而登记的是 `realpath` 解析后的
 * `/private/var/folders/...`（macOS 的 /var 是符号链接）。按原样 `delete` 会**静默失配**
 * —— 墓碑照留，这个函数等于没写。basename 是 mkdtemp 生成的唯一后缀，够用来对齐。 */
function resolveOwned(dir: string): string | undefined {
  if (ownedTempDirs.has(dir)) return dir
  const base = path.basename(dir)
  for (const owned of ownedTempDirs) {
    if (path.basename(owned) === base) return owned
  }
  return undefined
}

/** 写完溢出文件之后再执行一次字节配额。
 *
 * 🔴 `createManagedTempDir` 里那次执行是**在空目录上**做的：文件还没写，统计出来是 0。
 * 所以它实际只是「下一次创建溢出时清理上一次的」，拦不住**本次**写入把磁盘填满。
 * 每个落盘点写完都要调这个。
 *
 * `protect` 是**刚写完的那一份**。不传的话就得靠「集合最后一项多半是它」这个假设，而
 * 该假设在两种常见情形下不成立：并发的另一次下载后插入、或另一条路径刚留下一个墓碑。
 * 猜错的代价是把调用方刚拿到的 `_saved_to` 立刻作废，所以这里要求显式传。 */
export async function enforceOwnedTempQuota(protect?: string): Promise<void> {
  await evictOldestOwned(protect)
}

async function evictOldestOwned(protect?: string): Promise<void> {
  // 有回读在飞就不淘汰 —— 下一次创建溢出时会把积压的一起清掉。
  if (activeSpillReads > 0) return

  const keep = protect ? resolveOwned(protect) : undefined

  // 先按**数量**削（便宜，不用 stat）
  const excess = ownedTempDirs.size > MAX_OWNED_TEMP_DIRS
    ? [...ownedTempDirs].filter((d) => d !== keep).slice(0, ownedTempDirs.size - MAX_OWNED_TEMP_DIRS)
    : []
  for (const old of excess) {
    ownedTempDirs.delete(old)
    await fs.rm(old, { recursive: true, force: true }).catch(() => {})
  }

  // 再按**字节**削：数量没超、但少数几个大下载就能占满磁盘。
  // 从最久未用的一端开始丢，直到回到配额内。
  let evictedForBytes = 0
  const sizes = new Map<string, number>()
  let total = 0
  for (const dir of ownedTempDirs) {
    const size = await dirBytes(dir)
    sizes.set(dir, size)
    total += size
  }
  if (total > MAX_OWNED_TEMP_BYTES) {
    // 从最久未用的一端丢。⚠️ **刚写完的那一份不参与淘汰**：淘汰它等于把调用方刚拿到的
    // _saved_to 立刻作废。单份自己就超配额的情况由落盘侧的流量上限拦（见 client.download
    // 的 MAX_SPILL_BYTES），不在这里处理。
    //
    // 🔴 判据是调用方**显式传进来的** `protect`，不是「集合最后一项」。后者只在「没有并发、
    // 且没有别的路径刚插入过」时才碰巧成立 —— 一次并发下载、或另一条路径新建的目录，都会
    // 让最后一项不是刚写完的那份，于是保护落到别人头上而真正该保的被删。
    const evictable = [...ownedTempDirs].filter((d) => d !== (keep ?? [...ownedTempDirs].at(-1)))
    for (const dir of evictable) {
      if (total <= MAX_OWNED_TEMP_BYTES) break
      ownedTempDirs.delete(dir)
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      total -= sizes.get(dir) ?? 0
      evictedForBytes += 1
    }
  }

  if ((excess.length > 0 || evictedForBytes > 0) && isVerbose()) {
    process.stderr.write(`[gangtise] evicted ${excess.length} spill dir(s) over the count cap, ${evictedForBytes} over the byte quota\n`)
  }
}

/** Test-only: 登记表当前占用的名额数。
 *
 * 墓碑的定义是「磁盘上没有、登记表里还有」——所以按 `readdir(tmpdir)` 遍历是**观测不到**
 * 它的，回归测试只能直接读这个数。少了它，「某条早退路径漏调 release」的变异只能靠扫源码
 * 抓，而扫源码抓不到「调了但对象不对」这类错。 */
export function ownedTempDirCount(): number {
  return ownedTempDirs.size
}

/** Test-only: reset the owned-dir registry between cases. */
export function resetOwnedTempDirs(): void {
  ownedTempDirs.clear()
  activeSpillReads = 0
}

/** True when `realPath` (already realpath-resolved) lives in a temp dir this process created. */
export function isOwnedTempPath(realPath: string): boolean {
  for (const dir of ownedTempDirs) {
    if (realPath === dir || realPath.startsWith(dir + path.sep)) return true
  }
  return false
}

interface DirEntryStat {
  name: string
  mtimeMs: number
}

/** Pure: pick the prefixed temp dirs older than maxAgeMs. */
export function selectStaleTempDirs(entries: DirEntryStat[], prefix: string, now: number, maxAgeMs: number): string[] {
  return entries
    .filter((e) => e.name.startsWith(prefix) && now - e.mtimeMs > maxAgeMs)
    .map((e) => e.name)
}

/**
 * Best-effort sweep of stale gangtise-mcp-* temp dirs left behind by
 * buildToolContent / buildTextResult / downloads. Swallows all errors —
 * cleanup must never break server startup. Returns the dirs removed.
 */
export async function cleanupStaleTempDirs(now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<string[]> {
  const tmp = os.tmpdir()
  let names: string[]
  try {
    names = await fs.readdir(tmp)
  } catch {
    return []
  }

  const stats: DirEntryStat[] = []
  for (const name of names) {
    if (!name.startsWith(TMP_DIR_PREFIX)) continue
    try {
      const st = await fs.stat(path.join(tmp, name))
      if (st.isDirectory()) stats.push({ name, mtimeMs: st.mtimeMs })
    } catch {
      // ignore unreadable entries
    }
  }

  const stale = selectStaleTempDirs(stats, TMP_DIR_PREFIX, now, maxAgeMs)
  const removed: string[] = []
  for (const name of stale) {
    try {
      await fs.rm(path.join(tmp, name), { recursive: true, force: true })
      removed.push(name)
    } catch {
      // ignore
    }
  }

  if (removed.length > 0 && isVerbose()) {
    process.stderr.write(`[gangtise] cleaned ${removed.length} stale temp dir(s)\n`)
  }
  return removed
}
