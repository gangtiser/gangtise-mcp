# gangtise-mcp

基于 [Gangtise OpenAPI](https://open.gangtise.com) 的 MCP（Model Context Protocol）服务，让 Claude 等 AI 助手直接访问 Gangtise 投研平台数据。

## Changelog

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

<details>
<summary>历史版本（0.1.3–0.1.19）</summary>

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

</details>

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
