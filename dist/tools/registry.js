import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ENDPOINTS } from "../core/endpoints.js";
import { normalizeRows } from "../core/normalize.js";
import { downloadToResult } from "../core/download.js";
import { errorMessage } from "../core/errors.js";
const INLINE_MAX_BYTES = 256_000;
const PREVIEW_ITEMS = 20;
function isPaginatedShape(value) {
    return (value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Array.isArray(value.list));
}
export async function buildToolContent(normalized) {
    const json = JSON.stringify(normalized, null, 2);
    const byteLength = Buffer.byteLength(json, "utf8");
    if (byteLength <= INLINE_MAX_BYTES) {
        return [{ type: "text", text: json }];
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gangtise-mcp-"));
    const savedPath = path.join(tempDir, "response.json");
    await fs.writeFile(savedPath, json, "utf8");
    let preview;
    if (isPaginatedShape(normalized)) {
        const { list, ...rest } = normalized;
        const previewList = list.slice(0, PREVIEW_ITEMS);
        preview = {
            ...rest,
            list: previewList,
            _truncated: true,
            _saved_to: savedPath,
            _total_bytes: byteLength,
            _total_items: list.length,
            _preview_count: previewList.length,
            has_more: list.length > PREVIEW_ITEMS,
        };
    }
    else if (Array.isArray(normalized)) {
        const previewList = normalized.slice(0, PREVIEW_ITEMS);
        preview = {
            list: previewList,
            _truncated: true,
            _saved_to: savedPath,
            _total_bytes: byteLength,
            _total_items: normalized.length,
            _preview_count: previewList.length,
            has_more: normalized.length > PREVIEW_ITEMS,
        };
    }
    else {
        preview = {
            _truncated: true,
            _saved_to: savedPath,
            _total_bytes: byteLength,
            _preview_count: 0,
            has_more: false,
        };
    }
    // Guard: if preview itself exceeds the byte cap (e.g. large rows), drop list and return metadata only.
    if (Buffer.byteLength(JSON.stringify(preview, null, 2), "utf8") > INLINE_MAX_BYTES) {
        const { list: _dropped, ...metaOnly } = preview;
        preview = { ...metaOnly, _preview_count: 0 };
    }
    return [{ type: "text", text: JSON.stringify(preview, null, 2) }];
}
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
            return { content: await buildToolContent(normalizeRows(result)) };
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
