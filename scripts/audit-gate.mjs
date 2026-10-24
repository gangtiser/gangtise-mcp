#!/usr/bin/env node
// 生产依赖审计门禁：等同 `npm audit --omit=dev --audit-level=high`，外加一份按公告逐条列出、带到期日的例外。
//
//   node scripts/audit-gate.mjs                                         CI 用（默认源即官方源）
//   node scripts/audit-gate.mjs --registry=https://registry.npmjs.org  本机默认源是镜像、没有 audit 接口时
//
// 其余参数原样转给 `npm audit`。high / critical 公告不在例外里即失败；例外过了到期日、或报告里已经没有
// 那条公告（修好了就该删）同样失败。只按公告 ID 放行，不降审计级别——降级会把以后的高危一并放过去。
// 同一套判定由 tests/unit/audit-gate.test.ts 在 CI 里跑。
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const BLOCKING = new Set(["high", "critical"])

/** 放行的公告。`expires` 当天仍有效，次日起失效；到期前要么修掉，要么改日期并写明理由。 */
export const ALLOWED = [
  {
    id: "GHSA-mrhx-c7xc-m3w5",
    package: "zod",
    reason: "修复只在 zod 4（4.6.6 起），3.x 没有修复版本；本服务的入参来自本机 stdio 客户端。随 0.4.0 迁移到 zod 4 后删除。",
    expires: "2026-12-31",
  },
]

/** `npm audit --json`（npm 7+）里的公告：每个漏洞包的 `via` 中对象形式的那些，按公告 ID 去重。
 *  字符串形式的 `via` 是依赖链上的传递关系，根上的公告在被依赖的那个包下面已经列过。 */
export function advisoriesOf(report) {
  if (!report || typeof report !== "object" || report.error || typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
    throw new Error(`npm audit 没有返回可读的报告：${JSON.stringify(report?.error ?? report).slice(0, 200)}`)
  }
  const byId = new Map()
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || via === null) continue
      const id = String(via.url ?? via.source).split("/").pop()
      byId.set(id, { id, package: via.name, severity: via.severity, title: via.title })
    }
  }
  return [...byId.values()]
}

/** `today`：YYYY-MM-DD。返回挡发布的公告、已到期的例外、已不成立的例外与放行的公告。 */
export function auditGate(report, allowed, today) {
  const advisories = advisoriesOf(report)
  const allowedById = new Map(allowed.map((a) => [a.id, a]))
  const reported = new Set(advisories.map((a) => a.id))
  const high = advisories.filter((a) => BLOCKING.has(a.severity))
  return {
    blocking: high.filter((a) => !allowedById.has(a.id)),
    expired: allowed.filter((a) => a.expires < today),
    stale: allowed.filter((a) => !reported.has(a.id)),
    excused: high.filter((a) => allowedById.has(a.id) && allowedById.get(a.id).expires >= today),
  }
}

function main() {
  const audit = spawnSync("npm", ["audit", "--omit=dev", "--json", ...process.argv.slice(2)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  let result
  try {
    result = auditGate(JSON.parse(audit.stdout), ALLOWED, new Date().toISOString().slice(0, 10))
  } catch (err) {
    console.log(`  ❌ ${err instanceof SyntaxError ? `npm audit 的输出不是 JSON（退出码 ${audit.status}）：${(audit.stderr || audit.stdout).slice(0, 300)}` : err.message}`)
    process.exit(1)
  }
  const { blocking, expired, stale, excused } = result
  for (const a of excused) console.log(`  ⚠️ 例外放行：${a.id} ${a.package}（${a.severity}）${a.title}`)
  for (const a of blocking) console.log(`  ❌ ${a.id} ${a.package}（${a.severity}）${a.title}`)
  for (const a of expired) console.log(`  ❌ 例外已过期（${a.expires}）：${a.id} ${a.package}`)
  for (const a of stale) console.log(`  ❌ 例外已不成立，报告里已没有这条公告，删掉它：${a.id} ${a.package}`)
  if (blocking.length > 0 || expired.length > 0 || stale.length > 0) process.exit(1)
  console.log("  ✅ 生产依赖没有例外之外的 high / critical 公告")
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main()
