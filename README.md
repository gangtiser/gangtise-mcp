# gangtise-mcp

基于 [Gangtise OpenAPI](https://open.gangtise.com) 的 MCP（Model Context Protocol）服务，让 Claude 等 AI 助手直接访问 Gangtise 投研平台数据。

## Changelog

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

## 功能覆盖

<table>
<thead><tr><th width="100">类别</th><th>工具</th></tr></thead>
<tbody>
<tr><td>上下文</td><td><code>gangtise_current_date</code> — 查询运行时当前日期、年份、时间和时区</td></tr>
<tr><td>参考数据</td><td><code>gangtise_constant_category</code> / <code>gangtise_constant_list</code> — 行业、城市、公告分类、区域等常量；<code>gangtise_concept_search</code> — 题材 ID 搜索；<code>gangtise_sector_search</code> / <code>gangtise_sector_constituents</code> — 板块及成分股（含申万行业代码 <code>821xxx.SWI</code>）；<code>gangtise_chiefs_search</code> — 首席分析师 ID 搜索；<code>gangtise_lookup</code> — 券商机构、会议机构（本地表）</td></tr>
<tr><td>证券检索</td><td><code>gangtise_securities_search</code></td></tr>
<tr><td>观点/研报</td><td>国内首席观点、纪要、券商研报、外资研报、外资独立观点、公告（A股/港股/美股）</td></tr>
<tr><td>路演/调研</td><td>路演、调研、策略会、论坛</td></tr>
<tr><td>行情</td><td>A 股/港股/美股日 K（仅历史）、A 股分钟 K、指数日 K、实时行情快照（A/港/美）</td></tr>
<tr><td>基本面</td><td>A股/港股/美股利润表、资产负债表、现金流量表（累计/单季）、主营业务、估值、股东、盈利预测</td></tr>
<tr><td>AI 能力</td><td>知识库检索、个股看点、一页通、投资逻辑、同业对比、线索、主题跟踪、业绩点评、观点辩证、管理层讨论</td></tr>
<tr><td>云盘/语音</td><td>网盘文件、录音转写、我的会议、群消息、自选股池</td></tr>
<tr><td>另类数据</td><td>EDB 行业经济指标搜索与时序数据查询、题材指数基本信息与成分股</td></tr>
<tr><td>数据指标</td><td><code>gangtise_indicator_search</code> — 证券级数据指标（EDE）搜索；<code>gangtise_indicator_cross_section</code> / <code>gangtise_indicator_time_series</code> — 指标截面/时序（支持复权等分指标参数，二维矩阵展平为宽表）</td></tr>
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
| `GANGTISE_BASE_URL` | `https://open.gangtise.com` | API 基础地址 |
| `GANGTISE_TIMEOUT_MS` | `30000` | 单次请求超时（毫秒） |
| `GANGTISE_MCP_ASYNC_TIMEOUT_MS` | `55000` | 异步 AI 任务默认等待超时（毫秒）；保持在 MCP 客户端请求超时（约 60s）以下，超时返回 dataId 供 `*_check` 续查。需更长等待可调高本值或按调用传 `waitSeconds`（最大 180） |
| `GANGTISE_TOKEN_CACHE_PATH` | `~/.config/gangtise/token.json` | Token 缓存文件路径 |
| `GANGTISE_PAGE_CONCURRENCY` | `5` | 分页并发数 |
| `GANGTISE_VERBOSE` | — | 设为 `1` 开启请求耗时日志（输出到 stderr） |

认证优先级：`GANGTISE_TOKEN` > Token 缓存文件 > `GANGTISE_ACCESS_KEY` + `GANGTISE_SECRET_KEY`（自动换取并缓存 Token）。

## 大响应处理

当单次工具调用返回超过 256 KB 时，完整数据会写入系统临时目录下的 `gangtise-mcp-*` 目录（macOS 实际在 `/var/folders/.../T/` 下；JSON 数据为 `response.json`，文本类为 `response.md`），MCP 响应改为内联返回前 20 条预览及元数据：

| 字段 | 说明 |
|---|---|
| `_truncated` | `true` — 表示响应已截断 |
| `_saved_to` | 完整数据的临时文件路径 |
| `_total_bytes` | 完整响应的 UTF-8 字节数 |
| `_total_items` | 文件中的总条数 |
| `_preview_count` | 本次内联返回的条数（最多 20） |
| `_read_with` | 续读工具名（固定为 `gangtise_read_response`） |
| `has_more` | 文件中是否还有未返回的条目 |

续读完整数据请调用 **`gangtise_read_response`** 工具（传 `_saved_to` 路径，按 `offset`/`limit` 分页；单页同样受 256KB 字节预算约束）——不要依赖客户端直接读文件，Claude Desktop 等无文件读取能力的客户端只能走该工具。若单条内容过大导致 20 条预览本身也超过阈值，则只返回元数据，`_preview_count` 为 0（此时 `has_more: true` 表示数据全部在文件中）。

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
