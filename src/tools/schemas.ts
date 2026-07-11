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
