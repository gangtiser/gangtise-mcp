import { z } from "zod";
import { getLookupData } from "../core/lookupData/index.js";
import { errorMessage } from "../core/errors.js";
const LOOKUP_TYPES = [
    "research-areas",
    "broker-orgs",
    "meeting-orgs",
    "industries",
    "regions",
    "announcement-categories",
    "industry-codes",
    "theme-ids",
];
export function registerLookupTools(server, _client) {
    server.registerTool("gangtise_lookup", {
        description: "查询本地静态参考数据：研究方向、券商机构、会议机构、行业、地区、公告类别、申万行业代码、主题 ID。无需调用 API，直接返回本地数据。",
        inputSchema: {
            type: z.enum(LOOKUP_TYPES).describe("research-areas=研究方向 | broker-orgs=券商机构 | meeting-orgs=会议机构 | industries=行业 | regions=地区 | announcement-categories=公告类别 | industry-codes=申万行业代码 | theme-ids=主题ID"),
        },
    }, async ({ type }) => {
        try {
            const data = await getLookupData(type);
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
        catch (err) {
            return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
    });
}
