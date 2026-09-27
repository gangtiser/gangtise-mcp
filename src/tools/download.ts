import { z } from "zod"
import { ENDPOINTS } from "../core/endpoints.js"
import { downloadToResult } from "../core/download.js"
import { ValidationError } from "../core/errors.js"
import { buildDownloadContent } from "../core/present.js"
import { defineTool, type FamilyModule } from "../mcp/define.js"
import { intLiteralEnum, nonEmptyString } from "../mcp/schemas.js"

/** 一种可下载的资源：端点、ID 的参数名与来源、它收的附加参数（各 kind 的取值闭集不同）。 */
interface Kind {
  label: string
  endpoint: string
  idParam: string
  /** ID 从哪个工具来（省略 gangtise_ 前缀）。 */
  from: string
  fileType?: { values: number[]; required?: boolean; desc: string }
  contentType?: { values: string[]; desc: string }
  resourceType?: true
  note?: string
}

const KINDS: Record<string, Kind> = {
  summary: { label: "纪要", endpoint: "insight.summary.download", idParam: "summaryId", from: "summary_list", fileType: { values: [1, 2], desc: "1=原始文件（默认）2=HTML（仅限会议平台纪要）" } },
  pamirs_summary: { label: "帕米尔专家纪要", endpoint: "insight.pamirs-summary.download", idParam: "summaryId", from: "pamirs_summary_list", fileType: { values: [1, 2], desc: "1=原始文件（默认）2=HTML" } },
  research: { label: "券商研报", endpoint: "insight.research.download", idParam: "reportId", from: "research_list", fileType: { values: [1, 2], desc: "1=PDF（默认）2=Markdown" } },
  foreign_report: { label: "外资研报", endpoint: "insight.foreign-report.download", idParam: "reportId", from: "foreign_report_list", fileType: { values: [1, 2, 3, 4], desc: "1=PDF 2=Markdown 3=中文PDF 4=中文Markdown" } },
  announcement: { label: "A股公告", endpoint: "insight.announcement.download", idParam: "announcementId", from: "announcement_list", fileType: { values: [1, 2], desc: "1=PDF（默认）2=Markdown" } },
  announcement_hk: { label: "港股公告", endpoint: "insight.announcement-hk.download", idParam: "announcementId", from: "announcement_list", fileType: { values: [1, 2], desc: "1=原始（默认）2=Markdown" } },
  announcement_us: { label: "美股公告", endpoint: "insight.announcement-us.download", idParam: "announcementId", from: "announcement_list", fileType: { values: [1, 2], desc: "1=原始 PDF（默认）2=Markdown" } },
  independent_opinion: { label: "独立观点 HTML", endpoint: "insight.independent-opinion.download", idParam: "independentOpinionId", from: "independent_opinion_list", fileType: { values: [1, 2], required: true, desc: "1=原文 2=中文翻译，必填" } },
  official_account: { label: "公众号文章", endpoint: "insight.official-account.download", idParam: "articleId", from: "official_account_list", fileType: { values: [1, 2], desc: "1=txt（默认）2=HTML" } },
  report_image: { label: "研报图表原图 JPEG", endpoint: "insight.report-image.download", idParam: "chunkId", from: "report_image_list" },
  performance_calendar: { label: "业绩报告原文 PDF", endpoint: "insight.performance-calendar.download", idParam: "performanceReportId", from: "performance_calendar_list", note: "仅 hasAttachment=true 的可下载" },
  knowledge_resource: { label: "知识库资源", endpoint: "ai.knowledge-resource.download", idParam: "sourceId", from: "knowledge_batch", resourceType: true },
  drive: { label: "云盘文件", endpoint: "vault.drive.download", idParam: "fileId", from: "drive_list" },
  record: { label: "录音", endpoint: "vault.record.download", idParam: "recordId", from: "record_list", contentType: { values: ["original", "asr", "summary"], desc: "original=原始音频 | asr=语音转文字 | summary=AI摘要，必填" } },
  my_conference: { label: "我的会议", endpoint: "vault.my-conference.download", idParam: "conferenceId", from: "my_conference_list", contentType: { values: ["asr", "summary"], desc: "asr=语音转文字 | summary=AI摘要，必填，不支持原始音频" } },
}
const KIND_NAMES = Object.keys(KINDS) as [string, ...string[]]
const RESOURCE_TYPES = [10, 11, 20, 40, 50, 51, 60, 70, 80, 90] as const

/** 单价取自端点，不另抄一份。 */
function priceOf(endpointKey: string): string {
  const billing = ENDPOINTS[endpointKey]?.billing
  switch (billing?.kind) {
    case "free":
      return "免费"
    case "fixed":
      return `${billing.price}/${billing.unit ?? (billing.per === "call" ? "次" : "条")}${billing.amplify ? `，${billing.amplify}` : ""}`
    case "downstream":
      return "按下游资源类型计"
    default:
      return "单价以平台计费为准"
  }
}

const KIND_DESC = KIND_NAMES.map((name) => {
  const kind = KINDS[name]
  return `${name}=${kind.label}（${kind.idParam}，来自 ${kind.from}${kind.note ? `，${kind.note}` : ""}；${priceOf(kind.endpoint)}）`
}).join(" | ")
const FILE_TYPE_DESC = KIND_NAMES.filter((name) => KINDS[name].fileType).map((name) => `${name} ${KINDS[name].fileType!.desc}`).join("；")

function reject(kind: string, message: string): never {
  throw new ValidationError(`kind=${kind}：${message}`)
}

export const downloadFamily: FamilyModule = {
  name: "download",
  endpoints: {},
  tools: [
    defineTool({
      name: "gangtise_download",
      tier: "core",
      access: "read",
      billingLabel: { kind: "variable", note: "单价随 kind 对应的资源而定，见 kind 说明", basis: "按下载类型" },
      description: "下载研报、纪要、公告、独立观点、公众号、图表、业绩报告、知识库资源、云盘文件与录音 / 会议转写：kind 选资源，id 填对应列表返回的 ID。文本类直接返回内容（大文件落盘返回路径），二进制返回文件路径。",
      input: {
        kind: z.enum(KIND_NAMES).describe(KIND_DESC),
        id: nonEmptyString.describe("资源 ID，按 kind 说明里的来源取"),
        fileType: intLiteralEnum([1, 2, 3, 4]).optional().describe(`格式，只有以下 kind 收：${FILE_TYPE_DESC}`),
        contentType: z.enum(["original", "asr", "summary"]).optional().describe(`只有 record（${KINDS.record.contentType!.desc}）与 my_conference（${KINDS.my_conference.contentType!.desc}）收`),
        resourceType: intLiteralEnum(RESOURCE_TYPES).optional().describe("只有 knowledge_resource 收，必填：10=研报 | 11=外资研报 | 20=内部 | 40=观点 | 50=公告 | 51=港股公告 | 60=纪要 | 70=调研 | 80=网络纪要 | 90=公众号"),
      },
      run: async ({ client }, args) => {
        const { kind: name, id, fileType, contentType, resourceType } = args as { kind: string; id: string; fileType?: number; contentType?: string; resourceType?: number }
        const kind = KINDS[name]
        // 每个 kind 的附加参数契约与原来的独立下载工具一致：该收的缺了拒，不该收的传了拒。
        if (fileType !== undefined && !kind.fileType) reject(name, "不收 fileType")
        if (kind.fileType?.required && fileType === undefined) reject(name, `fileType 必填（${kind.fileType.desc}）`)
        if (fileType !== undefined && kind.fileType && !kind.fileType.values.includes(fileType)) reject(name, `fileType 只收 ${kind.fileType.values.join(" / ")}（${kind.fileType.desc}）`)
        if (contentType !== undefined && !kind.contentType) reject(name, "不收 contentType")
        if (kind.contentType && contentType === undefined) reject(name, `contentType 必填（${kind.contentType.desc}）`)
        if (contentType !== undefined && kind.contentType && !kind.contentType.values.includes(contentType)) reject(name, `contentType 只收 ${kind.contentType.values.join(" / ")}`)
        if (resourceType !== undefined && !kind.resourceType) reject(name, "不收 resourceType")
        if (kind.resourceType && resourceType === undefined) reject(name, "resourceType 必填")
        const query: Record<string, string | number> = { [kind.idParam]: id }
        if (fileType !== undefined) query.fileType = fileType
        if (contentType !== undefined) query.contentType = contentType
        if (resourceType !== undefined) query.resourceType = resourceType
        const result = await downloadToResult(client, ENDPOINTS[kind.endpoint], query)
        return { content: await buildDownloadContent(result) }
      },
    }),
  ],
}
