import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { startHarness, type Harness } from "../helpers/harness.js"
import { missingToolRefs } from "../helpers/instructionRefs.js"

/** 对外表面快照：`tools/list` 与 `initialize.instructions` 是每次请求原样进客户模型上下文
 *  的两段字节。快照钉的是**措辞**——内部重构时它必须逐字节不变；有意改动时 `-u` 更新，
 *  但 diff 必须逐条人读（语义对不对，快照判断不了）。
 *
 *  快照取的是**线上原始出站**的 tools/list（见 harness.rawToolsList），不是 SDK client 解析
 *  之后的对象：字节预算按客户端实际收到的算。 */

let harness: Harness

beforeAll(async () => {
  harness = await startHarness()
})

afterAll(async () => {
  await harness.close()
})

const bytes = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8")

describe("surface snapshot (default profile)", () => {
  it("tools/list", async () => {
    const tools = await harness.rawToolsList()
    await expect(`${JSON.stringify(tools, null, 2)}\n`).toMatchFileSnapshot("./__snapshots__/tools-list.default.json")
  })

  it("instructions", async () => {
    await expect(`${harness.instructions() ?? ""}\n`).toMatchFileSnapshot("./__snapshots__/instructions.default.txt")
  })

  /** 字节口径：`tools` 数组的紧凑 JSON（不含 JSON-RPC 信封与 `result` 外壳），与
   *  scripts/prerelease-check.mjs ⑤ 的 150KB 门禁同口径，适合做前后对比。 */
  it("byte summary", async () => {
    const tools = (await harness.rawToolsList()) as Array<{ name: string }>
    const lines = [
      `tools: ${tools.length}`,
      `tools/list bytes: ${bytes(tools)}`,
      `instructions bytes: ${bytes(harness.instructions() ?? "")}`,
      "",
      ...tools.map((tool) => `${String(bytes(tool)).padStart(6)}  ${tool.name}`),
    ]
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("./__snapshots__/bytes.default.txt")
  })

  /** instructions 里点名的工具必须在该 profile 下真的存在：分档 / 合并之后，一条指向不存在
   *  工具的路由总则比没有更糟——模型会照着去调一个调不到的名字。 */
  it("every tool the instructions refer to exists", async () => {
    const names = ((await harness.rawToolsList()) as Array<{ name: string }>).map((t) => t.name)
    const text = harness.instructions() ?? ""
    const missing = missingToolRefs(text, names)
    expect(missing).toEqual([])
  })
})
