import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DownloadError } from "./errors.js";
const MIME_EXT = {
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
};
function extFromContentType(contentType) {
    if (!contentType)
        return ".bin";
    const mime = contentType.split(";")[0].trim().toLowerCase();
    return MIME_EXT[mime] ?? ".bin";
}
/**
 * Downloads a file via the Gangtise client and returns a structured result.
 * For binary files, streams to a unique temp directory (not auto-cleaned).
 */
export async function downloadToResult(client, endpoint, query) {
    // For binary downloads, generate a unique temp dir first
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gangtise-mcp-"));
    const tempPath = path.join(tempDir, "download.bin");
    const raw = await client.download(endpoint, query, { streamTo: tempPath });
    // Case 1: API returned a redirect/presigned URL
    if (raw.url) {
        // Clean up the unused temp file
        await fs.rm(tempDir, { recursive: true, force: true });
        return { url: raw.url, filename: raw.filename };
    }
    // Case 2: Text content (Markdown, HTML, plain text)
    if (raw.text != null) {
        await fs.rm(tempDir, { recursive: true, force: true });
        return { text: raw.text, filename: raw.filename, contentType: raw.contentType };
    }
    // Case 3: Streamed to disk (binary)
    if (raw.savedPath) {
        const ext = extFromContentType(raw.contentType);
        const filename = raw.filename ?? `download${ext}`;
        // Rename to meaningful extension if needed
        const finalPath = path.join(tempDir, filename);
        if (finalPath !== raw.savedPath) {
            await fs.rename(raw.savedPath, finalPath);
        }
        return { savedPath: finalPath, filename, contentType: raw.contentType };
    }
    // Case 4: In-memory binary (fallback for small files)
    if (raw.data) {
        const ext = extFromContentType(raw.contentType);
        const filename = raw.filename ?? `download${ext}`;
        const finalPath = path.join(tempDir, filename);
        await fs.writeFile(finalPath, raw.data);
        return { savedPath: finalPath, filename, contentType: raw.contentType };
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    throw new DownloadError("Unexpected download response: no url, text, or binary data");
}
