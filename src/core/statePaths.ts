/** 上传的本机文件不能指向本服务自己的状态：token 缓存所在目录（存着有效的访问令牌），或
 *  GANGTISE_TOKEN_CACHE_PATH 挪到别处的 token 缓存——读它等于把令牌随上传发出去。目标路径交给系统解析
 *  （软链、`..`），再逐级向上按设备号 + inode 比对，同一位置的其他写法（大小写不敏感的磁盘上换大小写）一样拒绝。 */
import fs from "node:fs/promises"
import path from "node:path"

import { DEFAULT_TOKEN_CACHE_PATH, loadConfig } from "./config.js"
import { ValidationError } from "./errors.js"

const identity = async (target: string): Promise<string | undefined> => {
  const stat = await fs.stat(target).catch(() => undefined)
  return stat ? `${stat.dev}:${stat.ino}` : undefined
}

/** 系统实际会到达的路径：最深的已存在部分按 realpath 解析，其余照接。 */
async function physical(target: string): Promise<string> {
  const rest: string[] = []
  // 不用 path.resolve：它按文本折叠 `..`，而系统是先跟随前面的软链再处理 `..`。
  let head = path.isAbsolute(target) ? target : `${process.cwd()}${path.sep}${target}`
  for (;;) {
    const real = await fs.realpath(head).catch(() => undefined)
    if (real) return path.join(real, ...rest)
    const parent = path.dirname(head)
    if (parent === head) return path.resolve(target)
    rest.unshift(path.basename(head))
    head = parent
  }
}

export async function assertNotStatePath(target: string, param: string): Promise<void> {
  const stateDir = path.dirname(DEFAULT_TOKEN_CACHE_PATH)
  const tokenCache = loadConfig().tokenCachePath
  const guarded = new Set((await Promise.all([stateDir, tokenCache].map(identity))).filter((id): id is string => id !== undefined))
  const resolved = await physical(target)
  // 还不存在的 token 缓存没有 inode 可比，用路径代替。
  let refused = resolved === await physical(tokenCache)
  for (let current = resolved; !refused; ) {
    const id = await identity(current)
    if (id && guarded.has(id)) refused = true
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  if (refused) {
    throw new ValidationError(`${param} ${target} 指向本服务存放访问令牌的位置（${stateDir}，或 token 缓存 ${tokenCache}），不能上传，请换一个路径。`)
  }
}
