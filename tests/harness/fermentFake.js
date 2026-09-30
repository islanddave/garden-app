// Put-Up release F — an IN-BROWSER stand-in for the preservation Lambda's ferment routes, for the ferment
// walks (tests/harness/putupferment.jsx). Stateful: a walk starts a batch, adds lines, salts it, checks on
// it, works out the heat, puts it up, finishes, and edits after finishing — and every write lands here.
//
// WHAT MAKES IT A PROOF RATHER THAN A PROP: every body the UI sends is checked by the Lambda's OWN pure
// validators — kitchenBatch.js validateBatchCreate / validateBatchUpdate / validateStage, kitchenLines.js
// linesError / linePatchError / stagePatchError / drawPlan, putUp.js validatePutUp + planPutUp (which
// resolves each jar's discard-by through shelfLife.js), jarRoutes.js validateJarPatch — and the heat is
// worked out by shuEstimate.js itself. A body the Lambda would refuse is a 400 here too, recorded in
// `state.errors`, and a walk fails on any. What this does NOT prove is SQL: the statements, the CHECKs,
// the audit and the household predicates are the integration lane's (ferment-lambda.int.test.js).
//
// Numeric columns come back as STRINGS, the way the Neon driver returns `numeric` (qty "170", base_g
// "448"), and integers as numbers — so a client that concatenated instead of adding would show it here.
import { validateBatchCreate, validateBatchUpdate, validateStage, KITCHEN_BATCH_EDITABLE_COLUMNS, gramsOf } from '../../lambda/preservation/kitchenBatch.js'
import { linesError, linePatchError, stagePatchError, drawPlan, jarIsWeighed, LINE_PATCH_KEYS } from '../../lambda/preservation/kitchenLines.js'
import { validatePutUp, planPutUp } from '../../lambda/preservation/putUp.js'
import { validateJarPatch } from '../../lambda/preservation/jarRoutes.js'
import { estimateShu, isStale } from '../../lambda/preservation/shuEstimate.js'

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
let seq = 0
const uuid = () => {
  seq += 1
  return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`
}
const nowIso = () => new Date().toISOString()
const localDay = (d = new Date()) => {
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
// numeric → text, as the driver returns it.
const num = (v) => (v == null || v === '' ? null : String(Number(v)))
const NUMERIC = new Set(['qty', 'salt_pct', 'base_g', 'amount', 'mash_in_g', 'ph_reading', 'vessel_size', 'quantity_value', 'remaining_amount'])
const INTEGER = new Set(['shu_rating_low', 'shu_rating_high', 'shu_est_low', 'shu_est_high', 'vessel_count', 'ordinal', 'package_count'])
function stored(k, v) {
  if (v == null) return null
  if (NUMERIC.has(k)) return num(v)
  if (INTEGER.has(k)) return Number(v)
  return v
}

// ── the household's world ─────────────────────────────────────────────────────────────────────────────
export const PLACES = [
  { id: uuid(), user_id: 'harness_user', label: 'Fridge', kind: 'fridge' },
  { id: uuid(), user_id: 'harness_user', label: 'Chest Freezer 1', kind: 'deep_freezer' },
]
// Ratings are SYNTHETIC, arithmetic-only (06 §5.3: the formula is never tuned to a card).
export const PLANTINGS = [
  { plant_id: uuid(), label: 'Jalapeño', crop_type_slug: 'pepper', variety_id: uuid(), rating: [2500, 8000], picks: [] },
  { plant_id: uuid(), label: 'Onion, red', crop_type_slug: 'onion', variety_id: null, rating: null, picks: [] },
  { plant_id: uuid(), label: 'Ristra Cayenne', crop_type_slug: 'pepper', variety_id: uuid(), rating: [24200, 34800], picks: [] },
  { plant_id: uuid(), label: 'Napa cabbage', crop_type_slug: 'cabbage', variety_id: null, rating: null, picks: [] },
  { plant_id: uuid(), label: 'Megatron jalapeño', crop_type_slug: 'pepper', variety_id: uuid(), rating: [2500, 8000], picks: [] },
  { plant_id: uuid(), label: 'Serranos', crop_type_slug: 'pepper', variety_id: uuid(), rating: [10000, 23000],
    picks: [{ harvest_log_id: uuid(), picked_on: localDay(new Date(Date.now() - 2 * 86400000)), qty: '230', qty_unit: 'g' }] },
]
export const JARS = [
  { id: uuid(), label: 'Reaper, frozen', method: 'whole_freeze', crop_type_slug: 'pepper', variety_id: 'reaper', quantity_value: '100',
    quantity_unit: 'g', package_count: 1, remaining_count: null, remaining_amount: null, consumed_at: null, deleted_at: null,
    storage_location_id: PLACES[1].id, from_garden: true, rating: [1400000, 2200000], batch_id: null },
  { id: uuid(), label: 'Carrots, local', method: 'blanch_freeze', crop_type_slug: 'carrot', variety_id: null, quantity_value: '3',
    quantity_unit: 'lb', package_count: 4, remaining_count: null, remaining_amount: null, consumed_at: null, deleted_at: null,
    storage_location_id: PLACES[1].id, from_garden: false, rating: null, batch_id: null },
]

// `inflight` lets a walk wait for the network to go quiet rather than for a guessed number of ms.
export const state = { batches: [], stages: [], lines: [], errors: [], calls: [], unknown: [], inflight: 0 }

const refuse = (status, body) => ({ status, body })
const bad = (error) => refuse(400, { error })
const ok = (body, status = 200) => ({ status, body })

const voided = (s) => state.stages.some(v => v.stage_kind === 'void' && v.voids_id === s.id)
const liveStages = (b) => state.stages.filter(s => s.batch_id === b.id && s.stage_kind !== 'void' && !voided(s))
const byEnteredDesc = (a, c) => String(c.entered_at ?? '').localeCompare(String(a.entered_at ?? ''))
  || String(c.created_at).localeCompare(String(a.created_at))

function viewRow(b) {
  const live = liveStages(b)
  const cur = live.filter(s => ['started', 'tended', 'moved', 'finished', 'failed'].includes(s.stage_kind)).sort(byEnteredDesc)[0]
  const ph = live.filter(s => s.ph_reading != null).sort((a, c) => String(c.ph_read_at).localeCompare(String(a.ph_read_at)))[0]
  return {
    ...b,
    current_stage_kind: cur?.stage_kind ?? null, current_stage_label: cur?.label ?? null, current_stage_entered_at: cur?.entered_at ?? null,
    input_count: String(state.lines.filter(l => l.batch_id === b.id && l.deleted_at == null).length),
    output_count: String(JARS.filter(j => j.batch_id === b.id && j.deleted_at == null).length),
    last_ph_reading: ph?.ph_reading ?? null, last_ph_read_at: ph?.ph_read_at ?? null,
  }
}

const plantingOf = (id) => PLANTINGS.find(p => p.plant_id === id)
const jarOf = (id) => JARS.find(j => j.id === id)
const pickOf = (id) => PLANTINGS.flatMap(p => p.picks.map(k => ({ ...k, planting: p }))).find(k => k.harvest_log_id === id)

function fromGarden(l) {
  if (l.input_kind === 'garden' || l.input_kind === 'harvest') return true
  if (l.input_kind === 'put_up') return jarOf(l.preservation_log_id)?.from_garden === true
  return false
}
function publicLine(l) {
  const { _use: _u, ...rest } = l
  return { ...rest, from_garden: fromGarden(l), count_drawn: l.input_kind === 'put_up' && l._use ? l._use.count : null }
}
function shuLine(l) {
  const p = l.plant_id ? plantingOf(l.plant_id) : null
  const j = l.preservation_log_id ? jarOf(l.preservation_log_id) : null
  const rating = p?.rating ?? j?.rating ?? null
  return {
    id: l.id, label: l.label, qty: l.qty, qty_unit: l.qty_unit, form: l.form, role: l.role,
    put_up_stage_id: l.put_up_stage_id ?? null, output_id: l.output_id ?? null, input_kind: l.input_kind,
    shu_rating_low: l.shu_rating_low, shu_rating_high: l.shu_rating_high,
    crop_type_slug: l.crop_type_slug ?? p?.crop_type_slug ?? j?.crop_type_slug ?? null,
    variety_rating: rating ? { low: rating[0], high: rating[1] } : null,
    draw: l._use ? { count_drawn: l._use.count, jar_quantity_value: j.quantity_value, jar_quantity_unit: j.quantity_unit, jar_package_count: j.package_count } : null,
  }
}
function estimateFor(b, scope, id) {
  const lines = state.lines.filter(l => l.batch_id === b.id && l.deleted_at == null).map(shuLine)
  const live = liveStages(b)
  const started = live.find(s => s.stage_kind === 'started')
  const sittings = live.filter(s => s.stage_kind === 'put_up').map(s => ({ id: s.id, made_g: s.amount, mash_in_g: s.mash_in_g }))
  const jar = scope === 'jar' ? jarOf(id) : null
  return estimateShu({ scope, lines, about: started && started.amount != null ? { amount: started.amount, amount_unit: started.amount_unit } : null,
    sittings, sitting_id: scope === 'sitting' ? id : null,
    jar: jar ? { id: jar.id, put_up_stage_id: jar.put_up_stage_id, quantity_value: jar.quantity_value, quantity_unit: jar.quantity_unit } : null,
    pepperNames: [] })
}

// The batch detail's jar projection (kitchenRoutes.js getBatch): an explicit list — no use_by_target,
// no storage_kind — plus stock_mode.
const OUTPUT_COLUMNS = ['id', 'batch_id', 'crop_type_slug', 'variety_id', 'preserved_at', 'preserved_at_approx', 'method',
  'quantity_value', 'quantity_unit', 'package_count', 'storage_location_id', 'remaining_count', 'consumed_at', 'label',
  'container_label', 'put_up_stage_id', 'is_raw', 'in_oil', 'texture', 'ph_reading', 'ph_read_at', 'preserved_at_precision',
  'use_by_basis', 'shu_est_low', 'shu_est_high', 'shu_est_basis', 'cooked', 'remaining_amount']
const detailJar = (j) => ({ ...Object.fromEntries(OUTPUT_COLUMNS.map(k => [k, j[k] ?? null])), stock_mode: jarIsWeighed(j) ? 'weighed' : 'counted' })

function detail(b) {
  const inputs = state.lines.filter(l => l.batch_id === b.id && l.deleted_at == null)
    .sort((a, c) => (a.ordinal ?? -1) - (c.ordinal ?? -1)).map(publicLine)
  const out = {
    ...viewRow(b),
    garden_names: [...new Set(inputs.filter(l => l.from_garden && l.label).map(l => l.label))],
    inputs,
    stages: state.stages.filter(s => s.batch_id === b.id).sort(byEnteredDesc),
    outputs: JARS.filter(j => j.batch_id === b.id && j.deleted_at == null).map(detailJar),
  }
  if (b.shu_est_basis === 'computed' && isStale(b, estimateFor(b, 'batch'))) out.shu_est_stale = true
  return out
}

// A draw (counted or weighed), applied to the jar; undone by `reverse`.
function applyDraw(l, jar) {
  const plan = drawPlan(l, jar)
  if (plan.status) return plan
  if (plan.weighed) {
    const had = Number(jar.remaining_amount ?? gramsOf(jar.quantity_value, jar.quantity_unit))
    const left = had - gramsOf(l.qty, l.qty_unit)
    if (left < 0) return { status: 409, code: 'only_g_left', error: 'Only about that much left.', g: Math.round(had) }
    jar.remaining_amount = num(left)
    if (left === 0) { jar.remaining_count = 0; jar.consumed_at = nowIso() }
    l._use = null
  } else {
    const had = Number(jar.remaining_count ?? jar.package_count)
    if (had - plan.count < 0) return { status: 409, code: 'only_n_left', error: 'Not that many left.', n: had }
    jar.remaining_count = had - plan.count
    if (jar.remaining_count === 0) jar.consumed_at = nowIso()
    l._use = { count: plan.count }
  }
  return {}
}
function reverse(l) {
  const jar = jarOf(l.preservation_log_id)
  if (!jar) return
  if (l._use) { jar.remaining_count = Number(jar.remaining_count ?? jar.package_count) + l._use.count; jar.consumed_at = null }
  else jar.remaining_amount = num(Number(jar.remaining_amount ?? 0) + gramsOf(l.qty, l.qty_unit))
}

function makeLine(batchId, body) {
  const p = body.plant_id ? plantingOf(body.plant_id) : null
  const pick = body.harvest_log_id ? pickOf(body.harvest_log_id) : null
  const jar = body.preservation_log_id ? jarOf(body.preservation_log_id) : null
  const l = {
    id: uuid(), batch_id: batchId, input_kind: body.input_kind, harvest_log_id: body.harvest_log_id ?? null,
    plant_id: body.plant_id ?? pick?.planting.plant_id ?? null, preservation_log_id: body.preservation_log_id ?? null,
    crop_type_slug: body.crop_type_slug ?? p?.crop_type_slug ?? pick?.planting.crop_type_slug ?? jar?.crop_type_slug ?? null,
    label: body.label ?? p?.label ?? pick?.planting.label ?? jar?.label ?? null,
    is_byproduct: false, deleted_at: null, edited_at: null, added_at: nowIso(), created_at: nowIso(), created_by: 'harness_user',
  }
  for (const k of ['source_label', 'qty', 'qty_unit', 'form', 'brand', 'note', 'shu_rating_low', 'shu_rating_high', 'role', 'salt_pct',
    'salt_base', 'base_g', 'salt_method', 'base_from', 'put_up_stage_id', 'output_id', 'ordinal']) l[k] = stored(k, body[k] ?? null)
  if (l.shu_rating_low != null && l.shu_rating_high == null) l.shu_rating_high = l.shu_rating_low
  return l
}
// The date and its word, written the way the route writes them (kitchenRoutes.js addStage, createBatch):
// a note is stamped now, 'exact'; a row sent WITH a precision carries exactly the date it was sent (NULL
// for 'unknown'); a row sent WITHOUT one takes the pre-1b path — its date or now, and a NULL precision.
// This stand-in used to stamp 'exact' on that last shape, which is how the walks hid an Undo that 400'd
// on every legacy-shaped check-in and move (review I-N1).
function stageDate(body) {
  if (body.stage_kind === 'noted') return { entered_at: nowIso(), entered_precision: 'exact' }
  const precision = body.entered_precision ?? null
  return precision != null
    ? { entered_at: body.entered_at ?? null, entered_precision: precision }
    : { entered_at: body.entered_at ?? nowIso(), entered_precision: null }
}
function makeStage(b, body, extra = {}) {
  const row = {
    id: uuid(), batch_id: b.id, stage_kind: body.stage_kind, label: body.label ?? null, cue_observed: body.cue_observed ?? null,
    ...stageDate(body), ph_read_at: body.ph_read_at ?? null,
    voids_id: body.voids_id ?? null, acts: body.acts ? [...new Set(body.acts)] : null, edited_at: null,
    storage_location_id: body.storage_location_id ?? null, photo_id: null, note: body.note ?? null, created_by: 'harness_user', created_at: nowIso(),
    amount: stored('amount', body.amount), amount_unit: body.amount_unit ?? null, ph_reading: stored('ph_reading', body.ph_reading),
    mash_in_g: null, ...extra,
  }
  state.stages.push(row)
  return row
}

// ── the routes ────────────────────────────────────────────────────────────────────────────────────────
function route(method, path, query, body) {
  if (path === '/api/storage-locations') return ok(PLACES)
  if (path === '/api/kitchen-batches/line-search') {
    const q = String(query.get('q') ?? '').trim().toLowerCase()
    if (!q) return bad('type something to search for')
    return ok({
      plantings: PLANTINGS.filter(p => p.label.toLowerCase().includes(q))
        .map(p => ({ plant_id: p.plant_id, label: p.label, crop_type_slug: p.crop_type_slug, variety_id: p.variety_id, recent_picks: p.picks })),
      put_ups: JARS.filter(j => j.deleted_at == null && j.consumed_at == null && Number(j.remaining_count ?? 1) > 0
        && j.batch_id == null && j.label.toLowerCase().includes(q)).map(j => ({
        preservation_log_id: j.id, label: j.label, method: j.method, crop_type_slug: j.crop_type_slug, variety_id: j.variety_id,
        quantity_value: j.quantity_value, quantity_unit: j.quantity_unit, package_count: j.package_count, remaining_count: j.remaining_count,
        remaining_amount: j.remaining_amount, stock_mode: jarIsWeighed(j) ? 'weighed' : 'counted',
        suggested_form: j.method === 'whole_freeze' || j.method === 'blanch_freeze' ? 'frozen' : null,
      })),
    })
  }
  if (path === '/api/kitchen-batches') {
    if (method === 'GET') {
      const st = query.get('state') ?? 'going'
      const rows = state.batches.filter(b => b.deleted_at == null && (st === 'all' || (st === 'closed') === (b.closed_at != null))).map(viewRow)
      return ok({ state: st, batches: rows })
    }
    const e = validateBatchCreate(body)
    if (e) return bad(e)
    const b = {
      id: uuid(), user_id: 'harness_user', label: body.label.trim(), kind: body.kind ?? null, kind_other: body.kind_other ?? null,
      started_at: body.started_at ?? null, start_precision: body.start_precision ?? null, start_anchor_kind: body.start_anchor_kind ?? null,
      start_anchor_id: null, first_recorded_at: nowIso(), expected_days_min: null, expected_days_max: null, brine_note: null,
      suspended_at: null, closed_at: null, outcome: null, outcome_note: null, cover_photo_id: null, notes: null,
      created_at: nowIso(), updated_at: nowIso(), deleted_at: null,
      vessel_label: null, vessel_size: null, vessel_unit: null, vessel_count: null, no_salt: null,
      shu_est_low: null, shu_est_high: null, shu_est_basis: null, recipe_ref: null,
    }
    state.batches.push(b)
    makeStage(b, { stage_kind: 'started', entered_at: b.started_at, entered_precision: b.start_precision ?? null })
    return ok(viewRow(b), 201)
  }
  const m = path.match(/^\/api\/kitchen-batches\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/)
  if (!m) return null
  const [, id, sub, tail, fourth] = m
  const b = state.batches.find(x => x.id === id && x.deleted_at == null)
  if (!b) return refuse(404, { error: 'Not found', code: 'not_found' })

  if (!sub) {
    if (method === 'GET') return ok(detail(b))
    if (method === 'PUT') {
      const e = validateBatchUpdate(body)
      if (e) return bad(e)
      if (body.no_salt === true && state.lines.some(l => l.batch_id === b.id && l.deleted_at == null && l.role === 'salt')) {
        return refuse(409, { code: 'has_salt_line', error: 'Take the salt line out first.' })
      }
      for (const k of KITCHEN_BATCH_EDITABLE_COLUMNS) if (has(body, k)) b[k] = stored(k, body[k])
      if (has(body, 'shu_est_low')) b.shu_est_basis = body.shu_est_low == null ? null : 'typed'
      b.updated_at = nowIso()
      return ok(viewRow(b))
    }
    return refuse(405, { error: 'Method not allowed' })
  }
  if (sub === 'stages' && !tail && method === 'POST') {
    const e = validateStage(body)
    if (e) return bad(e)
    if (body.stage_kind === 'paused') b.suspended_at = nowIso()
    if (body.stage_kind === 'resumed') b.suspended_at = null
    if (body.stage_kind === 'reopened') { b.closed_at = null; b.outcome = null }
    const row = makeStage(b, body)
    return ok({ stage: row, batch: viewRow(b) }, 201)
  }
  if (sub === 'stages' && tail && method === 'PATCH') {
    const st = state.stages.find(s => s.id === tail && s.batch_id === b.id)
    if (!st) return refuse(404, { error: 'Not found' })
    const e = stagePatchError(body, { ...st, voided: voided(st) })
    if (e) return bad(e)
    for (const [k, v] of Object.entries(body)) st[k] = stored(k, v)
    st.edited_at = nowIso()
    return ok({ stage: st })
  }
  if (sub === 'inputs' && !tail && method === 'POST') {
    const e = linesError(body.inputs, { keyed: true })
    if (e) return bad(e)
    const made = []
    for (const lb of body.inputs) {
      const l = makeLine(b.id, lb)
      if (l.input_kind === 'put_up') {
        const r = applyDraw(l, jarOf(l.preservation_log_id))
        if (r.status) {
          for (const x of made) if (x.input_kind === 'put_up') reverse(x)
          return refuse(r.status, { code: r.code, error: r.error, ...(r.g != null ? { g: r.g } : {}), ...(r.n != null ? { n: r.n } : {}) })
        }
      }
      if (l.role === 'salt') b.no_salt = null
      made.push(l)
    }
    state.lines.push(...made)
    return ok({ inserted: made.length, requested: made.length, inputs: made.map(publicLine) }, 201)
  }
  if (sub === 'inputs' && tail && !fourth) {
    const l = state.lines.find(x => x.id === tail && x.batch_id === b.id)
    if (!l) return refuse(404, { error: 'Not found' })
    if (method === 'PATCH') {
      const e = linePatchError(body, { ...l, weighed: l.input_kind === 'put_up' && !l._use })
      if (e) return bad(e)
      for (const k of LINE_PATCH_KEYS) if (has(body, k)) l[k] = stored(k, body[k])
      l.edited_at = nowIso()
      return ok({ input: publicLine(l) })
    }
    if (method === 'DELETE') {
      if (l.input_kind === 'harvest') { state.lines = state.lines.filter(x => x !== l); return ok({ ok: true, input: null }) }
      if (l.deleted_at) return ok({ ok: true, already: true })
      l.deleted_at = nowIso()
      if (l.input_kind === 'put_up') reverse(l)
      return ok({ ok: true, input: publicLine(l) })
    }
  }
  if (sub === 'inputs' && tail && fourth === 'restore' && method === 'POST') {
    const l = state.lines.find(x => x.id === tail && x.batch_id === b.id)
    if (!l) return refuse(404, { error: 'Not found' })
    if (!l.deleted_at) return ok({ ok: true, already: true })
    if (l.input_kind === 'put_up') {
      const r = applyDraw(l, jarOf(l.preservation_log_id))
      if (r.status) return refuse(r.status, { code: r.code, error: r.error })
    }
    l.deleted_at = null
    return ok({ ok: true, input: publicLine(l) })
  }
  if (sub === 'shu-estimate' && !tail && method === 'GET') return ok(estimateFor(b, query.get('scope') ?? 'batch', query.get('id')))
  if (sub === 'shu-estimate' && tail === 'save' && method === 'POST') {
    const scope = body.scope ?? 'batch'
    const est = estimateFor(b, scope, body.id ?? null)
    if (est.refusal) return refuse(409, { code: 'shu_cannot_compute', error: "Can't work it out yet.", ...est })
    const target = scope === 'batch' ? b : jarOf(body.id)
    target.shu_est_low = est.low; target.shu_est_high = est.high; target.shu_est_basis = 'computed'
    return ok({ shu_est_low: est.low, shu_est_high: est.high, shu_est_basis: 'computed' })
  }
  if (sub === 'put-up' && !tail && method === 'POST') {
    if (b.closed_at) return refuse(409, { code: 'batch_closed', reopen: true, error: 'This batch is finished. Reopen it to bottle more →' })
    const e = validatePutUp(body)
    if (e) return bad(e)
    const bodies = [...(body.sitting_lines ?? []), ...body.rows.flatMap(r => r.added_lines ?? [])]
      .map(x => ({ ...x, input_kind: x.input_kind ?? 'other' }))
    const le = bodies.length ? linesError(bodies, { keyed: false }) : null
    if (le) return bad(le)
    const placeKinds = Object.fromEntries(PLACES.map(p => [p.id, p.kind]))
    const prepared = bodies.map(x => makeLine(b.id, x))
    const plan = planPutUp(body, { batchLabel: b.label, notSureDay: localDay(), newId: uuid, placeKinds, prepared })
    const stage = makeStage(b, { stage_kind: 'put_up', entered_at: plan.stage.entered_at, entered_precision: plan.stage.entered_precision },
      { id: plan.stage.id, amount: num(plan.stage.made_g), amount_unit: plan.stage.made_g ? 'g' : null, mash_in_g: num(plan.stage.mash_in_g) })
    const jars = plan.jars.map(j => {
      let placeId = j.place_id
      if (!placeId) {
        const found = PLACES.find(p => p.kind === j.place_kind && p.label.toLowerCase() === String(j.place_label).toLowerCase())
        if (found) placeId = found.id
        else { const np = { id: uuid(), user_id: 'harness_user', label: j.place_label, kind: j.place_kind }; PLACES.push(np); placeId = np.id }
      }
      const jar = {
        id: j.id, batch_id: b.id, put_up_stage_id: stage.id, label: j.label, container_label: j.container_label,
        quantity_value: num(j.quantity_value), quantity_unit: j.quantity_unit, package_count: j.package_count, remaining_count: j.package_count,
        storage_location_id: placeId, preserved_at: plan.jar_day, preserved_at_precision: plan.jar_precision, preserved_at_approx: plan.approx,
        use_by_target: j.use_by_target, use_by_basis: j.use_by_basis, is_raw: j.is_raw, in_oil: j.in_oil, texture: j.texture,
        ph_reading: num(j.ph_reading), ph_read_at: j.ph_read_at, shu_est_low: j.shu_est_low, shu_est_high: j.shu_est_high,
        shu_est_basis: j.shu_est_basis, cooked: j.cooked, method: body.method, crop_type_slug: null, variety_id: null,
        consumed_at: null, deleted_at: null, remaining_amount: null, from_garden: false, rating: null,
      }
      JARS.push(jar)
      return jar
    })
    for (const l of plan.lines) {
      const line = { ...l, batch_id: b.id }
      if (line.input_kind === 'put_up') {
        const r = applyDraw(line, jarOf(line.preservation_log_id))
        if (r.status) return refuse(r.status, { code: r.code, error: r.error })
      }
      state.lines.push(line)
    }
    if (plan.stage.next_time) makeStage(b, { stage_kind: 'noted', note: plan.stage.next_time })
    if (body.finish) {
      b.closed_at = nowIso(); b.outcome = 'put_up'; b.suspended_at = null
      makeStage(b, { stage_kind: 'finished', entered_at: plan.stage.entered_at, entered_precision: plan.stage.entered_precision })
    }
    const place = (j) => PLACES.find(p => p.id === j.storage_location_id)
    return ok({
      stage, jars: jars.map(j => ({ ...detailJar(j), storage_label: place(j)?.label ?? null, storage_kind: place(j)?.kind ?? null })),
      inputs: plan.lines.map(l => publicLine(state.lines.find(x => x.id === l.id))), batch: viewRow(b),
    }, 201)
  }
  if (sub === 'reopen' && method === 'POST') { b.closed_at = null; b.outcome = null; return ok(viewRow(b)) }
  return null
}

function jarRoute(method, path, body) {
  const m = path.match(/^\/api\/preservation\/([0-9a-f-]{36})$/)
  if (!m || method !== 'PATCH') return null
  const jar = jarOf(m[1])
  if (!jar) return refuse(404, { error: 'Not found' })
  const e = validateJarPatch(body)
  if (e) return bad(e)
  for (const [k, v] of Object.entries(body)) jar[k] = stored(k, v)
  if (has(body, 'shu_est_low')) jar.shu_est_basis = body.shu_est_low == null ? null : 'typed'
  return ok(detailJar(jar))
}

// Surfaces the walks pass through but do not exercise (the put-up list behind the segmented control).
// Answered empty; each is recorded in `state.unknown` so a walk that lands somewhere unplanned shows it.
function elsewhere(method, path) {
  if (method !== 'GET') return null
  if (path === '/api/preservation/whats-put-up') return ok({ group_by: 'storage', groups: [] })
  if (path === '/api/preservation') return ok([])
  state.unknown.push(path)
  return ok([])
}

// Installs the stand-in on window.fetch. Every call is recorded; every refusal (4xx) is recorded in
// state.errors so a walk can fail on the first body the Lambda would have refused.
export function installFake() {
  const realFetch = window.fetch.bind(window)
  window.fetch = async (url, init = {}) => {
    const u = new URL(String(url), window.location.origin)
    if (!u.pathname.startsWith('/api/')) return realFetch(url, init)
    const method = String(init.method ?? 'GET').toUpperCase()
    let body = null
    try { body = init.body ? JSON.parse(init.body) : null } catch { body = null }
    state.inflight += 1
    try {
      await new Promise(res => setTimeout(res, 15))
      const r = jarRoute(method, u.pathname, body) ?? route(method, u.pathname, u.searchParams, body ?? {})
        ?? elsewhere(method, u.pathname) ?? refuse(404, { error: 'Not found' })
      state.calls.push({ method, path: u.pathname + u.search, body, status: r.status })
      if (r.status >= 400) state.errors.push({ method, path: u.pathname, status: r.status, body: r.body, sent: body })
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
    } finally {
      state.inflight -= 1
    }
  }
  return state
}
