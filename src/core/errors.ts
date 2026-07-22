export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class ConfigError extends CliError {}
export class ValidationError extends CliError {}
export class DownloadError extends CliError {}

export class AsyncTimeoutError extends CliError {
  constructor(public readonly dataId: string) {
    super(`Async content not ready after timeout (dataId: ${dataId})`)
    this.name = "AsyncTimeoutError"
  }
}

/** Outer-envelope traceId, stashed on the unwrapped payload so it survives
 * `unwrapEnvelope` discarding the envelope. Needed by the EDE endpoints alone:
 * they double-wrap, and the traceId lives only on the OUTER envelope — the inner
 * failure envelope (`{code, status: false, msg}`) has none. Without this the one
 * correlation id Gangtise support can trace is gone exactly where the inner
 * failure is raised. Non-enumerable so it never reaches tool output. */
export const ENVELOPE_TRACE_ID = Symbol("gangtise.envelopeTraceId")

export function attachEnvelopeTraceId<T>(payload: T, traceId: unknown): T {
  if (payload && typeof payload === "object" && (typeof traceId === "string" || typeof traceId === "number")) {
    Object.defineProperty(payload, ENVELOPE_TRACE_ID, { value: String(traceId), enumerable: false, configurable: true })
  }
  return payload
}

/** Keyed by the code as a string — `unwrapEnvelope` runs every envelope code
 * through `String()` first, which matters because the 2026-07-17 error-code
 * overhaul emits the new codes as JSON *numbers* while legacy codes stay strings.
 *
 * Both generations are listed on purpose. The sibling CLI probed all 41 public
 * codes on 2026-07-20: the migration runs per error-handling layer, not per
 * endpoint — inside one interface the parameter-validation and routing layers
 * already answer with new codes while the method router and token filter still
 * emit old ones. Dropping either set would leave a live code hintless.
 *
 * A hint is appended AFTER the server's own msg (see `errorMessage`), so it must
 * carry the *action* and never restate the diagnosis — "资源不存在 资源不存在，
 * 确认 ID 有效" reads as a stutter. */
const ERROR_HINTS: Record<string, string> = {
  // ── 服务统一层 999xxx ──
  "999001": "检查 GANGTISE_TOKEN 或 GANGTISE_ACCESS_KEY / GANGTISE_SECRET_KEY 是否已配置。",
  "999002": "配了 AK/SK 时会自动重新登录重试一次；仅配 GANGTISE_TOKEN 时请手动更新令牌。反复出现说明有其他客户端用同一账号反复登录挤掉本会话。",
  "999003": "定制接口需联系客户经理开通。",
  "999004": "换一条本账号可见的记录重试。",
  "999005": "联系客户经理充值，或缩小查询范围降低消耗。",
  // 与 transport 的 RATE_LIMIT_API_CODES 一一对应，改一处必须改另一处：
  // 普通端点对任何状态下的 999006 都退避重试；按次计费的 no-replay 端点只在 HTTP 429
  // 时重试（429 由服务端在处理前拒绝，重放不会重复计费），非 429 形态一律不重放。
  // errors.test.ts 有断言把这句话与 isRetryableError 的实际判定钉在一起，防止再次漂移。
  "999006": "稍后再试或联系客户经理提额；普通端点会自动退避重试，按次计费端点仅在 HTTP 429 时重试、非 429 错误信封不重放。",
  "999007": "接口方法不被支持，服务端路由可能已变更，请报障。",
  "999008": "该接口只接受 application/json，请报障。",
  "999009": "请求体无法解析，检查参数中是否含非法字符。",
  "999010": "该接口可能已下线，请报障。",
  "999011": "检查 GANGTISE_ACCESS_KEY / GANGTISE_SECRET_KEY 是否写反或含多余空格；凭证错误不会自愈，已停止重试。",
  "999012": "联系客户经理。",
  "999013": "联系客户经理续期。",
  "999014": "联系客户经理。",
  "999015": "联系客户经理开通长期 token。",
  "999016": "联系客户经理登记当前出口 IP。",
  // 官方未文档化，实测见于 vault 接口。
  "999994": "联系客户经理核查该接口的权限与配额。",
  "999995": "联系客户经理充值，或缩小查询范围降低消耗。",
  "999997": "联系客户经理开通该接口权限。",
  "999999": "稍后重试；持续失败请带上报错行的 trace 报障。",

  // ── 业务通用层 1xxxxx ──
  "100001": "对照工具参数说明检查必填项。",
  "100002": "检查数值/字符串参数是否传反。",
  // 实测两种形态都有：类型/范围错的 msg 带字段（「请求体字段类型不匹配: size 期望类型
  // Integer」），枚举错的 msg 只有笼统的「参数值非法」。条件句让两种形态都读得通。
  "100003": "msg 已指明字段名或取值范围时按 msg 改；msg 只说「参数值非法」时多为枚举参数拼写错误，对照工具参数说明列出的合法值检查。",
  "100004": "检查 from / size 是否为非负数且未超单页上限。",
  "100005": "对照工具参数说明列出的合法取值检查。",
  "100006": "缩短日期范围或调小 size / limit。",
  // 按参数名判断，不要按工具族：ai 的 reportDate 是 date 型，而同属 ai 的
  // knowledge_batch 收 datetime 或 epoch 毫秒。
  "110001": "看参数名：*Date 用 YYYY-MM-DD，*Time 用 YYYY-MM-DD HH:mm:ss（gangtise_knowledge_batch 的 startTime/endTime 另可传 epoch 时间戳，10 位秒或 13 位毫秒）。",
  "110002": "起始晚于结束——检查 startDate/endDate 或 startTime/endTime 的先后。",
  "110003": "请缩小日期范围或改用更近日期。",
  "120001": "用 gangtise_securities_search 确认证券代码与后缀（如 600519.SH / 00700.HK / AAPL.O）。",
  "130001": "先核对查询条件；EDE 指标端点此码也可能是未开通该指标权限，仍失败联系客户经理。",
  "130002": "确认下载 ID 有效且本账号可见；下载类还需检查 fileType 取值是否合法（非法 fileType 也归此码）。",
  "130003": "该条记录可能未附带文件。",
  "130004": "下载 ID 需为数字，检查该工具的 *Id 参数是否传对。",
  "130005": "对照工具参数说明检查 fileType / contentType 取值。",
  "140001": "稍后用对应 *_check 工具查询。",
  "140002": "更换参数重新提交；重查同一 dataId 结果不会变，重新提交会再次计费。",

  // ── 接口专有层 2xxxxx ──
  "210001": "换一篇，或改用对应 list 工具取摘要。",
  "220001": "改用对应 list 工具取摘要。",
  "230001": "只有自己上传的文件可下载。",
  "240001": "换更早的报告期。",
  "240002": "改述后重新提交。",
  "240003": "对照工具参数说明检查取值。",
  "250001": "检查 resourceType 与 sourceId 组合（两者都来自 gangtise_knowledge_batch 返回）。",

  // ── 旧码（2026-07-20 实测仍在线，或历史遗留） ──
  "0000001007": "检查 GANGTISE_TOKEN 或 GANGTISE_ACCESS_KEY / GANGTISE_SECRET_KEY 是否已配置。",
  "0000001008": "仅配 GANGTISE_TOKEN 时请手动更新令牌（或改配 GANGTISE_ACCESS_KEY/GANGTISE_SECRET_KEY 以自动刷新）；已配 key 仍报此错说明自动刷新重试后仍被拒，请检查是否有其他客户端用同一账号反复登录。",
  "900001": "对照工具参数说明检查必填项。",
  // 实测服务端用它表示「请求方法不正确」（HTTP 405，msg 为「请求类型有误」）；
  // 旧文档写作「请求缺少 uid」，据此排查会走错方向。
  "900002": "服务端路由可能已变更（请求方法不被接受），请报障。",
  "903301": "次日再试，或联系客户经理提额。",
  // EDE 专有旧码：未被 2026-07-17 重排收编，却是 indicator 取数最常见的两个报错。
  "410001": "检查必填参数及 ID 来源：板块 ID 用 gangtise_sector_search，行业/公告类别/地区 ID 用 gangtise_constant_list，题材 ID 用 gangtise_concept_search；EDE 指标端点此码多为漏传 indicatorCodeList / securityCodeList。",
  "410004": "换证券或日期确认该条件下本应有数据；仍失败多为未开通该指标，联系客户经理。",
  "410106": "读 gangtise_indicator_search 返回的 parameterList，用 indicatorParamList 补上 required:true 的参数（如 periodNum / startDate / fiscalYear）。",
  "410110": "稍后用对应 *_check 工具查询。",
  "410111": "更换参数重新提交；重查同一 dataId 结果不会变，重新提交会再次计费。",
  "430004": "确认 reportId 有效，或更换 fileType 重试（官方未文档化错误码）。",
  "430007": "缩短日期范围或调小 limit。",
  "433007": "检查 resourceType 与 sourceId 组合（两者都来自 gangtise_knowledge_batch 返回）。",
  "8000014": "检查 GANGTISE_ACCESS_KEY 是否正确、是否与 SECRET_KEY 写反。",
  "8000015": "检查 GANGTISE_SECRET_KEY 是否正确、是否与 ACCESS_KEY 写反。",
  "8000016": "联系客户经理核查账号状态。",
  "8000018": "联系客户经理续期。",
  "10011401": "联系客户经理开通白名单。",
}

export class ApiError extends CliError {
  readonly hint?: string

  constructor(
    message: string,
    readonly code?: string,
    readonly statusCode?: number,
    readonly details?: unknown,
    /** Parsed from a Retry-After response header (ms), when the server sent one. */
    readonly retryAfterMs?: number,
    /** Context-specific hint that beats the generic per-code table — e.g. EDE's
     * 999999 means "no data", not the table's "稍后重试". */
    hintOverride?: string,
  ) {
    super(message)
    this.hint = hintOverride ?? (code ? ERROR_HINTS[code] : undefined)
  }

  /** Server-side correlation id from the 2026-07-17 envelope
   * (`{code, errorType, msg, status, data, traceId}`). Read off `details` rather
   * than threading a 7th positional constructor arg through every call site.
   * Worth surfacing: it is the only handle Gangtise support can trace a failure by. */
  get traceId(): string | undefined {
    if (!this.details || typeof this.details !== "object") return undefined
    // Fall back to the outer envelope's id for double-wrapped (EDE) responses,
    // whose inner failure envelope carries no traceId of its own.
    const details = this.details as { traceId?: unknown } & Record<symbol, unknown>
    const value = details.traceId ?? details[ENVELOPE_TRACE_ID]
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const meta = [err.code && `错误码 ${err.code}`, err.traceId && `trace ${err.traceId}`].filter(Boolean)
    const base = meta.length ? `${err.message}（${meta.join("，")}）` : err.message
    return err.hint ? `${base} — ${err.hint}` : base
  }
  if (err instanceof Error) return err.message
  return String(err)
}
