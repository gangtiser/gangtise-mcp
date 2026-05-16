# gangtise-mcp

基于 [Gangtise OpenAPI](https://open.gangtise.com) 的 MCP（Model Context Protocol）服务，让 Claude 等 AI 助手直接访问 Gangtise 投研平台数据。

## Changelog

### 0.1.6
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
| 行情 | A 股/港股日 K、A 股分钟 K、指数日 K |
| 基本面 | A股/港股利润表、资产负债表、现金流量表（累计/单季）、主营业务、估值、股东、盈利预测 |
| AI 能力 | 知识库检索、一页通、投资逻辑、同业对比、线索、主题跟踪、业绩点评、观点辩证、管理层讨论 |
| 云盘/语音 | 网盘文件、录音转写、我的会议、群消息、自选股池 |
| 另类数据 | EDB 行业经济指标搜索与时序数据查询 |

## 前置要求

- Node.js ≥ 20
- Gangtise 开放平台账号（[申请地址](https://open.gangtise.com)），获取 `accessKey` / `secretKey`

## 快速开始

### Claude Code

```bash
claude mcp add gangtise \
  -e GANGTISE_ACCESS_KEY=your_access_key \
  -e GANGTISE_SECRET_KEY=your_secret_key \
  -- npx -y gangtise-mcp
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
      "args": ["-y", "gangtise-mcp"],
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
      "args": ["-y", "gangtise-mcp"],
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
      "args": ["-y", "gangtise-mcp"],
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
    "args": ["-y", "gangtise-mcp"],
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
  "args": ["-y", "gangtise-mcp"],
  "env": {
    "GANGTISE_ACCESS_KEY": "your_access_key",
    "GANGTISE_SECRET_KEY": "your_secret_key"
  }
}
```

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
