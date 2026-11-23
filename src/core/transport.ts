import { Agent, interceptors, Pool, ProxyAgent, type Dispatcher } from "undici"

import { GLOBAL_CONCURRENCY, PAGE_CONCURRENCY, resolveProxyUrl, resolveTimeoutMs } from "./config.js"
import { ApiError, errorMessage } from "./errors.js"

/** 每个源的连接数。分页扇出 / 分片按 GANGTISE_PAGE_CONCURRENCY 并发、全局按
 *  GANGTISE_MCP_GLOBAL_CONCURRENCY 封顶，池子比它们小时多出来的请求会在 undici 内部排队，调大
 *  并发等于没调；16 是两者取默认值时的下限。 */
export const POOL_CONNECTIONS = Math.max(16, PAGE_CONCURRENCY, GLOBAL_CONCURRENCY)

let cachedDispatcher: Dispatcher | null = null

let cachedTransferAgent: Dispatcher | null = null

let cachedDownloadDispatcher: Dispatcher | null = null

const agentOptions = { keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: POOL_CONNECTIONS, pipelining: 1 }

/** 代理没有打开隧道时的错误码（见 proxyClient）。 */
const PROXY_TUNNEL_CODE = "GANGTISE_PROXY_TUNNEL"
/** 代理应答隧道请求（CONNECT）的时限：隧道属于建连，且不超过一次请求允许的无数据时长。 */
const PROXY_TUNNEL_TIMEOUT_MS = 10_000

/** 向代理请求隧道的那个连接池。undici 在这里留了两个口子：
 *  - 请求自己的超时要等上了连接才开始算，代理迟迟不应答 CONNECT 时只受 undici 几分钟的默认值约束——这里给它一个时限；
 *  - 隧道请求死于套接字错误（端口收下 CONNECT 就断开，只开 SOCKS 的端口就这样）时，undici 当作值得重连的连接，
 *    立刻、无限地重连，等着的请求既不失败也不超时。
 *  所以隧道请求的失败一律换成自己的错误码抛出，像没建立起来的连接一样结束请求；建连阶段的四个错误码与中止原样放行
 *  （已按建连失败处理）。原错误挂在 `cause` 上，供 connectionHint 判读。 */
function proxyClient(origin: URL, options: object): Pool {
  const deadline = Math.min(PROXY_TUNNEL_TIMEOUT_MS, resolveTimeoutMs(process.env.GANGTISE_TIMEOUT_MS))
  const pool = new Pool(origin, { ...options, headersTimeout: deadline })
  const requestTunnel = pool.connect.bind(pool) as (tunnel: unknown) => Promise<TunnelAnswer>
  pool.connect = (async (tunnel: unknown) => {
    let answer: TunnelAnswer
    try {
      answer = await requestTunnel(tunnel)
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (typeof code === "string" && (NO_REPLAY_NETWORK_CODES.has(code) || code === "UND_ERR_ABORTED")) throw error
      const why = code === "UND_ERR_HEADERS_TIMEOUT" ? `no answer to the tunnel request within ${deadline / 1000}s` : errorMessage(error)
      throw Object.assign(new Error(`The proxy did not open a tunnel (${why})`), { code: PROXY_TUNNEL_CODE, cause: error })
    }
    // 代理临时拒开隧道（限流、自身故障；状态码见 RETRYABLE_HTTP_STATUS）：undici 会把它报成不重试的中止。换成带状态码与 Retry-After 的错误，
    // 走现有的退避；请求还没发往服务端，不重放的端点也照样重试（见 isRetryableError）。407 / 403 等不在此列。
    if (RETRYABLE_HTTP_STATUS.has(answer.statusCode)) {
      answer.socket.destroy()
      const error = new ApiError(`Proxy response (${answer.statusCode}) !== 200 when HTTP Tunneling`, undefined, answer.statusCode, undefined, parseRetryAfterMs(answer.headers["retry-after"]))
      throw Object.assign(error, { [PROXY_REFUSAL]: true })
    }
    return answer
  }) as typeof pool.connect
  return pool
}

/** Pool.connect 的应答里用到的部分。 */
interface TunnelAnswer {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  socket: { destroy(): void }
}

const PROXY_REFUSAL = Symbol("gangtise.proxyRefusal")

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, or undefined. */
export function parseRetryAfterMs(raw: string | string[] | undefined): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

let proxyNoted = false

/** 设了 GANGTISE_PROXY 时，查询与传输两个连接池都经它建隧道（CONNECT）；URL 里的账号作为 Proxy-Authorization 发出。 */
function createAgent(): Dispatcher {
  const proxy = resolveProxyUrl()
  if (!proxy) return new Agent(agentOptions)
  if (verboseEnabled && !proxyNoted) {
    proxyNoted = true
    // 只打主机与端口：URL 里可能有密码。
    process.stderr.write(`[gangtise] requests go through the proxy at ${proxy.host} (GANGTISE_PROXY)\n`)
  }
  // undici 只在用户名与密码都非空时才发 Proxy-Authorization；只写了其中一个（如以令牌作用户名的代理）同样要发出去。
  const token = proxy.username || proxy.password ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` : undefined
  return new ProxyAgent({ ...agentOptions, uri: proxy.href, token, clientFactory: proxyClient })
}

/** 下载与上传自己的连接池。它们另有一组并发名额（scheduler.ts 的 withDownloadSlot），却曾与查询共用同一个
 *  Agent：同源的慢下载占满每源的连接，查询就在 undici 内部排队，名额分开也白分。 */
export function getTransferAgent(): Dispatcher {
  if (!cachedTransferAgent) cachedTransferAgent = createAgent()
  return cachedTransferAgent
}

const HOPS = Symbol("gangtise.hops")

/** 一次下载请求走过的跳数：首个请求算一跳，每跟随一次重定向再加一。`crossed`：某一跳离开过首个请求的源——undici
 *  跨源时剥掉 Authorization，之后即便跳回原站也不再带上，所以只看终点的源不够。 */
export interface HopCounter {
  count: number
  first?: string
  crossed?: boolean
}

/** 给 `request()` 的选项挂上跳数计数器（见 countHops）。 */
export function trackHops<T extends object>(options: T, hops: HopCounter): T {
  return Object.assign(options, { [HOPS]: hops })
}

/** 垫在 redirect 拦截器下面：它每发一跳都经过这里。源按 URL 的 origin 比（协议、主机、端口），与 undici 判断
 *  跨源剥 Authorization 的口径一致。 */
const countHops: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) => {
  const hops = (opts as { [HOPS]?: HopCounter })[HOPS]
  if (hops) {
    const origin = new URL(String(opts.origin)).origin
    if (hops.count === 0) hops.first = origin
    else if (origin !== hops.first) hops.crossed = true
    hops.count++
  }
  return dispatch(opts, handler)
}

/** 下载族专用：在传输连接池上叠一层 redirect 拦截器。
 *
 * 🔴 只给下载开，不给 JSON 开：JSON 端点不应该重定向，那里出现 30x 是异常信号，
 * 静默跟随会把它藏起来。下载则相反 —— 对象存储的签名 URL 常用 30x，不跟随时客户端会把
 * redirect body 当成正常文本结果交出去：既拿不到文件，报错也不指向真因。
 *
 * ✅ 令牌安全性已实测（2026-08-30）：undici 在**跨源**跳转时会剥掉 `Authorization`，
 * 所以令牌不会跟到对象存储的域名上；同源跳转才保留。不需要自己拆头。
 * 跳数 3，与 gangtise CLI 一致。跳数按请求计（`trackHops`）：跟随过重定向之后的失败发生在文件地址上，
 * 不重放的端点据此不再重发下载请求（见 markFileStep）。 */
export function getDownloadDispatcher(): Dispatcher {
  if (!cachedDownloadDispatcher) {
    cachedDownloadDispatcher = getTransferAgent().compose(countHops, interceptors.redirect({ maxRedirections: 3 }))
  }
  return cachedDownloadDispatcher
}

export function getDispatcher(): Dispatcher {
  if (!cachedDispatcher) {
    cachedDispatcher = createAgent()
  }
  return cachedDispatcher
}

/** 取消信号上挂着的原因；SDK 传的是字符串或 undefined，统一成能进 errorMessage 的值。 */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("请求已取消")
}

/** 可取消的等待：信号触发时立刻以 signal.reason 拒绝，不等计时器走完。
 *  重试退避与异步轮询的间隔都走这里——客户端已经放弃的请求，不该再睡满 30s 才发现。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return []
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results: R[] = new Array(items.length)
  let next = 0
  let firstError: unknown = null

  async function worker(): Promise<void> {
    // Stop pulling new work once any worker has failed, so we don't waste
    // requests after the batch is already doomed. 同理，调用方已取消时不再派发
    // 尚未开始的条目——已在飞的那几条由各自的 HTTP signal 中止。
    while (firstError === null && !signal?.aborted) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        // Capture the first failure and resolve quietly — re-throwing here would
        // surface as an unhandled rejection once Promise.all has already settled.
        if (firstError === null) firstError = err
        return
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()))
  if (firstError !== null) throw firstError
  if (signal?.aborted) throw abortReason(signal)
  return results
}

const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504])
const RETRYABLE_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", PROXY_TUNNEL_CODE])
const RETRYABLE_API_CODES = new Set(["999999"])
// Never replayed on any HTTP status:
// - 999011 CREDENTIAL_INVALID (bad AK/SK): a 5xx would otherwise be replayed twice
//   by the status rule, and a credential error never fixes itself.
// - 140002 PROCESSING_FAILED (the 2026-07-17 renumbering of 410111): the async
//   *_check endpoints declare no retry policy, so a 140002@500 would be retried 2×
//   by the default policy BEFORE asyncContent's terminal check sees it — that guard
//   sits above client.call's withRetry and cannot observe the retries. 140002 means
//   "generation failed" (terminal by definition) and only those async endpoints can
//   return it, so a blanket rule is safe and skips the wasted retries. The server
//   still emits 410111 today (410111@400 isn't retryable anyway); this is a forward
//   guard for the documented 140002@500.
// - 410111 / 410106 / 410001: terminal or deterministic by definition — a generation
//   that already failed, and two EDE parameter errors (missing indicator/security,
//   missing a required indicatorParamList entry). Replaying them with identical
//   arguments cannot change the answer. We have NOT observed the server return these
//   with a 5xx; the guard is for the shape, not a sighting — should any of them
//   arrive wrapped in a retryable status, the status rule would replay it 2× for a
//   verdict that cannot move, and on the per-cell-billed indicator endpoints those
//   replays may also cost credits. Gating by API code takes the question off the table.
const NON_RETRYABLE_API_CODES = new Set(["999011", "140002", "410111", "410106", "410001"])
// Rate limiting in envelope form: the 429 rule above only catches the HTTP form, so
// a 999006 arriving inside a 2xx/4xx envelope used to fail on the first attempt with
// the server's Retry-After parsed but never acted on. Checked AFTER the no-replay
// return on purpose — on no-replay endpoints we cannot prove the throttle fired
// before the handler executed, and a wrong guess double-bills.
const RATE_LIMIT_API_CODES = new Set(["999006"])
// Connect-phase / DNS failures: the request provably never reached the server, so a
// replay cannot double-execute (or double-bill) anything even under "no-replay".
// 代理没打开隧道（PROXY_TUNNEL_CODE）同属此类：请求还没有发往服务端。
const NO_REPLAY_NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", PROXY_TUNNEL_CODE])

const FILE_STEP = Symbol("gangtise.fileStep")

/** 标记「取文件那一步」的失败：下载接口已经应答（重定向到了文件地址），这时再发下载请求就是重放。 */
export function markFileStep<E>(error: E): E {
  if (error && typeof error === "object") Object.defineProperty(error, FILE_STEP, { value: true, enumerable: false, configurable: true })
  return error
}

function atFileStep(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as Record<symbol, unknown>)[FILE_STEP] === true)
}

const RETRIES_SPENT = Symbol("gangtise.retriesSpent")

/** 标记已经在自己的重试循环里试够了的错误（等 token 的请求里失败的登录），外层的重试循环见到它即结束，
 *  不把次数相乘。isTransientError 不看它：异步轮询照样等过这次失败，下一轮轮询重新登录。 */
export function markRetriesSpent<E>(error: E): E {
  if (error && typeof error === "object") Object.defineProperty(error, RETRIES_SPENT, { value: true, enumerable: false, configurable: true })
  return error
}

export function retriesSpent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as Record<symbol, unknown>)[RETRIES_SPENT] === true)
}

/** 连接根本没建立：建连阶段的四个错误码之一，或 connect() 以任何 errno 失败（无路由、网络不通）。
 *  主机有多个地址、全都连不上时是一个装着各次尝试的 AggregateError。 */
function connectFailed(error: unknown): boolean {
  const { code, syscall, errors } = (error ?? {}) as { code?: unknown; syscall?: unknown; errors?: unknown }
  if (syscall === "connect" || (typeof code === "string" && code !== PROXY_TUNNEL_CODE && NO_REPLAY_NETWORK_CODES.has(code))) return true
  return Array.isArray(errors) && errors.length > 0 && errors.every(connectFailed)
}

const PROXY_UNREACHABLE_HINT = "连不上 GANGTISE_PROXY 指向的代理：核对代理地址与端口，并确认本机能连到它。"
/** 端口收下连接又断开时，隧道请求失败的样子。 */
const TUNNEL_DROPPED_CODES = new Set(["UND_ERR_SOCKET", "UND_ERR_INFO", "ECONNRESET", "EPIPE"])

/** 代理没打开隧道时该查什么，按隧道请求失败的原因分。`target` 是隧道要通往的地方。 */
function tunnelHint(cause: unknown, target: string): string {
  const { code, name } = (cause ?? {}) as { code?: unknown; name?: unknown }
  if (connectFailed(cause)) return PROXY_UNREACHABLE_HINT
  if (code === "UND_ERR_HEADERS_TIMEOUT") return `GANGTISE_PROXY 指向的代理在限时内没有应答隧道请求：可能是代理连不到${target}（请网络管理员确认放行），也可能该端口不是 HTTP 代理。`
  // 回的不是 HTTP 时是 undici 的 HTTPParserError，这里不带 code。
  if (name === "HTTPParserError" || (typeof code === "string" && TUNNEL_DROPPED_CODES.has(code))) return "GANGTISE_PROXY 指向的地址没有按 HTTP 代理应答（连上后被断开，或回的不是 HTTP）：核对代理的地址、端口与协议（http:// 还是 https://），确认填的是 HTTP 代理端口而不是 SOCKS 端口。"
  return "经 GANGTISE_PROXY 指向的代理建立隧道失败，原因见前文：核对代理地址、端口与协议（http:// 还是 https://）。"
}

/** 常见的代理变量。本服务不读它们（见 config.ts 的 resolveProxyUrl），所以设了其中一个，多半就是请求没出去的原因。 */
const STANDARD_PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]

/** 请求根本没送达时该查什么——原始报错只有一个地址。其余失败返回 undefined。
 *
 * 看三件事：连接要去哪里（接口；或下载的取文件那一步，见 markFileStep，那时接口已经应答过）；设没设 GANGTISE_PROXY
 * （设了就只连代理，连不上说的是代理，代理拒开隧道回的是它的 HTTP 状态，没好好应答是 PROXY_TUNNEL_CODE）；
 * 以及怎么失败的（连接没建立，或建立后在 TLS 握手完成前被断开——两种都还什么都没发出）。没设代理时，环境里设了的
 * 常见代理变量只点名、不回显取值（可能带密码）。 */
export function connectionHint(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const fileStep = atFileStep(error)
  const target = fileStep ? "文件的下载地址" : "接口地址"
  // 取文件那一步要去的不是 GANGTISE_BASE_URL。
  const askAdmin = fileStep ? "请网络管理员确认代理放行该地址" : "核对 GANGTISE_BASE_URL，或请网络管理员确认代理放行该地址"
  const refused = /^Proxy response \((\d+)\)/.exec(error.message)
  if (refused) {
    if (refused[1] !== "407") return `GANGTISE_PROXY 指向的代理没有接通到${target}的连接（返回 ${refused[1]}）：${askAdmin}。`
    const proxy = resolveProxyUrl()
    return proxy?.username || proxy?.password
      ? "GANGTISE_PROXY 指向的代理拒绝了地址里的账号（407）：核对用户名与密码，特殊字符按 URL 编码（如 @ 写成 %40、% 写成 %25）。"
      : "GANGTISE_PROXY 指向的代理要求认证：把账号写进地址，如 http://用户名:密码@代理主机:端口（特殊字符按 URL 编码）。"
  }
  const { code, cause } = error as { code?: unknown; cause?: unknown }
  if (code === PROXY_TUNNEL_CODE) return tunnelHint(cause, target)
  const droppedBeforeTls = /before secure TLS connection was established/.test(error.message)
  if (!connectFailed(error) && !droppedBeforeTls) return undefined
  if (resolveProxyUrl()) {
    if (droppedBeforeTls) return `代理已经接通隧道，但与${target}的 TLS 握手被断开：${askAdmin}。`
    return code === "UND_ERR_CONNECT_TIMEOUT"
      ? `经 GANGTISE_PROXY 指向的代理建立连接超时：核对代理地址与端口；代理本身连得上时，多半是代理到${target}这一段不通，请网络管理员确认放行。`
      : PROXY_UNREACHABLE_HINT
  }
  if (fileStep) return "连不上文件的下载地址：下载接口已经应答，这一步是去它给出的地址取文件。检查到该地址的网络；所在网络须经 HTTP 代理出网时，在 MCP 配置的 env 里设置 GANGTISE_PROXY。"
  const standard = STANDARD_PROXY_VARIABLES.find((name) => process.env[name]?.trim())
  return standard
    ? `连不上接口地址：检查网络与 GANGTISE_BASE_URL。环境里设了 ${standard}，但本服务不读它——要让请求也走这个代理，在 MCP 配置的 env 里把 GANGTISE_PROXY 设成同一地址（须以 http:// 或 https:// 开头）。`
    : "连不上接口地址：检查网络与 GANGTISE_BASE_URL；所在网络须经 HTTP 代理出网时，在 MCP 配置的 env 里设置 GANGTISE_PROXY=http://代理主机:端口（本服务不读 HTTPS_PROXY / HTTP_PROXY）。"
}

/** "no-replay" (endpoints where a replay may bill twice — REPLAY safety, not a
 * billing model; see endpoints.ts): never resend a request the server may have
 * executed.
 * Only connect-phase errors, 429 (rejected before processing) and the explicit
 * token-self-heal mark retry; 5xx / response timeouts / 999999 fail fast. 下载取文件那一步
 * （markFileStep）的失败一律不重试，连接期错误与 429 也不例外。
 * "no-999999" (EDE indicator endpoints): 999999 is a server-side fault here (it
 * also meant "no data" until 2026-08-01; a no-data answer now keeps its row and
 * column and carries a `null` placeholder — the old indicator-dependent `0` tier
 * is gone) and
 * replaying an already-billed query buys nothing; everything
 * else follows the default policy. */
export type RetryPolicy = "default" | "no-replay" | "no-999999"

export function isRetryableError(error: unknown, policy: RetryPolicy = "default"): boolean {
  if (error && typeof error === "object" && (error as { __retryable?: boolean }).__retryable === true) {
    return true
  }
  // 下载接口已经应答过、取文件那一步失败：再发一次就是重放，无论失败是没连上还是文件地址回了 429。
  if (policy === "no-replay" && atFileStep(error)) return false
  // 代理对隧道请求回了 429 / 500 / 502 / 503 / 504（RETRYABLE_HTTP_STATUS）：请求还没发往服务端，按状态码退避重试。
  if ((error as Record<symbol, unknown> | null)?.[PROXY_REFUSAL] === true) return true
  if (error instanceof ApiError) {
    if (error.code && NON_RETRYABLE_API_CODES.has(error.code)) return false
    if (error.statusCode === 429) return true
    if (policy === "no-replay") return false
    if (error.code && RATE_LIMIT_API_CODES.has(error.code)) return true
    if (error.code && RETRYABLE_API_CODES.has(error.code)) return policy !== "no-999999"
    if (error.statusCode != null && RETRYABLE_HTTP_STATUS.has(error.statusCode)) return true
    return false
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code)
    if ((policy === "no-replay" ? NO_REPLAY_NETWORK_CODES : RETRYABLE_NETWORK_CODES).has(code)) return true
  }
  if (policy === "no-replay") return false
  if (error instanceof Error && /timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(error.message)) {
    return true
  }
  return false
}

export function markRetryable<E extends object>(error: E): E {
  return Object.assign(error, { __retryable: true })
}

/** Errors worth waiting out (anything the default policy would retry): transient
 * 5xx / network / timeout / 429 / 999999 / 999006. Used by async polling to survive
 * a blip without abandoning a multi-minute wait — a throttle mid-poll must not void
 * a generation that was already billed. */
export function isTransientError(error: unknown): boolean {
  return isRetryableError(error, "default")
}

export interface RetryOptions {
  retries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  policy?: RetryPolicy
  /** 已取消的请求不再重试，退避等待也会被立刻打断。 */
  signal?: AbortSignal
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void
}

/** Rate limits (HTTP 429) and any response carrying a Retry-After header get a
 * patient, capped backoff — hammering a throttled API only extends the throttle.
 * 5xx and network errors keep the fast generic backoff unchanged. */
const RATE_LIMIT_BASE_DELAY = 2_000
const RATE_LIMIT_MAX_DELAY = 15_000

export function computeRetryDelay(error: unknown, attempt: number, baseDelay: number, maxDelay: number): number {
  const retryAfterMs = error instanceof ApiError ? error.retryAfterMs : undefined
  // A throttle deserves the patient backoff however it arrived — HTTP 429 or the
  // 999006 envelope form. Without the code check the envelope form would fall back
  // to the fast generic schedule and hammer an already-throttled API.
  const isRateLimit = error instanceof ApiError && (error.statusCode === 429 || (error.code !== undefined && RATE_LIMIT_API_CODES.has(error.code)))
  const base = isRateLimit ? RATE_LIMIT_BASE_DELAY : baseDelay
  const ceil = isRateLimit || retryAfterMs !== undefined ? RATE_LIMIT_MAX_DELAY : maxDelay
  const jitter = Math.random() * base
  let delay = Math.min(ceil, base * 2 ** attempt + jitter)
  // Honor Retry-After when the server asks for longer, capped so a huge or
  // hostile value can't stall the request past the ceiling.
  if (retryAfterMs !== undefined) delay = Math.min(ceil, Math.max(delay, retryAfterMs))
  return delay
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2
  const baseDelay = options.baseDelayMs ?? 400
  const maxDelay = options.maxDelayMs ?? 4_000
  const policy = options.policy ?? "default"
  let attempt = 0
  let tokenReplayed = false

  while (true) {
    try {
      return await fn()
    } catch (error) {
      // 换了 token 的重放（http.ts 的鉴权自愈）：不占重试次数、不退避——先遇到的限流不该把它耗掉。只免一次：
      // 本函数是通用的，调用方若反复标记可重放，之后按普通重试计次，不会空转。
      if (!tokenReplayed && (error as { __retryable?: boolean } | null)?.__retryable === true && !options.signal?.aborted) {
        tokenReplayed = true
        continue
      }
      if (attempt >= retries || options.signal?.aborted || retriesSpent(error) || !isRetryableError(error, policy)) throw error
      const delay = computeRetryDelay(error, attempt, baseDelay, maxDelay)
      options.onRetry?.(attempt + 1, error, delay)
      await sleep(delay, options.signal)
      attempt++
    }
  }
}

const verboseEnabled = process.env.GANGTISE_VERBOSE === "1" || process.env.GANGTISE_VERBOSE === "true"

export function isVerbose(): boolean {
  return verboseEnabled
}

export function logTiming(label: string, durationMs: number, extra?: string): void {
  if (!verboseEnabled) return
  const ms = durationMs.toFixed(0).padStart(5, " ")
  process.stderr.write(`[gangtise] ${ms}ms ${label}${extra ? ` (${extra})` : ""}\n`)
}
