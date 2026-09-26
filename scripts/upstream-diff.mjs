#!/usr/bin/env node
// 与 gangtise-openapi-cli 的端点契约对比。
//
//   node scripts/upstream-diff.mjs            对比 dist/ 的端点表与 tests/fixtures/upstream-endpoints.json
//   node scripts/upstream-diff.mjs --refresh  从本机 ../gangtise-openapi-cli 重新导出夹具（需要 tsx）
//
// 差异不在 tests/fixtures/sync-exceptions.json 里即失败；例外清单里已经不成立的条目也失败，
// 免得修好之后例外还留着。同一份比对由 tests/unit/upstream-diff.test.ts 在 CI 里跑。
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const UPSTREAM_FIXTURE = path.join(ROOT, "tests/fixtures/upstream-endpoints.json")
const EXCEPTIONS_FIXTURE = path.join(ROOT, "tests/fixtures/sync-exceptions.json")

const SCALAR_FIELDS = ["method", "path", "kind", "retry", "timeoutMs", "rowId", "rowIdUnverified", "expects", "itemFailures", "bigIntFields"]

/** 端点里两仓都有、且会影响请求或结果的字段。计费只比 fixed 的单价（本仓的其余计费种类在上游没有
 *  对应写法）；不可逆标记只比有无（文案各写各的）。 */
export function normalizeEndpoint(def) {
  const out = {}
  for (const field of SCALAR_FIELDS) if (def[field] !== undefined) out[field] = def[field]
  if (def.pagination) {
    out.pagination = { maxPageSize: def.pagination.maxPageSize }
    if (def.pagination.maxWindow !== undefined) out.pagination.maxWindow = def.pagination.maxWindow
  }
  const billing = def.billing
  const fixed = billing && (billing.kind === undefined || billing.kind === "fixed")
  if (fixed) {
    out.billing = { per: billing.per, price: billing.price }
    if (billing.maxUnits !== undefined) out.billing.maxUnits = Number.isFinite(billing.maxUnits) ? billing.maxUnits : "Infinity"
  }
  if (def.destructive) out.destructive = true
  return out
}

/** `ours` / `upstream`：端点键 → 端点定义（upstream 已按 normalizeEndpoint 导出）。
 *  `exceptions`：[{ key, field, reason }]，field 为 "missing" 表示本仓没接这个端点。 */
export function diffEndpoints(ours, upstream, exceptions) {
  const diffs = []
  for (const key of Object.keys(upstream).sort()) {
    if (!(key in ours)) {
      diffs.push({ key, field: "missing", ours: undefined, upstream: "exists" })
      continue
    }
    const a = normalizeEndpoint(ours[key])
    const b = upstream[key]
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) diffs.push({ key, field, ours: a[field], upstream: b[field] })
    }
  }
  const excused = new Set(exceptions.map((e) => `${e.key} ${e.field}`))
  const found = new Set(diffs.map((d) => `${d.key} ${d.field}`))
  return {
    unexplained: diffs.filter((d) => !excused.has(`${d.key} ${d.field}`)),
    stale: exceptions.filter((e) => !found.has(`${e.key} ${e.field}`)),
    excused: diffs.filter((d) => excused.has(`${d.key} ${d.field}`)),
  }
}

export function loadFixtures() {
  return {
    upstream: JSON.parse(fs.readFileSync(UPSTREAM_FIXTURE, "utf8")),
    exceptions: JSON.parse(fs.readFileSync(EXCEPTIONS_FIXTURE, "utf8")),
  }
}

function refresh(upstreamRoot) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "upstream-diff-")), "dump.mts")
  fs.writeFileSync(tmp, `const { ENDPOINTS } = await import(${JSON.stringify(pathToFileURL(path.join(upstreamRoot, "src/core/endpoints.ts")).href)})\nprocess.stdout.write(JSON.stringify(ENDPOINTS))\n`)
  const raw = JSON.parse(execFileSync("npx", ["tsx", tmp], { cwd: ROOT, encoding: "utf8" }))
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  const endpoints = {}
  for (const key of Object.keys(raw).sort()) endpoints[key] = normalizeEndpoint(raw[key])
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstreamRoot, encoding: "utf8" }).trim()
  const { version } = JSON.parse(fs.readFileSync(path.join(upstreamRoot, "package.json"), "utf8"))
  fs.writeFileSync(UPSTREAM_FIXTURE, JSON.stringify({ source: "gangtise-openapi-cli", version, commit, endpoints }, null, 2) + "\n")
  console.log(`已从 ${upstreamRoot}（${version}，${commit.slice(0, 7)}）导出 ${Object.keys(endpoints).length} 个端点`)
}

async function main() {
  if (process.argv.includes("--refresh")) {
    refresh(path.resolve(ROOT, "../gangtise-openapi-cli"))
  }
  const { upstream, exceptions } = loadFixtures()
  const { ENDPOINTS } = await import(pathToFileURL(path.join(ROOT, "dist/core/endpoints.js")).href)
  const { unexplained, stale, excused } = diffEndpoints(ENDPOINTS, upstream.endpoints, exceptions)
  console.log(`对比 gangtise-openapi-cli ${upstream.version}（${upstream.commit.slice(0, 7)}）：${excused.length} 处差异在例外清单内`)
  for (const d of unexplained) console.log(`  ❌ ${d.key} ${d.field}: 本仓 ${JSON.stringify(d.ours)} / 上游 ${JSON.stringify(d.upstream)}`)
  for (const e of stale) console.log(`  ❌ 例外已不成立：${e.key} ${e.field}（${e.reason}）`)
  if (unexplained.length > 0 || stale.length > 0) process.exit(1)
  console.log("  ✅ 没有例外清单之外的差异")
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main()
