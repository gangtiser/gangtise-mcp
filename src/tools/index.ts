import type { FamilyModule } from "../mcp/define.js"
import { contextFamily } from "./context.js"
import { lookupFamily } from "./lookup.js"
import { referenceFamily } from "./reference.js"
import { insightFamily } from "./insight.js"
import { quoteFamily } from "./quote.js"
import { fundamentalFamily } from "./fundamental.js"
import { aiFamily, type AiToolOptions } from "./ai.js"
import { vaultFamily } from "./vault.js"
import { alternativeFamily } from "./alternative.js"
import { indicatorFamily } from "./indicator.js"
import { responseFamily } from "./response.js"

/** 全部族，顺序即注册顺序（也就是 tools/list 的顺序）。 */
export function createFamilies(options: AiToolOptions): FamilyModule[] {
  return [
    contextFamily,
    lookupFamily,
    referenceFamily,
    insightFamily,
    quoteFamily,
    fundamentalFamily,
    aiFamily(options),
    vaultFamily,
    alternativeFamily,
    indicatorFamily,
    responseFamily,
  ]
}
