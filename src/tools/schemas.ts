import { z } from "zod"

/**
 * A required, non-blank string: trims surrounding whitespace and rejects "" / "   ".
 * Use for IDs and codes always forwarded to the upstream API — a blank value
 * guarantees a wasted (sometimes billed) round-trip or a 400.
 */
export const nonEmptyString = z.string().trim().min(1)

/**
 * A closed set of integer literals (e.g. a download `fileType` of 1|2). Rejects
 * out-of-set values at the tool boundary instead of forwarding them for an
 * upstream 400. Requires ≥2 values — a single valid value should be z.literal().
 */
export function intLiteralEnum(values: readonly [number, number, ...number[]]) {
  return z.union(
    values.map((v) => z.literal(v)) as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]],
  )
}

/**
 * Whole-market keywords the quote APIs accept in `securityList`, lower-cased for
 * comparison. Which ones a given endpoint takes differs — the unified day K-line and
 * realtime take `aShares` / `hkStocks` / `usStocks`, the market-specific day K-line
 * endpoints take `all`, fund flow takes only `aShares`, and `gangtise_stock_summary`
 * takes none — so callers pass their own accepted list; this set only answers "is this
 * string a market keyword at all".
 *
 * Unknown keywords are deliberately absent rather than guessed at: this is a
 * known-keyword list, so a future server-side addition degrades to "not recognised as a
 * keyword" instead of being refused outright.
 */
export const MARKET_KEYWORDS = new Set(["all", "ashares", "hkstocks", "usstocks"])

/** Market keywords are compared case-insensitively — see the note on
 * `assertMarketKeywords` in tools/quote.ts for why that folding is load-bearing. */
export const matchesKeyword = (value: string, keyword: string): boolean =>
  value.toLowerCase() === keyword.toLowerCase()
