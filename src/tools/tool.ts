import { z } from "zod"
import { ValidationError } from "../core/errors.js"
import { defineJsonTool, type FamilyModule } from "../mcp/define.js"
import { nonEmptyList, nonEmptyString } from "../mcp/schemas.js"
import { toolEndpoints } from "./tool.endpoints.js"

/** 带正文时服务端每次最多 5 条。 */
const CONTENT_MAX_SIZE = 5

export const toolFamily: FamilyModule = {
  name: "tool",
  routingHint: "联网：平台外的公开网页用 gangtise_web_search；平台内的研报、纪要、公告优先用对应 *_list。",
  endpoints: toolEndpoints,
  tools: [
    defineJsonTool({
      name: "gangtise_web_search",
      tier: "core",
      description: "投研定向检索公开网页：服务端已做转载去重、信源分级（tier T0–T3）与内容打标，零结果时 hints 给放宽建议。检索词原样发送、不做意图改写。⚠️ 排序是 tier 升序 → publishTime 降序 → 相关性，首条不等于最相关。publishTime 是规则判定的发布日期，判不出为 null（不代表网页没有日期）；indexTime 是索引记录的时间、不保证是发布时间，做时点判断用 publishTime。flags 标 rumor 传闻 / forward 转载 / disclaimer 免责声明 / toutSuspect 疑似荐股 / paywall 付费墙。",
      endpointKey: "tool.web-search",
      inputSchema: {
        query: nonEmptyString.max(200).describe("检索词，1–200 字；要限定站点用 siteList"),
        size: z.number().int().min(1).max(20).optional().describe(`返回条数（去重过滤之后，不足不补），默认 10；includeContent 时最多 ${CONTENT_MAX_SIZE}、省略即 ${CONTENT_MAX_SIZE}`),
        freshness: z.enum(["day", "week", "month", "none"]).optional().describe("按 publishTime 限时效，默认 none；⚠️ day / week / month 会连带丢掉 publishTime 判不出（null）的结果"),
        minTier: z.enum(["T0", "T1", "T2", "T3"]).optional().describe("最低信源等级，默认 T3（不过滤）"),
        siteList: nonEmptyList().optional().describe("限定注册域或子域（如 csrc.gov.cn），相互为或、子域按后缀匹配，去重后最多 10 个"),
        includeContent: z.boolean().optional().describe("返回网页正文 content（Markdown），个别页面取不到时为 null"),
        maxContentChars: z.number().int().min(1000).max(20000).optional().describe("每条正文字符上限，默认 8000，仅 includeContent 时生效；超出截断并标 contentTruncated"),
      },
      transformBody: (body) => {
        const out = { ...body }
        if (out.includeContent === true) {
          if (out.size === undefined) out.size = CONTENT_MAX_SIZE
          else if ((out.size as number) > CONTENT_MAX_SIZE) throw new ValidationError(`includeContent=true 时 size 最多 ${CONTENT_MAX_SIZE}（当前 ${String(out.size)}）：调小 size，或不取正文（最多 20 条摘要）。`)
        }
        if (Array.isArray(out.siteList)) {
          // 服务端按去重后的个数计上限。
          const sites = [...new Set(out.siteList as string[])]
          if (sites.length > 10) throw new ValidationError(`siteList 去重后 ${sites.length} 个，最多 10 个。`)
          out.siteList = sites
        }
        return out
      },
    }),
  ],
}
