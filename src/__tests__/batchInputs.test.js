// V5-INFLIGHTBATCH-001 item A — the pure half of "what went into this batch".
//
// TEST-SHAPE RULES, inherited from PutUpGoingNow.test.jsx / PutUpPhReading.test.jsx and each earned:
//   • FULL LITERALS, both bounds and every separator. `toContain` on a fragment passes on a value ten
//     days wrong — '14 days in drying'.includes('4 days in drying') is true, and this repo shipped
//     exactly that. Every window, net-count and roll-up assertion below is a whole-string equality.
//   • BOTH BOUNDS OF EVERY THRESHOLD. A single value proves a boundary exists, not where it is. The
//     span cap is asserted at 366 (accepted) AND 367 (refused), never at one of them.
//   • FIXED ZONELESS LOCAL DATE LITERALS, never Date.now() offsets. A ms offset is TZ-invariant by
//     construction, so the blocking TZ=America/New_York re-run would have nothing to bite on. NOW is
//     noon local: mid-day in both CI lanes, so the ET civil day is the same string under each.
//   • EVERY ABSENCE ASSERTION PAIRED WITH A POSITIVE ONE OVER THE SAME SUBJECT. A sweep over the
//     wrong value passes for the wrong reason.
//   • TWO FIXTURE SIZES. PREDICATE_139 (the measured pepper fan-in) and PREDICATE_12 beside it — one
//     count is a spot-check, and "139 assumed, 12 met" is the failure the pair exists to catch.
//
// CI LANE: `npm test` plus the blocking TZ re-run. No database — every assertion bites on logic or
// on what the client SENDS.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KITCHEN_INPUT_KINDS, KITCHEN_QTY_UNITS, INPUT_KIND_LABELS, INPUT_KIND_FALLBACK,
  PREDICATE_MAX_SPAN_DAYS, PREDICATE_ERRORS, EXPLICIT_ERRORS, WEIGHT_UNITS, TOTAL_WEIGHT_LABEL,
  WHOLE_PICK_NOTICE, ALL_TIME_REFUSAL, INSERT_NONE_NEW, INSERT_UNKNOWN,
  foreignHarvestError, labelNeededError, spanError,
  isRealDate, spanDays, chipToWindow, describeWindow, predicateBody, explicitInputsBody,
  weightInputRow, readPreview, netCountLine, summariseInsert, summariseTrueCount,
  describeInputRow, rollUpGrams, describeRollUp, toggleDecision, committedIds, skippedCount,
  inputsDraftKey,
} from '../components/putup/batchInputs.js'

// Noon LOCAL on a fixed day, not an offset from the wall clock. Under TZ=UTC this is 12:00Z and
// under TZ=America/New_York it is 16:00Z; both land at mid-day ET on 2026-09-04, so every day key
// derived from it is the same string in both blocking lanes.
const NOW = new Date('2026-09-04T12:00:00').getTime()

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
// Shaped like the wire, which means STRINGS: @neondatabase/serverless returns numeric and int8 as
// text, so a fixture carrying JS numbers would be testing a response this app never receives.
// `quantity: '1'` rides along deliberately — it is what makes a roll-up that reads `quantity`
// instead of `weight_grams` produce a plausible WRONG number rather than a NaN, which is the only
// way the mutation on that line can be caught by a value assertion.
const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const mkRow = (i) => ({
  id: uuid(i),
  harvest_log_id: uuid(i),
  quantity: '1',
  unit: 'count',
  weight_grams: String(20 + (i % 5) * 5),
  // 1 in 3 estimated from a cultivar sample — prod measures 31% of all harvest weights that way
  // (measured 841 / cultivar_sample 262 / cultivar 108 of 1212).
  weight_basis: i % 3 === 0 ? 'cultivar_sample' : 'measured',
})
const PREDICATE_139 = Array.from({ length: 139 }, (_, i) => mkRow(i + 1))
const PREDICATE_12 = Array.from({ length: 12 }, (_, i) => mkRow(i + 1))

describe('the fixtures are the two sizes the design argues about', () => {
  it('139 and 12, and both carry a quantity so a quantity-summing mutation is catchable', () => {
    expect(PREDICATE_139).toHaveLength(139)
    expect(PREDICATE_12).toHaveLength(12)
    expect(PREDICATE_139.every((r) => r.quantity === '1')).toBe(true)
    expect(PREDICATE_139.every((r) => typeof r.weight_grams === 'string')).toBe(true)
  })
})

// ── the vocabularies are pinned to the schema, not to a memory of it ─────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../..')
const DDL = readFileSync(resolve(REPO, 'migrations/v5-inflightbatch-001/0a-additive-ddl.sql'), 'utf8')
const LAMBDA = readFileSync(resolve(REPO, 'lambda/preservation/kitchenBatch.js'), 'utf8')

function ddlArray(constraintName) {
  const at = DDL.indexOf(`CONSTRAINT ${constraintName} CHECK`)
  expect(at, `no CONSTRAINT ${constraintName} in the migration`).toBeGreaterThan(-1)
  const open = DDL.indexOf('ARRAY[', at)
  const close = DDL.indexOf(']', open)
  return [...DDL.slice(open, close).matchAll(/'([^']*)'/g)].map((m) => m[1])
}
function lambdaArray(name) {
  const at = LAMBDA.indexOf(`export const ${name} = [`)
  expect(at, `no export const ${name} in kitchenBatch.js`).toBeGreaterThan(-1)
  const close = LAMBDA.indexOf('];', at)
  return [...LAMBDA.slice(at, close).matchAll(/'([^']*)'/g)].map((m) => m[1])
}

describe('the client mirrors are pinned in BOTH directions', () => {
  // A mirror that nothing checks is a second source of truth. These bind the client copy to the
  // Lambda copy AND to the DDL CHECK, so a value added in one place and not the others goes red
  // here rather than reaching a 23514 in prod or becoming silently unreachable.
  it('input_kind matches the migration', () => {
    expect(KITCHEN_INPUT_KINDS).toEqual(ddlArray('chk_kbi_kind'))
  })
  it('input_kind matches the Lambda', () => {
    expect(KITCHEN_INPUT_KINDS).toEqual(lambdaArray('KITCHEN_INPUT_KINDS'))
  })
  it('qty_unit matches the migration', () => {
    expect(KITCHEN_QTY_UNITS).toEqual(ddlArray('chk_kbi_qty_unit'))
  })
  it('qty_unit matches the Lambda, space in "fl oz" and all', () => {
    expect(KITCHEN_QTY_UNITS).toEqual(lambdaArray('KITCHEN_QTY_UNITS'))
    expect(KITCHEN_QTY_UNITS).toContain('fl oz')
  })
  it('the extraction helpers are not vacuous', () => {
    // Non-vacuity: both readers must actually find something and must actually disagree with a
    // wrong list. Four green equalities above prove nothing if either helper returns [].
    expect(ddlArray('chk_kbi_kind').length).toBeGreaterThan(0)
    expect(lambdaArray('KITCHEN_QTY_UNITS').length).toBe(14)
    expect(ddlArray('chk_kbi_kind')).not.toEqual(['harvest'])
  })
  it('every weight unit offered is a unit the CHECK allows', () => {
    for (const u of WEIGHT_UNITS) expect(KITCHEN_QTY_UNITS).toContain(u)
    // The other direction, as a control: the CHECK is WIDER than this list, so a test that merely
    // proved containment either way would pass on a bug that offered 'count' as a weight.
    expect(WEIGHT_UNITS).not.toContain('count')
    expect(KITCHEN_QTY_UNITS).toContain('count')
  })
  it('the kind label table is total, and its fallback is prose rather than the slug', () => {
    for (const k of KITCHEN_INPUT_KINDS) {
      expect(INPUT_KIND_LABELS[k], `no label for ${k}`).toBeTruthy()
      expect(INPUT_KIND_LABELS[k]).not.toBe(k)
    }
    expect(INPUT_KIND_FALLBACK).not.toMatch(/harvest|purchased|pantry|^other$/)
    // Green control: the table really does answer for a known kind, so the assertions above are
    // about totality and not about an empty object.
    expect(INPUT_KIND_LABELS.harvest).toBe('A pick from the garden')
  })
})

// ── dates ────────────────────────────────────────────────────────────────────────────────────────

describe('isRealDate — shape is not validity, and the difference is a 500', () => {
  it('accepts real dates', () => {
    expect(isRealDate('2026-09-04')).toBe(true)
    expect(isRealDate('2024-02-29')).toBe(true)
    expect(isRealDate('2026-07-28')).toBe(true)
  })
  it('refuses the shape-valid impossibles the server would 500 on', () => {
    // The server's DATE_RE is /^\d{4}-\d{2}-\d{2}$/ and nothing more, so each of these passes it,
    // reaches ::date in Postgres and falls out of the handler as 500 Internal server error.
    expect(isRealDate('2026-99-99')).toBe(false)
    expect(isRealDate('2026-02-30')).toBe(false)
    expect(isRealDate('2026-13-01')).toBe(false)
    expect(isRealDate('2025-02-29')).toBe(false)
    expect(isRealDate('2026-04-31')).toBe(false)
  })
  it('refuses junk that is not even the shape', () => {
    expect(isRealDate('')).toBe(false)
    expect(isRealDate(null)).toBe(false)
    expect(isRealDate('2026-9-4')).toBe(false)
    expect(isRealDate('20260904')).toBe(false)
  })
})

describe('spanDays — inclusive, both ends, the way BETWEEN is', () => {
  it('one day is one, not zero', () => expect(spanDays('2026-09-04', '2026-09-04')).toBe(1))
  it('the measured pepper window is 36 days', () =>
    expect(spanDays('2026-07-28', '2026-09-01')).toBe(36))
  it('a whole grow-year is 365, and a leap one is 366', () => {
    expect(spanDays('2025-11-01', '2026-10-31')).toBe(365)
    expect(spanDays('2023-11-01', '2024-10-31')).toBe(366)
  })
  it('is null rather than NaN on junk', () => expect(spanDays('2026-99-99', '2026-09-04')).toBeNull())
})

describe('chipToWindow — the chip vocabulary, mapped to civil ET dates', () => {
  it('today', () => expect(chipToWindow('today', NOW)).toEqual({ from: '2026-09-04', to: '2026-09-04' }))
  it('yesterday', () =>
    expect(chipToWindow('yesterday', NOW)).toEqual({ from: '2026-09-03', to: '2026-09-03' }))
  it('7d is SEVEN days inclusive of today — today minus six, not minus seven', () =>
    expect(chipToWindow('7d', NOW)).toEqual({ from: '2026-08-29', to: '2026-09-04' }))
  it('month runs from the 1st through today', () =>
    expect(chipToWindow('month', NOW)).toEqual({ from: '2026-09-01', to: '2026-09-04' }))
  it('a season is Nov 1 through Oct 31, inclusive — the half-open span closed at its last day', () =>
    expect(chipToWindow('season:2026', NOW)).toEqual({ from: '2025-11-01', to: '2026-10-31' }))
  it('an older season resolves the same way', () =>
    expect(chipToWindow('season:2024', NOW)).toEqual({ from: '2023-11-01', to: '2024-10-31' }))

  it('ALL TIME has no window, and that is the guard rather than an oversight', () => {
    // {from:'2000-01-01', to:'2099-12-31'} is a legal predicate that inserts every household harvest
    // in one statement. The unbounded chip must be refused, not widened.
    expect(chipToWindow('', NOW)).toBeNull()
    // Green control on the same call shape: a chip that DOES name a window returns one, so the null
    // above is about "All time" and not about chipToWindow being broken.
    expect(chipToWindow('today', NOW)).not.toBeNull()
  })
  it('junk is null, never a silent all-time', () => {
    expect(chipToWindow('season:26', NOW)).toBeNull()
    expect(chipToWindow('last-fortnight', NOW)).toBeNull()
    expect(chipToWindow(null, NOW)).toBeNull()
    expect(chipToWindow('7d', Number.NaN)).toBeNull()
  })
  it('no chip can produce a window wider than the cap', () => {
    for (const c of ['today', 'yesterday', '7d', 'month', 'season:2026', 'season:2024']) {
      const w = chipToWindow(c, NOW)
      expect(spanDays(w.from, w.to), `${c} is over the cap`).toBeLessThanOrEqual(PREDICATE_MAX_SPAN_DAYS)
    }
    // …and the cap is not merely large: the widest chip window is exactly at it, so the number is
    // derived from the vocabulary rather than picked to be safe.
    expect(spanDays('2023-11-01', '2024-10-31')).toBe(PREDICATE_MAX_SPAN_DAYS)
  })
})

describe('describeWindow — both bounds and the separator, always', () => {
  it('renders the full literal', () =>
    expect(describeWindow({ from: '2026-07-28', to: '2026-09-01' })).toBe('from 2026-07-28 through 2026-09-01'))
  it('says so when it is one day', () =>
    expect(describeWindow({ from: '2026-09-04', to: '2026-09-04' })).toBe('on 2026-09-04'))
  it('is null on an unusable window', () => {
    expect(describeWindow(null)).toBeNull()
    expect(describeWindow({ from: '2026-99-99', to: '2026-09-01' })).toBeNull()
    // Green control: a usable window on the same call is not null.
    expect(describeWindow({ from: '2026-09-01', to: '2026-09-04' })).toBe('from 2026-09-01 through 2026-09-04')
  })
})

// ── the predicate body ───────────────────────────────────────────────────────────────────────────

describe('predicateBody', () => {
  const W = { from: '2026-07-28', to: '2026-09-01' }

  it('sends from and to and nothing else when nothing is narrowed', () => {
    const { error, body } = predicateBody({ ...W })
    expect(error).toBeNull()
    expect(body).toEqual({ predicate: { from: '2026-07-28', to: '2026-09-01' } })
  })
  it('NEVER carries an inputs key, not even null — hasOwnProperty is the form selector', () => {
    const { body } = predicateBody({ ...W })
    // {"inputs": null, "predicate": {...}} counts as BOTH forms present and 400s.
    expect(Object.prototype.hasOwnProperty.call(body, 'inputs')).toBe(false)
    // Green control on the same object: the key it IS supposed to carry is present.
    expect(Object.prototype.hasOwnProperty.call(body, 'predicate')).toBe(true)
  })
  it('never carries variety_id — variety and planting are the same axis in this data', () => {
    const { body } = predicateBody({ ...W, plantingId: uuid(7) })
    expect(Object.prototype.hasOwnProperty.call(body.predicate, 'variety_id')).toBe(false)
    expect(body.predicate.plant_id).toBe(uuid(7))
  })
  it('carries crop_type_slug and plant_id only when they are set', () => {
    expect(predicateBody({ ...W, cropSlug: 'pepper' }).body)
      .toEqual({ predicate: { from: '2026-07-28', to: '2026-09-01', crop_type_slug: 'pepper' } })
    expect(predicateBody({ ...W, cropSlug: '   ' }).body)
      .toEqual({ predicate: { from: '2026-07-28', to: '2026-09-01' } })
  })
  it('adds preview:true only on the dry run', () => {
    expect(predicateBody({ ...W, preview: true }).body)
      .toEqual({ predicate: { from: '2026-07-28', to: '2026-09-01' }, preview: true })
    // The paired positive: the same call without the flag omits the KEY, not just the value.
    expect(Object.prototype.hasOwnProperty.call(predicateBody({ ...W }).body, 'preview')).toBe(false)
  })
  it('refuses a shape-valid impossible date rather than letting it 500', () => {
    expect(predicateBody({ from: '2026-99-99', to: '2026-09-01' }).error).toBe(PREDICATE_ERRORS.from)
    expect(predicateBody({ from: '2026-07-28', to: '2026-02-30' }).error).toBe(PREDICATE_ERRORS.to)
    expect(predicateBody({ from: '2026-99-99', to: '2026-09-01' }).body).toBeNull()
  })
  it('refuses a reversed window', () => {
    expect(predicateBody({ from: '2026-09-01', to: '2026-07-28' }).error).toBe(PREDICATE_ERRORS.order)
  })
  it('refuses a plant_id that is not a uuid', () => {
    expect(predicateBody({ ...W, plantingId: 'Chilly Chill' }).error).toBe(PREDICATE_ERRORS.planting)
  })
  it('asks for a window when neither end is given', () => {
    expect(predicateBody({}).error).toBe(PREDICATE_ERRORS.window)
  })

  // BOTH BOUNDS of the span cap. One of these alone proves a boundary exists, not where it is.
  it('accepts a window exactly at the cap — 366 days', () => {
    const at = predicateBody({ from: '2023-11-01', to: '2024-10-31' })
    expect(spanDays('2023-11-01', '2024-10-31')).toBe(366)
    expect(at.error).toBeNull()
    expect(at.body.predicate).toEqual({ from: '2023-11-01', to: '2024-10-31' })
  })
  it('refuses a window one day over the cap — 367 days', () => {
    const over = predicateBody({ from: '2023-10-31', to: '2024-10-31' })
    expect(spanDays('2023-10-31', '2024-10-31')).toBe(367)
    expect(over.body).toBeNull()
    expect(over.error).toBe('That window is 367 days. Pick a window of 366 days or less.')
  })
  it('refuses the sweep-everything window the route accepts today', () => {
    const all = predicateBody({ from: '2000-01-01', to: '2099-12-31' })
    expect(all.body).toBeNull()
    expect(all.error).toBe(spanError(36525))
  })
})

// ── the explicit body ────────────────────────────────────────────────────────────────────────────

describe('explicitInputsBody', () => {
  it('builds a harvest row', () => {
    const { error, body } = explicitInputsBody([{ input_kind: 'harvest', harvest_log_id: uuid(3) }])
    expect(error).toBeNull()
    expect(body).toEqual({ inputs: [{ input_kind: 'harvest', harvest_log_id: uuid(3) }] })
  })
  it('builds a non-harvest row with a label and a paired quantity', () => {
    const { body } = explicitInputsBody([
      { input_kind: 'pantry', label: '  Kosher salt ', qty: '2', qty_unit: 'cup' },
    ])
    expect(body).toEqual({ inputs: [{ input_kind: 'pantry', label: 'Kosher salt', qty: 2, qty_unit: 'cup' }] })
  })
  it('refuses an empty list without a round trip', () => {
    expect(explicitInputsBody([]).error).toBe(EXPLICIT_ERRORS.empty)
    expect(explicitInputsBody(null).error).toBe(EXPLICIT_ERRORS.empty)
  })
  it('enforces the harvest biconditional in BOTH directions', () => {
    expect(explicitInputsBody([{ input_kind: 'harvest' }]).error).toBe(EXPLICIT_ERRORS.harvestNeeded)
    expect(explicitInputsBody([{ input_kind: 'pantry', label: 'Salt', harvest_log_id: uuid(1) }]).error)
      .toBe(foreignHarvestError('pantry'))
  })
  it('checks the harvest id is a uuid before it checks the pairing, as the Lambda does', () => {
    expect(explicitInputsBody([{ input_kind: 'harvest', harvest_log_id: 'not-a-uuid' }]).error)
      .toBe(EXPLICIT_ERRORS.harvestUuid)
  })
  it('requires a label on a non-harvest row, in the Lambda words', () => {
    expect(explicitInputsBody([{ input_kind: 'other', label: '   ' }]).error)
      .toBe(labelNeededError('other'))
    expect(LAMBDA).toContain('needs a label — name what went in')
  })
  it('treats a blank quantity as absent, not as zero', () => {
    // '' would pair-check as present and coerce to 0, which the server rejects. Both halves have to
    // collapse together — a NULL pair means "the whole thing", never zero.
    const { error, body } = explicitInputsBody([{ input_kind: 'other', label: 'Vinegar', qty: '', qty_unit: '' }])
    expect(error).toBeNull()
    expect(body.inputs[0]).toEqual({ input_kind: 'other', label: 'Vinegar' })
  })
  it('refuses a half-set quantity pair, in either direction', () => {
    expect(explicitInputsBody([{ input_kind: 'other', label: 'X', qty: '2' }]).error)
      .toBe(EXPLICIT_ERRORS.qtyPairing)
    expect(explicitInputsBody([{ input_kind: 'other', label: 'X', qty_unit: 'cup' }]).error)
      .toBe(EXPLICIT_ERRORS.qtyPairing)
  })
  it('refuses a non-positive quantity and an unknown unit', () => {
    expect(explicitInputsBody([{ input_kind: 'other', label: 'X', qty: '0', qty_unit: 'cup' }]).error)
      .toBe(EXPLICIT_ERRORS.qtyPositive)
    expect(explicitInputsBody([{ input_kind: 'other', label: 'X', qty: '2', qty_unit: 'quarts' }]).error)
      .toBe(EXPLICIT_ERRORS.qtyUnit)
    // 'quarts' is not arbitrary: it is a live preservation_log.quantity_unit value in prod, and
    // chk_kbi_qty_unit does not allow it. Copying a jar's unit into a batch input is a real path.
  })
  it('is_byproduct is a strict identity test — "true" is not true', () => {
    const strict = explicitInputsBody([{ input_kind: 'harvest', harvest_log_id: uuid(1), is_byproduct: true }])
    expect(strict.body.inputs[0].is_byproduct).toBe(true)
    const stringy = explicitInputsBody([{ input_kind: 'harvest', harvest_log_id: uuid(1), is_byproduct: 'true' }])
    expect(Object.prototype.hasOwnProperty.call(stringy.body.inputs[0], 'is_byproduct')).toBe(false)
  })
  it('refuses is_byproduct on a non-harvest row', () => {
    expect(explicitInputsBody([{ input_kind: 'pantry', label: 'Salt', is_byproduct: true }]).error)
      .toBe(EXPLICIT_ERRORS.byproduct)
  })
  it('refuses an unknown kind', () => {
    expect(explicitInputsBody([{ input_kind: 'foraged', label: 'Ramps' }]).error).toBe(EXPLICIT_ERRORS.kind)
  })
  it('de-dupes harvest rows the way the server will, so the count reported is the count sent', () => {
    const { body } = explicitInputsBody([
      { input_kind: 'harvest', harvest_log_id: uuid(1) },
      { input_kind: 'harvest', harvest_log_id: uuid(1) },
      { input_kind: 'harvest', harvest_log_id: uuid(2) },
    ])
    expect(body.inputs).toHaveLength(2)
    expect(body.inputs.map((r) => r.harvest_log_id)).toEqual([uuid(1), uuid(2)])
  })
  it('does NOT de-dupe non-harvest rows, because the partial index does not cover them', () => {
    const { body } = explicitInputsBody([
      { input_kind: 'pantry', label: 'Salt' },
      { input_kind: 'pantry', label: 'Salt' },
    ])
    expect(body.inputs).toHaveLength(2)
  })
  it('carries a subset of a 139-row match without loss', () => {
    const keep = PREDICATE_139.slice(0, 12).map((r) => ({ input_kind: 'harvest', harvest_log_id: r.harvest_log_id }))
    const { error, body } = explicitInputsBody(keep)
    expect(error).toBeNull()
    expect(body.inputs).toHaveLength(12)
  })
})

describe('weightInputRow — the number the cook actually holds', () => {
  it('is an "other" row with a label, because the biconditional forbids anything else', () => {
    expect(weightInputRow({ amount: '11', unit: 'lb' }))
      .toEqual({ input_kind: 'other', label: TOTAL_WEIGHT_LABEL, qty: 11, qty_unit: 'lb' })
  })
  it('round-trips through the explicit validator', () => {
    const { error, body } = explicitInputsBody([weightInputRow({ amount: '4.33', unit: 'kg' })])
    expect(error).toBeNull()
    expect(body.inputs[0].qty).toBe(4.33)
  })
  it('is null on a blank, a zero or a unit that is not a weight', () => {
    expect(weightInputRow({ amount: '', unit: 'lb' })).toBeNull()
    expect(weightInputRow({ amount: '0', unit: 'lb' })).toBeNull()
    expect(weightInputRow({ amount: '3', unit: 'count' })).toBeNull()
    // Green control on the same shape: a real weight is not null.
    expect(weightInputRow({ amount: '3', unit: 'lb' })).not.toBeNull()
  })
})

// ── reading the response ─────────────────────────────────────────────────────────────────────────

describe('readPreview — defensive across both shapes the dry-run arm may land in', () => {
  it('reads a bare count', () => {
    expect(readPreview({ matched: 139, predicate: { from: 'a', to: 'b' } }))
      .toEqual({ matched: 139, rows: null, predicate: { from: 'a', to: 'b' } })
  })
  it('reads a count that arrived as a string', () => {
    expect(readPreview({ matched: '139' }).matched).toBe(139)
  })
  it('reads rows and counts them', () => {
    const r = readPreview({ matched: PREDICATE_139 })
    expect(r.matched).toBe(139)
    expect(r.rows).toHaveLength(139)
  })
  it('is null on an unreadable body — never a silent zero', () => {
    // A preview that reports 0 when it failed to parse would invite the user to widen a window that
    // already matched what they wanted. Absence of an answer is not an answer of none.
    expect(readPreview(null)).toBeNull()
    expect(readPreview({})).toBeNull()
    expect(readPreview({ matched: 'lots' })).toBeNull()
    expect(readPreview({ matched: -1 })).toBeNull()
    // Green control: the same reader does return a zero when the server actually says zero.
    expect(readPreview({ matched: 0 })).toEqual({ matched: 0, rows: null, predicate: null })
  })
})

describe('netCountLine — ScopeChecklist\'s contract, separators included', () => {
  it('is the full literal, with U+2212 and U+2192, for the 139 fixture', () => {
    expect(netCountLine({ matched: 139, skipped: 0 })).toBe('139 matched − 0 skipped → 139 will be added')
  })
  it('is the full literal for the 12 fixture, with rows skipped', () => {
    expect(netCountLine({ matched: 12, skipped: 5 })).toBe('12 matched − 5 skipped → 7 will be added')
  })
  it('uses a MINUS SIGN and a RIGHTWARDS ARROW, not a hyphen and not an ascii arrow', () => {
    const line = netCountLine({ matched: 139, skipped: 7 })
    expect(line).toContain('−')
    expect(line).toContain('→')
    expect(line).not.toContain('->')
    // Paired positive over the same string: it really is the line, so the absences above are about
    // the separators and not about netCountLine returning something else entirely.
    expect(line).toBe('139 matched − 7 skipped → 132 will be added')
  })
  it('never goes negative', () => {
    expect(netCountLine({ matched: 3, skipped: 9 })).toBe('3 matched − 9 skipped → 0 will be added')
  })
  it('is null on unreadable counts', () => {
    expect(netCountLine({ matched: null, skipped: 0 })).toBeNull()
    expect(netCountLine({})).toBeNull()
  })
})

describe('summariseInsert — the honest zero', () => {
  it('0 means "already here", never "nothing happened"', () => {
    // ON CONFLICT DO NOTHING makes a re-run safe but silent. "Nothing was added" would send the user
    // straight back to add them again.
    expect(summariseInsert({ inserted: 0 })).toBe(INSERT_NONE_NEW)
    expect(INSERT_NONE_NEW).toBe('Nothing new — every one of those picks was already in this batch.')
    expect(INSERT_NONE_NEW).not.toMatch(/nothing was added|no picks were added/i)
  })
  it('counts, and pluralises', () => {
    expect(summariseInsert({ inserted: 139 })).toBe('139 picks added.')
    expect(summariseInsert({ inserted: 12 })).toBe('12 picks added.')
    expect(summariseInsert({ inserted: 1 })).toBe('1 pick added.')
  })
  it('reads a count that arrived as a string', () => {
    expect(summariseInsert({ inserted: '139' })).toBe('139 picks added.')
  })
  it('says so when the count is unreadable, rather than claiming zero', () => {
    expect(summariseInsert({})).toBe(INSERT_UNKNOWN)
    expect(summariseInsert({ inserted: 'many' })).toBe(INSERT_UNKNOWN)
    expect(INSERT_UNKNOWN).not.toBe(INSERT_NONE_NEW)
  })
})

describe('summariseTrueCount — a retry after a dropped response lies, so report a total', () => {
  it('names the total from GET /:id, never a delta', () => {
    expect(summariseTrueCount({ total: 139 }))
      .toBe('That did not come back cleanly. Some may have gone in anyway — this batch now holds 139 inputs.')
    expect(summariseTrueCount({ total: 1 }))
      .toBe('That did not come back cleanly. Some may have gone in anyway — this batch now holds 1 input.')
  })
  it('is null when the re-read itself failed, so the caller can say something else', () => {
    expect(summariseTrueCount({ total: null })).toBeNull()
    expect(summariseTrueCount({})).toBeNull()
    // Green control: with a total it is not null.
    expect(summariseTrueCount({ total: 0 })).not.toBeNull()
  })
})

describe('describeInputRow — what GET /:id can honestly say', () => {
  it('a predicate-created row claims the WHOLE pick, because a NULL qty pair means exactly that', () => {
    expect(describeInputRow({
      input_kind: 'harvest', harvest_log_id: uuid(1), label: null, qty: null, qty_unit: null,
    })).toBe('A pick from the garden — the whole pick')
  })
  it('a measured row names its amount', () => {
    expect(describeInputRow({ input_kind: 'pantry', label: 'Kosher salt', qty: '2', qty_unit: 'cup' }))
      .toBe('Kosher salt — 2 cup')
  })
  it('reads qty as the STRING the wire delivers, without === across the boundary', () => {
    expect(describeInputRow({ input_kind: 'other', label: 'Vinegar', qty: '0.5', qty_unit: 'l' }))
      .toBe('Vinegar — 0.5 l')
  })
  it('marks a byproduct so a roll-up is not read as double-counting', () => {
    expect(describeInputRow({ input_kind: 'harvest', harvest_log_id: uuid(1), is_byproduct: true }))
      .toBe('A pick from the garden — the whole pick · trimmings, counted elsewhere')
  })
  it('never renders the raw kind slug, even for a kind it does not know', () => {
    const line = describeInputRow({ input_kind: 'foraged' })
    expect(line).toBe('Something that went in — the whole pick')
    expect(line).not.toMatch(/foraged/)
    // Green control on the same function: a KNOWN kind does render its own label, so the absence
    // above is about the fallback and not about describeInputRow ignoring input_kind.
    expect(describeInputRow({ input_kind: 'purchased' })).toBe('Something bought — the whole pick')
  })
})

// ── roll-ups ─────────────────────────────────────────────────────────────────────────────────────

describe('rollUpGrams — weight_grams, never quantity', () => {
  it('sums the 139 fixture in grams', () => {
    const r = rollUpGrams(PREDICATE_139)
    expect(r.rows).toBe(139)
    expect(r.grams).toBe(4180)
    // The number a quantity-summing implementation would produce, asserted as an inequality so the
    // mutation on that line cannot pass by coincidence. Every fixture row is unit='count' with
    // quantity '1' — exactly the prod shape, where all 152 live pepper rows are counts.
    expect(r.grams).not.toBe(139)
  })
  it('sums the 12 fixture in grams', () => {
    const r = rollUpGrams(PREDICATE_12)
    expect(r.rows).toBe(12)
    expect(r.grams).toBe(355)
    expect(r.grams).not.toBe(12)
  })
  it('separates measured weights from cultivar-estimated ones', () => {
    const r = rollUpGrams(PREDICATE_139)
    expect(r.weighed).toBe(93)
    expect(r.estimated).toBe(46)
    expect(r.weighed + r.estimated).toBe(139)
  })
  it('counts rows with no weight instead of treating them as zero', () => {
    const r = rollUpGrams([{ weight_grams: '100', weight_basis: 'measured' }, { weight_grams: null }])
    expect(r).toEqual({ grams: 100, weighed: 1, estimated: 0, missing: 1, rows: 2 })
  })
  it('is null on an empty set — "nothing to weigh" is not "weighs nothing"', () => {
    expect(rollUpGrams([])).toBeNull()
    expect(rollUpGrams(null)).toBeNull()
    // Green control: a non-empty set is not null.
    expect(rollUpGrams(PREDICATE_12)).not.toBeNull()
  })
})

describe('describeRollUp — a partly-estimated total has to say so', () => {
  it('names the kilograms and both counts, as a full literal', () => {
    expect(describeRollUp(rollUpGrams(PREDICATE_139)))
      .toBe('About 4.18 kg in total — 46 of 139 weights are estimated from a cultivar sample, not weighed.')
  })
  it('does the same for the 12-row match', () => {
    expect(describeRollUp(rollUpGrams(PREDICATE_12)))
      .toBe('About 0.35 kg in total — 4 of 12 weights are estimated from a cultivar sample, not weighed.')
  })
  it('says every weight was measured when that is true', () => {
    expect(describeRollUp(rollUpGrams([
      { weight_grams: '500', weight_basis: 'measured' }, { weight_grams: '250', weight_basis: 'measured' },
    ]))).toBe('About 0.75 kg in total — every weight was measured.')
  })
  it('names rows carrying no weight at all', () => {
    expect(describeRollUp(rollUpGrams([
      { weight_grams: '500', weight_basis: 'measured' }, { weight_grams: null },
    ]))).toBe('About 0.50 kg in total — 1 of 2 carry no weight at all and are not in this figure.')
  })
  it('is null when there is nothing to describe', () => {
    expect(describeRollUp(null)).toBeNull()
  })
})

// ── the decision map ─────────────────────────────────────────────────────────────────────────────

describe('the per-row decisions Map is durable, which the excluded Set was not', () => {
  const ids = PREDICATE_12.map((r) => r.harvest_log_id)

  it('everything is in by default', () => {
    expect(committedIds(ids, new Map())).toHaveLength(12)
    expect(skippedCount(ids, new Map())).toBe(0)
  })
  it('a toggle removes exactly one', () => {
    const d = toggleDecision(new Map(), ids[3])
    expect(committedIds(ids, d)).toHaveLength(11)
    expect(committedIds(ids, d)).not.toContain(ids[3])
    expect(skippedCount(ids, d)).toBe(1)
  })
  it('a second toggle puts it back', () => {
    const d = toggleDecision(toggleDecision(new Map(), ids[3]), ids[3])
    expect(committedIds(ids, d)).toHaveLength(12)
  })
  it('SURVIVES A RE-PREVIEW, including for an id that left the match set and came back', () => {
    // This is the whole reason the model is a Map and not an excluded Set: ScopeChecklist.jsx
    // records that the Set model was a shipped defect because any re-preview destroyed it. The Map
    // deliberately keeps decisions about ids that are not currently on screen.
    const d = toggleDecision(new Map(), ids[3])
    const narrowed = ids.slice(0, 2)                       // re-preview: ids[3] is no longer matched
    expect(committedIds(narrowed, d)).toEqual(narrowed)    // the decision is inert while out of scope
    expect(committedIds(ids, d)).not.toContain(ids[3])     // and intact when it returns
  })
  it('does not mutate the Map it was handed', () => {
    const before = new Map()
    toggleDecision(before, ids[0])
    expect(before.size).toBe(0)
  })
  it('is counted from the resolved rows, never from the Map size', () => {
    // BUG-PHOTOSELSTALE-001: a bar that read `selected.size` while the button posted the resolved
    // list showed one number and did another thing. Here the Map holds four decisions about ids
    // that are not in the match set at all, and the counts must ignore every one of them.
    let d = new Map()
    for (const ghost of ['ghost-a', 'ghost-b', 'ghost-c', 'ghost-d']) d = toggleDecision(d, ghost)
    expect(d.size).toBe(4)
    expect(committedIds(ids, d)).toHaveLength(12)
    expect(skippedCount(ids, d)).toBe(0)
  })
  it('handles a non-Map defensively rather than throwing', () => {
    expect(committedIds(ids, null)).toHaveLength(12)
    expect(committedIds(null, new Map())).toEqual([])
  })
})

describe('inputsDraftKey', () => {
  it('is per batch, so two open batches cannot restore each other\'s half-entered predicate', () => {
    expect(inputsDraftKey('b1')).toBe('putup.batch.b1.inputs')
    expect(inputsDraftKey('b1')).not.toBe(inputsDraftKey('b2'))
  })
})

// ── the copy sits on the right side of the eight inherited rulings ───────────────────────────────

describe('the module\'s copy carries no readiness, no verdict and no shelf claim', () => {
  const COPY = [WHOLE_PICK_NOTICE, ALL_TIME_REFUSAL, INSERT_NONE_NEW, INSERT_UNKNOWN,
    summariseTrueCount({ total: 139 }), describeRollUp(rollUpGrams(PREDICATE_139)),
    ...Object.values(PREDICATE_ERRORS), ...Object.values(INPUT_KIND_LABELS), INPUT_KIND_FALLBACK]

  it('every string is non-empty — the control that makes the sweeps below mean something', () => {
    expect(COPY).toHaveLength(16)
    for (const s of COPY) expect(typeof s === 'string' && s.length > 0).toBe(true)
  })
  it('names no readiness, no due date and no remaining time', () => {
    for (const s of COPY) expect(s).not.toMatch(/\bdue\b|\bremaining\b|\boverdue\b|\bready\b|\bdays left\b|\blate\b/i)
    // Paired positive over the same regex: it does match the thing it is written to catch, so the
    // 19 green rows above are not a regex that can never fire.
    expect('3 days left').toMatch(/\bdue\b|\bremaining\b|\boverdue\b|\bready\b|\bdays left\b|\blate\b/i)
  })
  it('says nothing about acidification, safety, shelf stability or spoilage', () => {
    for (const s of COPY) expect(s).not.toMatch(/acidif|shelf.stab|\bsafe\b|\bsafety\b|botul|spoil/i)
    expect('shelf stable at pH 4.6').toMatch(/acidif|shelf.stab|\bsafe\b|\bsafety\b|botul|spoil/i)
  })
  it('carries no acid line in any of the spellings the evidence base circulates', () => {
    const acid = /(?<![\d.])(4\.60|4\.6|4\.4|4\.2|4\.1|4\.0|3\.8|3\.3|5\.0)(?!\d)(?!\.\d)/
    for (const s of COPY) expect(s).not.toMatch(acid)
    expect('a drop below 4.6').toMatch(acid)
  })
  it('states the whole-pick claim explicitly, because nothing else in the system will', () => {
    expect(WHOLE_PICK_NOTICE).toContain('counts each one in full')
    expect(WHOLE_PICK_NOTICE).toContain('claims the whole thing')
  })
})
