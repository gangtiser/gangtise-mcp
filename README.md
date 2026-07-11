# gangtise-mcp

基于 [Gangtise OpenAPI](https://open.gangtise.com) 的 MCP（Model Context Protocol）服务，让 Workbuddy, OpenClaw, Hermes, Cherry Studio, Cursor, Claude, Codex 等 AI 助手直接访问 Gangtise 投研平台数据。

## Changelog

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

## 功能覆盖

<table>
<thead><tr><th width="100">类别</th><th>工具</th></tr></thead>
<tbody>
<tr><td>上下文</td><td><code>gangtise_current_date</code> — 查询运行时当前日期、年份、时间和时区</td></tr>
<tr><td>参考数据</td><td><code>gangtise_constant_category</code> / <code>gangtise_constant_list</code> — 行业、城市、公告分类、区域等常量；<code>gangtise_concept_search</code> — 题材 ID 搜索；<code>gangtise_sector_search</code> / <code>gangtise_sector_constituents</code> — 板块及成分股（含申万行业代码 <code>821xxx.SWI</code>）；<code>gangtise_chiefs_search</code> — 首席分析师 ID 搜索；<code>gangtise_institution_search</code> — 机构 ID 搜索（内资券商/外资/牵头/观点机构）；<code>gangtise_official_account_search</code> — 公众号 ID 搜索；<code>gangtise_lookup</code> — 券商机构、会议机构（本地表）</td></tr>
<tr><td>证券检索</td><td><code>gangtise_securities_search</code></td></tr>
<tr><td>观点/研报</td><td>国内首席观点、纪要、券商研报、外资研报、外资独立观点、公告（A股/港股/美股）、产业公众号资讯、投资者问答 QA、研报图表搜索与下载</td></tr>
<tr><td>路演/调研</td><td>路演、调研、策略会、论坛</td></tr>
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

续读完整数据请调用 **`gangtise_read_response`** 工具（传 `_saved_to` 路径，按 `offset`/`limit` 分页；单页同样受 `GANGTISE_INLINE_MAX_BYTES`（默认 64KB）字节预算约束）——不要依赖客户端直接读文件，Claude Desktop 等无文件读取能力的客户端只能走该工具。若单条内容过大导致 20 条预览本身也超过阈值，则只返回元数据，`_preview_count` 为 0（此时 `has_more: true` 表示数据全部在文件中）。

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
