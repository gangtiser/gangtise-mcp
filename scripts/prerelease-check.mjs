#!/usr/bin/env node
// 发版前自查。跑法：npm run check:release（CI 与发布流水线都会跑）。
//
// 本文件入库、但不进 npm tarball：package.json#files 是白名单（dist / README / CHANGELOG），
// scripts/ 天然在外。放在这里而不是本地目录，是因为**一个不在 CI 里跑的门禁等于没有门禁**。
//
// 检查的是「客户实际能拿到的四层」，不是源码：
//   ① 工具描述 / 参数说明  → 进客户模型上下文
//   ② 错误提示            → 报错时进客户模型上下文
//   ③ README / CHANGELOG  → 在 npm tarball 内，人读
//   ④ commit message      → 公开仓库，人读（脚本只查最近一条，新写的靠自觉）
//
// 退出码非 0 = 有项没过，别发。

import fs from "node:fs"
import path from "node:path"
import { execSync } from "node:child_process"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { GangtiseClient } from "../dist/core/client.js"
import { loadConfig } from "../dist/core/config.js"
import { createGangtiseMcpServer } from "../dist/server.js"

const results = []
const check = (layer, name, ok, detail) => results.push({ layer, name, ok, detail })

// ── ①② 工具描述与错误提示 ────────────────────────────────────────────
// 排查过程类措辞（「实测 YYYY-MM-DD」「旧行为是 Y」）只会占客户的上下文预算，
// 还会让模型不敢用本来正常的参数。缺陷判定类（「缺陷」「已报后台」）是对客户
// 自曝后端毛病。「上游」是供应链视角——客户只关心「这个接口会怎样」。
const BANNED = ["实测", "缺陷", "已报后台", "旧行为", "上游", "本仓", "绕行", "won't-fix"]

const server = createGangtiseMcpServer(new GangtiseClient(loadConfig()))
const [ct, st] = InMemoryTransport.createLinkedPair()
await server.connect(st)
const mcp = new Client({ name: "prerelease", version: "0" })
await mcp.connect(ct)
const toolsJson = JSON.stringify((await mcp.listTools()).tools)

for (const word of BANNED) {
  const n = toolsJson.split(word).length - 1
  check("① 工具描述", `不含「${word}」`, n === 0, n ? `命中 ${n} 处` : "")
}

// 错误提示不在 tools/list 里，要扫 dist 的字符串。连注释一起扫也无妨——
// removeComments 开着的话本来就没有注释。
const distFiles = []
const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const f = path.join(d, e.name)
    if (e.isDirectory()) walk(f)
    else if (f.endsWith(".js")) distFiles.push(f)
  })
walk("dist")
const distText = distFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n")

for (const word of BANNED) {
  const n = distText.split(word).length - 1
  // 「服务端」不列入禁词：`total` 是上限值、板块由服务端展开成成分股等，都是
  // 客户必须知道才不会拿错数/算错钱的行为描述，删了是害人。
  check("② 错误提示", `dist 不含「${word}」`, n === 0, n ? `命中 ${n} 处` : "")
}

// ── dist 注释是否随包分发 ─────────────────────────────────────────────
// tsc 默认把注释编译进 .js，而 dist/ 在 tarball 内。0.1.51 就这样分发过
// 280 行内部排查笔记。tsconfig 的 removeComments 若被关掉，这里会红。
const commentLines = distText.split("\n").filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l)).length
check("② 错误提示", "dist 无源码注释", commentLines === 0, commentLines ? `${commentLines} 行` : "")

// ── ③ README / CHANGELOG（在 tarball 内）──────────────────────────────
// 这两份是公开分发的。最容易犯的两类：
//   a) 把本机验证账号的权限档位写成平台事实（客户按具体年数写死逻辑必错）
//   b) 把开发返工史当版本说明（客户不需要读我们怎么把测试写漏的）
const DOC_BANNED = [
  ["本仓账号", "验证账号的权限档位"],
  ["本机验证账号", "验证账号的权限档位"],
  ["扩展权限", "验证账号的权限档位"],
  ["排查笔记", "开发过程叙事"],
  ["返工", "开发过程叙事"],
  ["漏过", "开发过程叙事"],
  ["靠自觉", "开发过程叙事"],
  ["本账号", "验证账号的权限档位"],
  ["已无法再复核", "开发过程叙事"],
  ["取样太薄", "开发过程叙事"],
  ["本轮第", "开发过程叙事"],
  ["更大样本", "开发过程叙事"],
]
// ⚠️ 这张表守的是**措辞**，守不了**视角**。「本账号自 X 日起返回 999004（权限收回），
// 已无法再复核」整段是排查自白，而它一度全绿——因为表里只有「本仓账号」「本机验证账号」，
// 没有「本账号」。新增条目时按「一个外部读者读到会觉得这是内部笔记吗」自问一遍，
// 别指望正则替你判断。
for (const doc of ["README.md", "CHANGELOG.md"]) {
  const text = fs.readFileSync(doc, "utf8")
  const hits = DOC_BANNED.filter(([w]) => text.includes(w)).map(([w, why]) => `${w}(${why})`)
  check("③ 包内文档", `${doc} 无内部信息`, hits.length === 0, hits.join(" "))

  // 上游数据集的绝对量（「12.8 万行」「基线 128414」「返回全量 17 万条」）随
  // 账号档位和数据积累变化，写进公开文档就是把本机观测当平台事实。客户按它
  // 判断「我这次是不是拿到全库了」必错。severity 用「全库切片」这类定性说法即可。
  //
  // 本仓自己机制的确定值（MAX_PAGES × 50 = 5 万行、闸门阈值、错误码）不在此列——
  // 它们与账号无关、可复现，删了反而让客户算不清计费。
  // 只认带「行/条」量词的数据集规模。不要放宽成「任意大数字」——那会把
  // tools/list 字节数（116,167B）、ES 的 track_total_hits 上限（10000）、
  // 指标值（1309.22）、错误码（999999）全部误报，噪音一多就没人看了。
  // ⚠️ 这条**不可能靠正则做准**，是个务实门槛：只看「≥4 位数 + 行/条」，
  // 再减掉本仓自己的确定值。小数字（默认页大小 20、示例里的 6 条）不查——
  // 查了全是噪音，而噪音一多整个脚本就没人看了。所以它挡的是最危险的那类：
  // 把「全库有多少条」当平台事实写出来。三位数的探测结果仍需人判断。
  const OWN_LIMITS = ["1000", "6000", "10000", "50000", "5万"] // 接口/翻页上限，与账号无关
  const volume = [...text.matchAll(/(?<![-\d])([0-9][0-9,.]*)\s*(万?)\s*(?:行|条)(?!\w)/g)]  // 前置 - 排除「-2700 行静态表」这类本仓代码增删
    .filter((m) => m[2] === "万" || m[1].replace(/[,.]/g, "").length >= 4)
    .map((m) => m[0].trim())
    .filter((s) => !OWN_LIMITS.some((w) => s.replace(/[\s,]/g, "").startsWith(w)))
  check("③ 包内文档", `${doc} 无上游数据量绝对值`, volume.length === 0, [...new Set(volume)].join(" "))

  // 「上游」是供应链视角。tools/list 与 dist 已按 0 守，包内文档同理——
  // 客户读 CHANGELOG 时关心的仍是「这个接口会怎样」。
  const n = text.split("上游").length - 1
  check("③ 包内文档", `${doc} 不含「上游」`, n === 0, n ? `命中 ${n} 处` : "")
}

// ── tarball 白名单没被改坏 ────────────────────────────────────────────
// files 是白名单，所以 scripts/ 与 CLAUDE.md 本来就进不去。但白名单一旦被改成
// 黑名单式写法，这层保护就没了——直接钉住它。
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"))
const norm = (a) => [...(a ?? [])].map((x) => x.replace(/\/$/, "")).sort()
const filesOk = JSON.stringify(norm(pkg.files)) === JSON.stringify(norm(["dist", "README.md", "CHANGELOG.md"]))
check("③ 包内文档", "files 白名单未变", filesOk, filesOk ? "" : JSON.stringify(pkg.files))

// ── ④ commit message（公开仓库）────────────────────────────────────────
// 只能查最近一条已提交的。新写的 message 靠自觉——但同样的规则：
// 别写「清理内部注释」「去掉内部视角措辞」这种把问题本身广播出去的说法。
const lastMsg = execSync("git log -1 --pretty=%B", { encoding: "utf8" })
const msgHits = ["内部注释", "内部视角", "自曝", "排查笔记", "本仓"].filter((w) => lastMsg.includes(w))
check("④ commit", "最近一条 message 无自曝措辞", msgHits.length === 0, msgHits.join(" "))

// ── ⑤ 上下文预算 ──────────────────────────────────────────────────────
// tools/list 与 instructions 是**每次请求都原样进客户模型上下文**的两段字节。
// instructions 一直是按字节精算的；tools/list 此前无人计量，长到 156KB —— 而这个
// 脚本从第一版起就已经把 toolsJson 拼出来了，只是没人取过它的 length。
//
// 为什么 tools/list 特别容易失控：每个工具的 inputSchema 是**独立** JSON 文档，客户端
// 不会跨工具解析 $ref。所以一句话写在 22 个参数描述上就付 22 遍，而 instructions 是
// tools/list 里唯一「只付一遍」的通道。判据因此不是「这句话有没有用」，是**杠杆**：
// 省下的 = 字节数 × (出现次数 - 1)，成本 = 字节数 × 1。≥10 次就该搬进 instructions，
// 10 次以下 locality 更值钱（警示贴着它警示的那个参数，模型更可能读到）。
//
// 三个上限都留了增长余量，新增工具不该撞上。撞了先看下面打印的重复度：能去重就去重，
// 确认省无可省再**主动**抬数字并在 commit 里说明。悄悄涨回去才是这一节要拦的事。
const TOOLS_LIST_CEILING = 150_000
const SINGLE_TOOL_CEILING = 10_000
const INSTRUCTIONS_CEILING = 2_500
const DUP_WASTE_CEILING = 18_000
// 🔴 整串相等只看得见一半。上面那个 freq 表以**整条 description** 为键，所以两条只在
// 开头几个字不同、后面 600 字逐字相同的描述（day_kline_hk / _us 曾经就是）在它眼里是
// 两条不同的字符串，浪费计 0。按句切一次再统计，量出来的是它的两倍 —— 门禁报 8.5KB
// 而实际 17.2KB 时，「全绿」给的是假安心。两个都留：整串那个指认「哪个工具该合并」，
// 句级这个指认「哪句话该上收 instructions」。
const SENTENCE_DUP_CEILING = 17_000

const listTools = JSON.parse(toolsJson)
const b = (x) => Buffer.byteLength(typeof x === "string" ? x : JSON.stringify(x), "utf8")
const listBytes = b(listTools)
const instructionsBytes = b(mcp.getInstructions() ?? "")
const biggest = listTools.map((t) => ({ name: t.name, bytes: b(t) })).sort((x, y) => y.bytes - x.bytes)

// 逐字重复的描述：同一个字符串出现 n 次就白付了 (n-1) 份。这是唯一能去重的成本，
// 也是撞天花板时第一个该看的地方 —— 所以它自己也有上限，别让它悄悄堆回去。
const freq = new Map()
const collect = (node) => {
  if (node === null || typeof node !== "object") return
  if (Array.isArray(node)) return node.forEach(collect)
  for (const [k, v] of Object.entries(node)) {
    if (k === "description" && typeof v === "string") freq.set(v, (freq.get(v) ?? 0) + 1)
    else collect(v)
  }
}
listTools.forEach((t) => collect(t.inputSchema))
for (const t of listTools) freq.set(t.description ?? "", (freq.get(t.description ?? "") ?? 0) + 1)
// 所有 description 的扁平列表（工具级 + 参数级），句级统计复用它。
const allDescriptions = []
const collectText = (node) => {
  if (node === null || typeof node !== "object") return
  if (Array.isArray(node)) return node.forEach(collectText)
  for (const [k, v] of Object.entries(node)) {
    if (k === "description" && typeof v === "string") allDescriptions.push(v)
    else collectText(v)
  }
}
for (const t of listTools) { allDescriptions.push(t.description ?? ""); collectText(t.inputSchema) }

const dups = [...freq]
  .filter(([, n]) => n > 1)
  .map(([text, n]) => ({ n, waste: (n - 1) * b(text), text }))
  .sort((x, y) => y.waste - x.waste)
const dupWaste = dups.reduce((sum, d) => sum + d.waste, 0)

check("⑤ 上下文预算", `tools/list ≤ ${TOOLS_LIST_CEILING / 1000}KB`, listBytes <= TOOLS_LIST_CEILING, `${listBytes}B / ${listTools.length} 工具，均值 ${Math.round(listBytes / listTools.length)}B`)
check("⑤ 上下文预算", `最大单工具 ≤ ${SINGLE_TOOL_CEILING}B`, biggest[0].bytes <= SINGLE_TOOL_CEILING, `${biggest[0].name} ${biggest[0].bytes}B`)
check("⑤ 上下文预算", `instructions ≤ ${INSTRUCTIONS_CEILING}B`, instructionsBytes <= INSTRUCTIONS_CEILING, `${instructionsBytes}B`)
check("⑤ 上下文预算", `整串重复浪费 ≤ ${DUP_WASTE_CEILING}B`, dupWaste <= DUP_WASTE_CEILING, `${dupWaste}B，最大一条 x${dups[0]?.n ?? 0}：${JSON.stringify((dups[0]?.text ?? "").slice(0, 30))}`)

// 句级重复：把每条描述按句号/分号切开再统计。判据仍是杠杆 —— 一句话出现 n 次就白付
// (n-1) 份，≥10 次该上收 instructions，10 次以下 locality 更值钱（警示贴着它警示的那个
// 参数，模型更可能读到）。所以这个数字不必压到 0，但不能**在没人看见的情况下**往上涨。
const sentFreq = new Map()
for (const text of allDescriptions) {
  for (const c of new Set(text.split(/(?<=[。；;!?])/).map((x) => x.trim()).filter((x) => b(x) >= 40))) {
    sentFreq.set(c, (sentFreq.get(c) ?? 0) + 1)
  }
}
const sentDups = [...sentFreq].filter(([, n]) => n > 1).map(([text, n]) => ({ n, waste: (n - 1) * b(text), text })).sort((x, y) => y.waste - x.waste)
const sentWaste = sentDups.reduce((sum, d) => sum + d.waste, 0)
check("⑤ 上下文预算", `句级重复浪费 ≤ ${SENTENCE_DUP_CEILING}B`, sentWaste <= SENTENCE_DUP_CEILING, `${sentWaste}B，最大一条 x${sentDups[0]?.n ?? 0}：${JSON.stringify((sentDups[0]?.text ?? "").slice(0, 30))}`)
// $schema 方言声明（97 × 47B）由 server.ts 的 stripSchemaDialect 剥掉。它拦在
// transport.send 上，失败模式是**静默失效**（字节涨回来、行为不变），所以在这里点名钉住。
check("⑤ 上下文预算", "已剥离 $schema 方言声明", !toolsJson.includes("$schema"), toolsJson.includes("$schema") ? "normalizePublishedSchemas 未生效" : "")
// $ref 同理，但它不是字节问题是**契约**问题：zod 按实例同一性去重，会把共享的
// nonEmptyString 折成指向「它第一次出现的位置」的指针（securityCodeList → paramKey 这种
// 语义无关的落点）。会解引用的客户端没事，把 schema 原样喂给模型的客户端读到的是错的。
check("⑤ 上下文预算", "inputSchema 自包含（无 $ref）", !toolsJson.includes("$ref"), toolsJson.includes("$ref") ? `残留 ${toolsJson.split('"$ref"').length - 1} 处` : "")

// 失败时（也只在失败时）打印可操作的明细：最大的几个工具 + 最费的几条重复。
if (listBytes > TOOLS_LIST_CEILING || dupWaste > DUP_WASTE_CEILING || sentWaste > SENTENCE_DUP_CEILING) {
  console.log("\n  最大的 5 个工具：")
  for (const t of biggest.slice(0, 5)) console.log(`    ${String(t.bytes).padStart(6)}B  ${t.name}`)
  console.log("  最费的 5 条整串重复（waste = 字节 × (出现次数-1)）：")
  for (const d of dups.slice(0, 5)) console.log(`    ${String(d.waste).padStart(6)}B  x${d.n}  ${JSON.stringify(d.text.slice(0, 46))}`)
  console.log("  最费的 5 条句级重复（x≥10 的该上收 instructions）：")
  for (const d of sentDups.slice(0, 5)) console.log(`    ${String(d.waste).padStart(6)}B  x${d.n}  ${JSON.stringify(d.text.slice(0, 46))}`)
}

// ── 输出 ──────────────────────────────────────────────────────────────
let failed = 0
let lastLayer = ""
for (const r of results) {
  if (!r.ok) failed++
  if (r.layer !== lastLayer) {
    console.log(`\n${r.layer}`)
    lastLayer = r.layer
  }
  console.log(`  ${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? "  ← " + r.detail : ""}`)
}
console.log(
  failed === 0
    ? `\n全部通过（${results.length} 项）。可以发版。`
    : `\n❌ ${failed} 项未过，别发。修完重跑。`,
)
process.exit(failed === 0 ? 0 : 1)
