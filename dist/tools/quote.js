import { z } from "zod";
import { normalizeRows } from "../core/normalize.js";
import { callKlineWithSharding } from "../core/quoteSharding.js";
import { errorMessage } from "../core/errors.js";
const commonKlineSchema = {
    security: z.union([z.string(), z.array(z.string())]).optional().describe("Security code(s) e.g. '600519.SH' or ['600519.SH','000858.SZ']; use 'all' for full market"),
    startDate: z.string().optional().describe("YYYY-MM-DD"),
    endDate: z.string().optional().describe("YYYY-MM-DD"),
    limit: z.number().int().optional().describe("Max rows (default 6000, max 10000)"),
    field: z.array(z.string()).optional().describe("Fields to return e.g. ['open','close','pctChange']"),
};
function buildKlineBody(args) {
    const body = {};
    if (args.security) {
        body.securityList = Array.isArray(args.security) ? args.security : [args.security];
    }
    if (args.startDate)
        body.startDate = args.startDate;
    if (args.endDate)
        body.endDate = args.endDate;
    if (args.limit)
        body.limit = args.limit;
    if (args.field)
        body.fieldList = args.field;
    return body;
}
function klineHandler(client, endpointKey, shardDays) {
    return async (args) => {
        try {
            const body = buildKlineBody(args);
            const isAllMarket = body.securityList?.[0] === "all";
            let result;
            if (isAllMarket && body.startDate && body.endDate) {
                result = await callKlineWithSharding(client, endpointKey, body, { shardDays });
            }
            else {
                result = await client.call(endpointKey, body);
            }
            return { content: [{ type: "text", text: JSON.stringify(normalizeRows(result), null, 2) }] };
        }
        catch (err) {
            return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
    };
}
export function registerQuoteTools(server, client) {
    server.registerTool("gangtise_day_kline", {
        description: "A-share daily candlestick data (SH/SZ/BJ markets). Use security='all' with startDate/endDate for full-market queries (auto-sharded).",
        inputSchema: commonKlineSchema,
    }, async (args) => klineHandler(client, "quote.day-kline", 2)(args));
    server.registerTool("gangtise_day_kline_hk", {
        description: "Hong Kong stock daily candlestick data.",
        inputSchema: commonKlineSchema,
    }, async (args) => klineHandler(client, "quote.day-kline-hk", 3)(args));
    server.registerTool("gangtise_index_day_kline", {
        description: "Index daily candlestick data (SH/SZ/BJ indices).",
        inputSchema: commonKlineSchema,
    }, async (args) => klineHandler(client, "quote.index-day-kline", 30)(args));
    server.registerTool("gangtise_minute_kline", {
        description: "A-share minute-level candlestick data. Requires a single security code.",
        inputSchema: {
            security: z.string().describe("Single security code e.g. '600519.SH'"),
            startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
            endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
            limit: z.number().int().optional().describe("Max rows (default 5000, max 10000)"),
            field: z.array(z.string()).optional(),
        },
    }, async ({ security, startTime, endTime, limit, field }) => {
        try {
            const body = { securityList: [security] };
            if (startTime)
                body.startTime = startTime;
            if (endTime)
                body.endTime = endTime;
            if (limit)
                body.limit = limit;
            if (field)
                body.fieldList = field;
            const result = await client.call("quote.minute-kline", body);
            return { content: [{ type: "text", text: JSON.stringify(normalizeRows(result), null, 2) }] };
        }
        catch (err) {
            return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
    });
}
