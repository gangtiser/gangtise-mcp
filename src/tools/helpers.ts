import { errorMessage } from "../core/errors.js"
import { runWithRequestContext } from "../core/requestContext.js"

export interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  // MCP CallToolResult carries an open index signature (_meta etc.); mirror it
  // so handlers wrapped by toolHandler satisfy registerTool's callback type.
  [key: string]: unknown
}

/** SDK 传给 handler 的第二个参数里我们只用 `signal`：客户端超时或主动取消时它会触发。 */
export interface HandlerExtra {
  signal?: AbortSignal
}

/** Wrap raw text into a single MCP text content block. */
export function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] }
}

/** Wrap content blocks (e.g. from buildToolContent) into a tool result. */
export function contentResult(content: Array<{ type: "text"; text: string }>): ToolTextResult {
  return { content }
}

/** Standard error result: surfaces a user-facing message and sets isError. */
export function errorResult(err: unknown): ToolTextResult {
  return { content: [{ type: "text", text: errorMessage(err) }], isError: true }
}

/**
 * Wraps a tool handler so any thrown error becomes a uniform error result, and
 * carries the request's cancel signal into the call chain (see requestContext.ts):
 * once the client gives up, no further page / shard / retry / poll is issued.
 */
export function toolHandler<A>(
  fn: (args: A) => Promise<ToolTextResult>,
): (args: A, extra?: HandlerExtra) => Promise<ToolTextResult> {
  return async (args: A, extra?: HandlerExtra) => {
    try {
      return await runWithRequestContext(extra?.signal, () => fn(args))
    } catch (err) {
      if (extra?.signal?.aborted) return errorResult(new Error("请求已被客户端取消，未再发出后续的分页 / 分片 / 轮询请求。"))
      return errorResult(err)
    }
  }
}
