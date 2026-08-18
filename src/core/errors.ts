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
  "999004": "本账号无权访问该资源：先确认对应的数据库/模块已开通（如帕米尔专家纪要需单独购买），再确认该条记录本账号可见。list 类接口报此码通常是整个库没开通，不是某条记录的问题。",
  "999005": "联系客户经理充值，或缩小查询范围降低消耗。",
  // 与 transport 的 RATE_LIMIT_API_CODES 一一对应，改一处必须改另一处：
  // 普通端点对任何状态下的 999006 都退避重试；标了 no-replay 的端点只在 HTTP 429
  // 时重试（429 由服务端在处理前拒绝，重放不会重复扣分），非 429 形态一律不重放。
  // 🔴 归因写「重放会重复扣分」，别写「按次计费」——no-replay 标的是重放安全，不是
  // 计费模型：18 个里 ai.hot-topic 按篇（= 一整份报告，属按行）计费、
  // insight.pamirs-summary.download 单价未公布。按计费模型归因既不成立，也会诱导
  // 下一个人拿 retry 注解去做计费判断。
  // errors.test.ts 有断言把这句话与 isRetryableError 的实际判定钉在一起，防止再次漂移。
  "999006": "稍后再试或联系客户经理提额；普通端点会自动退避重试，重放会重复扣分的端点仅在 HTTP 429 时重试、非 429 错误信封不重放。",
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
  // list 类端点把单页上限（50）也归到此码，不再只是「一次要太多行」。分页由本服务自动
  // 处理，所以调用方能碰到的多半是前半句。
  "100006": "缩短日期范围或调小 size / limit（list 类接口单页上限为 50）。",
  // 按参数名判断，不要按工具族：ai 的 reportDate 是 date 型，而同属 ai 的
  // knowledge_batch 收 datetime 或 epoch 毫秒。
  "110001": "看参数名：*Date 用 YYYY-MM-DD，*Time 用 YYYY-MM-DD HH:mm:ss（gangtise_knowledge_batch 的 startTime/endTime 另可传 epoch 时间戳，10 位秒或 13 位毫秒）。",
  "110002": "起始晚于结束——检查 startDate/endDate 或 startTime/endTime 的先后。",
  // 旧文案是「请缩小日期范围或改用更近日期」，前半句被证伪：单个日期也会报此码
  // （gangtise_indicator_screener 传一个较早的 date），此时根本没有窗口可缩。
  // 只写证据支持的两点：把日期移近、可查范围按接口而异。**有意不归因到「账号权限」**
  // —— 原始报文只说「超出时间范围限制」，除 theme-tracking 外没有端点证过那个归因，
  // 这与 v0.1.44 round-3 的决定一致，别再加回去。
  "110003": "查询时间超出该接口的可查范围——把日期改到更近的范围内；整段区间都在界外时缩短窗口没有用（单个日期同样会报此码）。可查范围随接口而异，同一账号下不同接口也可能不同（如 EDE 条件选股比截面/时序窄），撞界可改用范围更宽的同族工具。",
  "120001": "用 gangtise_securities_search 确认证券代码与后缀（如 600519.SH / 00700.HK / AAPL.O）。",
  "130001": "先核对查询条件；EDE 指标端点此码也可能是未开通该指标权限，仍失败联系客户经理。",
  // 非法 fileType 已拆到 130005、资源未生成已拆到 130003，但历史上两者都归过此码，
  // 所以提示保留对 fileType 的指引。
  "130002": "确认下载 ID 有效且本账号可见；下载类还需检查 fileType 取值是否合法。",
  "130003": "资源未生成，或该条记录未附带文件——换一条列表里标着有附件的记录，或稍后再试。",
  "130004": "下载 ID 需为数字，检查该工具的 *Id 参数是否传对。",
  "130005": "对照工具参数说明检查 fileType / contentType 取值。",
  "140001": "稍后用对应 *_check 工具查询。",
  // 两类终态参数错共用此码：异步 AI 生成失败，以及 EDE 取数/表达式的入参错（必填缺失、
  // 枚举越界、表达式语法错）。旧文案只讲 dataId，对 EDE 完全对不上——EDE 这条路径根本没有
  // dataId，会把用户引去查一个不存在的东西。两者都不该重试，故合并成通用的「改参数再来」。
  "140002": "终态参数错，不要重试同样的入参：核对必填项与枚举取值（EDE 指标还要核对 indicatorParamList 的参数名与 expression 语法，参数名以 gangtise_indicator_search 的 parameterList 为准）；异步生成类改参数重新提交会再次计费，重查同一 dataId 结果不会变。",

  // ── 接口专有层 2xxxxx ──
  "210001": "换一篇，或改用对应 list 工具取摘要。",
  "220001": "改用对应 list 工具取摘要。",
  "230001": "只有自己上传的文件可下载。",
  // 2026-08-07 新增码。私域模块，gangtise_wechat_* 就在这个模块下且明确要求
  // 「已绑定并激活群消息助理」，所以本服务够得着，不能当不可达而不给提示。
  "230002": "微信账号未绑定——群消息类工具要求先在 Gangtise 端绑定并激活群消息助理、且助理已入群。",
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
  // 举例只能用实际存在的参数名：`startDate` 在 EDE 指标上根本不存在（区间指标的起始日是
  // sDate，2026-08-03 实测），旧文案照它排查会走进死胡同。
  "410106": "读 gangtise_indicator_search 返回的 parameterList，用 indicatorParamList 补上 required:true 的参数（常见：periodNum + reportDate / fiscalYear + tradeDate；区间指标的起始日是 sDate，没有 startDate）。",
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

/** Hints keyed on the server's message rather than its code, for the cases where one
 * code covers many causes and only the message says which. The EDE input-error codes
 * are the reason this layer exists: `100001` / `100003` are the catch-all for every
 * indicator parameter problem, so their per-code hints can only be generic.
 *
 * Kept to cases where the message names the problem but not the fix: the caller is told
 * 「缺少必填参数 reportDate」 and still has to work out that such indicators need an
 * `indicatorParamList` entry rather than the tool's own `date`.
 *
 * ⚠️ 不要把这里改写成「哪些指标吃哪个日期」的归纳规则 —— 这两件事都不按 code 前缀分
 * （`is_*` 里两种都有，`finc_*` / `div_*` 同样），个别指标两个日期都必填，另有指标要的
 * 是 fiscalYear。提示只指向 gangtise_indicator_search 的 parameterList，不做断言。 */
// 🔴 **这张表刻意做成顺序无关**：`.find` 虽然先到先得，但每条规则的命中条件都写在它自己
// 身上（`all` 全中 + `none` 全不中 + `when` 成立），任意重排结果不变，`errors.test.ts` 的
// "does not depend on rule order" 逐一轮转验证。**新增规则时给足判别式，别靠往表头插。**
//
// 服务端的日期报错有两种形态：**拼接句**（`指标 X 不支持参数 A; 指标 X 缺少必填参数 B`，
// 两半同时出现，能唯一确定该换成哪个键）和**半句**（只有「不支持 A」，没有「缺少 B」）。
// 半句只证明「A 被拒了」，**推不出该换成哪个键**——推断就会断错：
//   - 只有「不支持 tradeDate」的指标，可能吃 reportDate、可能吃 fiscalYear、也可能一个
//     日期都不吃（如上市日期、交易市场这类静态属性）。
//   - 只有「不支持 reportDate」的同理。
// 所以拼接句配**断言式**提示（能确定），半句配**不断言**的提示（指向 parameterList）。
//
// 前一版把两种形态合并处理，结果是：给一个只吃 fiscalYear 的指标先建议「补 reportDate」，
// 照做后又建议「删掉 reportDate，date 会自动补 tradeDate」，回到原点——**两条建议互相
// 指反，构成死循环，而正确答案 fiscalYear 一次都没出现**。errors.test.ts 钉住了这一点。
// 一次请求里多个指标各自缺不同的键时，服务端会在同一句报错里逐个点名，而提示只讲得了其中
// 一种形态。所以每条提示都带上这句：告诉调用方逐个处理，别以为改完一个就完事。
const MULTI_NOTE = " ⚠️ 一条报错可能同时点名多个指标，且各自要补的键不同——逐个按各自的 parameterList 处理，改完一个再看新的报错。"

/** 这条报错里出现了几种**互不相同**的失败形态。
 *
 * 服务端把每个指标的每个问题写成一个分句（`指标 X 不支持参数 tradeDate; 指标 X 缺少必填
 * 参数 reportDate; 指标 Y 不支持参数 tradeDate`）。按指标聚成各自的形态再去重：
 * 上例里 X 是「换键」、Y 是「一个日期都不要」，两种改法完全不同。
 *
 * 为什么需要它：下面每条断言式提示都只讲一种形态，而 `find` 只会命中一条。形态不止一种
 * 时，任何一条断言式提示都会**对着其中一部分指标说错话**（MULTI_NOTE 只提醒「还有别的
 * 指标」，纠不回一个已经给错的药方）。此时改用不断言的批量提示。
 *
 * 认不出任何分句时按「单一形态」计（返回 1），让下面的规则照常匹配——报文形态变了的时候
 * 该退回旧行为，不该整张表一起哑掉。 */
export function distinctFailureShapes(message: string): number {
  const byIndicator = new Map<string, Set<string>>()
  for (const clause of message.split(/[;；]/)) {
    const matched = /指标\s+(\S+)\s+(不支持参数|缺少必填参数)[:：]?\s*(\S+)/.exec(clause)
    if (!matched) continue
    const [, indicator, kind, key] = matched
    const shape = byIndicator.get(indicator) ?? new Set<string>()
    shape.add(`${kind}:${key}`)
    byIndicator.set(indicator, shape)
  }
  if (byIndicator.size === 0) return 1
  return new Set([...byIndicator.values()].map((shape) => [...shape].sort().join("|"))).size
}

// `when` 把「形态是否唯一」这个判别式**写进每条规则**，而不是靠数组顺序兜住。少了它，
// 谁往表头插一条新规则都会把批量形态重新漏给断言式提示，而测试全绿。
const oneShape = (message: string) => distinctFailureShapes(message) <= 1
const manyShapes = (message: string) => distinctFailureShapes(message) > 1

/** 判别式全部写在规则自己身上：`all` 必须全中、`none` 必须全不中、`when` 必须成立。
 *
 * 🔴 `none` 是**必需**的，不是保险。拼接句同时匹配它自己那条和「半句」那条——
 * 「不支持参数 tradeDate; 缺少必填参数 reportDate」既中「缺 reportDate」那条（该换成
 * reportDate，对的），又中「只拒 tradeDate」那条（一个日期都不要，对这条**是错的**）。
 * 此前靠前者排在后者前面兜住，把表里两条挪一下顺序就会给出完全相反的药方，而所有测试
 * 照样全绿。**规则之间用报文形态互相指认，不要用序号**——序号会随新增规则整体漂移。
 *
 * 导出仅供测试：顺序无关性只能靠「把整张表换个顺序再跑一遍」来证明。 */
export const MESSAGE_HINTS: Array<{
  codes: string[]
  all: RegExp[]
  none?: RegExp[]
  when?: (message: string) => boolean
  hint: string
}> = [
  {
    // 多个指标、失败形态互不相同：任何一条断言式提示都会对其中一部分说错话。
    codes: ["100001", "100003"],
    all: [/不支持参数\s*(?:tradeDate|reportDate)|缺少必填参数[:：]?\s*(?:tradeDate|reportDate)/],
    when: manyShapes,
    hint: "🔴 **这条报错点名了多个指标，而且它们失败的方式不一样**——同一个改法套不到全部，按 msg 里每个指标各自说的话分别处理：对某个指标说「不支持参数 X; 缺少必填参数 Y」= 把该指标的 X 换成 Y；只说「不支持参数 tradeDate」而没说缺什么 = 该指标一个日期都不要，给它加 noQueryDate: true（截面写进 indicatorParamList 那条，条件选股写进该变量自己的绑定）；只说「缺少必填参数 Y」= 把 Y 补进该指标的 parameters。**最省事的办法是把这批指标拆成几次单独查**，那样每条报错只对应一个指标，提示也能给准。要哪些键以 gangtise_indicator_search 返回的 parameterList 为准。",
  },
  {
    // 拼接句 / 半句都成立：明确点名「缺 reportDate」，那就是要 reportDate。
    codes: ["100001", "100003"],
    all: [/缺少必填参数[:：]?\s*reportDate/],
    when: oneShape,
    hint: "报错里点名的那个指标要的是 reportDate（报告期），不是本工具的 date 下发的 tradeDate：在 indicatorParamList 里给该指标补一条 { indicatorCode, parameters: [{ paramKey: 'reportDate', paramValue: 'YYYY-MM-DD' }] }（条件选股写在对应变量上），date 参数仍要保留。以 gangtise_indicator_search 返回的 parameterList 为准，别按指标 code 前缀推断要哪个日期。" + MULTI_NOTE,
  },
  {
    // 拼接句：拒收 reportDate **且**缺 tradeDate ⇒ 这是个交易日指标，删掉多传的
    // reportDate 就好——删掉后本服务会自动把 date 作为 tradeDate 注入，那半句一并消失。
    codes: ["100001", "100003"],
    all: [/不支持参数\s*reportDate/, /缺少必填参数[:：]?\s*tradeDate/],
    when: oneShape,
    hint: "报错里点名的那个指标要的是 tradeDate（交易日），不吃 reportDate：把 indicatorParamList 里该指标的 reportDate 删掉即可——删掉后本工具的 date 会自动作为 tradeDate 下发，不需要另外补。以 gangtise_indicator_search 返回的 parameterList 为准。" + MULTI_NOTE,
  },
  {
    // 半句：只说拒收 reportDate。删掉它是对的，但**不能承诺**删掉就能出数——该指标可能
    // 连 tradeDate 都不吃，删完会撞上「只拒 tradeDate」那条。
    codes: ["100001", "100003"],
    all: [/不支持参数\s*reportDate/],
    // 拼接句（还说了「缺 tradeDate」）归上一条：那种形态能唯一确定该换成哪个键。
    none: [/缺少必填参数[:：]?\s*tradeDate/],
    when: oneShape,
    hint: "报错里点名的那个指标不接受 reportDate：先把 indicatorParamList 里该指标的 reportDate 删掉，再照 gangtise_indicator_search 返回的 parameterList 补它真正要的键（可能是 tradeDate，也可能是 fiscalYear，或者一个日期都不要）。" + MULTI_NOTE,
  },
  {
    // 半句：只说拒收 tradeDate，没说缺什么。**这一条最容易断错**——服务端没说该换成哪个
    // 键，多半是因为一个都不要，所以提示只给 opt-out，不替它挑一个替代键。
    // 截面与选股都有 noQueryDate 开关（选股侧 2026-08-17 放开，见 indicator.ts）；
    // 时序没有，因为它本来就不注入单日期参数。
    codes: ["100001", "100003"],
    all: [/不支持参数\s*tradeDate/],
    // 🔴 服务端顺带说了「缺哪个键」时，那就不是「一个日期都不要」，而是「换成它说的那个」
    // ——归第一条。少了这个否定判别式，本条会把拼接句也接走并给出完全相反的药方。
    none: [/缺少必填参数[:：]?\s*(?:reportDate|tradeDate)/],
    when: oneShape,
    hint: "报错里点名的那个指标不接受 tradeDate，而截面/条件选股默认会把 date 作为 tradeDate 下发给每个指标。**给它加 noQueryDate: true 即可**——date 参数仍要保留，本工具只是不再给这个指标注入日期；它若另有必填键（如股利支付率、年度现金分红总额要的 fiscalYear），写进同一条的 parameters 里。两个端点的写法只差一层：截面写在 indicatorParamList 里 { indicatorCode: '<该指标>', noQueryDate: true }；条件选股写在该变量自己的绑定里 { field: 'F1', indicatorCode: '<该指标>', noQueryDate: true }。它真正要哪些键以 gangtise_indicator_search 返回的 parameterList 为准。" + MULTI_NOTE,
  },
  {
    // 半句：没有任何键被拒，只是缺 tradeDate。本服务见到已声明的 reportDate、或调用方
    // 声明了 noQueryDate，就不再注入 tradeDate（见 withQueryDate）——两条路都会走到这里。
    codes: ["100001", "100003"],
    all: [/缺少必填参数[:：]?\s*tradeDate/],
    // 同时说了「不支持 reportDate」的拼接句归第二条：那是「删掉多传的 reportDate」，
    // 而不是「两个日期都补上」。
    none: [/不支持参数\s*reportDate/],
    when: oneShape,
    hint: "本工具这次没给该指标注入 date 的 tradeDate——因为你给它显式传了 reportDate/tradeDate，或者给它加了 noQueryDate: true，两者都会关掉注入。对症改：该指标若两个日期都必填，就在同一个 indicatorParamList 条目的 parameters 里把 tradeDate 也写上（{ paramKey: 'tradeDate', paramValue: 'YYYY-MM-DD' }）；若是 noQueryDate 加错了指标，删掉它即可。必填项以 gangtise_indicator_search 返回的 parameterList 为准。" + MULTI_NOTE,
  },
]

export class ApiError extends CliError {
  readonly hint?: string

  constructor(
    message: string,
    readonly code?: string,
    readonly statusCode?: number,
    readonly details?: unknown,
    /** Parsed from a Retry-After response header (ms), when the server sent one. */
    readonly retryAfterMs?: number,
    /** Context-specific hint that beats the generic per-code table — e.g. the EDE
     * fetch endpoints override 999999 with a parameter checklist (that code used to
     * mean "no data" there; since 2026-08-07 it is essentially a real fault, and a
     * no-data answer is a placeholder cell instead). */
    hintOverride?: string,
  ) {
    super(message)
    // 优先级：显式 override > 按消息匹配 > 按码。按消息的规则比码本身指认的原因更窄，
    // 所以排在按码之前；但调用点自带上下文时仍然它最准。
    const byMessage = code
      ? MESSAGE_HINTS.find(
          (rule) =>
            rule.codes.includes(code) &&
            rule.all.every((re) => re.test(message)) &&
            !rule.none?.some((re) => re.test(message)) &&
            (rule.when?.(message) ?? true),
        )?.hint
      : undefined
    this.hint = hintOverride ?? byMessage ?? (code ? ERROR_HINTS[code] : undefined)
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
