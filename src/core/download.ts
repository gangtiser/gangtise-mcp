import fs from "node:fs/promises"
import path from "node:path"

import type { GangtiseClient } from "./client.js"
import type { EndpointDefinition } from "./endpoints.js"
import { DownloadError } from "./errors.js"
import { createManagedTempDir, enforceOwnedTempQuota, releaseOwnedTempDir } from "./tempCleanup.js"

export interface DownloadResult {
  /** Presigned or redirect URL (caller should pass to user) */
  url?: string
  filename?: string
  /** Text content (Markdown, HTML, plain text) */
  text?: string
  contentType?: string
  /** Path to temp file on disk; caller is responsible for cleanup */
  savedPath?: string
}

const MIME_EXT: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/zip": ".zip",
  "application/json": ".json",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "application/octet-stream": ".bin",
}

function extFromContentType(contentType?: string): string {
  if (!contentType) return ".bin"
  const mime = contentType.split(";")[0].trim().toLowerCase()
  return MIME_EXT[mime] ?? ".bin"
}

function safeFilename(filename: string | undefined): string | undefined
function safeFilename(filename: string | undefined, fallback: string): string
function safeFilename(filename: string | undefined, fallback?: string): string | undefined {
  if (!filename) return fallback
  const basename = filename.split(/[\\/]/).pop()?.trim() ?? ""
  // eslint-disable-next-line no-control-regex -- 有意的：文件名里的控制字符必须剥掉
  const cleaned = basename.replace(/[\x00-\x1f\x7f]/g, "")
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback
  return cleaned
}

/** 删目录 + 从登记表摘除，成对执行。
 *
 * 🔴 只 `fs.rm` 不摘除会留下**墓碑**：`ownedTempDirs` 的容量上限数的是集合大小，墓碑
 * 因此挤占活目录的名额。下面六条早退路径（直链、文本正文、四类失败）都是建了就删，
 * 是墓碑的主要来源 —— 每一条都必须走这里，别再直接调 `fs.rm`。 */
async function dropTempDir(tempDir: string): Promise<void> {
  await fs.rm(tempDir, { recursive: true, force: true })
  releaseOwnedTempDir(tempDir)
}

/**
 * Downloads a file via the Gangtise client and returns a structured result.
 * For binary files, streams to a unique temp directory (not auto-cleaned).
 */
export async function downloadToResult(
  client: GangtiseClient,
  endpoint: EndpointDefinition,
  query: Record<string, string | number>,
): Promise<DownloadResult> {
  // For binary downloads, generate a unique temp dir first
  const tempDir = await createManagedTempDir()
  const tempPath = path.join(tempDir, "download.bin")

  let raw: Awaited<ReturnType<typeof client.download>>
  try {
    raw = await client.download(endpoint, query, { streamTo: tempPath })
  } catch (err) {
    // A mid-stream failure can leave a truncated download.bin behind; drop the
    // whole temp dir so a failed download never lingers as a partial file.
    await dropTempDir(tempDir)
    throw err
  }

  // Case 1: API returned a redirect/presigned URL
  if (raw.url) {
    // Clean up the unused temp file
    await dropTempDir(tempDir)
    return { url: raw.url, filename: safeFilename(raw.filename) }
  }

  // Case 2: Text content (Markdown, HTML, plain text)
  if (raw.text != null) {
    await dropTempDir(tempDir)
    return { text: raw.text, filename: safeFilename(raw.filename), contentType: raw.contentType }
  }

  // Case 3: Streamed to disk (binary)
  if (raw.savedPath) {
    try {
      const ext = extFromContentType(raw.contentType)
      const filename = safeFilename(raw.filename, `download${ext}`)
      // Rename to meaningful extension if needed
      const finalPath = path.join(tempDir, filename)
      if (finalPath !== raw.savedPath) {
        await fs.rename(raw.savedPath, finalPath)
      }
      // 下载已经落盘，这时才量得到真实体积。
      await enforceOwnedTempQuota(tempDir)
      return { savedPath: finalPath, filename, contentType: raw.contentType }
    } catch (err) {
      await dropTempDir(tempDir)
      throw err
    }
  }

  // Case 4: In-memory binary (fallback for small files)
  if (raw.data) {
    try {
      const ext = extFromContentType(raw.contentType)
      const filename = safeFilename(raw.filename, `download${ext}`)
      const finalPath = path.join(tempDir, filename)
      await fs.writeFile(finalPath, raw.data)
      // 与 Case 3 同理：字节配额只有在文件真正落盘之后才量得到。这条路径同样会把
      // 内容写进受管目录，漏掉它等于对「小文件走内存缓冲」这一整条路径不设配额。
      await enforceOwnedTempQuota(tempDir)
      return { savedPath: finalPath, filename, contentType: raw.contentType }
    } catch (err) {
      await dropTempDir(tempDir)
      throw err
    }
  }

  await dropTempDir(tempDir)
  throw new DownloadError("Unexpected download response: no url, text, or binary data")
}
