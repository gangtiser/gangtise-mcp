import { errorMessage } from "../core/errors.js"

export interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  // MCP CallToolResult carries an open index signature (_meta etc.); mirror it
  // so handlers wrapped by toolHandler satisfy registerTool's callback type.
  [key: string]: unknown
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
 * Wraps a tool handler so any thrown error becomes a uniform error result.
 * Removes the repeated try/catch boilerplate from hand-registered tools.
 */
export function toolHandler<A>(
  fn: (args: A) => Promise<ToolTextResult>,
): (args: A) => Promise<ToolTextResult> {
  return async (args: A) => {
    try {
      return await fn(args)
    } catch (err) {
      return errorResult(err)
    }
  }
}
