import { z } from "zod";
import { registerJsonTool } from "./registry.js";
const periodEnum = z.string().optional().describe("q1 | interim | q3 | annual | latest");
const quarterlyPeriodEnum = z.string().optional().describe("q1 | q2 | q3 | q4 | latest");
const reportTypeEnum = z.string().optional().describe("consolidated | consolidatedRestated | standalone | standaloneRestated");
const securityCode = z.string().describe("Security code e.g. '600519.SH'");
const dateRange = {
    startDate: z.string().optional().describe("YYYY-MM-DD"),
    endDate: z.string().optional().describe("YYYY-MM-DD"),
};
const fiscalYear = z.array(z.number().int()).optional().describe("Fiscal years e.g. [2023, 2024]");
const field = z.array(z.string()).optional().describe("Specific fields to return");
const specs = [
    {
        name: "gangtise_income_statement",
        description: "Get accumulated income statement for a security. Supports period, fiscal year, and report type filters.",
        endpointKey: "fundamental.income-statement",
        paginated: false,
        inputSchema: {
            securityCode,
            ...dateRange,
            fiscalYear,
            period: periodEnum,
            reportType: reportTypeEnum,
            field,
        },
    },
    {
        name: "gangtise_income_statement_quarterly",
        description: "Get quarterly income statement for a security.",
        endpointKey: "fundamental.income-statement-quarterly",
        paginated: false,
        inputSchema: {
            securityCode,
            ...dateRange,
            fiscalYear,
            period: quarterlyPeriodEnum,
            reportType: reportTypeEnum,
            field,
        },
    },
    {
        name: "gangtise_balance_sheet",
        description: "Get balance sheet for a security.",
        endpointKey: "fundamental.balance-sheet",
        paginated: false,
        inputSchema: {
            securityCode,
            ...dateRange,
            fiscalYear,
            period: periodEnum,
            reportType: reportTypeEnum,
            field,
        },
    },
    {
        name: "gangtise_cash_flow",
        description: "Get accumulated cash flow statement for a security.",
        endpointKey: "fundamental.cash-flow",
        paginated: false,
        inputSchema: {
            securityCode,
            ...dateRange,
            fiscalYear,
            period: periodEnum,
            reportType: reportTypeEnum,
            field,
        },
    },
    {
        name: "gangtise_cash_flow_quarterly",
        description: "Get quarterly cash flow statement for a security.",
        endpointKey: "fundamental.cash-flow-quarterly",
        paginated: false,
        inputSchema: {
            securityCode,
            ...dateRange,
            fiscalYear,
            period: quarterlyPeriodEnum,
            reportType: reportTypeEnum,
            field,
        },
    },
    {
        name: "gangtise_main_business",
        description: "Get main business composition breakdown (product, industry, or region) for a security.",
        endpointKey: "fundamental.main-business",
        paginated: false,
        inputSchema: {
            securityCode,
            breakdown: z.string().describe("product | industry | region (required)"),
            ...dateRange,
            period: z.string().optional().describe("interim | annual"),
            field,
        },
    },
    {
        name: "gangtise_valuation_analysis",
        description: "Get valuation metrics with historical percentile ranks for a security. Supports PE, PB, PEG, PS, PCF, EM.",
        endpointKey: "fundamental.valuation-analysis",
        paginated: false,
        inputSchema: {
            securityCode,
            indicator: z.string().describe("peTtm | pbMrq | peg | psTtm | pcfTtm | em (required)"),
            ...dateRange,
            limit: z.number().int().optional().describe("Max rows (default 2000)"),
            skipNull: z.boolean().optional().describe("Filter out null value rows"),
            field,
        },
    },
    {
        name: "gangtise_top_holders",
        description: "Get top 10 shareholders for a security.",
        endpointKey: "fundamental.top-holders",
        paginated: false,
        inputSchema: {
            securityCode,
            holderType: z.string().describe("top10 | top10Float (required)"),
            ...dateRange,
            fiscalYear,
            period: periodEnum,
        },
    },
    {
        name: "gangtise_earning_forecast",
        description: "Get consensus earnings forecast for a security (EPS, PE, net income, ROE, etc.).",
        endpointKey: "fundamental.earning-forecast",
        paginated: false,
        inputSchema: {
            securityCode,
            ...dateRange,
            consensus: z.array(z.string()).optional().describe("netIncome | netIncomeYoy | eps | pe | bps | pb | peg | roe | ps"),
        },
    },
];
export function registerFundamentalTools(server, client) {
    for (const spec of specs) {
        registerJsonTool(server, client, spec);
    }
}
