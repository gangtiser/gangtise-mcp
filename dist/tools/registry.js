import { z } from "zod";
import { ENDPOINTS } from "../core/endpoints.js";
import { normalizeRows } from "../core/normalize.js";
import { downloadToResult } from "../core/download.js";
import { errorMessage } from "../core/errors.js";
export function sanitizeArgs(args, opts = {}) {
    const { fetchAll: _fetchAll, ...rest } = args;
    if (opts.paginated) {
        if (opts.fetchAll) {
            delete rest.size;
        }
        else if (rest.size === undefined) {
            rest.size = 20;
        }
    }
    return rest;
}
export function registerJsonTool(server, client, spec) {
    const schema = spec.paginated
        ? {
            ...spec.inputSchema,
            size: z.number().int().min(1).optional().describe("Max rows (default 20 for paginated endpoints)"),
            fetchAll: z.boolean().optional().describe("Fetch all pages; may be slow for large datasets"),
        }
        : spec.inputSchema;
    server.registerTool(spec.name, { description: spec.description, inputSchema: schema }, async (args) => {
        try {
            const { fetchAll, ...rest } = args;
            const body = sanitizeArgs(rest, { paginated: spec.paginated, fetchAll: Boolean(fetchAll) });
            const result = await client.call(spec.endpointKey, body);
            return { content: [{ type: "text", text: JSON.stringify(normalizeRows(result), null, 2) }] };
        }
        catch (err) {
            return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
    });
}
export function registerDownloadTool(server, client, spec) {
    server.registerTool(spec.name, { description: spec.description, inputSchema: spec.inputSchema }, async (args) => {
        try {
            const endpoint = ENDPOINTS[spec.endpointKey];
            if (!endpoint)
                throw new Error(`Unknown endpoint: ${spec.endpointKey}`);
            const query = args;
            const result = await downloadToResult(client, endpoint, query);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (err) {
            return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
    });
}
