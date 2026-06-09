import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { downloadToResult } from "../../../src/core/download.js"
import type { GangtiseClient } from "../../../src/core/client.js"
import type { EndpointDefinition } from "../../../src/core/endpoints.js"

const endpoint: EndpointDefinition = {
  key: "mock.download",
  method: "GET",
  path: "/mock/download",
  kind: "download",
  description: "Mock download",
}

describe("downloadToResult", () => {
  it("keeps content-disposition filenames inside the generated temp directory", async () => {
    const client = {
      download: async (_endpoint: EndpointDefinition, _query: Record<string, string | number>, options?: { streamTo?: string }) => {
        if (!options?.streamTo) throw new Error("missing stream destination")
        await fs.writeFile(options.streamTo, "payload")
        return {
          savedPath: options.streamTo,
          filename: "../escaped-report.pdf",
          contentType: "application/pdf",
        }
      },
    } as unknown as GangtiseClient

    const result = await downloadToResult(client, endpoint, {})
    try {
      expect(result.filename).toBe("escaped-report.pdf")
      expect(path.basename(result.savedPath ?? "")).toBe("escaped-report.pdf")
      expect(path.basename(path.dirname(result.savedPath ?? ""))).toMatch(/^gangtise-mcp-/)

      const tmpReal = await fs.realpath(os.tmpdir())
      const savedReal = await fs.realpath(result.savedPath ?? "")
      expect(savedReal.startsWith(tmpReal + path.sep)).toBe(true)
      expect(path.basename(path.dirname(savedReal))).toMatch(/^gangtise-mcp-/)
    } finally {
      if (result.savedPath) {
        const dir = path.dirname(result.savedPath)
        if (path.basename(dir).startsWith("gangtise-mcp-")) {
          await fs.rm(dir, { recursive: true, force: true })
        } else {
          await fs.rm(result.savedPath, { force: true })
        }
      }
    }
  })
})
