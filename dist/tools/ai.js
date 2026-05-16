import { z } from "zod";
import { registerJsonTool, registerDownloadTool } from "./registry.js";
import { pollAsyncContent } from "../core/asyncContent.js";
import { ApiError, AsyncTimeoutError, errorMessage } from "../core/errors.js";
import { dateDesc, dateTimeDesc, today, todayDate } from "../core/dateContext.js";
const jsonSpecs = [
    {
        name: "gangtise_knowledge_batch",
        description: "在 Gangtise 知识库（研报、纪要、观点、公告等）中进行语义搜索，单次最多支持 5 个查询词。",
        endpointKey: "ai.knowledge-batch",
        paginated: false,
        inputSchema: {
            queryList: z.array(z.string()).min(1).max(5).describe("搜索词列表（最多 5 个）"),
            top: z.number().int().min(1).max(20).optional().describe("每个查询词返回的结果数（默认 10，最大 20）"),
            resourceType: z.array(z.number().int()).optional().describe("10=研报 | 11=外资研报 | 20=内部 | 40=观点 | 50=公告 | 51=港股公告 | 60=纪要 | 70=调研 | 80=网络纪要 | 90=公众号"),
            knowledgeName: z.string().optional().describe("system_knowledge_doc | tenant_knowledge_doc"),
        },
    },
    {
        name: "gangtise_security_clue_list",
        description: "查询 AI 生成的个股或行业投资线索列表，需传入时间范围。",
        endpointKey: "ai.security-clue.list",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            startTime: z.string().describe(dateTimeDesc() + "（必填）"),
            endTime: z.string().describe(dateTimeDesc() + "（必填）"),
            queryMode: z.string().describe("bySecurity=按个股 | byIndustry=按行业（必填）"),
            gtsCodeList: z.array(z.string()).optional().describe("个股代码或申万行业代码列表"),
            source: z.string().optional().describe("researchReport=研报 | conference=会议 | announcement=公告 | view=观点"),
        },
    },
    {
        name: "gangtise_hot_topic",
        description: "查询 AI 生成的热点话题简报列表，支持早报、午报、午后快讯、晚报等版别。",
        endpointKey: "ai.hot-topic",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            startDate: z.string().optional().describe(dateDesc()),
            endDate: z.string().optional().describe(dateDesc()),
            category: z.array(z.string()).optional().describe("morningBriefing=早报 | noonBriefing=午报 | afternoonFlash=午后快讯 | eveningBriefing=晚报"),
            withRelatedSecurities: z.boolean().optional(),
            withCloseReading: z.boolean().optional(),
        },
    },
    {
        name: "gangtise_management_discuss_announcement",
        description: "从财报公告（半年报/年报）中提取 AI 整理的管理层讨论内容，仅支持中报和年报。",
        endpointKey: "ai.management-discuss-announcement",
        paginated: false,
        inputSchema: {
            securityCode: z.string().describe("证券代码，如 '600519.SH'"),
            reportDate: z.string().describe("xxxx-06-30（中报）或 xxxx-12-31（年报）"),
            dimension: z.string().describe("businessOperation=经营情况 | financialPerformance=财务表现 | developmentAndRisk=发展与风险 | all=全部维度（必填）"),
        },
    },
    {
        name: "gangtise_management_discuss_earnings_call",
        description: "从业绩会会议纪要中提取 AI 整理的管理层讨论内容。",
        endpointKey: "ai.management-discuss-earnings-call",
        paginated: false,
        inputSchema: {
            securityCode: z.string().describe("证券代码，如 '600519.SH'"),
            reportDate: z.string().describe("xxxx-03-31 | xxxx-06-30 | xxxx-09-30 | xxxx-12-31"),
            dimension: z.string().describe("businessOperation=经营情况 | financialPerformance=财务表现 | developmentAndRisk=发展与风险（必填）"),
        },
    },
];
const downloadSpecs = [
    {
        name: "gangtise_knowledge_resource_download",
        description: "按 resourceId 下载知识库资源文件。",
        endpointKey: "ai.knowledge-resource.download",
        inputSchema: {
            resourceId: z.string().describe("资源 ID，来自 gangtise_knowledge_batch 返回结果"),
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
            waitSeconds: z.number().int().min(0).max(180).optional().describe("最长等待秒数（默认 60，最大 180）"),
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
    // gangtise_theme_tracking: registered directly to enforce 30-day date guard
    server.registerTool("gangtise_theme_tracking", {
        description: `[当前日期 ${today()}，时区 Asia/Shanghai。] 获取指定主题的每日跟踪报告（早报或晚报版），需传入主题 ID 和日期。`,
        inputSchema: {
            themeId: z.string().describe("主题 ID，来自 gangtise_lookup type=theme-ids（必填）"),
            date: z.string().describe(`YYYY-MM-DD，仅支持最近 30 天（必填）。当前日期 ${today()}，请勿使用训练数据年份`),
            type: z.string().optional().describe("morning=早报 | night=晚报"),
        },
    }, async (args) => {
        try {
            const { date, ...rest } = args;
            const inputDate = new Date(`${date}T00:00:00+08:00`);
            const diffDays = Math.floor((todayDate().getTime() - inputDate.getTime()) / 86_400_000);
            if (diffDays > 30 || diffDays < 0) {
                return {
                    content: [{ type: "text", text: `date 超出最近 30 天范围。当前日期是 ${today()}，请按当前日期重新换算。` }],
                    isError: true,
                };
            }
            const result = await client.call("ai.theme-tracking", { date, ...rest });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (err) {
            return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
    });
    // Spec-driven download tools
    for (const spec of downloadSpecs) {
        registerDownloadTool(server, client, spec);
    }
    // Synchronous AI content generation tools (returns content directly)
    server.registerTool("gangtise_one_pager", {
        description: "生成指定证券的 AI 一页纸投资摘要，返回 Markdown 内容。",
        inputSchema: { securityCode: z.string().describe("A 股或港股证券代码") },
    }, async (args) => makeAiContentHandler(client, "ai.one-pager")(args));
    server.registerTool("gangtise_investment_logic", {
        description: "生成指定证券的 AI 投资逻辑梳理报告，返回 Markdown 内容。",
        inputSchema: { securityCode: z.string().describe("A 股或港股证券代码") },
    }, async (args) => makeAiContentHandler(client, "ai.investment-logic")(args));
    server.registerTool("gangtise_peer_comparison", {
        description: "生成指定证券的 AI 同业竞争格局对比报告，返回 Markdown 内容。",
        inputSchema: { securityCode: z.string().describe("A 股或港股证券代码") },
    }, async (args) => makeAiContentHandler(client, "ai.peer-comparison")(args));
    server.registerTool("gangtise_research_outline", {
        description: "获取指定证券的 AI 生成公司研究提纲，返回 Markdown 内容。",
        inputSchema: { securityCode: z.string().describe("仅支持 A 股证券代码") },
    }, async (args) => makeAiContentHandler(client, "ai.research-outline")(args));
    // Async tools: earnings-review
    makeAsyncToolPair(server, client, opts, {
        name: "gangtise_earnings_review",
        description: "生成 AI 业绩点评报告。提交任务后等待最多 waitSeconds 秒（默认 60s），超时返回 dataId。",
        inputSchema: {
            securityCode: z.string().describe("仅支持 A 股证券代码"),
            period: z.string().describe("格式：2025q1 | 2025q3 | 2025interim | 2025annual"),
        },
        submitEndpoint: "ai.earnings-review.get-id",
        pollEndpoint: "ai.earnings-review.get-content",
        submitIdField: "dataId",
        checkName: "gangtise_earnings_review_check",
        checkDescription: "按 dataId 查询业绩点评任务的生成状态。",
    });
    // Async tools: viewpoint-debate
    makeAsyncToolPair(server, client, opts, {
        name: "gangtise_viewpoint_debate",
        description: "对给定投资观点生成 AI 多空辩论报告。提交任务后等待最多 waitSeconds 秒（默认 60s），超时返回 dataId。",
        inputSchema: {
            viewpoint: z.string().max(1000).describe("投资观点文本（最多 1000 字）"),
        },
        submitEndpoint: "ai.viewpoint-debate.get-id",
        pollEndpoint: "ai.viewpoint-debate.get-content",
        submitIdField: "dataId",
        checkName: "gangtise_viewpoint_debate_check",
        checkDescription: "按 dataId 查询多空辩论任务的生成状态。",
    });
}
