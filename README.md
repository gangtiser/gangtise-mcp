# gangtise-mcp

基于 [Gangtise OpenAPI](https://open.gangtise.com) 的 MCP（Model Context Protocol）服务，让 Workbuddy, OpenClaw, Hermes, Cherry Studio, Cursor, Claude, Codex 等 AI 助手直接访问 Gangtise 投研平台数据。

## Changelog

### 0.1.49 (2026-07-26)
同步 gangtise-openapi-cli v0.28.3 / v0.29.0。所有结论均在本机对真实 API 复验，与 CLI 结论不符处以复验为准。

- **新增财报日历 2 个工具**（`gangtise_performance_calendar_list` / `_download`，工具数 92 → 94）：业绩预告 / 业绩快报 / 业绩公告三类事件的发布日程（含未来已排期）。返回 `performanceReportId`（下载用）/ `securityCodeList`（A+H 会有多个码）/ `securityName` / `category` / `publishDate` / `title` / `hasAttachment`；仅 `hasAttachment: true` 可下载（A股 10 积分 / 港美股 20）。
  - ⚠️ **日期参数用 `startTime`/`endTime`，不是 CLI v0.29.0 写的 `startDate`/`endDate`**。实测 2026-07-26：`startDate`/`endDate` 被服务端**静默忽略**（单日区间、六日区间、单边区间的 `total` 全部等于不加筛选的 126683，且 HTTP 200）；`startTime`/`endTime` 才真正过滤 `publishDate`（07-20~07-25 → 517 条、2024-01 → 674 条、单日 07-25 → 12 条，返回行的日期均落在区间内）。两种写法都返回 200 且不回显服务端实际采用的区间，静默失效不可察觉。**gangtise-openapi-cli 侧同名 bug 尚未修复**（v0.29.0 的 `insight performance-calendar list --start-date/--end-date` 实际不过滤，且其「日期区间算一个约束」的护栏因此会放行整本日历的 fetch-all）。两端都含端点，`YYYY-MM-DD` 与 `YYYY-MM-DD HH:mm:ss` 实测等价，故两者皆放行。
  - **按「实际要取多少行」设闸，而不是只看 `fetchAll`**：`client.requestPaginated` 把 `size` 当作**总目标行数**按 `total` 自动翻页，所以 `size:50000` 和 `fetchAll` 是同一件事（都能拉满 `MAX_PAGES × 50` = 5 万行 ≈ 5000 积分）。无筛选时 `total` 十万量级（实测 126683，含未来排期）、按 0.1/条计费，故：完全无筛选时请求行数超过 1000 直接本地 `ValidationError`、不发请求（拒而不静默截断——加个筛选就能解决，返 1000 行会被读成全部）。`marketList`/`categoryList` **不算约束**（实测单个 `aShares` 仍有 64327 条）；常规路径（默认 `size=20`）不受影响。
  - **`securityList` 单约束时另加 1000 行隐式上限**（`fetchAll` 与显式大 `size` 一视同仁）：实测服务端确实按 `securityList` 过滤（无效码返 `total=0`），单只证券整段日历只有几十条（茅台 `total=10`），上限正常使用感知不到；筛选一旦失效，结果在此截断并标 `_partial`，而不是闷头翻完全表。判据是 `total` 而非行数——恰好取满 1000 行且 `from+行数 >= total` 是完整结果，不误标。`_partial_reason` 是**逗号拼接的多原因列表**（分页层会写入 `page_cap`/`total_drift`/`failed_pages`），本工具**追加** `security_only_row_cap` 而不是覆盖，不吞掉分页层的诊断。
  - **`marketList`/`categoryList` 收紧为 `z.enum`**：实测枚举拼错时上游**静默返回全量**（`categoryList:["bogusCategory"]` 与不传筛选同为 `total=126683`、`code` 仍是 `000000`）且照常按 0.1/条计费，schema 层是唯一防线。
- **`gangtise_valuation_analysis` / `gangtise_main_business` 的 `fieldList` 收成 `z.enum` 闭集**（不只是写进描述——描述是建议，schema 才会拒；等长错列既拦不住又不报错，是本仓最危险的一类失败，必须在发请求前挡下）：
  - `valuation-analysis` 全表 7 列、**没有 `securityCode`**：传 `['securityCode','tradeDate','value']` 时上游把相邻列的值复制进该槽位、**字段数与行长仍然相等**，返回 `{tradeDate:'2026-07-20', securityCode:'2026-07-20', value:20.06}`——`securityCode` 拿到的是日期，等长错列长度校验发现不了。
  - 且 `tradeDate` **总是自动前置到每一行**，显式请求它会让值多一个而字段名不多（请求 `['tradeDate','value']` 实到 2 名 3 值），反倒把长度校验撞红——所以可选字段是**除 `tradeDate` 外的 6 个**（`value` / `percentileRank` / `average` / `median` / `upper1Std` / `lower1Std`），`tradeDate` 传不传都会返回。这条是收 `z.enum` 时才发现的：原先照 CLI 记的「7 字段」清单本身就是错的。
  - `main-business` 的真实字段是 `periodName` / `periodEndDate` / `categoryName` / `opRevenue…` 共 15 个（旧文档记的 `endDate` / `breakdownName` / `revenue` 实测均不存在）。它同样固定前置 `periodName`/`periodEndDate`/`categoryName`，但**会正确去重**（显式请求仍是 4 名 4 值），故 15 个都可选；只有真正不存在的字段名会让字段数比行长多 1 而报错——不静默错列，但等于白跑一次。
- **`gangtise_balance_sheet` / `gangtise_cash_flow` 标注上游两列错位**：实测（工行 / 茅台 / 中信证券一致）A股**累计口径**的资产负债表与现金流量表，`companyType` 与 `currency` 两列的值互换（`companyType='人民币'`、`currency='银行'`/`'一般企业'`）。A股利润表（累计）正确、不带此注记；A股单季表则是 `companyType` 返回未映射的数字码（如 `102110100`）、`currency` 正确。科目数字不受影响。
- **`gangtise_edb_data` 的列式拍平并入同一道校验**：它返回 `{fieldList, dataList}`，此前自己 zip、绕过了 `normalizeRows` 的长度校验，等于留了第二条未校验的拍平路径。该工具不暴露 `fieldList` 入参（字段名由服务端给），今天不会错列——纯防御对齐。
- **EDE `reportType` 改为「未定论 + 需交叉核对」，撤除 0.1.47 的「勿传」**：CLI v0.28.3 复测推翻了「`2`/`4` 必报错、要指定口径改用 `fundamental`」的旧结论，给出的映射是 `1`=合并 / `3`=母公司；但服务端 `indicator.search` 自己声明的 enum 恰好相反（`1`=母公司报表 / `2`=合并报表）。2026-07-26 复验时 **EDE 取数端全线故障**（缺参仍正常返 `400`/`100001`，任何合法查询一律 `500`/`999999`，`search` 端点正常），无法裁决。因此描述改为：参数可传、但 label↔value 对应尚未定论，省略即默认合并口径，确需母公司口径时取完必须用三大报表工具交叉核对——不写任何一方的单边断言。
- **未移植**：v0.29.0 的 PDF 解析（`tool file-parse`）。需要给 MCP 引入读本地文件的能力（现有 94 个工具全是只读查询）、`kind:"upload"` 端点类型、`client.uploadFile()` 与 POST-body 型 download，而平台自有研报走 `gangtise_research_download --fileType 2` 已直出 Markdown、无需 0.8/页解析费。v0.29.0 群消息新增的 `quoteMsg` 无需改动（响应原样透传，新字段自动出现）；CLI 侧写错的 `msgContent`/`contentUrl` 字段名 MCP 从未使用。v0.29.0 的 `bigIntFields` 防护也不需要——实测 `performanceReportId` 返回的是字符串（`"33752980"`）。
- `tools/list` 实测 111,567B → 116,177B（+4,610B，工具数 92 → 94）
- 测试 510 → 533（财报日历：无约束的 `fetchAll` 与超大 `size` 都拒、`securityList` 单约束两条路径都封顶、有日期区间则不封顶、`_partial_reason` 追加不覆盖、枚举本地拦截；`edb_data` 错列必须报错；`valuation_analysis`/`main_business` 的非法字段名**本地拒绝且不调 API**、`tradeDate` 禁传；两表错位注记的范围）

### 0.1.48 (2026-07-24)
- **修复取数路由盲区：单票总市值被推去 `realtime`、却查不到**。`qte_mkt_cptl`（总市值）是 `qte_` 族里唯一「专用工具没有」的指标——实测 `realtime` 只有开高低 / 最新价 / 昨收 / 涨跌 / 成交量额 / 换手 / 振幅 / 量比（**无 `close`**），`day_kline` 只有 OHLCV + 复权因子，**都不含市值**；而 0.1.46 起 `indicator_search` 的 carve-out 笼统写「基础行情虽可搜到仍优先 realtime/day_kline」，把整个 `qte_` 族推离 EDE，单票市值于是掉进空档（既不走专用工具、也不触发「多证券→EDE」批量规则）：
  - **`indicator_search` 的 carve-out 收窄**为「开高低收 / 成交量额 / 换手 / 涨跌幅」，并点名例外：**总市值 `qte_mkt_cptl` 单票也走 EDE**（仅 A 股，默认返「元」，用 `scale` 缩放，如 `scale=8` → 亿元）
  - **`gangtise_realtime` 描述明写「不含市值」**并指向 `qte_mkt_cptl`——realtime 是模型查市值的落点，在这里就掉头
- **修复无效字段名导致的静默错列（数据污染，影响所有带 `fieldList` 的接口）**：上游对 `fieldList` 里不存在的字段，**只返有效字段的值、字段名却按请求原样回显**，`normalizeRows` 按位置拍平就把值贴到了错误的字段上——实测传 `['securityCode','close','turnoverRate']`（realtime **没有** `close`）会把换手率 `28.5573` 贴成 `close`，读起来就是「茅台收盘价 28.56」（真实价 ~1297）。现在 `normalizeRows` 在 `fieldList` 项数与该行返回值个数不等时**直接报错拒绝**，绝不输出错位数据；`realtime` 描述改列全部真实字段名（明写「没有 close」）、`fieldList` 参数补上该风险说明
- `tools/list` 实测 110,648B → 111,567B（+919B，工具数仍 92）
- 测试 508 → 510（钉住总市值路由：`realtime` 描述列全真实字段+「没有 close」+ `qte_mkt_cptl`、`indicator_search` carve-out 点名 `qte_mkt_cptl`；+ `normalizeRows` 字段数不匹配必须报错而非错位拍平）

### 0.1.47 (2026-07-24)
- **EDE 取数参数配方写进工具描述**（纯 guidance，无新工具 / 无 schema 变更 / 向后兼容）。基于对上游全部 990 个指标的实测（raw API 按 code 精确回填 + 4 公司面板 + 补必填参 + 年报回退，786/990 可取），把「怎么填参数才不撞 410106/999999」固化进 `indicator_cross_section` / `time_series` 的 `date`、`indicatorParamList` 与工具描述，让模型自动填对：
  - **日期按类目**（`date` 描述）：财务指标填报告期末季末，现金流附注 / N期统计填年报（如 `2025-12-31`），行情填交易日；日期语义不符整批报 `999999`。
  - **必填参数填法**（`indicatorParamList` 描述）：`parameterList` 标 `required` 的必须补——qte 周期变体→`startDate`(整数 YYYYMMDD)、N期统计→`periodNum`(如 4)、分红 / 预测→`fiscalYear`(年份)。
  - **`reportType` 勿传（截至 2026-07-24）**：EDE 该枚举与实际不符（`2/4` 常直接 `999999`、省略即合并口径已有数）；要指定合并 / 母公司口径改用 `fundamental` 三大报表的 `--report-type`。（问题已反馈服务端，修复后应撤除工具描述里的「勿传」提示——非删本 changelog）
  - **公司类型 + 时序兜底**（`cross_section` 描述）：财务科目分公司类型、公司类型不匹配时返 `null`（≠ 指标坏）；整批无数据报 `999999` 时改用 `time_series`（对缺值返 `null` 不报错）。
- **修正 `999999`「无数据」提示**（与 CLI 0.28.2 同步）：旧文案「日期是否为交易日」与财务/MRQ 指标「报告期末」语义自相矛盾——改为「多为无数据，确认应有数据再重试」+ 按指标周期路由（财务/MRQ→报告期末如 `2025-12-31`、日频估值→交易日）+ 补 `scopeList` / `required` 参数检查；且**只对取数端点（截面/时序）套用**，`search` 的 999999 **回落通用提示**（其 999999 是真系统错误——零命中本就返 `[]`、非无数据，date/scope/param 提示对它无意义）。（`indicatorMatrix.ts` 的批量映射本就**按响应数组共同索引对齐**〔`values[i]` 配 `name[i]`/`code[i]`〕+ 同名列加 code 后缀，无 CLI 那个「按名/位置错位」问题，无需 `--key-by`；但这**不等于 code-keyed 输出**——唯一名与首个同名列仍不带 code。）
- `tools/list` 实测 109,538B → 110,648B（+1,110B，工具数仍 92）
- 测试 507 → 508（新增 EDE 参数配方断言：日期路由 / `startDate`·`periodNum`·`fiscalYear` 填法 / `reportType` 勿传（时间限定）/ 公司类型 / `999999`→时序；+ 999999 端点专属：取数端点=多为无数据 / 报告期末 / scope / required、`search`=回落通用；+ flatten 重排+同名不丢值）

### 0.1.46 (2026-07-23)
- **取数路由调整：多证券财务/估值批量优先走 EDE 指标接口**（纯 guidance 文案，无新工具 / 无 schema 变更 / 向后兼容）。旧路由总则一律「行情/估值/财务/盈利预测优先专用工具」，模型查「一堆股票」的估值/财务时会逐只调用单证券工具（N 次往返、易截断放弃）。现改为：多证券取一批已实现财务/估值指标 → `gangtise_indicator_cross_section` / `_time_series` 一次拉，替代逐只调用：
  - **明确排除、仍走专用工具**（2026-07-23 用免费 `indicator_search` 探针实测，非永久契约）：**盈利预测 / 一致预期**（搜「一致预期 / 盈利预测 / 预期 / 目标价」= 0 条，`预测EPS` 模糊命中的是已实现值）与**估值历史分位**（搜「分位」= 0 条）EDE 未覆盖，仍用 `gangtise_earning_forecast` / `gangtise_valuation_analysis`；**行情 / K 线**由 `realtime` / `day_kline*` 免费多证券一次拉，不进按单元格计费的 EDE；**单票完整报表**仍用三大报表工具（期间 / 合并口径语义更清晰）
  - **`indicator_search` 描述补取数纪律**：返回值列出 `scopeList`（覆盖市场），要求核对 indicatorName/description 语义 + scopeList 是否覆盖目标市场 + parameterList，任一不符即回退专用工具（覆盖按指标而异，如 `finc_pe_ttm` 仅 A 股）；删去旧的「覆盖 A/港/美股」笼统表述
  - **计费总则补批量例外** `除①批量外，优先免费/低价`——EDE 按单元格计费而估值 / 报表专用工具多免费，避免「优先免费专用工具」与新批量路由自相矛盾
- 路由总则 1,751B → 1,793B（含日期前缀，门禁 ≤ 1,800B，余 7B）
- `tools/list` 实测 109,538B（三处 indicator 描述净增 519B，工具数仍 92）
- 测试 505 → 507（新增 EDE 批量路由断言：`indicator_*(EDE) 截面/时序` 优先 + 计费例外 + `scopeList` 核对 + 时序多×多需拆分 + 描述用「一批」而非「同一」）

### 0.1.45 (2026-07-22)
- 同步 gangtise-openapi-cli v0.28.0（对齐服务端 2026-07-17 更新：内资研报下载调价 + 41 个公开错误码三层重排）。上游 41 个码逐个打过线上探针，结论是迁移按「错误处理层」而非按业务模块进行——同一接口内参数校验层已发新码、方法路由层与 token 过滤器仍发旧码，故本版两代都识别：
  - **计费修正：`gangtise_research_download` 20 → 10 积分/篇**（服务端 2026-07-17 调价）。积分目录是模型看到的唯一价签，虚高一倍会让模型无谓回避该工具
  - **错误码表按三层结构重写**（`999xxx` 服务统一层 / `1xxxxx` 业务通用层 / `2xxxxx` 接口专有层）：24 条 → 覆盖 41 个新码 + 实测仍在线的旧码。补齐整个 `1xxxxx` 层（`100001~100006` / `110001~110003` / `120001` / `130001~130005` / `140001~140002`）、`2xxxxx` 层与 `999001~999016`
  - **修正 `900002` 的错误释义**：实测服务端用它表示「请求方法不正确」(HTTP 405)，旧文档写作「请求缺少 uid」，据此排查会走错方向
  - **补 `410106`**（EDE 漏传 `periodNum` 等 required 参数）——与 `410001` 并列 indicator 取数最常见的两个报错，此前完全无提示；`410004` 提示补上「多为未开通该指标权限」，只说「数据未找到」会让人一直换日期
  - **提示改为只给下一步动作**，不再复述服务端 msg——提示拼在 msg 之后，复述会读成叠字（`999997` / `903301` / `8000016` / `8000018` / `110003` 等原本逐字重复）
- **行为：异步状态码两代并存识别**（`410110`/`140001` 生成中、`410111`/`140002` 终态失败），覆盖轮询循环与 `*_check` 工具。实测服务端仍在用旧码，新码为预置——切换那天不会在首次轮询就把「生成中」当硬错抛出、作废一个已扣 50 积分的任务
- **行为：按 API code 禁止重试的集合 `NON_RETRYABLE_API_CODES`，任何 HTTP 状态下都不重放**——`999011`（AK/SK 不匹配，凭证错不会自己好）、`140002` / `410111`（异步生成失败，按定义即终态）、`410106` / `410001`（EDE 缺必填参数，同参重放结果不会变）。异步 `*_check` 端点无 retry 声明、走默认策略，`140002@500` 原本会被白重试 2 次才轮到 `asyncContent` 认它是终态（后者在 `withRetry` 之上、拦不到重试）。**未观测到服务端以 5xx 返回这几个码**，此处按形状设防而非按目击设防：这些确定性错误一旦以可重试的 5xx 返回，状态码规则就会为一个不可能改变的结论重放 2 次，而指标端点按单元格计费、这些重放还可能产生额外消耗；按 code 拦掉就不必去赌
- **行为：token 自愈补上 `999002`**（`0000001008` 的新码）。切码后自愈会静默停摆，用户直接撞上硬认证失败；`999011` 刻意不进自愈表（凭证写错刷 token 无用），改由终态码拦住
- **可观测性：透出服务端 `traceId`**——报错行形如 `资源不存在（错误码 130002，trace 830965044897325056）— …`，这是 Gangtise 侧唯一能回溯一次失败的抓手。EDE 双层信封的内层报错此前**永远拿不到 traceId**（`traceId` 只挂外层，外层解包即丢弃）：现在外层 id 以不可枚举属性随 payload 带下去（不进 JSON/工具输出），`ApiError.traceId` 兜底读它
- **修复：非 429 形态的限流（`999006`）现在真的退避重试**。此前只有 HTTP 429 走状态码规则，信封形态的 `999006` 一次即败——`Retry-After` 解析出来了却无人使用，退避窗口等于丢失。现纳入重试并享受与 429 同款的耐心退避（尊重服务端 `Retry-After`，封顶 15s）；**按次计费的 no-replay 端点仅在 HTTP 429 时重试、非 429 形态不重放**——429 由服务端在处理前拒绝、重放不会重复计费，而信封形态无法证明限流一定发生在执行之前，猜错就是重复扣费。`999006` 的错误提示与该策略有测试双向钉住，防止再次反向漂移
- **修复：`Retry-After` 不再只在 `statusCode >= 400` 时解析**，主 JSON 路径与下载 JSON 路径两处都已补上，HTTP 200 错误信封的退避窗口得以保留
- **修复：EDE 内层信封抛出的 `999999` 不再拿到反向提示**。`indicator` 的双层信封在解**内层**时才报 999999，而改写提示的 try/catch 只裹住 `client.call()`，这条路径会绕过去、给出与工具本意相反的「稍后重试」。内层解包已移入同一个 try
- **修复：`gangtise_knowledge_batch` 的 epoch 参数只收 10 位（秒）或 13 位（毫秒）**，10 位在转换时补到毫秒。此前收任意非负整数并一律当毫秒，秒级时间戳会被读成 1970 年——上游照单全收返回空结果，看不出是时间界错了
- 新增 `ApiError` 的 `hintOverride`：`indicator` 的 999999「无数据」改写提示时不再丢掉 code / statusCode / details（连带 traceId）
- 说明：CLI v0.28 的另一大项「date/datetime 严格校验」MCP 早已具备（`dateString`/`dateTimeString` 的正则 + 日历 round-trip 覆盖全部日期参数），且因用 UTC 构造，天然免疫 CLI 这次修的 `new Date(50,…)→1950` 与 DST 塌陷两个坑，无需改动
- `tools/list` 实测 108,961B → 109,029B（+68B，工具数仍 92）
- 测试 399 → 505（41 个公开错误码全量枚举钉住覆盖；禁重试码与限流改用 `withRetry` 实际调用次数断言，而非只测分类函数；`999006` 提示与 transport 策略双向钉住）

## 功能覆盖

<table>
<thead><tr><th width="100">类别</th><th>工具</th></tr></thead>
<tbody>
<tr><td>上下文</td><td><code>gangtise_current_date</code> — 查询运行时当前日期、年份、时间和时区</td></tr>
<tr><td>参考数据</td><td><code>gangtise_constant_category</code> / <code>gangtise_constant_list</code> — 行业、城市、公告分类、区域等常量；<code>gangtise_concept_search</code> — 题材 ID 搜索；<code>gangtise_sector_search</code> / <code>gangtise_sector_constituents</code> — 板块及成分股（含申万行业代码 <code>821xxx.SWI</code>）；<code>gangtise_chiefs_search</code> — 首席分析师 ID 搜索；<code>gangtise_institution_search</code> — 机构 ID 搜索（内资券商/外资/牵头/观点机构）；<code>gangtise_official_account_search</code> — 公众号 ID 搜索；<code>gangtise_lookup</code> — 券商机构、会议机构（本地表）</td></tr>
<tr><td>证券检索</td><td><code>gangtise_securities_search</code></td></tr>
<tr><td>观点/研报</td><td>国内首席观点、纪要、券商研报、外资研报、外资独立观点、公告（A股/港股/美股）、产业公众号资讯、投资者问答 QA、研报图表搜索与下载</td></tr>
<tr><td>路演/调研</td><td>路演、调研、策略会、论坛</td></tr>
<tr><td>财报日历</td><td><code>gangtise_performance_calendar_list</code> / <code>_download</code> — 业绩预告/快报/公告的发布排期（含未来已排期）与原文 PDF 下载</td></tr>
<tr><td>行情</td><td>A 股/港股/美股日 K（仅历史）、A 股分钟 K、指数日 K、实时行情快照（A/港/美）、A 股个股资金流向（日频）</td></tr>
<tr><td>基本面</td><td>A股/港股/美股利润表、资产负债表、现金流量表（累计/单季）、主营业务、估值、股东、盈利预测</td></tr>
<tr><td>AI 能力</td><td>知识库检索、个股看点、一页通、投资逻辑、同业对比、线索、主题跟踪、业绩点评、观点辩证、管理层讨论</td></tr>
<tr><td>云盘/语音</td><td>网盘文件、录音转写、我的会议、群消息、自选股池</td></tr>
<tr><td>另类数据</td><td>EDB 行业经济指标搜索与时序数据查询、题材指数基本信息与成分股</td></tr>
<tr><td>数据指标</td><td><code>gangtise_indicator_search</code> — 证券级数据指标（EDE）搜索；<code>gangtise_indicator_cross_section</code> / <code>gangtise_indicator_time_series</code> — 指标截面/时序（A/港/美股；支持复权等分指标参数，二维矩阵展平为宽表；美股代码用 <code>.O</code>/<code>.N</code> 后缀）</td></tr>
</tbody>
</table>

## 前置要求

- Node.js ≥ 20.18.1（undici 7.27+ 的要求，见 `package.json#engines`）
- Gangtise 开放平台账号（[申请地址](https://open.gangtise.com)），获取 `accessKey` / `secretKey`

## 快速开始

### Claude Code

```bash
claude mcp add gangtise \
  -e GANGTISE_ACCESS_KEY=your_access_key \
  -e GANGTISE_SECRET_KEY=your_secret_key \
  -- npx -y gangtise-mcp@latest
```

### Claude Desktop

编辑配置文件（根据系统选择路径）：

- **macOS**：`~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**：`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gangtise": {
      "command": "npx",
      "args": ["-y", "gangtise-mcp@latest"],
      "env": {
        "GANGTISE_ACCESS_KEY": "your_access_key",
        "GANGTISE_SECRET_KEY": "your_secret_key"
      }
    }
  }
}
```

修改后重启 Claude Desktop 生效。

### Cursor

编辑 `~/.cursor/mcp.json`（全局）或项目根目录下 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "gangtise": {
      "command": "npx",
      "args": ["-y", "gangtise-mcp@latest"],
      "env": {
        "GANGTISE_ACCESS_KEY": "your_access_key",
        "GANGTISE_SECRET_KEY": "your_secret_key"
      }
    }
  }
}
```

### Windsurf

编辑 `~/.codeium/windsurf/mcp_config.json`：

```json
{
  "mcpServers": {
    "gangtise": {
      "command": "npx",
      "args": ["-y", "gangtise-mcp@latest"],
      "env": {
        "GANGTISE_ACCESS_KEY": "your_access_key",
        "GANGTISE_SECRET_KEY": "your_secret_key"
      }
    }
  }
}
```

### Cline（VS Code 插件）

打开 VS Code → Cline 插件面板 → **MCP Servers** → **Edit MCP Settings**，加入：

```json
{
  "gangtise": {
    "command": "npx",
    "args": ["-y", "gangtise-mcp@latest"],
    "env": {
      "GANGTISE_ACCESS_KEY": "your_access_key",
      "GANGTISE_SECRET_KEY": "your_secret_key"
    }
  }
}
```

### 其他支持 MCP 的客户端

配置格式通用，只需在对应客户端的 MCP 配置文件中加入：

```json
{
  "command": "npx",
  "args": ["-y", "gangtise-mcp@latest"],
  "env": {
    "GANGTISE_ACCESS_KEY": "your_access_key",
    "GANGTISE_SECRET_KEY": "your_secret_key"
  }
}
```

## 升级到最新版本

`npx -y gangtise-mcp` **不会**每次都去 registry 拉最新版——npx 会把已下载的版本缓存到 `~/.npm/_npx/<hash>/` 下，后续启动直接复用。npm 发布了新版本但客户端工具列表没出现新工具时，多半就是这个原因。

任选其一：

**方法 1：配置里钉版本（推荐）** —— 把 args 改成 `["-y", "gangtise-mcp@latest"]` 或具体版本 `["-y", "gangtise-mcp@0.x.x"]`，重启 MCP 客户端即可强制拉新。

**方法 2：清 npx 缓存**

```bash
# macOS / Linux
rm -rf ~/.npm/_npx
# Windows (PowerShell)
Remove-Item -Recurse -Force $env:LOCALAPPDATA\npm-cache\_npx
```

清完缓存后，在 MCP 客户端里关掉再打开 gangtise 服务（或重启客户端），npx 会重新下载最新版。

> 怎么确认当前跑的是哪个版本？查 `~/.npm/_npx/*/node_modules/gangtise-mcp/package.json` 的 `version` 字段。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GANGTISE_ACCESS_KEY` | — | 开放平台 Access Key（与 SECRET_KEY 配对使用） |
| `GANGTISE_SECRET_KEY` | — | 开放平台 Secret Key |
| `GANGTISE_TOKEN` | — | 直接传 Bearer Token（优先于 Key/Secret，适合临时使用） |
| `GANGTISE_BASE_URL` | `https://openapi.gangtise.com` | API 基础地址（旧域名 `https://open.gangtise.com` 仍可用） |
| `GANGTISE_TIMEOUT_MS` | `30000` | 单次请求超时（毫秒） |
| `GANGTISE_MCP_ASYNC_TIMEOUT_MS` | `55000` | 异步 AI 任务默认等待超时（毫秒）；保持在 MCP 客户端请求超时（约 60s）以下，超时返回 dataId 供 `*_check` 续查。需更长等待可调高本值或按调用传 `waitSeconds`（最大 180） |
| `GANGTISE_TOKEN_CACHE_PATH` | `~/.config/gangtise/token.json` | Token 缓存文件路径 |
| `GANGTISE_PAGE_CONCURRENCY` | `5` | 分页并发数 |
| `GANGTISE_INLINE_MAX_BYTES` | `65536` | 工具结果内联字节上限；超过则落盘为临时文件并返回可翻页的预览指针。默认 64KB（约 1.5–2 万 token）控制单次响应体积；批量导出可调大（最低 8192） |
| `GANGTISE_VERBOSE` | — | 设为 `1` 开启请求耗时日志（输出到 stderr） |

认证优先级：`GANGTISE_TOKEN` > Token 缓存文件 > `GANGTISE_ACCESS_KEY` + `GANGTISE_SECRET_KEY`（自动换取并缓存 Token）。

## 大响应处理

当单次工具调用返回超过内联阈值（`GANGTISE_INLINE_MAX_BYTES`，默认 64 KB）时，完整数据会写入系统临时目录下的 `gangtise-mcp-*` 目录（macOS 实际在 `/var/folders/.../T/` 下；JSON 数据为 `response.json`，文本类为 `response.md`），MCP 响应改为内联返回前 20 条预览及元数据：

| 字段 | 说明 |
|---|---|
| `_truncated` | `true` — 表示响应已截断 |
| `_saved_to` | 完整数据的临时文件路径 |
| `_total_bytes` | 完整响应的 UTF-8 字节数 |
| `_total_items` | 文件中的总条数 |
| `_preview_count` | 本次内联返回的条数（最多 20） |
| `_read_with` | 续读工具名（固定为 `gangtise_read_response`） |
| `has_more` | 文件中是否还有未返回的条目 |
| `_local_hint` | 本地处理建议（server 与客户端共享文件系统时适用） |
| `_available_fields` / `_available_fields_sampled` | 采样前 20 行得到的顶层字段名，及实际扫描行数；供 `gangtise_read_response` 的 `fields` 参考 |
| `_available_fields_truncated` | 仅当顶层字段超 50 个时出现（`true`）：`_available_fields` 已截断至前 50 个 |

续读完整数据请调用 **`gangtise_read_response`** 工具（传 `_saved_to` 路径，按 `offset`/`limit` 分页；单页同样受 `GANGTISE_INLINE_MAX_BYTES`（默认 64KB）字节预算约束）——不要依赖客户端直接读文件，Claude Desktop 等无文件读取能力的客户端只能走该工具。若单条内容过大导致 20 条预览本身也超过阈值，则只返回元数据（字段名仍见 `_available_fields`），`_preview_count` 为 0（此时 `has_more: true` 表示数据全部在文件中）。

宽表可用 `fields` 只取所需列（如 `fields: ["tradeDate","close"]`）——投影在字节预算之前完成，因此每页能装下更多行。部分字段名拼错会以 `_unknown_fields` 回显并照常返回其余字段，全部拼错才报错并回列可用字段。

`gangtise_read_response` 每页也受同一字节预算约束：当「信封 + 最小一行」仍超预算（或列表为空但非列表兄弟字段本身超预算）时，仍返回该内容并标 `_oversized: true`——此时单页已无法再缩小，但 `next_offset` 照常推进，翻页不会卡死。

`_local_hint` 仅在 **server 与客户端共享文件系统、且客户端获准访问该路径**时可用：此时可在本地直接投影/过滤/聚合该文件，只把结果读进上下文。**远程 MCP、容器隔离、以及无文件读取能力的客户端（如 Claude Desktop）必须继续走 `gangtise_read_response`。** 注意本地直读不受 MCP 侧 owned-temp-path 校验保护，其安全性取决于客户端自身的文件权限。

## 开发

```bash
git clone https://github.com/gangtiser/gangtise-mcp
cd gangtise-mcp
npm install
npm run dev      # 直接运行源码（tsx，无需 build）
npm run build    # 编译 TypeScript → dist/
npm test         # 运行测试
```

## 发布维护

本包默认通过 GitHub Actions + npm Trusted Publisher 发布，不在本地执行 `npm publish`，也不需要长期 npm token。发布前确保 npm 包设置已信任本仓库的 `.github/workflows/npm-publish.yml` workflow；该 workflow 已配置 `permissions: id-token: write`，推送 `v*` tag 后会通过 OIDC 发布到 npm。

标准流程：

```bash
npm version patch --no-git-tag-version
# 更新 README Changelog，并完成代码/测试修改
npm test
npx tsc --noEmit
npm run build
git add .
git commit -m "fix: <message>"
git push origin main
git tag v0.1.x
git push origin v0.1.x
```

发布完成后确认：

```bash
gh run list --workflow npm-publish.yml --limit 1
npm view gangtise-mcp version
```

如果 GitHub Actions 的 publish 步骤提示 OIDC/trusted publisher 失败，应先检查 npm 包的 Publishing access 设置是否绑定到 `gangtiser/gangtise-mcp` 和 `.github/workflows/npm-publish.yml`，不要改回本地 token 发布。

## License

MIT
