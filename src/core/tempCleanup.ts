import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { isVerbose } from "./transport.js"

const TMP_DIR_PREFIX = "gangtise-mcp-"
/** Temp dirs from truncated responses / downloads older than this are swept on startup. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

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
