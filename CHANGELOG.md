# 更新日志

> README 顶部只保留最新 5 条；本文件是完整历史（中文）。

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
