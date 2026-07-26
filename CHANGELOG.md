# 更新日志

> README 顶部只放最近 5 个版本的一行摘要 + 历史里程碑；本文件是完整历史明细（中文），回溯至 0.1.3。

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

### 0.1.44 (2026-07-21)
- **工具发现 / 计费透明 / 大响应消费**（向后兼容，工具数仍 92）：
  - **`server.instructions` 重写为路由层**（429B → 1,583B 静态，含日期前缀合计 1,751B，门禁 ≤1,800B）：修掉旧文案里 `vault_*` / `reference_*` 这类**并不存在的工具前缀**（那是 src 文件名，模型照此检索必扑空），补齐四大族（行情财务 / 内容 / AI / 私域参考）的路由与市场变体规则
  - **新增积分目录 `src/tools/billing.ts`**：92 个工具全部归档（free 34 / fixed 43 / downstream 1 / variable 2 / unconfirmed 9 / local 3），由注册器自动把 `【积分：50/次】` 这类紧凑标签追加到描述尾，并清掉 7 处与计分表不符或会与标签叠字的手写计费文案。免费档不打标签（instructions 末行已声明「未标注即免费」，省 714B）。**积分与 retry 策略、MCP annotations 三者独立建模，互不推导**；目录键集合 == 注册工具名集合有测试钉住防漂移
  - **分页参数文案单点缩短** 223B → 120B/工具（×21 = −2,163B）；18 个付费分页工具补 `fetchAll` 计费警示（不改默认 size、不自动开 fetchAll）
  - **`gangtise_theme_tracking` 取消本地 30 天窗口拦截**：取数窗口随账号权限变化（标称窗口不等于实际拦截线，实际以账号权限为准），超范围交由上游报错；错误码 `110003` 补中文提示。**未来日期的本地拒绝保留** —— 没有账号能拿到明天的早报，50 积分/次不值得赌
  - **`gangtise_knowledge_batch` 时间参数收字符串**：`startTime`/`endTime` 接受 `YYYY-MM-DD HH:mm:ss`（按固定 +08:00 转毫秒，不依赖机器时区）或原有 epoch 毫秒；不收纯日期（`endTime` 会被当 00:00 静默丢当天数据）
  - **`gangtise_read_response` 新增 `fields` 顶层投影**：宽表按需取列，投影先于字节预算计算，故每页装更多行。部分字段拼错会以 `_unknown_fields` 回显而非静默丢弃，全部拼错则报错并回列可用字段；未知字段判定扫全部行（只出现在第 21 行的稀疏字段不会被误杀）
  - **分页字节预算修正**：原先只累加行字节、未计入 `_saved_to`/`_total_items`/`_note` 等信封字段，导致「行贴边不超限、拼上信封就超限」的载荷溜过检查（实测单行 65,509B → 完整 payload 65,779B）。现按行+信封计；信封与最小一行仍超预算时返回该行并标 `_oversized: true`，翻页不卡死
  - **溢出指针增 `_local_hint` 与 `_available_fields`**：同机可读文件的客户端可在本地投影/过滤后只取所需结果；`_available_fields` 采样前 20 行并附 `_available_fields_sampled`（实际扫描行数，可与 `_total_items` 比对判断清单是否完整），字段超 50 个截断并标 `_available_fields_truncated`。**远程 MCP / 容器隔离 / 无文件权限的客户端必须继续用 `gangtise_read_response`**。metadata-only 回退（单行即超预算）的字段名改由封顶的 `_available_fields` 提供，移除旧的无上限 `_first_item_keys`（后者在超宽行上可自身撑爆预览指针字节预算）
  - 3 个 AI 工具描述「生成」改「获取」与 instructions ③「均取预生成内容」对齐；`indicator_search`/`opinion_list`/`foreign_opinion_list`/`stock_summary` 补路由边界句
  - `tools/list` 实测 107,201B → 108,961B（+1,760B，+1.64%）
- 测试 332 → 399

### 0.1.43 (2026-07-11)
- 同步 gangtise-openapi-cli v0.24–v0.27：
  - **资金安全：16 个按次计费端点改 no-replay 重试策略**（一页通/投资逻辑/同业对比/研究提纲/主题跟踪/管理层讨论×2/热点话题/知识库批量/业绩点评提交/观点辩证提交/题材信息/题材成分股 + 纪要/外资研报/我的会议三个下载）——上游实测（2026-07-11）按次计费且缓存命中不豁免，5xx/响应超时/999999 不再自动重放（此前一次超时最多三连扣）；仅连接期错误（ECONNREFUSED/DNS 类，请求未发出）、429 与 token 自愈仍重试，连接期错误同时纳入默认重试范围；精确集合守卫测试钉住注解清单（`gangtise_qa_list`/`gangtise_report_image_download` 经复核维持默认重试：按条计费失败响应不扣费 / 0.1 积分档风险接受，依据见 `tests/unit/core/endpoints.test.ts` 注释）
  - **7 个同步 AI 生成端点 120s 超时下限**（生效值 = max(`GANGTISE_TIMEOUT_MS`, 120s)）——生成慢不再撞 30s 默认超时→重试→重复计费
  - **EDE 指标 999999 不再重试**——实测 999999 + HTTP 500 = 查询无数据（节假日/未来日期/未覆盖标的），此前每次空查询白烧 3 个请求 ~4 秒；错误提示改为指向检查查询条件而非「稍后重试」
  - **新增 4 个工具**：`gangtise_qa_list` 投资者问答（互动平台/电话会议/调研纪要的提问与回答，0.1 积分/条，自动翻页）；`gangtise_report_image_list`（免费）+ `gangtise_report_image_download`（0.1 积分/张，JPEG）研报图表按关键词搜索与下载；`gangtise_official_account_search` 公众号 ID 搜索（免费，结果喂 `gangtise_official_account_list`；注意未分类公众号 category 为 null，传 category 过滤会漏掉）
  - **indicator 三工具覆盖扩展至 A/港/美股**（服务端变更）——描述补美股交易所后缀 `.O`(NASDAQ)/`.N`(NYSE) 说明（官方示例的 `.US` 查不到数据）
  - **正确性**：EDE 矩阵中与 `date`/`security`/`name` 同名的指标列自动加代码后缀，不再覆盖元数据列；错误码 `100003`（参数值非法）补中文提示（服务端不指明参数，提示对照枚举拼写）；异步轮询容忍瞬态 5xx/网络错误——只消耗一次尝试继续等待，不再作废整段计费等待（410111 终态仍立即失败）
  - **性能**：JSON 请求启用 gzip（上游实测 3.6x，K 线类更高；损坏 gzip 包装为带请求上下文的 ApiError）；全市场 1 天/片分片跳过周六日（闭市必空，省 ~28% 请求与每日配额；含单日快速路径，纯周末区间零请求直接返空）；撞行数上限的分片以 `_truncated_shards` 输出具体日期区间（与 `_failed_shards` 对称，可定向缩窗补拉）
- GPT-5.6 review 批次（0.1.42 后未发版部分）：
  - **异步等待预算从工具调用起点计时**——submit 耗时计入 `waitSeconds`，预算耗尽即刻返回 dataId 不再多打一次计费轮询；单次轮询调用同样受剩余预算约束（防止卡到 MCP 客户端 ~60s 截止丢失已计费 dataId）
  - **入参校验收紧**——新增共享 `nonEmptyString` / `intLiteralEnum`（`schemas.ts`）：AI/insight/fundamental 的 ID/代码类必填参数拒绝空白，8 个下载工具 `fileType` 改字面量枚举，知识库 `securityList` 上限 6000 等
  - **`GANGTISE_PAGE_CONCURRENCY` 上限钳制 32**——超大值不再打爆 socket/触发限流；非法值仍回退默认 5
  - **CI 发布加固**——npm-publish workflow 拆分 verify（运行依赖代码、无 OIDC token）与 publish（仅持 token 发布已验证 tarball，不运行任何包代码）两个 job；tag 必须在 origin/main 上才允许发布
- undici 版本下限 `^7.16.0` → `^7.28.0`（GHSA-35p6-xmwp-9g52 keep-alive 队列污染；lockfile 早已解析到 7.28.0）
- 测试 272 → 332

### 0.1.42 (2026-07-06)
- 质量护栏与内部重构（无对外行为变化，除并发负值修正）：
  - **新增 spec↔ENDPOINTS 交叉校验测试**——遍历所有 spec 驱动工具，钉住每个 `endpointKey` 存在于 `ENDPOINTS`、json/download 种类匹配、`paginated` 与端点 `pagination.enabled` 双向一致、工具名唯一且 `gangtise_` 前缀；另一条 spec-liveness 测试启动整个 server 断言每个 spec 都真实注册（自适应，取代集成测试里需手工维护的工具名单）。挡住跟 gangtise-openapi-cli 同步时易引入的 endpoint/参数错配类 bug
  - **`GANGTISE_PAGE_CONCURRENCY` 收口到 `config.ts`**——原先 `client.ts`（分页扇出）与 `quoteSharding.ts`（分片扇出）各自在模块加载期读一次 env，现统一为 `config.ts` 的 `PAGE_CONCURRENCY`（经可测的 `resolvePageConcurrency`，与 `INLINE_MAX_BYTES` 同款）；顺带修掉旧 `Number(x)||5` 放行负数并发的潜在 bug（0/负/NaN 回退默认、小数向下取整）
  - **`gangtise_fund_flow` 市场校验复用 `assertMarketMatch`**——去掉内联重复的后缀→市场检查（`assertMarketMatch` 加可选 `sentinel`/`message`），保留其「资金流向仅支持 A 股」专属提示与 `aShares` 哨兵
  - **`gangtise_read_response` 分页提示文案修正**——`_note` 里过期的「256KB」改为动态引用实际 `INLINE_MAX_BYTES`（0.1.40 起默认 64KB、可 env 覆盖）
  - 删除 `gangtise_security_clue_list` / `gangtise_hot_topic` spec 里冗余的 `from` 字段（分页工具的 `from`/`size`/`fetchAll` 由注册器统一注入）
- 测试 265 → 272

### 0.1.41 (2026-07-06)
- 同步 gangtise-openapi-cli v0.23：
  - **默认 API 域名迁移** `open.gangtise.com` → `openapi.gangtise.com`（新旧域名多接口实测等价、旧域名仍可用；固定旧域名设 `GANGTISE_BASE_URL=https://open.gangtise.com`）
  - **新增 `gangtise_fund_flow`**（A 股个股日资金流向，沪深北）——含小/中/大/特大单流入流出金额及占比、主力净流入等字段；免费。`security` 传单/多只代码（仅 A 股沪深北，传港/美股代码本地即报错，不静默返空），或 `'aShares'` 配合 `startDate`/`endDate` 拉全市场（自动按 1 天/片分片合并，缺日期本地报错）
  - **新增 `gangtise_institution_search`**（机构 ID 搜索）——按机构名/简称返回 `institutionId` 及 `usageScopes`（标明用于哪个接口的哪个参数），覆盖内资券商/外资/牵头/观点/外资观点机构，供各 list 工具 `institutionList`/`brokerList` 等参数使用；免费
  - **`gangtise_my_conference_list` 新增 `sourceList`**——按录制来源筛选（1=企微会议助理 | 2=会议服务微信群，可多选）
  - **`gangtise_wechat_chatroom_list` 适配服务端改版**——上游改返 `{total, list}`（原 `chatRoomList` 且无 total），改为标准分页端点按 `total` 并发翻页（旧的 `chatRoomList` 串行翻页对新结构会漏读）；省略 `size` 拉全部群、传 `size` 取前 N 条，`roomName` 多值仍以逗号拼接为标量下发
  - **行情截断防静默**——无翻页行情端点（`gangtise_fund_flow` / `gangtise_minute_kline` / 显式多标的日 K〔A/港/美〕/ 指数日 K）单次请求返回行数达到 `limit`（默认 6000 / 上限 10000）时标 `_partial`（`limit_truncated`）；默认 `limit=6000` 现显式写入请求体，令截断判定不受服务端默认值漂移影响（分钟 K `limit` 描述笔误 5000→6000 一并修正）。`security='all'` 全市场分片路径同样在分片失败或单片撞行数上限时标 `_partial`（`failed_shards` / `limit_truncated`），不再只标失败。混用 `'all'`/`'aShares'` 与具体代码本地即报错（避免落到无 limit 注入/不标截断的裸请求）
- 对齐 CLI v0.23 源码：清理 `normalize.ts` 已失效的 `chatRoomList` 分支（服务端改返 `list`）；各 list 工具的 broker/institution ID 参数描述改为优先引导 `gangtise_institution_search`，并按接口标注对应机构分类（内资研报=`domesticBroker` / 外资研报=`foreignInstitution` / 内资观点=`opinionInstitution` / 外资观点=`foreignOpinionInstitution` / 纪要·路演·调研·策略=`leadInstitution`），模型可直接带 `categoryList` 精确搜；本地静态表仅作全量枚举兜底
- 测试 250 → 265

### 0.1.40 (2026-07-05)
- 对抗式审查 batch 3 收尾（健壮性 / 参数一致性 / 描述路由 / 工具注解，逐条单独核实）：
  - **健壮性修复（3 个真行为 bug）**：
    - token 缓存写失败不再连累当前请求（#35）——token 已在内存中有效、落盘仅是跨进程缓存优化；此前只读 home / ENOSPC 写盘抛错会让触发刷新的在途请求（及并发等待者）一起失败，现在吞掉写错误（`verbose` 记日志）、请求照常返回数据
    - 超大截断预览收缩为样本而非清空（#33）——20 行预览本身超内联预算时（大行如公告全文），此前整份 list 被丢、模型拿到零示例行无从得知字段；现在样本逐级减半（20→10→5→2→1）直到装下、保留几行真数据，单行都装不下才退回 metadata-only 并以 `_first_item_keys` 暴露首行字段名（落盘文件不变，`has_more`/`next_offset` 指向样本之后供续读）
    - async `_check` 终态失败带出原因（#36）——`410111`（失败）分支此前只返回 `{status,dataId}` 丢了 reason，模型无从判断为何失败或是否该重提；现补 `error`（错误码 + 可操作提示），与 submit 路径一致
  - **K 线/实时字段参数统一为 `fieldList`（#32）**：quote 工具原用 `field`，而 13 个基本面工具及上游 body key 都用 `fieldList`；zod v3 strip 静默丢弃未知 key，习惯性给 K 线/实时工具传 `fieldList` 会被无声丢弃、拿回未过滤全字段数据。跨 `commonKlineSchema` / 分钟线 / 实时 / `buildKlineBody` / 美股默认字段回退统一改名，不设别名（两个同义词只会误导模型）
  - **内联阈值可配置，默认 256KB → 64KB（#16）**：`INLINE_MAX_BYTES` 原在 `registry.ts` + `response.ts` 硬编码两处，统一到 `config.ts` 单一来源、env 可覆盖 `GANGTISE_INLINE_MAX_BYTES`（下限 8KB）。降到 64KB（约 15-20K token）——单个结果落入客户端典型显示预算内，且落盘结果总留可分页预览指针，64-256KB 响应从「整块 dump 无分页退路」变为可经 `gangtise_read_response` 续读（批量导出会话可调高）
  - **工具描述 / 路由指引**：
    - 重叠工具补「何时用我 vs 另一个」路由指引（#28）——`gangtise_knowledge_batch` / `gangtise_edb_search` / `gangtise_indicator_search`（语义搜索 vs 结构化 `*_list`；EDB 宏观/行业 vs EDE 证券级）
    - async submit describe 警告任务计费且非幂等（用返回的 `dataId` 配 `*_check`、勿重提），`_check` describe 说明 `dataId` 来源及 pending=继续轮询（#29）
    - `gangtise_securities_search` category `z.string()`→`z.enum`（stock/dr/index/fund）非法值边界拒绝、不再静默 no-op；补 `research_list` rankType（1=综合默认 | 2=时间倒序）、top gains `.max(10)` 等 X5 schema 收紧漏网 describe（#30/#31）
  - **全工具声明 `openWorldHint: false`（#37）**：每个工具只触达单一封闭域 API（Gangtise）或纯本地数据、从不触达开放世界，MCP 把缺失的 `openWorldHint` 当 true，故 26 个工具注解全部显式置 false（async submit 保持 `readOnlyHint:false`，其余 `readOnlyHint:true`），集成测试钉住该不变式
- 测试 246 → 250

### 0.1.39 (2026-07-03)
- 对抗式审查后续（性能 / 健壮性 / 可用性，逐条单独核实实现）：
  - **响应 JSON 改紧凑序列化**：去掉模型可见输出与落盘文件的 2 空格缩进——实测日 K 载荷 -38% 字节（59KB→36.8KB），纯 token 节省；256KB 内联阈值 / 落盘 / `gangtise_read_response` 分页字节预算全部按紧凑字节统一度量，更多数据得以内联、减少续读往返（`context.ts` 小日期载荷与 `auth.ts` 令牌缓存保留原格式）
  - **异步 AI 默认等待 180s→55s**：原 180s 超过 MCP 客户端约 60s 请求超时，客户端在服务端返回 `{dataId, status:"timeout"}` 前即断开，计费任务的 dataId 丢失、无从 `*_check` 续查；55s 让超时响应及时返回。`GANGTISE_MCP_ASYNC_TIMEOUT_MS` 语义不变（可调高，或按调用传 `waitSeconds` 最大 180）
  - **K 线市场/工具错配预校验**：`.HK`/`.O` 代码传给 A 股 `gangtise_day_kline`（或 A 股代码传 `_hk`/`_us`）此前打到上游返回静默空列表、与「区间无数据」难辨；现在明显跨市场错配在请求前抛错并点名正确工具、不花 API（跳过 `security:'all'` 与未知后缀防误伤；指数 / 分钟 / 实时接口不校验）
  - **429 限流退避尊重 Retry-After**：429 此前与 5xx 共用 400ms/4s 退避且丢弃 `Retry-After` 头（狂敲已限流的接口）；现 429 走更狠的 2s 基 / 15s 顶退避，服务端 `Retry-After`（429 或 503）更长时采纳并封顶 15s（防超大/恶意值卡死），JSON 与下载两条请求路径均覆盖；5xx / 网络退避逐字节不变，重试次数仍为 2
- 测试 234 → 246

### 0.1.38 (2026-07-03)
- 对抗式审查（6 维度并行 + 逐条对抗核实）后的工具描述 / schema 收紧：
  - **枚举收紧防静默 no-op**：`gangtise_summary_list` 会议纪要类别修正为实测有效的 9 值集（删无效的 `expertInterview`/`fieldResearch`/`industryConference`——上游对未知值静默忽略过滤、返回全量 17 万条）；`gangtise_research_list` / `gangtise_foreign_report_list` 修正 `quantitative`→`quant` 并补齐 15 值集；连同 fundamental / ai / vault / indicator 共 18 组闭集参数（报告期、报表类型、拆分、股东类型、估值指标、查询模式、管理层讨论维度、内容类型、币种、量纲、日历类型等）从宽松 `string` 收紧为 `z.enum`——非法值在 MCP schema 层即拒绝，不再打到上游得静默 no-op 或不透明错误（取值全部对 CLI 文档闭集核实）
  - **错误可诊断**：未知上游错误码始终带出「（错误码 X）」，补 `999994`（vault 权限/配额）、`0000001008`（令牌失效/被顶号）提示；下载失败带 HTTP 状态码 + 响应体片段（区分 404 失效 ID / 403 权限）
  - **选对工具/参数**：server instructions 补证券代码后缀约定（`.SH/.SZ/.BJ`=A股 / `.HK`=港股 / `.O/.N/.A`=美股）与「只知名称先 `gangtise_securities_search`」；4 个日程工具与会议纪要工具双向消歧；补港/美股 `securityCode` 格式示例、港股/指数 K 线 `'all'` 全市场能力、`period` 标注修正（`h2`=下半年报，原误标年报）、`conceptList`/`institutionList`/`brokerList` ID 来源、外资研报评级枚举、`hot_topic` 布尔参数、分页 `from`/`size`/`fetchAll` 说明
  - **空结果 / 续读**：空列表结果附 `_hint` 区分「真无数据」与「参数不匹配」（漏交易所后缀等）；截断预览补 `next_offset` 对齐 `gangtise_read_response` 续读契约，不再重复拉取预览项
  - `gangtise_earnings_review` 的 `period` 加正则校验（计费且不可重试的提交，防畸形格式白扣一次费）
- 测试 227 → 234

### 0.1.37 (2026-07-02)
- Schema 全面收紧（原审查搁置项 X5）：畸形日期/时间在本地 schema 层快速失败，不再透传给上游被静默改写（JS Date 会把 2026-02-30 滚成 2026-03-02）或返回不透明错误
  - `dateString`（YYYY-MM-DD + 日历 round-trip 校验，原 quote.ts 私有实现）与新增 `dateTimeString`（YYYY-MM-DD HH:mm:ss，时分秒范围 + 日历校验）、`quarterEndDate`（季末报告期）提取至 `dateContext.ts` 统一导出
  - 覆盖全部日期/时间参数：fundamental（三大报表 startDate/endDate）、alternative（EDB）、indicator（截面 date / 时序 startDate/endDate）、insight（日程类 4 组 startTime/endTime）、vault（云盘/录音/会议/微信 4 组 startTime/endTime）、ai（线索 startTime/endTime、热点 startDate/endDate、主题跟踪 date、管理层讨论 reportDate——后者按接口限定 中报/年报 或 四季末）、quote（分钟线 startTime/endTime）
  - `gangtise_stock_pool_stocks` 的 `poolIdList` 拒绝空数组（实测上游对 `[]` 返回空列表而非文档承诺的"所有池"默认值，静默错答案）——查所有池请省略该参数
- 测试 210 → 227（schema 边界单元测试 + 工具级拒绝/通过用例；已对真实 API 冒烟验证合法值不受影响）

### 0.1.36 (2026-07-02)
- 对抗式审查第三批（工程加固）+ 补测试时发现的真 bug：
  - **修复 indicator（EDE）内层失败信封漏判**：失败信封不带 `data` 键（`{code,status:false,msg}`）时，`unwrapIndicatorData` 因判定条件要求 `data` 存在而原样放行，三个 indicator 工具把权限/配额错误当"成功数据"返回。现按 `code`/`status` 判定失败（补齐信封证据守卫防误伤）。注：同门 CLI 同款实现有同样问题，待同步
  - 全市场 K 线分片合并后 `total` 重算为合并行数，不再泄漏第一个分片的 `total`（此前 total=单日行数 + 全量 list，误导完整性判断）
  - token 缓存目录以 `0700` 创建（对齐文件 0600 策略；此前按 umask 落成 755，同机其他用户可列目录）
- CI/发布链加固：
  - `ci.yml` 增加 `permissions: contents: read`（此前默认 token 权限暴露给依赖安装脚本）+ `npm audit --omit=dev` 步骤（CI 走官方 registry，本地 npmmirror 无法 audit）
  - 两个 workflow 的 `actions/checkout`、`actions/setup-node` pin 到 commit SHA；`npm ci --ignore-scripts`（发布 job 持有 OIDC id-token，不给依赖生命周期脚本执行机会）
  - 移除 `workflow_dispatch` 触发器——手动触发会跳过 tag↔版本一致性校验、从分支直接发版
- 测试补盲区（210 个）：token 刷新 single-flight 并发去重、`gangtise_read_response` 拒绝他进程创建的同前缀目录（钉住 0.1.28 的进程隔离语义）、港股 2 天/片分片边界（无重叠无缺日+尾片截断）、indicator 内层失败信封 → `isError`（上述真 bug 即由此测试暴露）
- README 修正：大响应章节改为真实路径与 `gangtise_read_response` 续读指引（此前写 `/tmp/...` 且教直接读文件，无文件能力的客户端走不通）、字段表补 `_read_with`、前置要求改 Node ≥ 20.18.1（对齐 engines）

### 0.1.35 (2026-07-02)
- 对抗式审查第二批修复（防线加固）：
  - `gangtise_read_response`：list 分页新增 256KB 字节预算——单行巨大（公告全文等）时按字节截短本页并给 `next_offset` 指引，不再一次内联数 MB 击穿截断契约
  - 全市场 K 线：分片数护栏（>180 片直接拒绝并提示缩小区间）——此前多年区间会先成功拉完全部分片、再在合并序列化时撞 V8 字符串上限（RangeError），数分钟抓取全部作废
  - 文本切片（read_response 文本/大对象分片、大文本预览）不再切开 surrogate pair——70K 字符边界落在 emoji 等 4 字节字符中间时产生孤立代理项，严格 UTF-8 消费端会拒收
  - `gangtise_read_response` 读取时刷新落盘目录 mtime——防第二个实例的 24h 启动清扫误删仍在使用的长会话（Claude Desktop 常驻场景）落盘文件
  - auth 自愈：`noRetry` 端点（计费 submit）刷新 token 成功后现在会重放一次请求（auth 被拒的请求未到达后端处理器，重放不会重复扣费；此前刷新成功但直接把 auth 错误抛给用户）
  - auth 自愈：强制刷新前先重读共享 token 缓存文件——若同机 gangtise CLI 已刷新，直接采纳其 token，不再重复登录互相顶号
  - 分页：首页短返回/中间页欠填但 `total` 表明还有数据时，标记 `_partial` + `short_page`（对齐 loud-partial 契约，此前是无标记的静默数据空洞）
  - K 线 `limit`/`security` 参数描述补关键语义：上游从窗口开头截取（取「最近 N 条」须传日期区间）；`security:'all'` 须同时传两个日期
- 测试 195 → 203

### 0.1.34 (2026-07-02)
- 对抗式审查（7 路并行审查 + 反驳式验证）第一批修复：
  - 下载：文件名含字面 `%`（如「盈利增长50%点评.pdf」，研报标题常见）不再抛 `URIError` 令整个下载失败；decode 失败回退原始文件名
  - 下载：带 `content-disposition` 的 JSON 文件附件按原始字节返回，不再被误当 API 信封剥壳（内容改写）或误判为 API 错误（云盘自存 `.json` 场景）
  - 异步 AI：`*_check` 对「已完成但内容为空」的任务不再永远返回 pending（truthiness 判断改 `!= null`）；submit→poll 路径空内容同样返回「内容为空」提示而非空白文本块
  - 大响应：预览超限降级为 metadata-only 时 `has_more` 按 `_total_items` 重算，不再误报 `false` 误导调用方跳过整份落盘数据
  - 全市场 K 线：缺任一日期时同样注入 10000 行上限（对齐 CLI 行为；实测上游当前对开区间全市场返回空数据或「行情查询超出限制」，此为防御性对齐，防上游语义变化后出现 6000 行静默截断）
- 测试 189 → 195

### 0.1.33 (2026-06-29)
- 数据可靠性硬化（来自多轮审计）：
  - 分页：后续页失败返回已取页 + `_partial` / `_failed_pages`，不再整批作废（对齐分片的 loud-partial 契约）
  - 异步 AI：轮询中途失败（超时 / 410111 / 其他）保留 `dataId`，已扣费任务可经 `*_check` 找回
  - 全市场日 K 线：schema 拒绝畸形或不存在的日历日期（`2026-4-1` / `2026-13-45` / `2026-02-30`），避免 `security:'all'` 静默降级为单次截断或日期被改写
  - 指标时序：拒绝「多指标 × 多证券」歧义矩阵（此前静默丢一个维度）
- 同步 CLI v0.21.0：
  - `gangtise_wechat_chatroom_list` 省略 `size` 改为自动翻页拉取全部群（接口无 `total`，按页上限 50 串行翻页；传 `size` 为跨页总量上限），不再静默只返 20 条；后续页失败 fail-soft
  - token 缓存改为临时文件 + 原子 `rename` 写入（0600 从第一字节），消除旧文件宽松权限残留与崩溃截断
- 审计跟进修复：
  - `gangtise_read_response` 大对象按字节预算分片，不再整坨内联回上下文（续读不再绕过 256KB 截断）
  - `gangtise_earnings_review` / `gangtise_viewpoint_debate` 提交工具去除 `readOnlyHint`（计费、不可重试，客户端不应免确认自动调用）；对应 `_check` 仍只读
  - `engines.node` 提升至 `>=20.18.1`（匹配 undici 7.27.2）
- 测试扩展：新增日期校验、指标互斥守卫、chatroom 翻页 / fail-soft、token 原子写、异步 submit→poll 对、大响应字节分片等单测（共 189）

### 0.1.32 (2026-06-27)
- 修复 `gangtise_independent_opinion_download`：参数名 `opinionId` → `independentOpinionId`（上游 API 与 `gangtise_independent_opinion_list` 返回字段均为 `independentOpinionId`；旧名导致任何调用都返回 HTTP 400，该工具自注册起即不可用）。已对真实 API 端到端验证修复。
- `gangtise_one_pager` / `gangtise_investment_logic` / `gangtise_peer_comparison` / `gangtise_research_outline`：后端返回空内容时给出「该证券暂无相关 AI 生成内容」提示，替代此前的空白文本块。
- 全量接口真实联调：86 个 MCP 工具端到端真跑（上述 download 参数名 bug 即由此发现并修复）。

### 0.1.31 (2026-06-27)
- 同步 CLI v0.19.0 + v0.20.0：新增 10 个工具，覆盖证券级数据指标（EDE）、美股财报/公告、个股看点、首席搜索
  - **证券级数据指标（EDE）** 3 工具：`gangtise_indicator_search`（按名称搜指标 code 及可传参数 `parameterList`，取数前必先 search，勿猜编码）/ `gangtise_indicator_cross_section`（多指标 × 多证券，单日截面）/ `gangtise_indicator_time_series`（多指标 × 单证券 或 单指标 × 多证券，按区间）；复权等分指标参数用 `indicatorParamList`（`adjustmentType` 1=不复权 | 2=前复权 | 3=后复权）；EDE 双层信封自动剥离（含内层错误码透出），二维矩阵展平为 `{date, security, 指标:值}` 宽表
  - **美股财报** 3 工具：`gangtise_income_statement_us` / `gangtise_balance_sheet_us` / `gangtise_cash_flow_us`（参数同 A 股/港股财报）
  - **美股公告** 2 工具：`gangtise_announcement_us_list`（按证券/类别 `usShareAnnouncementCategory`/时间筛选）/ `gangtise_announcement_us_download`（`fileType` 1=原始 PDF（默认）| 2=Markdown）
  - **个股看点** `gangtise_stock_summary`：按证券返回精炼投研总结，`securityList` 必填（A 股/港股代码，或市场关键词 `aShares`/`hkStocks`），空列表本地拦截防全市场误扣分
  - **首席搜索** `gangtise_chiefs_search`：按姓名/机构/团队搜首席分析师 ID，供 `gangtise_opinion_list.chiefList` 使用
- `gangtise_announcement_hk_download` 新增 `fileType`（1=原始（默认）| 2=Markdown），此前无格式选项
- `gangtise_constant_list` 的 `category` 枚举补 `usShareAnnouncementCategory`（美股公告分类，`103980xxx` 段）
- CLI v0.20.0 的几项修复 MCP 早有等价实现或语义不适用：分页 fail-soft 见 0.1.28 的 `_partial` 标记；`gangtise_hot_topic` 的 `withRelatedSecurities`/`withCloseReading` 本就是显式可选布尔；`gangtise_knowledge_batch.queries` 已 `min(1)` 强制非空；MCP 不导出 CSV
- 扩展测试覆盖：新增 EDE 矩阵展平单测 + 美股/指标/个股看点集成测试（共 154）

### 0.1.30 (2026-06-17)
- 同步 CLI v0.18.0：新增「产业公众号资讯」2 个工具
  - `gangtise_official_account_list`：查询公众号资讯列表，支持 `keyword`（需用数据中的具体词，非整句白话）/ `accountIdList`（公众号 ID）/ `securityList` / `categoryList`（文章类型枚举：news / law / report / view / data / event / meeting / notice / recruit / investEdu / brand / notes / other）/ `industryList`（citicIndustry）/ `searchType`（1=标题 | 2=全文）/ `rankType`（1=综合 | 2=时间倒序）；返回含模型生成摘要 `summary` 及关联行业/题材/证券列表
  - `gangtise_official_account_download`：按 `articleId` 下载公众号文章，`fileType` 1=txt（默认）| 2=HTML
- 修复：下载流式写盘中途失败时，清理残缺临时文件与整个临时目录（对齐 CLI v0.17.1；此前遗漏，失败的下载会残留 temp 目录直到下次启动清扫）
- CLI v0.17.1 的分页 cap 警告，MCP 早有等价且更优实现（结构化 `_partial` / `_page_cap` 字段，而非 stderr 警告）；token 服务端失效自愈 `0000001008` 已在 0.1.29 同步

### 0.1.29 (2026-06-16)
- token 自动续期覆盖「服务端失效」场景：缓存 token 被服务端判失效（HTTP 401，错误码 `0000001008`，常见于在别处重新登录挤掉了原会话）时，客户端自动重新登录并重试一次。此前仅 `8000014/8000015`（HTTP 200 信封）会触发续期，而 4xx 响应在进入续期逻辑前就抛错，导致 Cherry Studio 等 MCP 客户端遇到 token 失效只能手动重登；现在会自愈。

### 0.1.28 (2026-06-16)
内部健壮性与发布链路加固（无 CLI 同步，无工具入参变更）：
- 分页：某页返回异常结构或 `total` 中途漂移时，响应标记 `_partial` + `_partial_reason`（此前静默返回不完整列表，仅 verbose 日志）
- AI 异步提交（`gangtise_earnings_review` / `gangtise_viewpoint_debate`）遇 5xx 不再自动重试，避免重复建任务、重复扣分
- 修复 auth 刷新失败掩盖原始 API 错误：重新登录失败时抛出原始请求错误而非次生错误
- `gangtise_read_response` 仅允许读取本进程生成的临时文件（此前只校验目录名前缀，与工具描述不符）
- 并发请求首个失败即停止后续取数并消除潜在未捕获拒绝；下载写盘失败时清理临时目录；`gangtise_lookup` 统一走大响应截断保护
- CI 增加 Node 20/22/24 矩阵；发布流程校验 git tag 与 `package.json` 版本一致并启用 npm provenance；`build` 先清理 `dist/`
- 新增 config / auth / 分页 partial / 并发失败 等单测（115 → 133）

### 0.1.25–0.1.27 (2026-06-15)
- 同步 CLI v0.17.0：日程类 4 工具各自只暴露 API spec 支持的字段（之前共享 11 字段大 schema，传不支持字段静默无效）
  - `gangtise_roadshow_list`：researchArea / institution / security / location / category / market / participantRole / brokerType / permission
  - `gangtise_site_visit_list`：同上去掉 participantRole/brokerType，加 object；market 范围排除美股
  - `gangtise_strategy_list`：仅 institution / location
  - `gangtise_forum_list`：仅 researchArea / location
- `gangtise_announcement_list` 移除服务端忽略的 `announcementTypeList`（A 股公告分类筛选用 `categoryList`）
- 对齐 CLI v0.17.0 路由建议：`industryList` / `industryIdList` 统一用 `category=citicIndustry`（`1008001xx`）；`researchAreaList` 统一用 `category=gangtiseIndustry`（行业 + 宏观/策略/固收等方向 `122000xxx`）
- 修复 `gangtise_knowledge_resource_download` query param：`resourceId` → `resourceType`(int) + `sourceId`(str)（原字段名打错，下载必然失败）
- 修复 `gangtise_security_clue_list` 的 `source` 类型：`string` → `string[]`，与 CLI 及 API 对齐
- 补全 `gangtise_knowledge_batch` 的 `startTime` / `endTime` 参数（epoch 毫秒，CLI 有 MCP 之前缺失）
- 补全 `gangtise_opinion_list.researchAreaList` 描述，对齐 `category=gangtiseIndustry`（其他工具已在 v0.1.24 更新，此处遗漏）

### 0.1.24 (2026-06-13)
- 接口路由审计后的校验与指路加固（无新增/删除工具，仍 74 个）：
  - `gangtise_constant_list` 的 `category` 收窄为枚举：传错在本地即拦截并回显 7 个合法值，不再静默返回 `null`
  - 上游返回空数据时归一化为稳定的 `list: []`（此前键名在 `list` 与 `constants: null` 间漂移）
  - `gangtise_concept_search` / `gangtise_securities_search` 的 `keyword` 与 `gangtise_sector_constituents` 的 `sectorId` 加非空校验，空串/纯空白本地拦截
  - 新增错误码 `410001` 提示，按 ID 来源引导改用对应 reference 工具
  - 补全 `industryList` / `researchAreaList` / `industryIdList` 参数描述，写明 ID 来源分类
  - `gangtise_sector_search` 描述澄清拼音首字母仅对概念类板块有效，申万/指数类请用中文

### 0.1.22–0.1.23 (2026-06-12)
- 同步 CLI v0.16.0：移除申万行业代码本地表，`gangtise_lookup` 仅剩券商机构 / 会议机构
  - 31 个申万行业指数代码（`821xxx.SWI`）改走板块 API：`gangtise_sector_search`（取「指数数据板块」层级节点 `2000000014`）→ `gangtise_sector_constituents`；单个行业也可直接 `gangtise_securities_search`（如 `keyword=申万银行 category=['index']`）
- 同步 CLI reference 常量/题材/板块 API：
  - 新增 `gangtise_constant_category` / `gangtise_constant_list`：行业、城市、公告分类、区域等常量（树形分类含 `children`，`constants` 自动归一化为 `list`）
  - 新增 `gangtise_concept_search`：按中文名/拼音/分组名搜索题材 ID
  - 新增 `gangtise_sector_search` / `gangtise_sector_constituents`：板块 ID 搜索与全量成分股
  - `gangtise_lookup` 退出研究方向/行业/地区/公告类别/主题 ID 本地数据（-2700 行静态表，改由上述 API 实时提供）
  - 日程类工具新增 `locationList` 筛选（domesticCity 常量 ID）
- 同步 CLI v0.15.1 错误码提示（410110/410111/410004/430004/430007/433007/10011401）

### 0.1.20–0.1.21 (2026-06-10)
- 全部工具声明 `annotations: { readOnlyHint: true }`，支持该注解的客户端（如 VS Code Copilot）可跳过确认弹窗
- 补齐核心模块单测：`pollAsyncContent` 轮询、`normalizeRows` 矩阵转换、异步工具 submit→poll，测试 85 → 98
- 下载类工具补 256KB 截断防护：超大载荷写临时文件，返回 `_truncated` 预览指针，配合 `gangtise_read_response` 续读
- 日期指引去重：通过 MCP server instructions 全局声明，工具列表体积 79.6KB → 58.2KB（-27%）
- `gangtise_theme_tracking` 对无效 `date` 直接报参数错误；异步轮询超时与 `GANGTISE_MCP_ASYNC_TIMEOUT_MS` 对齐


### 0.1.18–0.1.19 (2026-06-09)
- 新增 `gangtise_current_date`：运行时查询当前日期/时间/时区，供相对日期换算
- 修复 `gangtise_theme_tracking` 的 `type` 参数：可传单字符串或数组，内部统一转数组
- 修复显式配置 `GANGTISE_TOKEN` 时认证恢复逻辑：刷新后重试使用新 token
- `fetchAll` 命中分页上限时返回 `_partial` / `_page_cap` 元数据，避免静默截断
- K 线工具 `limit` 参数增加 `1..10000` 校验；加强下载文件名清洗；忽略本地 `.mcp.json`

### 0.1.15–0.1.17 (2026-05-29)
- 同步 CLI v0.15.0：新增 `gangtise_concept_info`（题材指数画像）/ `gangtise_concept_securities`（题材 F8 成分股）；`gangtise_index_day_kline` 新增 `securityName` 返回字段
- 同步 CLI v0.14.3：下载类工具 token 过期自动刷新重试；全市场 K 线分片并发改用 `GANGTISE_PAGE_CONCURRENCY`
- 大响应截断扩展到行情/AI 工具（`day_kline*` / `realtime` / `securities_search` / `theme_tracking`）
- 修复 MCP 上报版本号固定为 `0.1.0` 的问题
- `security='all'` K 线分片改为容错：部分分片失败返回成功数据 + `_partial`/`_failed_shards` 标记
- 异步 AI 工具默认等待时间统一为 180s；启动时自动清理 24h+ 临时目录

### 0.1.14 (2026-05-26)
- 新增 `gangtise_read_response`：当其他工具返回 `_truncated: true` 时，按 `offset`/`limit` 分片续读完整数据；截断响应追加 `_read_with` 字段；仅允许读取本进程 `gangtise-mcp-*` 临时产物

### 0.1.8–0.1.9 (2026-05-22)
- 同步 CLI v0.14.0：新增 `gangtise_day_kline_us`（美股日 K）/ `gangtise_realtime`（A/港/美实时快照）
- 修复 `security='all'` 全市场日 K 分片内静默截断（A/美股改 1 天/片，港股改 2 天/片）

### 0.1.7 (2026-05-18)
- 修复一批入参字段名与后端不一致（`securityList→securityCode`、`queryList→queries`、`dimension→discussionDimension`、多工具单数 filter→数组 `*List` 等）
- 修复 `gangtise_valuation_analysis` 的 `skipNull` 参数未生效问题
- 同步 CLI v0.13.x 完整入参集

### 0.1.6 (2026-05-16)
- 新增港股三大报表（`income_statement_hk`/`balance_sheet_hk`/`cash_flow_hk`）、自选股池（`stock_pool_list`/`stock_pool_stocks`）、EDB 另类数据（`edb_search`/`edb_data`）
- 修复财报工具 `field` → `fieldList`；补充 `gangtise_management_discuss_announcement` dimension `all` 选项

### 0.1.3–0.1.5
- `0.1.5` 修复群消息分页
- `0.1.4` 新增大响应截断与本地文件保存（超 256 KB 写临时文件，内联前 20 条预览）
- `0.1.3` 工具元数据注入当前日期上下文
