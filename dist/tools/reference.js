import { z } from "zod";
import { normalizeRows } from "../core/normalize.js";
import { errorMessage } from "../core/errors.js";
export function registerReferenceTools(server, client) {
    server.registerTool("gangtise_securities_search", {
        description: "按关键词搜索证券，支持股票名称、代码（如 600519）、拼音或英文名。返回匹配证券及其 GTS 代码。",
        inputSchema: {
            keyword: z.string().describe("搜索词：股票名称、代码（如 600519）、拼音或英文名"),
        },
    }, async ({ keyword }) => {
        try {
            const result = await client.call("reference.securities-search", { keyword });
            return { content: [{ type: "text", text: JSON.stringify(normalizeRows(result), null, 2) }] };
        }
        catch (err) {
            return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
    });
}
