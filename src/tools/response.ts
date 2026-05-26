import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { errorMessage } from "../core/errors.js"

const TMP_DIR_PREFIX = "gangtise-mcp-"
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

async function readSavedFile(savedTo: string): Promise<string> {
  let real: string
  try {
    real = await fs.realpath(savedTo)
  } catch {
    throw new Error(`saved_to path not found: ${savedTo}`)
  }
  const tmpReal = await fs.realpath(os.tmpdir())
  if (!real.startsWith(tmpReal + path.sep)) {
    throw new Error("saved_to must be inside the system tmpdir")
  }
  const parentName = path.basename(path.dirname(real))
  if (!parentName.startsWith(TMP_DIR_PREFIX)) {
    throw new Error(`saved_to must reside in a directory prefixed by ${TMP_DIR_PREFIX}`)
  }
  return fs.readFile(real, "utf8")
}

export function registerResponseTools(server: McpServer, _client: GangtiseClient): void {
  server.registerTool(
    "gangtise_read_response",
    {
      description:
        "读取被截断的大响应。当其他工具返回 `_truncated: true` 且包含 `_saved_to` 临时文件路径时，用此工具按 offset/limit 分片读取完整数据。仅可读取本进程在系统临时目录下生成的 gangtise-mcp- 前缀文件。",
      inputSchema: {
        saved_to: z
          .string()
          .describe("被截断响应的临时文件路径（来自其他工具响应中的 _saved_to 字段）"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("起始条目索引（从 0 开始），默认 0"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`本次返回的条目数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}`),
      },
    },
    async ({ saved_to, offset = 0, limit = DEFAULT_LIMIT }) => {
      try {
        const raw = await readSavedFile(saved_to)
        const data = JSON.parse(raw)

        let list: unknown[]
        let rest: Record<string, unknown> = {}
        if (Array.isArray(data)) {
          list = data
        } else if (
          data !== null &&
          typeof data === "object" &&
          Array.isArray((data as Record<string, unknown>).list)
        ) {
          const obj = data as Record<string, unknown>
          list = obj.list as unknown[]
          rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "list"))
        } else {
          const payload = {
            data,
            _saved_to: saved_to,
            _total_items: null,
            _offset: 0,
            _returned: 1,
            has_more: false,
            next_offset: null,
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] }
        }

        const total = list.length
        const start = Math.min(offset, total)
        const end = Math.min(start + limit, total)
        const slice = list.slice(start, end)

        const payload = {
          ...rest,
          list: slice,
          _saved_to: saved_to,
          _total_items: total,
          _offset: start,
          _returned: slice.length,
          has_more: end < total,
          next_offset: end < total ? end : null,
        }

        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true }
      }
    },
  )
}
