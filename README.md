# gangtise-mcp

基于 [Gangtise OpenAPI](https://open.gangtise.com) 的 MCP（Model Context Protocol）服务，让 Claude 等 AI 助手直接访问 Gangtise 投研平台数据。

## Changelog

### 0.1.17 (2026-05-29)
- 同步 CLI v0.15.0：
  - 新增 `gangtise_concept_info`：题材指数基本信息，返回题材整体画像（定义 / 投资逻辑 / 行业空间 / 竞争格局 / 催化事件），仅最新截面、不支持历史回溯
  - 新增 `gangtise_concept_securities`：题材指数成分股（题材深度 F8），按分组结构返回当前成分股，每只含是否重点个股 `isKey` 与纳入理由 `inclusionReason`
  - 两者 `conceptId` 与主题跟踪 `gangtise_theme_tracking` 的 `themeId` 同一套 ID 体系，可用 `gangtise_lookup`（`type=theme-ids`）按名称查询（如 机器人 → `121000130`）
  - `gangtise_index_day_kline` 返回字段新增 `securityName`（指数名称，如"上证指数"）

### 0.1.16 (2026-05-29)
- 同步 CLI v0.14.3：
  - 下载类工具（研报 / 纪要 / 公告 / 云盘 / 录音等）在 token 过期（8000014 / 8000015）时自动刷新并重试一次，与 JSON 请求行为一致（此前仅 JSON 请求会自愈，下载会直接失败）
  - 全市场 K 线分片 fan-out 并发改用 `GANGTISE_PAGE_CONCURRENCY`（与分页统一一个环境变量调度）

### 0.1.15 (2026-05-29)
- 大响应截断兜底扩展到行情与 AI 工具：`gangtise_day_kline*` / `gangtise_minute_kline` / `gangtise_realtime` / `gangtise_securities_search` / `gangtise_theme_tracking` 现与分页 list 工具一致，超 256KB 自动转存临时文件并返回预览，配合 `gangtise_read_response` 续读，避免全市场快照 / 全市场 K 线撑爆上下文
  - AI 长文工具（一页纸 / 投资逻辑 / 同业对比 / 研究提纲 / 业绩点评 / 多空辩论）超限时转存 `.md`，`gangtise_read_response` 支持按字符分片续读
- 修复 MCP 上报版本号固定为 `0.1.0` 的问题，改为从 `package.json` 读取真实版本
- `security='all'` 全市场 K 线分片改为容错：部分日期分片失败时返回已成功数据并标记 `_partial` / `_failed_shards`，仅当全部分片失败才报错（不再因单日失败丢弃整段）
- 异步 AI 工具（业绩点评 / 多空辩论）默认等待时间统一为 180s（此前文档与实现不一致）
- 启动时自动清理超过 24h 的 `gangtise-mcp-*` 临时目录

### 0.1.14 (2026-05-26)
- 新增 `gangtise_read_response` 工具：当其他工具返回 `_truncated: true` 时，模型可调用此工具按 `offset` / `limit` 分片读取 `_saved_to` 完整数据
  - 原先 `_saved_to` 路径只对自带文件读取能力的客户端（如 Claude Code）有效；Cherry Studio 等无内置文件读工具的客户端拿到路径也无法续读
  - 现在所有 MCP 客户端均可通过工具调用方式取回完整大响应，不再依赖宿主进程的文件系统能力
- 截断响应负载追加 `_read_with: "gangtise_read_response"` 字段，明确续读入口
- 安全：`gangtise_read_response` 仅允许读取系统临时目录下 `gangtise-mcp-*` 前缀的本进程产物，拒绝其他路径

### 0.1.9 (2026-05-22)
- 修复 `security='all'` 全市场日 K 在分片内被静默截断的问题（同步 CLI v0.14.1 / v0.14.2）：
  - A 股全市场每天约 5500 行，原 2 天/片 ≈ 11000 行命中默认 6000 上限 → 改 1 天/片
  - 港股全市场每天约 2770 行，原 3 天/片 ≈ 8300 行命中 6000 上限 → 改 2 天/片
  - 美股全市场每天约 5800 行，原 2 天/片 ≈ 11600 行命中 6000 上限 → 改 1 天/片
  - `callKlineWithSharding` 在 `security='all'` 路径自动注入 `limit=10000`（API 上限）；用户显式传的 `limit` 不变；单只证券查询不受影响

### 0.1.8 (2026-05-22)
- 同步 CLI v0.14.0：
  - 新增 `gangtise_day_kline_us`：美股历史日 K 线（NYSE / NASDAQ / AMEX，代码格式 `AAPL.O` / `.N` / `.A`），`security='all'` 自动按 2 天/片分片
  - 新增 `gangtise_realtime`：实时行情快照，单接口覆盖 A 股 / 港股 / 美股，支持代码混合或 `aShares` / `hkStocks` / `usStocks` 市场关键字批量
  - 更新 `gangtise_day_kline` / `gangtise_day_kline_hk` 描述，明确仅返回历史数据，盘中实时改走 `gangtise_realtime`
- 注意：`gangtise_valuation_analysis` 返回字段不再包含 `p10` / `p25` / `p75` / `p90`（后端字段精简，工具入参未变）

### 0.1.7 (2026-05-18)
- 修复一批入参字段名与后端不一致的问题（filter 之前被静默忽略或直接报错）：
  - `gangtise_minute_kline`: `securityList` → `securityCode`（原报 "非有效A股"）
  - `gangtise_knowledge_batch`: `queryList`/`resourceType`/`knowledgeName` → `queries`/`resourceTypes`/`knowledgeNames`（原返回 null）
  - `gangtise_management_discuss_*`: `dimension` → `discussionDimension`（原报 "参数错误"）
  - `gangtise_wechat_chatroom_list`: `roomName` 数组 → 逗号拼接字符串（原报 "请求参数解析失败"）
  - 多个 list 工具单数 filter → 数组 `*List`：`opinion/summary/research` 的 `source/category/market/rating/...`；`hot_topic` 的 `category`；`record/wechat_message/my_conference` 的 `category/tag/...`；`earning_forecast` 的 `consensus`
  - `research` 的 `minPages/maxPages` → `minReportPages/maxReportPages`
- 修复 `gangtise_valuation_analysis` 的 `skipNull` 参数（之前声明但未生效，现客户端真实过滤）
- 同步 CLI v0.13.x 完整入参集：
  - `opinion_list`: +`chiefList` +`conceptList`
  - `roadshow/site_visit/strategy/forum_list`: 补全 `researchAreaList/institutionList/securityList/categoryList/marketList/participantRoleList/brokerTypeList/objectList/permission`
  - `foreign_report_list`: +`searchType/regionList/categoryList/industryList/brokerList/llmTagList/ratingList/ratingChangeList/minReportPages/maxReportPages`
  - `foreign_opinion_list`: +`regionList/industryList/brokerList/ratingList/ratingChangeList`
  - `independent_opinion_list`: +`industryList/ratingList/ratingChangeList`
  - `announcement_list`: +`searchType/announcementTypeList`
  - `announcement_hk_list`: +`searchType/rankType/categoryList`
  - `drive_list`: `fileType/spaceType` → `fileTypeList/spaceTypeList`（数组）
  - `record_list`: `spaceType` → `spaceTypeList`（数组）
  - `securities_search`: +`category/top`

### 0.1.6 (2026-05-16)
- 新增港股三大报表：`gangtise_income_statement_hk`、`gangtise_balance_sheet_hk`、`gangtise_cash_flow_hk`（中国会计准则，period 支持 `q1/h1/q3/h2/nsd/annual/latest`）
- 新增自选股池：`gangtise_stock_pool_list`、`gangtise_stock_pool_stocks`（不传参数默认返回所有池）
- 新增另类数据（EDB）：`gangtise_edb_search`、`gangtise_edb_data`（自动归一化 `fieldList+dataList` 为对象数组）
- 修复财报工具字段筛选参数：`field` 更正为 `fieldList`，影响所有利润表/资产负债表/现金流量表/估值工具（A股 + 港股）
- 更新 `gangtise_management_discuss_announcement` dimension 新增 `all` 选项
- 更新 `gangtise_wechat_message_list`：新增 `securityList` 参数，修正 `tag` 枚举值
- 更新 `gangtise_my_conference_list` category 枚举与 CLI 同步

### 0.1.5
- 修复群消息分页

### 0.1.4
- 新增大响应截断与本地文件保存（超 256 KB 时写临时文件，内联返回前 20 条预览）

### 0.1.3
- 工具元数据注入当前日期，避免 AI 使用训练数据年份

## 功能覆盖

| 类别 | 工具 |
|---|---|
| 参考数据 | `gangtise_lookup` — 研究方向、券商、行业、地区、公告类别、申万行业代码、主题 ID |
| 证券检索 | `gangtise_securities_search` |
| 观点/研报 | 国内首席观点、纪要、券商研报、外资研报、外资独立观点、公告（A股/港股） |
| 路演/调研 | 路演、调研、策略会、论坛 |
| 行情 | A 股/港股/美股日 K（仅历史）、A 股分钟 K、指数日 K、实时行情快照（A/港/美） |
| 基本面 | A股/港股利润表、资产负债表、现金流量表（累计/单季）、主营业务、估值、股东、盈利预测 |
| AI 能力 | 知识库检索、一页通、投资逻辑、同业对比、线索、主题跟踪、业绩点评、观点辩证、管理层讨论 |
| 云盘/语音 | 网盘文件、录音转写、我的会议、群消息、自选股池 |
| 另类数据 | EDB 行业经济指标搜索与时序数据查询、题材指数基本信息与成分股 |

## 前置要求

- Node.js ≥ 20
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
| `GANGTISE_MCP_ASYNC_TIMEOUT_MS` | `180000` | 异步 AI 任务等待超时（毫秒） |
| `GANGTISE_TOKEN_CACHE_PATH` | `~/.config/gangtise/token.json` | Token 缓存文件路径 |
| `GANGTISE_PAGE_CONCURRENCY` | `5` | 分页并发数 |
| `GANGTISE_VERBOSE` | — | 设为 `1` 开启请求耗时日志（输出到 stderr） |

认证优先级：`GANGTISE_TOKEN` > Token 缓存文件 > `GANGTISE_ACCESS_KEY` + `GANGTISE_SECRET_KEY`（自动换取并缓存 Token）。

## 大响应处理

当单次工具调用返回超过 256 KB 时，完整数据会写入本地临时文件（`/tmp/gangtise-mcp-*/response.json`），MCP 响应改为内联返回前 20 条预览及元数据：

| 字段 | 说明 |
|---|---|
| `_truncated` | `true` — 表示响应已截断 |
| `_saved_to` | 完整数据的临时文件路径 |
| `_total_bytes` | 完整响应的 UTF-8 字节数 |
| `_total_items` | 文件中的总条数 |
| `_preview_count` | 本次内联返回的条数（最多 20） |
| `has_more` | 文件中是否有超过预览的条目 |

AI 可直接读取 `_saved_to` 路径获取完整数据。若单条内容过大导致 20 条预览本身也超过阈值，则只返回元数据，`_preview_count` 为 0。

## 开发

```bash
git clone https://github.com/gangtiser/gangtise-mcp
cd gangtise-mcp
npm install
npm run dev      # 直接运行源码（tsx，无需 build）
npm run build    # 编译 TypeScript → dist/
npm test         # 运行测试
```

## License

MIT
