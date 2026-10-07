import fs from "node:fs/promises"
import path from "node:path"

import type { GangtiseClient } from "./client.js"
import type { EndpointDefinition } from "./endpoints.js"
import { DownloadError } from "./errors.js"
import { createManagedTempDir, discardManagedTempDir, enforceOwnedTempQuota } from "./tempCleanup.js"

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
  "text/markdown": ".md",
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

/** 单个文件名的长度上限，按 UTF-8 字节算：ext4 / APFS 是 255 字节，NTFS 是 255 个 UTF-16 单元（不会多于 UTF-8 字节数）。 */
const MAX_FILENAME_BYTES = 255

/** 超长的文件名截到上限内、保留扩展名：UTF-8 文件名常是整段标题，原样落盘会 ENAMETOOLONG。按码点截，不切坏字符。 */
function fitFilename(filename: string): string {
  if (Buffer.byteLength(filename) <= MAX_FILENAME_BYTES) return filename
  const extname = path.extname(filename)
  // 只保留像扩展名的短后缀；「点后面一大段」不是扩展名，整体截断即可。
  const ext = Buffer.byteLength(extname) <= 16 ? extname : ""
  let budget = MAX_FILENAME_BYTES - Buffer.byteLength(ext)
  let stem = ""
  for (const char of filename.slice(0, filename.length - ext.length)) {
    budget -= Buffer.byteLength(char)
    if (budget < 0) break
    stem += char
  }
  return stem + ext
}

function safeFilename(filename: string | undefined): string | undefined
function safeFilename(filename: string | undefined, fallback: string): string
function safeFilename(filename: string | undefined, fallback?: string): string | undefined {
  if (!filename) return fallback
  const basename = filename.split(/[\\/]/).pop()?.trim() ?? ""
  // eslint-disable-next-line no-control-regex -- 有意的：文件名里的控制字符必须剥掉
  const cleaned = basename.replace(/[\x00-\x1f\x7f]/g, "")
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback
  return fitFilename(cleaned)
}

/**
 * Downloads a file via the Gangtise client and returns a structured result.
 * For binary files, streams to a unique temp directory (not auto-cleaned).
 */
export async function downloadToResult(
  client: GangtiseClient,
  endpoint: EndpointDefinition,
  query: Record<string, string | number>,
  /** POST 型下载的 JSON 请求体。 */
  body?: unknown,
): Promise<DownloadResult> {
  // For binary downloads, generate a unique temp dir first
  const tempDir = await createManagedTempDir()
  const tempPath = path.join(tempDir, "download.bin")

  let raw: Awaited<ReturnType<typeof client.download>>
  try {
    raw = await client.download(endpoint, query, { streamTo: tempPath, body })
  } catch (err) {
    // A mid-stream failure can leave a truncated download.bin behind; drop the
    // whole temp dir so a failed download never lingers as a partial file.
    await discardManagedTempDir(tempDir)
    throw err
  }

  // Case 1: API returned a redirect/presigned URL
  if (raw.url) {
    // Clean up the unused temp file
    await discardManagedTempDir(tempDir)
    return { url: raw.url, filename: safeFilename(raw.filename) }
  }

  // Case 2: Text content (Markdown, HTML, plain text)
  if (raw.text != null) {
    await discardManagedTempDir(tempDir)
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
      await discardManagedTempDir(tempDir)
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
      await discardManagedTempDir(tempDir)
      throw err
    }
  }

  await discardManagedTempDir(tempDir)
  throw new DownloadError("Unexpected download response: no url, text, or binary data")
}
