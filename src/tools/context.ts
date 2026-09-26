import { currentDateContext, CURRENT_TIMEZONE } from "../core/dateContext.js"
import { LOCAL } from "../mcp/billing.js"
import { defineTool, type FamilyModule } from "../mcp/define.js"

export const contextFamily: FamilyModule = {
  name: "context",
  endpoints: {},
  tools: [
    defineTool({
      name: "gangtise_current_date",
      tier: "core",
      access: "read",
      billingLabel: LOCAL,
      description: `查询当前日期、当前年份和当前时间（${CURRENT_TIMEZONE}），用于换算今天/最近/今年/当前等相对日期。`,
      input: {},
      run: async () => ({
        content: [{ type: "text" as const, text: JSON.stringify(currentDateContext(), null, 2) }],
      }),
      examples: [
        { title: "本地工具不发请求", args: {}, expect: { requests: [] } },
      ],
    }),
  ],
}
