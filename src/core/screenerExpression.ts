// The screener's `expression` combines F1/F2… variables with `&&` / `||` and
// parentheses. Two questions get asked of it:
//  - which variables does it actually filter on (so a variable the expression
//    names but nothing binds can be rejected before a billed round trip), and
//  - given only the columns that came back, can it still be evaluated at all.
// Ported from gangtise-openapi-cli 0.31.0 (src/core/args.ts).

const FIELD_REF = /\bF[1-9][0-9]*\b/g
const STRING_LITERAL = /'[^']*'|"[^"]*"/g

/** A screener variable name: F followed by a positive integer. */
export const SCREENER_FIELD = /^F[1-9][0-9]*$/

/** Split an expression into `(`, `)`, `&&`, `||` and the atoms between them.
 * String literals are copied verbatim so a `||` or an `F2` inside one is never
 * mistaken for syntax. */
function tokenize(src: string): string[] {
  const tokens: string[] = []
  let atom = ""
  const flush = () => {
    if (atom.trim()) tokens.push(atom)
    atom = ""
  }
  for (let i = 0; i < src.length; ) {
    const ch = src[i]
    if (ch === "'" || ch === '"') {
      const close = src.indexOf(ch, i + 1)
      const stop = close === -1 ? src.length : close + 1
      atom += src.slice(i, stop)
      i = stop
    } else if (src.startsWith("&&", i) || src.startsWith("||", i)) {
      flush()
      tokens.push(src.slice(i, i + 2))
      i += 2
    } else if (ch === "(" || ch === ")") {
      flush()
      tokens.push(ch)
      i += 1
    } else {
      atom += ch
      i += 1
    }
  }
  flush()
  return tokens
}

/** Variables the expression actually filters on, string literals stripped.
 * These are the bindings whose VALUES the result depends on — a column missing
 * for one of them means the filter cannot be shown to have been applied. */
export function screenerExpressionFields(expression: string | undefined): string[] {
  return (expression ?? "").replace(STRING_LITERAL, "").match(FIELD_REF) ?? []
}

/** Can the expression still be evaluated when only `present` variables came
 * back with a column? Treat a missing column as an unevaluable term and ask
 * whether any branch survives:
 *   - `A && B` needs both — a term that cannot be evaluated voids the claim
 *     even if the other side is fine;
 *   - `A || B` needs only one — a row can legitimately match through one
 *     operand while the other is not evaluable at all.
 *
 * So `F1 && (F2 || F3)` missing F1, and `F1 || F2` missing both, are both
 * unevaluable — testing merely for a `||` anywhere would let them through. */
export function screenerExpressionIsEvaluable(expression: string | undefined, present: Set<string>): boolean {
  const tokens = tokenize(expression ?? "")
  let pos = 0
  const unit = (): boolean => {
    if (tokens[pos] === "(") {
      pos += 1
      const value = or()
      if (tokens[pos] === ")") pos += 1
      return value
    }
    const atom = tokens[pos++] ?? ""
    // A term naming no variable (a literal comparison) is always evaluable.
    return (atom.replace(STRING_LITERAL, "").match(FIELD_REF) ?? []).every((ref) => present.has(ref))
  }
  const and = (): boolean => {
    let value = unit()
    // Evaluate both sides before combining: short-circuiting would leave the
    // parser mid-expression.
    while (tokens[pos] === "&&") {
      pos += 1
      const right = unit()
      value = value && right
    }
    return value
  }
  const or = (): boolean => {
    let value = and()
    while (tokens[pos] === "||") {
      pos += 1
      const right = and()
      value = value || right
    }
    return value
  }
  return or()
}
