import { FormData } from "undici"

import { ApiError } from "./errors.js"
import { flagFailedItems } from "./normalize.js"
import { ENDPOINTS } from "./endpoints.js"
import { HttpClient } from "./http.js"
import { requestPaginated } from "./paginate.js"
import { emptyResultFor } from "./shape.js"

export type { DownloadResponse } from "./http.js"

/** 取数入口：按端点的 kind 与分页声明分派——下载走 HTTP 层的 download，分页列表走分页层，
 *  其余一次 JSON 请求（逐条失败的批量写在这里统一标记）。 */
export class GangtiseClient extends HttpClient {
  async call(endpointKey: string, body?: unknown, query?: Record<string, string | number>, options?: { streamTo?: string }): Promise<unknown> {
    const endpoint = ENDPOINTS[endpointKey]
    if (!endpoint) {
      throw new ApiError(`Unknown endpoint key: ${endpointKey}`)
    }

    if (endpoint.kind === 'download') {
      return this.download(endpoint, query ?? {}, options)
    }
    if (endpoint.kind === 'upload') {
      throw new ApiError(`${endpointKey} 是上传端点，请用 uploadFile`)
    }

    if (endpoint.kind === 'json' && endpoint.pagination?.mode === 'offset') {
      return requestPaginated(this, endpoint, body)
    }

    let data: unknown
    try {
      data = await this.requestJson(endpoint, body)
    } catch (error) {
      const empty = emptyResultFor(endpoint, error)
      if (empty) return empty
      throw error
    }
    // 逐条失败藏在 `000000` 成功信封里。判据挂在端点上、在这里统一执行，而不是让每个
    // 工具的 handler 自己记得调一次 —— 规则复制成两份，早晚只改其中一份：下一个加逐条
    // 端点的人标了 `itemFailures` 就会以为完事，落地的正是注释警告的那个后果。
    return endpoint.itemFailures ? flagFailedItems(data) : data
  }

  /** 以 multipart/form-data 上传一个文件（字段名 `file`），外加文本字段（undefined 的不发）。鉴权、重试策略、
   *  信封处理与 JSON 请求共用 requestJson，只有请求体不同。文件以 Blob 传入：`fs.openAsBlob` 得到的是按需读
   *  磁盘的 Blob，发送时流式读出，不会先把整个文件读进内存。 */
  async uploadFile(endpointKey: string, file: { filename: string; blob: Blob }, fields: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const endpoint = ENDPOINTS[endpointKey]
    if (endpoint?.kind !== 'upload') throw new ApiError(`${endpointKey} 不是上传端点`)
    const form = new FormData()
    form.append('file', file.blob, file.filename)
    for (const [name, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(name, String(value))
    }
    return this.requestJson(endpoint, form)
  }
}
