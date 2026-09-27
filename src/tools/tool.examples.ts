import type { ToolExamples } from "../mcp/contract.examples.js"

const PATH = "/application/open-tool/web-search/search"
const PARSE = "/application/open-tool/file-parse"
const SAMPLE = { file: { filename: "sample.pdf", bytes: 18 } }
/** 提交返回一个超出安全整数的数字 taskId（原文字节，不经 JS 序列化）。 */
const bigTaskId = (req: { endpoint: string }) => (req.endpoint === "tool.file-parse.submit" ? { text: '{"code":"000000","msg":"ok","data":{"taskId":123456789012345678901}}', headers: { "content-type": "application/json" } } : undefined)

export const toolExamples: ToolExamples = {
  gangtise_file_parse: [
    { title: "提交后取结果：multipart 上传，按 taskId（大整数按字符串读出）POST 取 ZIP", args: { filePath: "tests/fixtures/upload/sample.pdf" }, upstream: bigTaskId, expect: { requests: [
        { method: "POST", path: `${PARSE}/submit`, body: SAMPLE },
        { method: "POST", path: `${PARSE}/result`, body: { taskId: "123456789012345678901" } },
      ] } },
    { title: "waitSeconds=0 只提交", args: { filePath: "tests/fixtures/upload/sample.pdf", waitSeconds: 0 }, upstream: bigTaskId, expect: { requests: [{ method: "POST", path: `${PARSE}/submit`, body: SAMPLE }] } },
    { title: "非 PDF 本地拒绝", args: { filePath: "tests/fixtures/upload/sample.txt" }, expect: { rejects: /只支持 PDF/ } },
    { title: "文件不存在本地拒绝", args: { filePath: "tests/fixtures/upload/missing.pdf" }, expect: { rejects: /找不到文件/ } },
  ],
  gangtise_file_parse_check: [
    { title: "按 taskId POST 取结果", args: { taskId: "t-1" }, expect: { requests: [{ method: "POST", path: `${PARSE}/result`, body: { taskId: "t-1" } }] } },
    { title: "未就绪（140001）返回 pending，不报错", args: { taskId: "t-1" }, upstream: (req) => (req.endpoint === "tool.file-parse.result" ? { status: 409, json: { code: "140001", msg: "结果生成中", data: null } } : undefined), expect: { requests: [{ method: "POST", path: `${PARSE}/result`, body: { taskId: "t-1" } }] } },
  ],
  gangtise_web_search: [
    { title: "只传 query", args: { query: "减持新规" }, expect: { requests: [{ method: "POST", path: PATH, body: { query: "减持新规" } }] } },
    { title: "站点去重、时效与信源", args: { query: "减持新规", siteList: ["csrc.gov.cn", "sse.com.cn", "csrc.gov.cn"], freshness: "week", minTier: "T1" }, expect: { requests: [{ method: "POST", path: PATH, body: { query: "减持新规", siteList: ["csrc.gov.cn", "sse.com.cn"], freshness: "week", minTier: "T1" } }] } },
    { title: "带正文且省略 size：按上限 5 条发", args: { query: "某公告标题", includeContent: true, maxContentChars: 6000 }, expect: { requests: [{ method: "POST", path: PATH, body: { query: "某公告标题", includeContent: true, maxContentChars: 6000, size: 5 } }] } },
    { title: "带正文时 size 超 5 本地拒绝", args: { query: "某公告标题", includeContent: true, size: 10 }, expect: { rejects: /size 最多 5/ } },
    { title: "站点超 10 个本地拒绝", args: { query: "x", siteList: Array.from({ length: 11 }, (_, i) => `s${i}.gov.cn`) }, expect: { rejects: /最多 10 个/ } },
    { title: "query 超 200 字在 schema 层拒绝", args: { query: "字".repeat(201) }, expect: { rejects: /query/ } },
  ],
}
