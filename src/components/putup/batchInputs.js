// src/components/putup/batchInputs.js
// V5-INFLIGHTBATCH-001 item A — the pure half of "what went into this batch".
//
// Seam rule (BUILD-CONTRACT §3): anything that DECIDES lives here, anything that PAINTS lives in
// BatchInputsField.jsx. Every function below is a pure function of its arguments plus an explicit
// `nowMs` — there is no clock, no fetch and no DOM in this file, which is what lets the window
// arithmetic be asserted against fixed zoneless date literals instead of against whenever CI ran.
//
// THE RULINGS THIS FILE ENFORCES. Read the absences as hard as the presences:
//
//   1. THE WINDOW IS THE CHIP VOCABULARY, NOT A RANGE PICKER. `chipToWindow` maps
//      HarvestTimeframeChips' six values to the civil-ET {from,to} the server's predicate takes.
//      There is no two-ended range control in this app and none is minted here:
//      `src/lib/harvestExport.js:19-21` carries the standing ruling — "arbitrary from/to needs a
//      Lambda parseTimeframe change and is deliberately deferred — do not 'helpfully' add it here."
//      Each arm below is the client-side twin of the SQL arm in `lambda/harvests/index.js:266-273`,
//      so a chip means the same window here that it means on the Harvests page.
//
//   2. "All time" HAS NO WINDOW, AND THAT IS THE POINT. `chipToWindow('')` returns null rather than
//      a wide-open span. `{from:'2000-01-01', to:'2099-12-31'}` is a legal predicate that inserts
//      every household harvest in one statement, so the unbounded chip must be refused, not widened.
//      PREDICATE_MAX_SPAN_DAYS is the second half of that guard and is derived, not picked: 366 is
//      the widest window any chip can produce (a leap grow-year, Nov 1 → Oct 31).
//
//   3. NEVER `===` ACROSS THE STRING/NUMBER BOUNDARY. `qty`, `weight_grams`, `quantity`,
//      `input_count` arrive from the Lambda as STRINGS (@neondatabase/serverless returns numeric
//      and int8 as text); only `linked_output_count` is a number. Every read here goes through
//      Number() before it is compared or summed.
//
//   4. ROLL-UPS SUM `weight_grams`, NEVER `quantity`. Measured on prod 2026-09-04: all 152 pepper
//      rows in a five-week window carry unit='count', so summing quantity yields a pepper tally, not
//      an amount. 31% of all harvest weights carry weight_basis != 'measured' (cultivar_sample or
//      cultivar), so a total is partly an estimate and `describeRollUp` says so out loud.
//
//   5. A BULK ADD CLAIMS WHOLE PICKS. Predicate-created rows land with qty NULL, and the DDL's own
//      idiom (v5-inflightbatch-001/0a-additive-ddl.sql:241-242) is "a NULL pair means 'unrecorded,
//      assume THE WHOLE THING'". So a 152-row add asserts the entirety of every one of those picks
//      went into the batch, which for peppers is routinely false. WHOLE_PICK_NOTICE states that,
//      because nothing else in the system will, and `weightInputRow` is how the number the cook is
//      actually holding gets recorded beside it.
//
//   6. A RETRY AFTER A DROPPED RESPONSE LIES. `ON CONFLICT DO NOTHING` makes a re-run safe but
//      SILENT: `inserted: 0` reads as "nothing was added" when the rows are in fact present.
//      `summariseInsert` therefore never says "nothing was added" for 0, and `summariseTrueCount`
//      exists so a failed write reports the count re-read from GET /:id rather than a delta.
//
//   7. NO RAW MACHINE VALUE REACHES THE DOM. INPUT_KIND_LABELS is total over KITCHEN_INPUT_KINDS and
//      its fallback is prose, not the slug. Same discipline the outcome labels are held to.
import { etDay, addDays } from '../../lib/harvestSummary.js'
import { growYearSpan } from '../../lib/growYear.js'

// ── vocabularies mirrored from the Lambda ────────────────────────────────────────────────────────
// These are CLIENT MIRRORS of lambda/preservation/kitchenBatch.js:46 and :52-54. A mirror is only
// safe if it is pinned, so batchInputs.test.js text-reads both arrays out of the Lambda source AND
// out of the migration's own CHECK, and asserts set equality against both (model:
// startChipParity.test.js). Note the space in 'fl oz'.
export const KITCHEN_INPUT_KINDS = ['harvest', 'purchased', 'pantry', 'other']
export const KITCHEN_QTY_UNITS = [
  'g', 'kg', 'oz', 'lb', 'count', 'cup', 'tbsp', 'tsp', 'fl oz', 'qt', 'gal', 'ml', 'l', 'other',
]

// Total over KITCHEN_INPUT_KINDS. The fallback is deliberately prose: an unknown kind must render as
// a sentence a person can read, never as the slug — a raw enum in the DOM is how a machine value
// ends up being asserted about by a copy sweep that was written about claims.
export const INPUT_KIND_LABELS = {
  harvest: 'A pick from the garden',
  purchased: 'Something bought',
  pantry: 'Something from the pantry',
  other: 'Something else',
}
export const INPUT_KIND_FALLBACK = 'Something that went in'

// The label the batch-level total-weight row is written under. Not a harvest row (the biconditional
// chk_kbi_harvest_pairing forbids a harvest kind without a harvest_log_id and vice versa), so it goes
// in as `other` with a label — which is the only shape the schema leaves for "this is how much".
export const TOTAL_WEIGHT_LABEL = 'Total weight that went in'
// A subset of KITCHEN_QTY_UNITS: only the mass units. Prod harvest data carries no mass unit at all
// (count/cup/head/bunch) — mass lives in weight_grams — so this list is what the COOK holds on a
// scale, not what the harvest log records.
export const WEIGHT_UNITS = ['lb', 'oz', 'kg', 'g']

// ── copy ─────────────────────────────────────────────────────────────────────────────────────────
// Every string below is swept by BatchInputsField.test.jsx against the eight inherited rulings —
// no readiness language, no age-derived claim, no food-keeping claim of any kind, and a question
// where a verdict would fit. The regexes are in that file rather than restated here, deliberately:
// the same source guard forbids these files from naming the terms, so a copy of the ban list here
// would trip the ban. Read the test to find out what the words are.
export const WHOLE_PICK_NOTICE =
  'Adding picks this way counts each one in full. If part of a pick went elsewhere — eaten fresh, dried, handed to a neighbour — this still claims the whole thing.'
export const ALL_TIME_REFUSAL =
  'Pick a window first. "All time" has no edges, so there is nothing to add from.'
export const INSERT_NONE_NEW =
  'Nothing new — every one of those picks was already in this batch.'
export const INSERT_UNKNOWN =
  'Added, but the count came back unreadable — open the list below to see what is in.'
export const WHOLE_PICK_PHRASE = 'the whole pick'
export const BYPRODUCT_PHRASE = 'trimmings, counted elsewhere'

export const PREDICATE_ERRORS = {
  from: 'That start date is not a real date.',
  to: 'That end date is not a real date.',
  order: 'The end of the window has to be on or after the start.',
  planting: 'That planting id is not a uuid.',
  window: 'Pick a window first.',
}

// Mirrored word-for-word from the Lambda's own messages (kitchenBatch.js:358, :366-399) so a refusal
// the client makes reads identically to one the server would have made. Divergent phrasings for the
// same rule teach the user that the two halves disagree.
export const EXPLICIT_ERRORS = {
  empty: 'inputs must be a non-empty array',
  kind: `input_kind must be one of: ${KITCHEN_INPUT_KINDS.join(', ')}`,
  harvestUuid: 'harvest_log_id must be a uuid',
  harvestNeeded: "an input of kind 'harvest' needs a harvest_log_id",
  qtyPairing: 'qty and qty_unit must both be set, or both be empty',
  qtyPositive: 'qty must be greater than 0',
  qtyUnit: `qty_unit must be one of: ${KITCHEN_QTY_UNITS.join(', ')}`,
  byproduct: 'is_byproduct only applies to a harvest input',
}

export const foreignHarvestError = (kind) =>
  `an input of kind '${kind}' must not carry a harvest_log_id`
export const labelNeededError = (kind) =>
  `an input of kind '${kind}' needs a label — name what went in`

// 366, and it is derived rather than chosen: the widest window any chip can produce is a grow-year
// (Nov 1 → Oct 31), which is 365 days ordinarily and 366 when a Feb 29 falls inside it. So the cap
// admits every legal chip window exactly and refuses everything one day wider. If the server ever
// lands a narrower cap of its own, THAT one governs and this becomes the client-side pre-check —
// the two are not required to agree, only to both refuse the unbounded case.
export const PREDICATE_MAX_SPAN_DAYS = 366

export const spanError = (span) =>
  `That window is ${span} days. Pick a window of ${PREDICATE_MAX_SPAN_DAYS} days or less.`

// ── primitives ───────────────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The Lambda's normalizeText (kitchenBatch.js:113-117), mirrored: trimmed, and '' collapses to null.
// A whitespace-only label is NOT a label.
function normalizeText(v) {
  if (v == null) return null
  const t = String(v).trim()
  return t === '' ? null : t
}

// SHAPE IS NOT VALIDITY, and the difference is a 500. The server's DATE_RE checks `\d{4}-\d{2}-\d{2}`
// and nothing else, so '2026-99-99' passes it, reaches Postgres as a ::date cast, and falls out the
// bottom of the handler as `500 Internal server error` — not a 400 with a message. Every date this
// module hands to the wire has been through here first. Date.UTC round-trip catches the rollovers
// a range check cannot ('2026-02-30' becomes Mar 2 and no longer matches its own input).
// ONE guard, not two: a leading `mo < 1 || mo > 12 || d < 1 || d > 31` range check would be fully
// subsumed by the round trip below (month 99 rolls the year, day 32 rolls the month, both fail the
// identity), and a redundant guard is a place a mutation survives while the surviving half quietly
// does the work. Left as a single testable line.
export function isRealDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''))
  if (!m) return false
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

// Inclusive day count, matching the server's BETWEEN semantics: from === to is one day, not zero.
// UTC anchors only — a local-zone Date would make the answer depend on the CI lane's TZ.
export function spanDays(from, to) {
  if (!isRealDate(from) || !isRealDate(to)) return null
  const at = (s) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((at(to) - at(from)) / 86400000) + 1
}

// ── the window ───────────────────────────────────────────────────────────────────────────────────

// chipValue is HarvestTimeframeChips' vocabulary verbatim: 'today' | 'yesterday' | '' | '7d' |
// 'month' | `season:${year}`. Returns {from,to} as civil ET day keys, or null when the chip names no
// bounded window ('' = All time) or is not a chip at all.
//
// Each arm mirrors the SQL it will be resolved against (lambda/harvests/index.js:266-273):
//   today      ::date =  today
//   yesterday  ::date =  today - 1
//   7d         ::date >= today - INTERVAL '6 days'      → seven days INCLUSIVE of today
//   month      ::date >= date_trunc('month', today)     → the 1st through today
//   season:Y   ::date >= make_date(Y-1,11,1) AND < make_date(Y,11,1)
// The upper bound the SQL leaves open (7d, month) is closed at today here, because the predicate
// requires both ends. The season arm is NOT clamped to today even when Y is the current season: the
// chip means the season, and narrowing it here would make "This season" mean two different windows
// on two surfaces. A `to` in the future selects nothing, which is the correct no-op.
export function chipToWindow(chipValue, nowMs) {
  const v = String(chipValue ?? '')
  const today = etDay(new Date(Number(nowMs)))
  if (today == null) return null
  if (v === '') return null
  if (v === 'today') return { from: today, to: today }
  if (v === 'yesterday') { const d = addDays(today, -1); return { from: d, to: d } }
  if (v === '7d') return { from: addDays(today, -6), to: today }
  if (v === 'month') return { from: `${today.slice(0, 7)}-01`, to: today }
  const m = /^season:(\d{4})$/.exec(v)
  if (!m) return null
  // growYearSpan is the shared derivation and is half-open [start, end); the predicate is inclusive
  // on both ends, so the last day is end - 1. Re-deriving Oct 31 by hand here would be a second copy
  // of the grow-year rule, which growYear.js's header forbids by name.
  const span = growYearSpan(Number(m[1]))
  return { from: span.start, to: addDays(span.end, -1) }
}

// The window, rendered as the civil ET day keys themselves. Deliberately NOT reformatted into
// "Jul 28 – Sep 1": these strings ARE what the server will compare against, and every reformat is a
// place a zone can be introduced. Both bounds always appear, and the one-day case says so.
export function describeWindow(w) {
  if (!w || !isRealDate(w.from) || !isRealDate(w.to)) return null
  return w.from === w.to ? `on ${w.from}` : `from ${w.from} through ${w.to}`
}

// ── request bodies ───────────────────────────────────────────────────────────────────────────────

// { error, body } — body is null whenever error is set, and vice versa. Callers branch on error.
//
// The `preview` arm is the dry-run (BUILD-CONTRACT §2): the server resolves the SAME WHERE and
// returns {matched, predicate} without inserting. Passing preview:false omits the key entirely
// rather than sending `preview: false` — the validator's form selector is hasOwnProperty-based and
// the fewer keys ride along, the fewer there are to be echoed back raw.
//
// `inputs` is NEVER present on this body, not even as null. §2.1: presence is hasOwnProperty, so
// {"inputs": null, "predicate": {...}} counts as BOTH forms and 400s.
//
// variety_id is deliberately absent from the whole module. Measured on prod: over 90 days there are
// 117 distinct varieties against 119 distinct plantings, so variety and planting are very nearly the
// same axis and offering both is two controls for one decision.
export function predicateBody({ cropSlug, plantingId, from, to, preview = false } = {}) {
  if (from == null && to == null) return { error: PREDICATE_ERRORS.window, body: null }
  if (!isRealDate(from)) return { error: PREDICATE_ERRORS.from, body: null }
  if (!isRealDate(to)) return { error: PREDICATE_ERRORS.to, body: null }
  // Lexicographic, which is chronological for ISO dates — the same comparison the server makes.
  if (String(to) < String(from)) return { error: PREDICATE_ERRORS.order, body: null }
  const span = spanDays(from, to)
  if (span > PREDICATE_MAX_SPAN_DAYS) return { error: spanError(span), body: null }

  const predicate = { from, to }
  const crop = normalizeText(cropSlug)
  if (crop != null) predicate.crop_type_slug = crop
  const planting = normalizeText(plantingId)
  if (planting != null) {
    if (!UUID_RE.test(planting)) return { error: PREDICATE_ERRORS.planting, body: null }
    predicate.plant_id = planting
  }
  return { error: null, body: preview ? { predicate, preview: true } : { predicate } }
}

// { error, body } for the explicit form. Every rule here restates one the Lambda enforces, in the
// Lambda's own words, so a refusal made without a round trip is indistinguishable from one made
// with it. The de-dupe mirrors normalizeInputRows (kitchenBatch.js:419-440) so the count this client
// reports is the count the server will call `requested` — the server drops duplicate
// harvest_log_ids silently and reports the POST-dedupe length, and a client that reported the
// pre-dedupe length would be off by exactly the rows it dropped.
export function explicitInputsBody(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { error: EXPLICIT_ERRORS.empty, body: null }
  const out = []
  const seen = new Set()
  for (const raw of rows) {
    const r = raw ?? {}
    const kind = normalizeText(r.input_kind)
    if (kind == null || !KITCHEN_INPUT_KINDS.includes(kind)) {
      return { error: EXPLICIT_ERRORS.kind, body: null }
    }
    // normalizeText, where the Lambda uses `?? null`: a form field the user cleared arrives as '',
    // and the Lambda would answer "harvest_log_id must be a uuid" for it while this answers "needs a
    // harvest_log_id". Both refuse — this client is never laxer than the server, only clearer.
    const harvestId = normalizeText(r.harvest_log_id)
    // Order matters and mirrors inputRowError: the uuid check runs BEFORE the biconditional, so a
    // malformed id on a non-harvest row reports the id, not the pairing.
    if (harvestId != null && !UUID_RE.test(harvestId)) {
      return { error: EXPLICIT_ERRORS.harvestUuid, body: null }
    }
    // The biconditional, both directions (chk_kbi_harvest_pairing): a harvest row must carry the FK
    // and a non-harvest row must not.
    if ((kind === 'harvest') !== (harvestId != null)) {
      return {
        error: kind === 'harvest' ? EXPLICIT_ERRORS.harvestNeeded : foreignHarvestError(kind),
        body: null,
      }
    }
    const label = normalizeText(r.label)
    if (kind !== 'harvest' && label == null) return { error: labelNeededError(kind), body: null }

    // Strict === true, exactly as the server tests and stores it (kitchenBatch.js:386, :435).
    // 'true', 1 and 'yes' are all stored as false there, so anything but the literal is dropped here
    // rather than sent and silently discarded. Checked BEFORE qty, as inputRowError does.
    const byproduct = r.is_byproduct === true
    if (byproduct && kind !== 'harvest') return { error: EXPLICIT_ERRORS.byproduct, body: null }

    // A blank typed into a number box is NOT zero and is NOT a quantity: '' would pair-check as
    // present and then coerce to 0, which the server rejects as "qty must be greater than 0". Both
    // halves collapse to absent together, which is the NULL pair meaning "the whole thing".
    const qtyRaw = normalizeText(r.qty)
    const unit = normalizeText(r.qty_unit)
    if ((qtyRaw == null) !== (unit == null)) return { error: EXPLICIT_ERRORS.qtyPairing, body: null }
    let qty = null
    if (qtyRaw != null) {
      qty = Number(qtyRaw)
      if (!Number.isFinite(qty) || qty <= 0) return { error: EXPLICIT_ERRORS.qtyPositive, body: null }
      if (!KITCHEN_QTY_UNITS.includes(unit)) return { error: EXPLICIT_ERRORS.qtyUnit, body: null }
    }

    if (harvestId != null) {
      if (seen.has(harvestId)) continue
      seen.add(harvestId)
    }
    const row = { input_kind: kind }
    if (harvestId != null) row.harvest_log_id = harvestId
    if (label != null) row.label = label
    if (qty != null) { row.qty = qty; row.qty_unit = unit }
    if (byproduct) row.is_byproduct = true
    const note = normalizeText(r.note)
    if (note != null) row.note = note
    out.push(row)
  }
  if (out.length === 0) return { error: EXPLICIT_ERRORS.empty, body: null }
  return { error: null, body: { inputs: out } }
}

// The batch-level total weight, as an explicit row. Ruling: a predicate add claims whole picks, and
// the one number that survives that over-attribution is what the cook actually put on a scale. It
// cannot be a harvest row (the biconditional), so it is an `other` row carrying a label and a qty.
// NOT idempotent — a repeated post inserts a second copy every time, because uq_kbi_batch_harvest
// is a PARTIAL index over harvest_log_id IS NOT NULL and this row has none. The caller must guard.
export function weightInputRow({ amount, unit } = {}) {
  const n = Number(normalizeText(amount))
  if (!Number.isFinite(n) || n <= 0) return null
  const u = normalizeText(unit)
  if (u == null || !WEIGHT_UNITS.includes(u)) return null
  return { input_kind: 'other', label: TOTAL_WEIGHT_LABEL, qty: n, qty_unit: u }
}

// ── reading what came back ───────────────────────────────────────────────────────────────────────

// The dry-run response, read defensively across BOTH shapes the arm may land in. BUILD-CONTRACT §2
// specifies `{matched, predicate}` without saying whether `matched` is a count or the rows, and the
// two are not distinguishable from the contract text. A number gives a count and no per-row
// decisions; an array gives both. Anything else is null, never a silent zero — a preview that
// reports 0 when it failed to parse is the exact class of lie a preview exists to prevent.
export function readPreview(body) {
  const b = body ?? {}
  const raw = b.matched
  if (Array.isArray(raw)) return { matched: raw.length, rows: raw, predicate: b.predicate ?? null }
  const n = Number(raw)
  if (raw != null && raw !== '' && Number.isFinite(n) && n >= 0) {
    return { matched: n, rows: null, predicate: b.predicate ?? null }
  }
  return null
}

// ScopeChecklist's shipped net-count contract (ScopeChecklist.jsx:41-43): "never make the user
// mentally compute the set difference". Same separators as the shipped line — U+2212 MINUS SIGN and
// U+2192 RIGHTWARDS ARROW, not a hyphen and not '->'. Rendered aria-live by the caller so a toggle
// is announced rather than only shown.
export function netCountLine({ matched, skipped } = {}) {
  // null and '' both coerce to 0 through Number(), so they are refused BEFORE the coercion: a
  // missing count must produce no line at all, never a line that reads zero.
  if (matched == null || matched === '' || skipped == null || skipped === '') return null
  const m = Number(matched); const s = Number(skipped)
  if (!Number.isFinite(m) || !Number.isFinite(s) || m < 0 || s < 0) return null
  const k = Math.max(0, m - s)
  return `${m} matched − ${s} skipped → ${k} will be added`
}

// The SUCCESS summary. `inserted` is the count the writing statement itself returned, after
// ON CONFLICT DO NOTHING — the only count in the system that cannot be wrong about what it did.
// The 0 case is the load-bearing one: 0 does NOT mean "nothing happened", it means "every one of
// those was already here", and saying "nothing was added" would send the user to add them again.
export function summariseInsert({ inserted } = {}) {
  const n = Number(inserted)
  if (inserted == null || inserted === '' || !Number.isFinite(n) || n < 0) return INSERT_UNKNOWN
  if (n === 0) return INSERT_NONE_NEW
  return `${n} ${n === 1 ? 'pick' : 'picks'} added.`
}

// The FAILURE summary, and it deliberately reports a TOTAL rather than a delta. A dropped response
// on a request the server did in fact commit leaves the client unable to say how many rows it added
// — but GET /:id can always say how many are there now, and that number is true whichever way the
// request went. Never subtract to reach it.
export function summariseTrueCount({ total } = {}) {
  const n = Number(total)
  if (total == null || total === '' || !Number.isFinite(n) || n < 0) return null
  return `That did not come back cleanly. Some may have gone in anyway — this batch now holds ${n} ${n === 1 ? 'input' : 'inputs'}.`
}

// One line for one row of GET /:id's inputs[]. That response carries NO joined harvest detail — for
// a harvest input the only identifying column is harvest_log_id — so this describes what is
// knowable and does not invent the rest. A predicate-created row is `input_kind:'harvest'` with a
// null label and a null qty pair, and the honest reading of that null pair is the DDL's own:
// unrecorded, assume the whole thing.
export function describeInputRow(input) {
  const row = input ?? {}
  const kind = normalizeText(row.input_kind)
  const label = normalizeText(row.label)
  const what = label ?? INPUT_KIND_LABELS[kind] ?? INPUT_KIND_FALLBACK
  const qtyRaw = normalizeText(row.qty)
  const unit = normalizeText(row.qty_unit)
  const qty = qtyRaw == null ? null : Number(qtyRaw)
  const amount = (qty != null && Number.isFinite(qty) && unit != null)
    ? `${qty} ${unit}`
    : WHOLE_PICK_PHRASE
  const tail = row.is_byproduct === true ? ` · ${BYPRODUCT_PHRASE}` : ''
  return `${what} — ${amount}${tail}`
}

// ── roll-ups ─────────────────────────────────────────────────────────────────────────────────────

// `weight_grams` ONLY. `quantity` is not read anywhere in this function and must not become read:
// every one of the 152 live pepper rows in a five-week window is unit='count', so a quantity sum is
// a count of peppers wearing a mass label. Returns null for an absent/empty rowset rather than a
// zero total — "nothing to weigh" and "weighs nothing" are different claims.
export function rollUpGrams(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  let grams = 0; let weighed = 0; let estimated = 0; let missing = 0
  for (const r of rows) {
    const raw = r?.weight_grams
    const g = raw == null || raw === '' ? null : Number(raw)
    if (g == null || !Number.isFinite(g)) { missing += 1; continue }
    grams += g
    if (normalizeText(r?.weight_basis) === 'measured') weighed += 1
    else estimated += 1
  }
  return { grams, weighed, estimated, missing, rows: rows.length }
}

// States the estimate out loud, with both counts, because a total that is 31% inferred from a
// cultivar sample is not a measurement and a bare "4.33 kg" would read as one.
export function describeRollUp(rollup) {
  if (!rollup || rollup.rows === 0) return null
  const kg = (rollup.grams / 1000).toFixed(2)
  const head = `About ${kg} kg in total`
  if (rollup.estimated === 0 && rollup.missing === 0) return `${head} — every weight was measured.`
  const parts = []
  if (rollup.estimated > 0) {
    parts.push(`${rollup.estimated} of ${rollup.rows} weights are estimated from a cultivar sample, not weighed`)
  }
  if (rollup.missing > 0) {
    parts.push(`${rollup.missing} of ${rollup.rows} carry no weight at all and are not in this figure`)
  }
  return `${head} — ${parts.join('; ')}.`
}

// ── the per-row decision map ─────────────────────────────────────────────────────────────────────
//
// A Map<id, boolean> of EXPLICIT choices, plus a baseline for the undecided. It is deliberately NOT
// an `excluded` Set: ScopeChecklist.jsx:133-152 records that the Set model was a shipped defect
// because any re-preview destroyed it. The Map persists across re-previews AND deliberately keeps
// ids that have fallen out of the current match set, so narrowing the window and widening it back
// returns the user's own decisions rather than silently re-including what they removed.

export const DECISION_BASELINE = true

export function toggleDecision(decisions, id, baseline = DECISION_BASELINE) {
  const next = new Map(decisions ?? [])
  const current = next.has(id) ? next.get(id) : baseline
  next.set(id, !current)
  return next
}

// THE RESOLVED ROWS, and every affordance must derive from these rather than from the Map's .size.
// BUG-PHOTOSELSTALE-001: a bar that read `selected.size` while the button posted the resolved list
// showed one number and did another thing. The Map's size counts decisions, including decisions
// about ids that are no longer on screen; only this answers "what will actually be added".
export function committedIds(matchedIds, decisions, baseline = DECISION_BASELINE) {
  const d = decisions instanceof Map ? decisions : new Map()
  const ids = Array.isArray(matchedIds) ? matchedIds : []
  return ids.filter((id) => (d.has(id) ? d.get(id) : baseline))
}

export function skippedCount(matchedIds, decisions, baseline = DECISION_BASELINE) {
  const ids = Array.isArray(matchedIds) ? matchedIds : []
  return ids.length - committedIds(ids, decisions, baseline).length
}

// sessionStorage route key for the failed-write stash. Per batch, because two batches open in two
// tabs must not restore each other's half-entered predicate. draftStash's own store is
// sessionStorage and versioned; this only names the key.
export const inputsDraftKey = (batchId) => `putup.batch.${batchId}.inputs`
