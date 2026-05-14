import { z } from "zod";
import { registerJsonTool, registerDownloadTool } from "./registry.js";
import { pollAsyncContent } from "../core/asyncContent.js";
import { ApiError, AsyncTimeoutError, errorMessage } from "../core/errors.js";
const jsonSpecs = [
    {
        name: "gangtise_knowledge_batch",
        description: "Semantic search across Gangtise knowledge base (research reports, summaries, opinions, announcements, etc.). Supports up to 5 queries in one call.",
        endpointKey: "ai.knowledge-batch",
        paginated: false,
        inputSchema: {
            query: z.array(z.string()).min(1).max(5).describe("Search queries (max 5)"),
            top: z.number().int().min(1).max(20).optional().describe("Results per query (default 10, max 20)"),
            resourceType: z.array(z.number().int()).optional().describe("10=研报 | 11=外资研报 | 20=内部 | 40=观点 | 50=公告 | 51=港股公告 | 60=纪要 | 70=调研 | 80=网络纪要 | 90=公众号"),
            knowledgeName: z.string().optional().describe("system_knowledge_doc | tenant_knowledge_doc"),
        },
    },
    {
        name: "gangtise_security_clue_list",
        description: "List AI-generated investment clues indexed by security or industry. Requires startTime and endTime.",
        endpointKey: "ai.security-clue.list",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            startTime: z.string().describe("YYYY-MM-DD HH:mm:ss (required)"),
            endTime: z.string().describe("YYYY-MM-DD HH:mm:ss (required)"),
            queryMode: z.string().describe("bySecurity | byIndustry (required)"),
            gtsCode: z.string().optional().describe("Individual stock code or Shenwan industry code"),
            source: z.string().optional().describe("researchReport | conference | announcement | view"),
        },
    },
    {
        name: "gangtise_theme_tracking",
        description: "Get daily theme tracking report for a specific theme (morning or night edition).",
        endpointKey: "ai.theme-tracking",
        paginated: false,
        inputSchema: {
            themeId: z.string().describe("Theme ID from gangtise_lookup type=theme-ids (required)"),
            date: z.string().describe("YYYY-MM-DD, within last 30 days (required)"),
            type: z.string().optional().describe("morning | night"),
        },
    },
    {
        name: "gangtise_hot_topic",
        description: "List AI-generated hot topic briefings (morning, noon, afternoon, evening editions).",
        endpointKey: "ai.hot-topic",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            startDate: z.string().optional().describe("YYYY-MM-DD"),
            endDate: z.string().optional().describe("YYYY-MM-DD"),
            category: z.array(z.string()).optional().describe("morningBriefing | noonBriefing | afternoonFlash | eveningBriefing"),
            withRelatedSecurities: z.boolean().optional(),
            withCloseReading: z.boolean().optional(),
        },
    },
    {
        name: "gangtise_management_discuss_announcement",
        description: "Get AI-extracted management discussion from financial report announcements (half-year/annual only).",
        endpointKey: "ai.management-discuss-announcement",
        paginated: false,
        inputSchema: {
            securityCode: z.string().describe("Security code e.g. '600519.SH'"),
            reportDate: z.string().describe("xxxx-06-30 or xxxx-12-31 (half-year or annual only)"),
            dimension: z.string().describe("businessOperation | financialPerformance | developmentAndRisk (required)"),
        },
    },
    {
        name: "gangtise_management_discuss_earnings_call",
        description: "Get AI-extracted management discussion from earnings call transcripts.",
        endpointKey: "ai.management-discuss-earnings-call",
        paginated: false,
        inputSchema: {
            securityCode: z.string().describe("Security code e.g. '600519.SH'"),
            reportDate: z.string().describe("xxxx-03-31 | xxxx-06-30 | xxxx-09-30 | xxxx-12-31"),
            dimension: z.string().describe("businessOperation | financialPerformance | developmentAndRisk (required)"),
        },
    },
];
const downloadSpecs = [
    {
        name: "gangtise_knowledge_resource_download",
        description: "Download a knowledge resource file by resourceId.",
        endpointKey: "ai.knowledge-resource.download",
        inputSchema: {
            resourceId: z.string().describe("Resource ID from gangtise_knowledge_batch results"),
        },
    },
];
function makeAiContentHandler(client, endpointKey) {
    return async (args) => {
        try {
            const result = await client.call(endpointKey, args);
            const text = result?.content ?? JSON.stringify(result, null, 2);
            return { content: [{ type: "text", text }] };
        }
        catch (err) {
            return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
    };
}
function makeAsyncToolPair(server, client, opts, config) {
    // Submit + poll tool
    server.registerTool(config.name, {
        description: config.description,
        inputSchema: {
            ...config.inputSchema,
            waitSeconds: z.number().int().min(0).max(180).optional().describe("Max seconds to wait (default 60, max 180)"),
        },
    }, async (args) => {
        try {
            const { waitSeconds, ...submitArgs } = args;
            const timeoutMs = typeof waitSeconds === "number" ? waitSeconds * 1000 : opts.asyncTimeoutMs;
            const submitResult = await client.call(config.submitEndpoint, submitArgs);
            const dataId = submitResult[config.submitIdField];
            if (!dataId)
                throw new Error(`No ${config.submitIdField} in response`);
            try {
                const polled = await pollAsyncContent(client, config.pollEndpoint, dataId, timeoutMs);
                return { content: [{ type: "text", text: polled.content }] };
            }
            catch (err) {
                if (err instanceof AsyncTimeoutError) {
                    return { content: [{ type: "text", text: JSON.stringify({ dataId, status: "timeout", hint: `Call ${config.checkName} with this dataId in ~2 minutes` }) }] };
                }
                throw err;
            }
        }
        catch (err) {
            return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
    });
    // Single-shot check tool
    server.registerTool(config.checkName, {
        description: config.checkDescription,
        inputSchema: { dataId: z.string() },
    }, async ({ dataId }) => {
        try {
            const result = await client.call(config.pollEndpoint, { dataId });
            if (result.content)
                return { content: [{ type: "text", text: result.content }] };
            return { content: [{ type: "text", text: JSON.stringify({ status: "pending", dataId }) }] };
        }
        catch (err) {
            if (err instanceof ApiError && err.code === "410111")
                return { content: [{ type: "text", text: JSON.stringify({ status: "failed", dataId }) }], isError: true };
            if (err instanceof ApiError && err.code === "410110")
                return { content: [{ type: "text", text: JSON.stringify({ status: "pending", dataId }) }] };
            return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
    });
}
export function registerAiTools(server, client, opts) {
    // Spec-driven JSON tools
    for (const spec of jsonSpecs) {
        registerJsonTool(server, client, spec);
    }
    // Spec-driven download tools
    for (const spec of downloadSpecs) {
        registerDownloadTool(server, client, spec);
    }
    // Synchronous AI content generation tools (returns content directly)
    server.registerTool("gangtise_one_pager", {
        description: "Generate an AI one-pager (investment summary page) for a security. Returns Markdown content.",
        inputSchema: { securityCode: z.string().describe("A-share or HK security code") },
    }, async (args) => makeAiContentHandler(client, "ai.one-pager")(args));
    server.registerTool("gangtise_investment_logic", {
        description: "Generate an AI investment logic synthesis for a security. Returns Markdown content.",
        inputSchema: { securityCode: z.string().describe("A-share or HK security code") },
    }, async (args) => makeAiContentHandler(client, "ai.investment-logic")(args));
    server.registerTool("gangtise_peer_comparison", {
        description: "Generate an AI peer comparison / competitive landscape report for a security. Returns Markdown content.",
        inputSchema: { securityCode: z.string().describe("A-share or HK security code") },
    }, async (args) => makeAiContentHandler(client, "ai.peer-comparison")(args));
    server.registerTool("gangtise_research_outline", {
        description: "Get an AI-generated company research outline for a security. Returns Markdown content.",
        inputSchema: { securityCode: z.string().describe("A-share security code only") },
    }, async (args) => makeAiContentHandler(client, "ai.research-outline")(args));
    // Async tools: earnings-review
    makeAsyncToolPair(server, client, opts, {
        name: "gangtise_earnings_review",
        description: "Generate an AI earnings review report. Submits task then waits up to waitSeconds (default 60s). Returns dataId on timeout.",
        inputSchema: {
            securityCode: z.string().describe("A-share security code only"),
            period: z.string().describe("Format: 2025q1 | 2025q3 | 2025interim | 2025annual"),
        },
        submitEndpoint: "ai.earnings-review.get-id",
        pollEndpoint: "ai.earnings-review.get-content",
        submitIdField: "dataId",
        checkName: "gangtise_earnings_review_check",
        checkDescription: "Check status of a pending earnings review task by dataId.",
    });
    // Async tools: viewpoint-debate
    makeAsyncToolPair(server, client, opts, {
        name: "gangtise_viewpoint_debate",
        description: "Generate an AI viewpoint debate on a given investment opinion. Submits task then waits up to waitSeconds (default 60s). Returns dataId on timeout.",
        inputSchema: {
            viewpoint: z.string().max(1000).describe("Investment viewpoint text (max 1000 chars)"),
        },
        submitEndpoint: "ai.viewpoint-debate.get-id",
        pollEndpoint: "ai.viewpoint-debate.get-content",
        submitIdField: "dataId",
        checkName: "gangtise_viewpoint_debate_check",
        checkDescription: "Check status of a pending viewpoint debate task by dataId.",
    });
}
