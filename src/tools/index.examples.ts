import type { ToolExamples } from "../mcp/contract.examples.js"
import { contextExamples } from "./context.examples.js"
import { lookupExamples } from "./lookup.examples.js"
import { referenceExamples } from "./reference.examples.js"
import { insightExamples } from "./insight.examples.js"
import { quoteExamples } from "./quote.examples.js"
import { fundamentalExamples } from "./fundamental.examples.js"
import { aiExamples } from "./ai.examples.js"
import { vaultExamples } from "./vault.examples.js"
import { alternativeExamples } from "./alternative.examples.js"
import { indicatorExamples } from "./indicator.examples.js"
import { responseExamples } from "./response.examples.js"

/** 全部工具的契约示例（只给测试用）。 */
export const EXAMPLES: ToolExamples = {
  ...contextExamples,
  ...lookupExamples,
  ...referenceExamples,
  ...insightExamples,
  ...quoteExamples,
  ...fundamentalExamples,
  ...aiExamples,
  ...vaultExamples,
  ...alternativeExamples,
  ...indicatorExamples,
  ...responseExamples,
}
