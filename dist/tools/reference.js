import { z } from "zod";
import { normalizeRows } from "../core/normalize.js";
import { errorMessage } from "../core/errors.js";
export function registerReferenceTools(server, client) {
    server.registerTool("gangtise_securities_search", {
        description: "Search Gangtise securities by keyword, stock code, pinyin, or English name. Returns matching securities with their GTS codes.",
        inputSchema: {
            keyword: z.string().describe("Search term: stock name, code (e.g. 600519), pinyin, or English name"),
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
