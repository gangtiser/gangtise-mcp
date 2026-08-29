import { ApiError, attachEnvelopeTraceId, ENVELOPE_TRACE_ID } from "./errors.js"
import { screenerExpressionFields, screenerExpressionIsEvaluable } from "./screenerExpression.js"

// The EDE cross-section / time-series / screener endpoints return a `values`
// matrix plus parallel identity lists rather than ready-made rows. These helpers
// flatten that matrix into the wide tabular shape the MCP tools return.
//
// Shapes below match the EDE response as of the 2026-08-01 API revision, which
// replaced the parallel indicatorCodeList / indicatorNameList arrays with a
// single structured `indicatorList`, and TRANSPOSED the cross-section matrix.
// `values` is now [security][indicator] for cross-section and the screener, and
// stays [series][date] for time-series.
interface IndicatorMeta {
  /** Screener only: the F1/F2… variable this column was requested under. */
  field?: unknown
  code?: unknown
  name?: unknown
  dataType?: unknown
}

interface MatrixData {
  dates?: unknown
  securityCodeList?: unknown
  securityNameList?: unknown
  indicatorList?: unknown
  values?: unknown
}

// The EDE endpoints double-wrap on success: the shared client strips the outer
// envelope but leaves an inner { code, status, data } around the real payload.
// Peel that inner envelope so the list (search) / matrix (cross-section,
// time-series) is reachable. A failure code carried only by the inner envelope
// must still surface instead of rendering its null payload as success.
export function unwrapIndicatorData(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>
    if ("code" in record || "status" in record) {
      const code = record.code === undefined ? undefined : String(record.code)
      const ok = record.status === true || code === "000000" || code === "0"
      // A failure envelope may omit `data` entirely ({ code, status: false, msg })
      // — gating on the data key would let a permission/quota error flow through
      // as "successful" payload. Still require some envelope evidence
      // (status/msg/data) so a non-envelope object that merely carries a `code`
      // field can't be misread as a failure.
      if (!ok && ("status" in record || "msg" in record || "data" in record)) {
        throw new ApiError(
          typeof record.msg === "string" && record.msg ? record.msg : "Indicator API request failed",
          code,
          undefined,
          // Pass `record` as details: the inner envelope carries no traceId of its
          // own, so ApiError.traceId falls back to the outer envelope's id that
          // attachEnvelopeTraceId parked on this object. Without it these failures —
          // the ones most in need of a support ticket — are unreportable.
          record,
        )
      }
      // Hand the envelope's traceId to the inner payload. unwrapEnvelope attached
      // it to THIS object, but everything downstream (the shape guards below) only
      // ever sees `record.data` — without this hand-off a shape failure, exactly
      // the kind support needs to trace, arrives trace-less.
      if (ok && "data" in record) {
        return attachEnvelopeTraceId(record.data, (record as Record<PropertyKey, unknown>)[ENVELOPE_TRACE_ID] ?? record.traceId)
      }
    }
  }
  return raw
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((item) => String(item)) : undefined
}

/** An IDENTITY axis — the security a row belongs to, the date a column belongs
 * to. `String(item)` would turn a `null` into the literal `"null"` and render it
 * as a perfectly plausible label, so a fabricated identity would reach the model
 * looking like a valid answer. Nothing here may be coerced: every entry must
 * already be a non-empty string. */
function asIdentityArray(data: unknown, value: unknown, key: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const bad = value.findIndex((item) => typeof item !== "string" || item.trim() === "")
  if (bad !== -1) {
    throw new ApiError(
      `Indicator matrix shape mismatch: ${key}[${bad}] is not a usable identifier (${JSON.stringify(value[bad])}) — rows would be labelled with a value that identifies nothing`,
      undefined,
      undefined,
      data,
    )
  }
  return value as string[]
}

/** Indicator metadata is an identity axis too: a column without a `code` cannot
 * be mapped back to the indicator that was asked for. A non-object entry used to
 * collapse into `{}` and surface as `col0`. */
function asIndicatorMetaList(data: unknown, value: unknown): IndicatorMeta[] | undefined {
  if (!Array.isArray(value)) return undefined
  const bad = value.findIndex(
    (item) =>
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof (item as IndicatorMeta).code !== "string" ||
      String((item as IndicatorMeta).code).trim() === "",
  )
  if (bad !== -1) {
    throw new ApiError(
      `Indicator matrix shape mismatch: indicatorList[${bad}] carries no usable \`code\` (${JSON.stringify(value[bad])}) — the column could not be mapped back to a requested indicator`,
      undefined,
      undefined,
      data,
    )
  }
  return value as IndicatorMeta[]
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value)
}

function rowOf(values: unknown, index: number): unknown[] | undefined {
  const row = (values as unknown[])[index]
  return Array.isArray(row) ? row : undefined
}

// Build one column header per series. Prefer the human-readable name; on a
// duplicate name append a disambiguator so a column is never silently
// overwritten. `reserved` pre-claims the row's metadata keys (date / security /
// name) — a series literally named like one of them must be suffixed, not
// clobber the metadata.
function buildHeaders(bases: (string | undefined)[], suffixes: (string | undefined)[], reserved: readonly string[]): string[] {
  const used = new Set<string>(reserved)
  const headers: string[] = []
  for (let i = 0; i < bases.length; i++) {
    const base = bases[i] ?? suffixes[i] ?? `col${i}`
    let header = base
    let attempt = 1
    while (used.has(header)) {
      const suffix = suffixes[i] ?? i
      header = attempt === 1 ? `${base} (${suffix})` : `${base} (${suffix})_${attempt}`
      attempt++
    }
    used.add(header)
    headers.push(header)
  }
  return headers
}

// Column headers for a list of indicator metadata. Two indicators can share a
// display name (cf_finc_exp / cf_finc_exp_qtr are both 「财务费用」) while the
// server also reorders columns relative to the request, so a repeated name is
// disambiguated by `code` — or, on a screener payload, by the `field` variable
// the column was requested under.
function indicatorHeaders(indicators: IndicatorMeta[], reserved: readonly string[]): string[] {
  const codes = indicators.map((meta) => optionalString(meta.code))
  const fields = indicators.map((meta, i) => optionalString(meta.field) ?? codes[i])
  const bases = indicators.map((meta) => optionalString(meta.name))
  // On a screener payload every column carries its variable, so a repeated base
  // can suffix ALL of its occurrences instead of leaving the first one bare.
  // A bare `收盘价` next to `收盘价 (F2)` reads as "the" close price when it is
  // really just whichever variable the server happened to list first.
  const screener = indicators.some((meta) => meta.field !== undefined)
  if (!screener) return buildHeaders(bases, fields, reserved)
  const repeated = new Set(bases.filter((base, i) => base !== undefined && bases.indexOf(base) !== i))
  return buildHeaders(
    bases.map((base, i) => (base !== undefined && repeated.has(base) ? `${base} (${fields[i] ?? i})` : base)),
    fields,
    reserved,
  )
}

const CROSS_SECTION_COLUMNS = ["security", "name"] as const

/** A response carrying neither securities nor indicators: the query as a whole
 * resolved to nothing. This is NOT a dropped axis, so it must not be reported as
 * partial — calling every requested code "omitted" would be false metadata, the
 * diff against the request is total by construction.
 *
 * What it MEANS changed on 2026-08-07: a genuine no-data answer (non-trading
 * date, uncovered market, future date) keeps its row and column and carries a
 * `null` PLACEHOLDER, so an all-empty matrix no longer means "no data". It now
 * means nothing in the request RESOLVED — every security code or every indicator
 * code was unrecognised. A wrong PARAMETER name does not land here either — it is
 * now rejected outright with a `100003` naming the key; a wrong date VALUE or a
 * missing non-date required key yields a null cell or a plausible wrong value.
 * Neither shape ever produces an empty table (see indicator.ts's probe list).
 *
 * Placeholders were once indicator-dependent (`0` for some, `null` for most).
 * That closed on the server side and the `0` tier is gone from every customer-
 * facing description — do not reintroduce it here without a probe; a 330-cell
 * sweep across coverage gaps, non-period-end dates and company-type mismatches
 * found zero numeric-zero placeholders.
 *
 * The check covers every STRUCTURAL array, not just the two axis lists, because
 * anything looser would let a malformed payload — `values: null`, a missing
 * `values`, or dates with no matrix — pass as "legitimately empty" and bypass
 * every shape guard below. Required empty: `securityCodeList`, `indicatorList`,
 * `values`; plus `dates` when present (probed 2026-08-02, back when this shape
 * still meant "no data": a time-series all-empty answer is five empty arrays, a
 * cross-section one is four — it carries no `dates` key at all). The STRUCTURE is
 * unchanged; only its meaning moved.
 *
 * `securityNameList` is deliberately NOT checked: it holds display labels, not
 * structure, so a `null` there cannot misalign anything — and rejecting it would
 * re-introduce the false-partial this function exists to prevent.
 *
 * `requireDates` is for time-series, where `dates` is a required axis: without it
 * an answer that lost that axis entirely would still pass as "legitimately
 * empty" and skip the flattener's axis check. Cross-section and the screener omit
 * the key altogether (four empty arrays vs five), so they leave it off. */
export function isEmptyMatrix(data: unknown, options?: { requireDates?: boolean }): boolean {
  if (!data || typeof data !== "object") return false
  const d = data as MatrixData
  if (asStringArray(d.securityCodeList)?.length !== 0) return false
  if (!Array.isArray(d.indicatorList) || d.indicatorList.length !== 0) return false
  if (!Array.isArray(d.values) || d.values.length !== 0) return false
  if (options?.requireDates) return Array.isArray(d.dates) && d.dates.length === 0
  // `dates` is time-series only; when present it must be empty too.
  return d.dates === undefined || (Array.isArray(d.dates) && d.dates.length === 0)
}

/** Validate the variable bindings a screener answered with, returning the bound
 * variables that are merely missing a column.
 *
 * The screener answers with the variable each column was requested under, and
 * that binding is the ONLY thing tying a column back to the filter it came from
 * — nothing else in the payload can catch it going wrong. A swapped or unknown
 * `field` renders as a perfectly ordinary table, which would make every
 * screening decision downstream unfounded.
 *
 * Every returned entry must therefore name a REQUESTED variable and carry that
 * variable's code, and no variable may appear twice. A result with no securities
 * matched nothing and binds nothing, so it is left alone. */
export function checkScreenerBindings(
  data: unknown,
  requested: { field: string; indicatorCode: string }[],
  expression: string | undefined,
): string[] {
  if (!data || typeof data !== "object") return []
  const d = data as MatrixData
  if (!Array.isArray(d.securityCodeList) || d.securityCodeList.length === 0) return []
  const indicators = Array.isArray(d.indicatorList) ? (d.indicatorList as IndicatorMeta[]) : []
  const wanted = new Map(requested.map((binding) => [binding.field, binding.indicatorCode]))
  const seen = new Set<string>()
  for (const [i, meta] of indicators.entries()) {
    const field = optionalString(meta?.field)
    const code = optionalString(meta?.code)
    if (!field || !wanted.has(field)) {
      throw new ApiError(
        `Screener binding mismatch: indicatorList[${i}] is bound to ${field ? `"${field}"` : "no variable"}, which was never requested — the column cannot be traced to a filter`,
        undefined,
        undefined,
        data,
      )
    }
    if (wanted.get(field) !== code) {
      throw new ApiError(
        `Screener binding mismatch: variable ${field} came back as "${code}" but was requested as "${wanted.get(field)}" — the filter and the column disagree`,
        undefined,
        undefined,
        data,
      )
    }
    if (seen.has(field)) {
      throw new ApiError(
        `Screener binding mismatch: variable ${field} appears twice in the response — the mapping back to a filter is ambiguous`,
        undefined,
        undefined,
        data,
      )
    }
    seen.add(field)
  }
  // Securities came back, so the filter ran. A column vanishing is never "it got
  // filtered out" — filtering removes securities (rows), never indicators
  // (columns). Since 2026-08-07 a covered-but-empty indicator keeps a null
  // column, so an absent column means the server did not resolve that indicator
  // code at all. Whether that voids the result follows the expression's BOOLEAN
  // STRUCTURE, not the mere presence of a `||`: if no branch survives the missing
  // columns the rows cannot be shown to satisfy anything and the result must not
  // be returned; if some branch still could have matched, the absence proves
  // nothing wrong and only costs an output column.
  const missing = [...wanted.keys()].filter((field) => !seen.has(field))
  if (!screenerExpressionIsEvaluable(expression, seen)) {
    const absent = [...new Set(screenerExpressionFields(expression))].filter((field) => !seen.has(field))
    throw new ApiError(
      `Screener binding mismatch: the expression cannot be evaluated from what came back — ${absent.join(", ")} ${absent.length > 1 ? "have" : "has"} no column, and no branch of the expression survives without ${absent.length > 1 ? "them" : "it"}, so the rows cannot be shown to satisfy it`,
      undefined,
      undefined,
      data,
    )
  }
  return missing
}

/** What the caller asked for that the response does not contain.
 *
 * The server used to drop any axis it had no DATA for, which made this a coverage
 * check. That closed: a coverage gap now keeps its row and column and is filled
 * with `null`, down to the 1×1 case (`finc_pb_mrq` × 09992.HK — null, present,
 * alone in the request). What still disappears is a code the server
 * cannot RESOLVE: usually an unknown indicator code or a wrong market suffix
 * (`AAPL.US` vanishes, `AAPL.O` returns) — but "absent axis" is all this function
 * can prove; entitlement or coverage changes make the same shape. Callers must
 * phrase it as "not resolved/accepted", never as "you misspelled it".
 *
 * So the remaining shape is the dangerous one: an absent axis is invisible
 * otherwise — the pull quietly returns fewer rows/columns than requested at HTTP
 * 200 with nothing in the payload saying so.
 *
 * Universe entries with no `.` are skipped — those are sector IDs, which the
 * server expands into constituents, so their absence is expected rather than a
 * dropped row. */
export function droppedFromMatrix(
  data: unknown,
  requestedSecurities: string[],
  requestedIndicators: string[],
): { securities: string[]; indicators: string[] } {
  const empty = { securities: [], indicators: [] }
  if (!data || typeof data !== "object") return empty
  const d = data as MatrixData
  const returnedSecurities = new Set(asStringArray(d.securityCodeList) ?? [])
  const returnedIndicators = new Set(
    (Array.isArray(d.indicatorList) ? (d.indicatorList as IndicatorMeta[]) : []).map((meta) => optionalString(meta?.code)),
  )
  return {
    securities: requestedSecurities.filter((code) => code.includes(".") && !returnedSecurities.has(code)),
    indicators: requestedIndicators.filter((code) => !returnedIndicators.has(code)),
  }
}

/** True only when the payload carries NONE of the EDE matrix keys — a foreign
 * shape. Nothing legitimately reaches the flatteners in that state (indicator
 * search returns its unwrapped list directly), so this is a protocol failure,
 * not a payload to hand back: returning it would render the raw envelope as a
 * successful result, indistinguishable from data. */
function assertMatrixPayload(data: unknown, d: MatrixData): void {
  const bare =
    d.securityCodeList === undefined &&
    d.securityNameList === undefined &&
    d.indicatorList === undefined &&
    d.dates === undefined &&
    d.values === undefined
  if (bare) {
    throw new ApiError(
      "Indicator matrix shape mismatch: the response carries none of the matrix fields — the response layout may have changed",
      undefined,
      undefined,
      data,
    )
  }
}

function assertAxis<T>(data: unknown, axis: T | undefined, key: string): asserts axis is T {
  if (axis === undefined) {
    throw new ApiError(
      `Indicator matrix shape mismatch: the response is missing \`${key}\` or it is not an array — the response layout may have changed`,
      undefined,
      undefined,
      data,
    )
  }
}

function assertValuesPresent(data: unknown, values: unknown): asserts values is unknown[] {
  if (!Array.isArray(values)) {
    throw new ApiError(
      "Indicator matrix shape mismatch: the response carries axis lists but no `values` array — the response layout may have changed",
      undefined,
      undefined,
      data,
    )
  }
}

/** Resolve the display names for a security axis, degrading instead of failing.
 *
 * Names are consumed POSITIONALLY, so a list that does not line up cannot be
 * trusted at all: `["泡泡玛特"]` against `["600519.SH","09992.HK"]` labels 茅台's
 * series 泡泡玛特, and a `[null]` element renders a column literally headed
 * `"null"`. Neither may reach the model.
 *
 * But a name is a LABEL, not structure — `securityCodeList` already carries
 * identity and every header falls back to the code, so an anomaly here drops the
 * names and keeps the values rather than killing a result whose numbers are all
 * correct. That is a deliberate asymmetry with the other guards in this module:
 * they protect against MISATTRIBUTED VALUES and must be fatal; this one protects
 * a caption, and dropping it loses no information the row does not already
 * carry. It is deliberately not flagged `_partial` either — every value is
 * present and correctly attributed, and a false partial would make the model
 * distrust correct numbers. */
function resolveSecurityNames(names: unknown, codes: string[]): string[] | undefined {
  if (names === undefined || names === null) return undefined
  if (!Array.isArray(names) || names.length !== codes.length) return undefined
  return names.map((name, i) => (typeof name === "string" && name.trim() !== "" ? name : codes[i]))
}

/** The matrix endpoints cannot legitimately answer with a non-object payload, so
 * `null`, an array, or a foreign object is a protocol failure. Checked BEFORE the
 * envelope is discarded, because a `data: null` cannot carry the non-enumerable
 * traceId — passing the envelope as details is the only way such a failure stays
 * traceable. */
export function requireIndicatorMatrix(raw: unknown): Record<string, unknown> {
  const data = unwrapIndicatorData(raw)
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ApiError(
      `Indicator API returned no matrix object (got ${data === null ? "null" : Array.isArray(data) ? "an array" : typeof data}) — the response layout may have changed`,
      undefined,
      undefined,
      raw,
    )
  }
  return data as Record<string, unknown>
}

/** The matrix and its axis labels must agree on BOTH dimensions, or cells are
 * dropped or misread. The 2026-08-01 revision transposed cross-section without a
 * version marker, so a re-transpose has to fail loudly rather than silently
 * relabel columns — with the caveat that this only catches a NON-SQUARE change.
 * A 2×2 or 1×1 matrix keeps its dimensions when transposed and would still be
 * read with the axes swapped; nothing in the payload distinguishes the two.
 *
 * Row length is checked exactly, not leniently: the server pads a row with
 * `null` rather than truncating it (a US security missing 3 of 4 indicators
 * still comes back with a full-length row, and a cross-market time series pads
 * every security to the union of trading days). A short or long row is therefore
 * a structural change, not missing data. */
function assertMatrixShape(data: unknown, values: unknown[], rows: number, rowAxis: string, cols: number, colAxis: string): void {
  if (values.length !== rows) {
    throw new ApiError(
      `Indicator matrix shape mismatch: got ${values.length} value rows for ${rows} ${rowAxis} — the response layout may have changed`,
      undefined,
      undefined,
      data,
    )
  }
  for (const [i, row] of values.entries()) {
    const width = Array.isArray(row) ? row.length : -1
    if (width !== cols) {
      throw new ApiError(
        `Indicator matrix shape mismatch: value row ${i} has ${width < 0 ? "no array of" : String(width)} cells for ${cols} ${colAxis} — the response layout may have changed`,
        undefined,
        undefined,
        data,
      )
    }
  }
}

// Cross-section (and the screener, whose payload is the same shape plus a
// per-indicator `field`): one row per security, one column per indicator.
// `values` is [security][indicator], so security i's value for indicator j is
// values[i][j]. There is no row-level date any more — the query date now lives
// in each indicator's own parameters and may legitimately differ per column.
export function flattenCrossSection(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ApiError(
      `Indicator API returned no matrix object (got ${data === null ? "null" : Array.isArray(data) ? "an array" : typeof data}) — the response layout may have changed`,
      undefined,
      undefined,
      data,
    )
  }
  const d = data as MatrixData
  assertMatrixPayload(data, d)
  // Past this point the payload claims to be a matrix, so every axis it needs
  // must actually be there. A `null` or absent axis is a broken response.
  const securityCode = asIdentityArray(data, d.securityCodeList, "securityCodeList")
  const indicators = asIndicatorMetaList(data, d.indicatorList)
  assertAxis(data, securityCode, "securityCodeList")
  assertAxis(data, indicators, "indicatorList")
  assertValuesPresent(data, d.values)
  assertMatrixShape(data, d.values, securityCode.length, "securities", indicators.length, "indicators")

  const securityName = resolveSecurityNames(d.securityNameList, securityCode)
  const headers = indicatorHeaders(indicators, CROSS_SECTION_COLUMNS)

  const list = securityCode.map((code, i) => {
    // Only create `name` when there IS one: an always-present `name: undefined`
    // is invisible in JSON but renders as a real empty column in a table.
    const row: Record<string, unknown> = securityName ? { security: code, name: securityName[i] } : { security: code }
    const cells = rowOf(d.values, i)
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cells?.[j]
    }
    return row
  })
  return { list, total: list.length }
}

// Time-series: one row per date. Columns are the indicators (single-security
// case) or the securities (single-indicator case) — exactly one dimension
// varies, per the API contract. `values` stays a 2D [series][date] matrix.
//
// Axis rule, in priority order:
//  1. More than one indicator came back → multi-indicator × single-security.
//  2. More than one security came back → single-indicator × multi-security.
//     This is what a sector ID produces: the request carries ONE universe entry
//     and the server expands it into N constituents, so the request count says
//     nothing about the axis.
//  3. Both are 1 → genuinely ambiguous, so fall back to what was REQUESTED:
//     - a universe holding a sector ID always takes the security axis. The
//       sector may expand to one constituent, or the rest may have been dropped
//       for lack of data; either way the caller asked "which securities", and an
//       indicator-named column would erase whose series this is.
//     - otherwise the entry count decides. The server drops securities with no
//       data at all, so a two-security request that comes back with one must
//       still be labelled by security.
export function flattenTimeSeries(data: unknown, requestedUniverse?: string[]): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ApiError(
      `Indicator API returned no matrix object (got ${data === null ? "null" : Array.isArray(data) ? "an array" : typeof data}) — the response layout may have changed`,
      undefined,
      undefined,
      data,
    )
  }
  const d = data as MatrixData
  assertMatrixPayload(data, d)
  const dates = asIdentityArray(data, d.dates, "dates")
  const securityCode = asIdentityArray(data, d.securityCodeList, "securityCodeList")
  const indicators = asIndicatorMetaList(data, d.indicatorList)
  assertAxis(data, dates, "dates")
  assertAxis(data, securityCode, "securityCodeList")
  assertAxis(data, indicators, "indicatorList")
  assertValuesPresent(data, d.values)

  const securityName = resolveSecurityNames(d.securityNameList, securityCode)
  // Data with only one identity axis is unattributable: `securityCodeList: []`
  // alongside a populated matrix leaves every row belonging to no security at
  // all, and the row/column counts still line up so no other guard notices. A
  // response that resolved to nothing empties `dates` too, so dates alongside a missing
  // axis is always a broken response.
  if (dates.length > 0 && (securityCode.length === 0 || indicators.length === 0)) {
    throw new ApiError(
      `Indicator matrix shape mismatch: the time-series response carries ${dates.length} dates but ${securityCode.length} securities and ${indicators.length} indicators — the data could not be attributed`,
      undefined,
      undefined,
      data,
    )
  }
  // The API permits multi-indicator × single-security OR single-indicator ×
  // multi-security, never both — the server rejects such a REQUEST with 100003.
  // A RESPONSE carrying both axes plural is therefore unattributable: whichever
  // axis becomes the columns, the other one's identity is silently discarded,
  // and the request/response diff shows nothing missing so it would not even be
  // flagged partial.
  if (securityCode.length > 1 && indicators.length > 1) {
    throw new ApiError(
      `Indicator matrix shape mismatch: the time-series response carries ${securityCode.length} securities AND ${indicators.length} indicators, which the endpoint does not support — one of the two identities would be lost`,
      undefined,
      undefined,
      data,
    )
  }
  // A universe entry without a `.` is a sector ID — the server expands it, so
  // neither its presence nor the entry count says anything about the axis.
  const requested = requestedUniverse === undefined ? undefined : [...new Set(requestedUniverse)]
  const hasSector = requested?.some((entry) => !entry.includes(".")) ?? false
  const seriesAreIndicators =
    indicators.length > 1 ? true : securityCode.length > 1 ? false : hasSector ? false : (requested?.length ?? securityCode.length) <= 1
  const seriesCount = seriesAreIndicators ? indicators.length : securityCode.length
  assertMatrixShape(data, d.values, seriesCount, seriesAreIndicators ? "indicators" : "securities", dates.length, "dates")
  // Map over securityCode rather than securityNameList directly: a response that
  // omits the names must still yield one header per security (falling back to
  // the code), not zero columns.
  const headers = seriesAreIndicators
    ? indicatorHeaders(indicators, ["date"])
    : buildHeaders(
        securityCode.map((_, i) => securityName?.[i]),
        securityCode,
        ["date"],
      )

  const list = dates.map((date, k) => {
    const row: Record<string, unknown> = { date }
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = rowOf(d.values, i)?.[k]
    }
    return row
  })
  return { list, total: list.length }
}
