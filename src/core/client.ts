import { ApiError } from "./errors.js"
import { flagFailedItems } from "./normalize.js"
import { ENDPOINTS } from "./endpoints.js"
import { HttpClient } from "./http.js"
import { requestPaginated } from "./paginate.js"

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
  
    if (endpoint.kind === 'json' && endpoint.pagination?.enabled) {
      return requestPaginated(this, endpoint, body)
    }
  
    const data = await this.requestJson(endpoint, body)
    // 逐条失败藏在 `000000` 成功信封里。判据挂在端点上、在这里统一执行，而不是让每个
    // 工具的 handler 自己记得调一次 —— 规则复制成两份，早晚只改其中一份：下一个加逐条
    // 端点的人标了 `itemFailures` 就会以为完事，落地的正是注释警告的那个后果。
    return endpoint.itemFailures ? flagFailedItems(data) : data
  }
}
