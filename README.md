# gangtise-mcp

基于 [Gangtise OpenAPI](https://open.gangtise.com) 的 MCP（Model Context Protocol）服务，让 Workbuddy, OpenClaw, Hermes, Cherry Studio, Cursor, Claude, Codex 等 AI 助手直接访问 Gangtise 投研平台数据。

## Changelog

README 仅列最近 5 个版本的一行摘要，完整明细见 [CHANGELOG.md](CHANGELOG.md)：

- **0.2.5 — 2026-08-31**：同步 CLI v0.37.1，无工具/字段/参数增删。🔴 订正 `110003`（超出可查时间范围）的处置：这个窗口按账号的数据权限配、不按接口配，EDE 截面/时序/条件选股与日 K 同界，**换接口绕不过去**——旧提示建议的「改用范围更宽的同族工具」会多发一次注定同样失败的请求。`indicator_screener` 描述同步删去「范围比截面窄」一句，能力不变。
- **0.2.4 — 2026-08-30**：健壮性修复，无字段增删。🔴 三处静默丢数据（分页途中的空页、首包裸数组、全市场分片缺 `list`）改为归一或显式标记；两处工具元数据订正（`.CI` 实际支持日 K/实时；申万前缀是 `801xxx.SWI`）。发布的 `inputSchema` 改为自包含（不再含 `$ref`，客户端无需解引用）。**输入校验收紧**：空白值、空列表、重复 `fieldList`、同一指标的冲突参数、倒置日期区间改为本地拒绝——升级前请确认调用方不依赖旧的宽松行为。
- **0.2.3 — 2026-08-30**：同步 CLI v0.37.0。撤除四类已不成立的参数警示（外资/独立观点的 `industryList`、`regionList`、`total` 封顶）；🔴 新增两处防错数：`foreign_report_list` 的 `regionList` 收成闭集，EDE `indicatorParamList` 引用未查询的指标改为发请求前报错。
- **0.2.2 — 2026-08-18**：同步 CLI v0.36.0。日期入参新增接受 `YYYY/MM/DD` 与 `YYYYMMDD`；🔴「年在后」写法仍本地拒绝（按美式月在前解析，会静默差半年）。`indicator_screener` 新增 `noQueryDate` 开关。
- **0.2.1 — 2026-08-16**：同步 CLI v0.35.0。`indicator_cross_section` 新增 `noQueryDate` 开关（⚠️ 会同时关掉服务端对其余必填键的硬拦）；`rankType` 说明统一到 11 个工具。

### 历史里程碑

- **0.2.0**：同步 CLI v0.33.0–v0.34.1。🔴 破坏性：日 K 全市场关键字由 `all` 改为 `aShares`/`hkStocks`/`usStocks`（须单独传）；三大报表时点对齐改用 `earliestAnncDate`。
- **0.1.52**：打包与文案表述统一，无取数逻辑或参数契约变更——`dist/` 不再输出源码注释（体积约 −24%）。
- **0.1.51**：修复财报日历日期筛选完全失效（发错字段名，静默返回全库切片而非排期且按条计费）；同步 CLI v0.32.0，新增帕米尔专家纪要工具；`searchType` / `rankType` 收成闭集。
- **0.1.50**：同步 CLI v0.30.0–v0.31.0，适配 EDE 取数契约重构（`universe` 改名、截面矩阵转置、日期下沉到每个指标），修正复权参数名 `adjustType`，新增条件选股工具，整行/整列丢数据标成 `_partial`。
- **0.1.49**：新增财报日历工具，取数护栏改按实际请求行数判定，`fieldList` 收成闭集以拦截静默错列。
- **0.1.48**：修复无效字段名导致的静默错列（数据污染），并把单票总市值路由到 EDE `qte_mkt_cptl`。
- **0.1.46**：取数路由调整，多证券财务/估值批量优先走 EDE 截面/时序接口。
- **0.1.45**：同步 CLI v0.28.0，适配新版错误码三层重排、日期严格校验与 traceId 透出。
- **0.1.44**：`server.instructions` 重写为路由层，建立 92 工具积分目录与自动计费标签，大响应支持字段投影与 `_available_fields`。
- **0.1.36–0.1.43**：多轮对抗式审查收口——计费端点 `no-replay`、429 退避与 `Retry-After`、异步任务截止时间与 `dataId` 保全、紧凑 JSON，以及 OIDC 发布链 verify/publish 拆分。
- **0.1.33–0.1.35**：确立 loud-partial 契约（分页与分片失败均标记 `_partial` 而非静默空洞），token 缓存改原子写并与 CLI 共享自愈。
- **0.1.31–0.1.32**：接入 EDE 证券级数据指标，补齐美股财报与公告、个股看点、首席搜索；全量工具端到端联调。
- **0.1.28–0.1.30**：新增产业公众号资讯，token 服务端失效自愈，CI 加 Node 20/22/24 矩阵与 npm provenance 发布。
- **0.1.24–0.1.27**：日程类工具按 API spec 各自收窄字段，本地静态表迁移到服务端常量/题材/板块接口。
- **0.1.14–0.1.23**：确立大响应截断与 `gangtise_read_response` 续读契约，全工具声明 `readOnlyHint`，日期指引上收到 server instructions。
- **0.1.3–0.1.13**：铺开基础工具面——港美股行情与三大报表、EDB 另类数据、自选股池，并落地全市场 K 线分片与超 256KB 落盘预览。

> 完整更新明细及更早版本见 [CHANGELOG.md](CHANGELOG.md)。

## 功能覆盖

97 个工具，分十一类。完整清单与每个参数的语义由 `tools/list` 提供，此处只列范围。

| 类别 | 覆盖 |
|---|---|
| 上下文 | 运行时当前日期、年份、时间与时区（用于换算「今天 / 最近 / 今年」） |
| 检索与 ID 解析 | 证券搜索；行业 / 城市 / 公告分类 / 区域常量；题材与板块成分股；首席分析师、机构、公众号 ID |
| 观点与研报 | 国内首席观点、会议纪要、帕米尔专家纪要（独立库，需单独购买）、券商研报、外资研报与独立观点、A/港/美股公告、产业公众号资讯、投资者问答、研报图表 |
| 会议日程 | 路演、调研、策略会、论坛（日程；正文走会议纪要） |
| 财报日历 | 业绩预告 / 快报 / 公告的发布排期（含未来已排期）与原文 PDF |
| 行情 | A/港/美股日 K 与实时快照、A 股分钟 K、指数日 K、A 股个股资金流向 |
| 基本面 | A/港/美股三大报表（累计 / 单季）、主营业务、估值、股东、盈利预测 |
| 数据指标（EDE） | 证券级指标搜索；截面与时序（二维矩阵展平为宽表）；条件选股（变量绑指标 + 表达式筛选） |
| 另类数据 | EDB 宏观与行业经济指标；题材指数基本信息与成分股 |
| AI 能力 | 知识库检索、个股看点、一页通、投资逻辑、同业对比、投研线索、主题跟踪、业绩点评、观点辩证、管理层讨论 |
| 云盘与语音 | 网盘文件、录音转写、我的会议、微信群消息、自选股池 |

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
# macOS / Linux —— 只删本包的缓存条目，不动其他工具的
grep -rl '"gangtise-mcp"' ~/.npm/_npx/*/package.json 2>/dev/null | xargs -r dirname | xargs -r rm -rf
# Windows (PowerShell)
Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx" -Recurse -Filter package.json |
  Select-String -Pattern 'gangtise-mcp' | ForEach-Object { Remove-Item -Recurse -Force $_.Path.Substring(0, $_.Path.LastIndexOf('\')) }
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
| `GANGTISE_MAX_DOWNLOAD_BYTES` | `1073741824` | 单个下载文件的字节上限（默认 1 GiB）。超出时在落盘前拒绝（有 `Content-Length`）或流式中止（无该头），避免一次超大下载占满临时磁盘。`/tmp` 较小的部署可调低（最低 1 MB） |
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
git tag v0.2.x
git push origin v0.2.x
```

发布完成后确认：

```bash
gh run list --workflow npm-publish.yml --limit 1
npm view gangtise-mcp version
```

如果 GitHub Actions 的 publish 步骤提示 OIDC/trusted publisher 失败，应先检查 npm 包的 Publishing access 设置是否绑定到 `gangtiser/gangtise-mcp` 和 `.github/workflows/npm-publish.yml`，不要改回本地 token 发布。

## 数据、凭据与授权

**MIT 只覆盖本连接器的代码。** Gangtise OpenAPI 本身、经由它取得的行情/研报/纪要/公告等数据与内容，均按你与 Gangtise 的服务协议授权，不随本包一并授予。是否可再分发、可否用于对外产品，以该协议为准。

**取到的数据会进入你配置的 AI 客户端。** 本服务是一条管道：云盘文件、语音转写、我的会议、微信群消息、研报全文等**私域内容**，一旦被工具取回，就会进入你所连接的模型上下文，并按该客户端自己的策略被处理或留存。把这些工具接给第三方客户端前，请先确认对方的数据处理条款。

**凭据不要外传。** `GANGTISE_ACCESS_KEY` / `GANGTISE_SECRET_KEY` / `GANGTISE_TOKEN` 与 token 缓存文件（默认 `~/.config/gangtise/token.json`）等同于账号本身。提 issue、贴日志前先把它们去掉；`GANGTISE_VERBOSE=1` 的 stderr 输出不含凭据，但请求 URL 里可能带有你的查询内容。

**计费口径。** 工具描述里的【积分】标签是发布时的单价快照，用于让模型在调用前估算成本；**实际扣费以你的账户权限与平台当时的计费规则为准**。标注为免费的工具同样受账户数据权限约束。

## 客户端兼容性

已实际联调：Claude Code、Claude Desktop、Cursor、Cherry Studio。

其余任何支持 stdio 传输的 MCP 客户端理论上都可接入——本服务只用标准的 `tools/list` + `tools/call`，不依赖 MCP 的可选能力。但未联调过的客户端可能在两处有差异：一是是否把 server `instructions` 注入模型上下文（不注入时，跨工具的通用参数语义会缺失），二是超大响应的处理方式。遇到问题请提 issue 并附上客户端名称与版本。

## 支持与反馈

- 用法与缺陷：在 [GitHub Issues](https://github.com/gangtiser/gangtise-mcp/issues) 提，附上工具名、入参（去掉凭据）与返回中的 `traceId`。
- 数据权限、计费额度、账号问题：联系你的 Gangtise 客户经理，本连接器不参与这些环节。

## License

MIT（仅本连接器代码，见上方「数据、凭据与授权」）
