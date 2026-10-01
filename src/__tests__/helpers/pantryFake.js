// Test helper — Put-Up B′ release 2. Pantry rows shaped EXACTLY like the pinned cross-lane contract
// (GET /api/pantry → { rows: Row[] }), and a fake of the pantry-server lane's routes, so the client is
// built and tested against the contract while that lane builds the server concurrently.
//
// Row = { stock_kind, stock_id, name, group_key, group_label, place: {id,label,kind}|null, where_from,
// from_garden, plant_id, crop_type_slug, batch_id, stock_mode, count_left, count_made, grams_left,
// method, discard: {date, basis, status}, acquired_at, created_by, updated_at }.
import { validateUse } from '../../../lambda/preservation/pantryUses.js'
import { moveUseBy } from '../../../lambda/preservation/jarRoutes.js'
import { projectRow } from '../../../lambda/preservation/jarRules.js'

const USE_ID_STAND_IN = '00000000-0000-4000-8000-000000000000'

// POST /api/preservation/:id/move answers the MOVED ROW in the server's own shape (jarRules.projectRow),
// with its date decided by the Lambda's OWN move rule (jarRoutes.moveUseBy) from the listed row's STORED
// basis and the two place kinds — so a client test reads the answer a real move gives: a worked-out date
// at another kind of place comes back with no date, a typed date stays, a move within one kind keeps the
// date, a house estimate is worked out again from the move day. A jar this fake does not list answers
// `{ id }`, as it always did. `state.rows` is not rewritten (no route here rewrites it).
function movedJar({ id, body, state, places }) {
  const r = state.rows.find(x => x.stock_kind === 'put_up' && x.stock_id === id)
  if (!r) return { id }
  const dest = body?.place?.id != null
    ? (places.find(p => String(p.id) === String(body.place.id)) ?? { id: body.place.id, kind: null })
    : { id: `loc-new-${++state.seq}`, label: body?.place?.label, kind: body?.place?.kind ?? null }
  const when = typeof body?.when === 'string' ? body.when : body?.when?.date
  const moveDate = when ?? new Date().toISOString().slice(0, 10)
  const stored = { method: r.method, storage_kind: r.place?.kind ?? null, use_by_basis: r.discard?.basis ?? null }
  const { kindChanged, useBy } = moveUseBy(stored, dest.kind, moveDate)
  return projectRow({
    id, user_id: r.created_by, label: r.name, method: r.method, crop_type_slug: r.crop_type_slug, plant_id: r.plant_id,
    batch_id: r.batch_id, package_count: r.count_made ?? 1, remaining_count: r.count_left ?? 1,
    preserved_at: r.acquired_at ?? null, preserved_at_precision: r.acquired_precision ?? null, notes: r.notes ?? null,
    storage_location_id: dest.id,
    use_by_target: useBy ? useBy.use_by_target : (r.discard?.date ?? null),
    use_by_basis: useBy ? useBy.use_by_basis : (r.discard?.basis ?? null),
    storage_moved_at: kindChanged ? `${moveDate}T12:00:00.000Z` : null,
    updated_at: r.updated_at,
  })
}

export const PLACES = [
  { id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' },
  { id: 'loc-2', label: 'Chest Freezer 2', kind: 'deep_freezer' },
  { id: 'loc-3', label: 'Kitchen fridge', kind: 'fridge' },
]

export function jarRow(o = {}) {
  const place = o.place === undefined ? { id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' } : o.place
  return {
    stock_kind: 'put_up', stock_id: 'jar-1', name: 'Blueberries', group_key: place?.id ?? 'none', group_label: place?.label ?? 'No place',
    place, where_from: null, from_garden: false, plant_id: null, crop_type_slug: 'blueberry', batch_id: null,
    stock_mode: 'counted', count_left: 4, count_made: 6, grams_left: null, method: 'whole_freeze',
    discard: { date: '2027-07-01', basis: 'table', status: 'ok' }, acquired_at: null, created_by: 'user_dave',
    updated_at: '2026-09-01T12:00:00Z',
    ...o,
  }
}

export function itemRow(o = {}) {
  const place = o.place === undefined ? { id: 'loc-3', label: 'Kitchen fridge', kind: 'fridge' } : o.place
  return {
    stock_kind: 'pantry_item', stock_id: 'item-1', name: 'Oat milk', group_key: place?.id ?? 'none', group_label: place?.label ?? 'No place',
    place, where_from: null, from_garden: false, plant_id: null, crop_type_slug: null, batch_id: null,
    stock_mode: 'item', count_left: null, count_made: null, grams_left: null, method: null,
    discard: { date: null, basis: null, status: null }, acquired_at: '2026-09-18', created_by: 'user_jen',
    updated_at: '2026-09-18T12:00:00Z',
    ...o,
  }
}

// A fetch fake routing the Pantry contract plus the shipped routes the Pantry calls. `state.rows` is the
// list; handlers can be overridden per route key. Every call is recorded on `calls`.
export function pantryFetch({ rows = [], places = PLACES, overrides = {}, lineSearch = { plantings: [], put_ups: [] } } = {}) {
  const state = { rows: [...rows], calls: [], seq: 0 }
  const fn = async (path, options = {}) => {
    const method = options.method || 'GET'
    const body = options.body ? JSON.parse(options.body) : undefined
    state.calls.push({ path, method, body })
    const key = `${method} ${path.split('?')[0]}`
    for (const [k, h] of Object.entries(overrides)) {
      if (key === k || (k.endsWith('*') && key.startsWith(k.slice(0, -1)))) return h({ path, method, body, state })
    }
    if (method === 'GET' && path.startsWith('/api/pantry?')) {
      const u = new URL(path, 'http://x')
      const placeId = u.searchParams.get('place_id')
      return { rows: placeId ? state.rows.filter(r => String(r.place?.id) === placeId) : state.rows }
    }
    if (method === 'GET' && path === '/api/storage-locations') return places
    if (method === 'POST' && path === '/api/storage-locations') return { id: `loc-new-${++state.seq}`, label: body.label, kind: body.kind }
    if (method === 'GET' && path.startsWith('/api/kitchen-batches/line-search')) return lineSearch
    if (method === 'GET' && path.startsWith('/api/kitchen-batches')) return { state: 'going', batches: [] }
    if (method === 'POST' && path === '/api/pantry/uses') {
      // Judged by the Lambda's OWN validator, so a body the server refuses is a 400 here too, with the
      // server's sentence. ONE stand-in: this fake's stock ids are short words ('jar-1'), not uuids, and
      // the validator checks that before the rules a client can get wrong — so a named jar is judged as
      // a well-formed id. Everything else in the body is judged exactly as it was sent.
      const judged = typeof body?.preservation_log_id === 'string' && body.preservation_log_id !== ''
        ? { ...body, preservation_log_id: USE_ID_STAND_IN } : body
      const refused = validateUse(judged)
      if (refused) throw apiError(400, { error: refused })
      const r = state.rows.find(x => x.stock_id === body.preservation_log_id)
      const left = r?.count_left ?? 1
      const n = body.all_remaining ? left : body.count_used
      return { use: { id: `use-${++state.seq}`, preservation_log_id: body.preservation_log_id, count_used: n, fate: body.fate ?? null },
        jar: { id: body.preservation_log_id, remaining_count: left - n } }
    }
    if (method === 'POST' && /^\/api\/pantry\/uses\/[^/]+\/undo$/.test(path)) {
      return { use: { id: `use-${++state.seq}`, reverses_use_id: path.split('/')[4] }, jar: { id: 'x', remaining_count: 1 } }
    }
    if (method === 'POST' && path === '/api/pantry/items') return { item: { id: `item-new-${++state.seq}`, ...body } }
    if (method === 'PATCH' && path.startsWith('/api/pantry/items/')) return { item: { id: path.split('/').pop(), ...body } }
    if (method === 'DELETE' && path.startsWith('/api/pantry/items/')) return { ok: true }
    if (method === 'POST' && path === '/api/preservation') {
      return { id: `jar-new-${++state.seq}`, ...body, use_by_target: '2027-09-30', use_by_basis: 'table' }
    }
    if (method === 'GET' && /^\/api\/preservation\/[^/]+$/.test(path)) {
      const id = path.split('/').pop()
      const r = state.rows.find(x => x.stock_id === id)
      return { id, label: r?.name ?? 'Jar', method: r?.method ?? 'whole_freeze', package_count: r?.count_made ?? 1, quantity_value: null,
        quantity_unit: null, notes: null, use_by_target: null, storage_location_id: r?.place?.id ?? null }
    }
    if (method === 'PATCH' && path.startsWith('/api/preservation/')) return { id: path.split('/')[3], ...body }
    if (method === 'POST' && /^\/api\/preservation\/[^/]+\/move$/.test(path)) return movedJar({ id: path.split('/')[3], body, state, places })
    if (method === 'DELETE' && path.startsWith('/api/preservation/')) return { ok: true }
    if (method === 'POST' && /^\/api\/kitchen-batches\/[^/]+\/stages$/.test(path)) return { stage: { id: 'st-1', stage_kind: body.stage_kind } }
    if (path.startsWith('/api/harvests')) return { entries: [], aggregates: { crops: [] } }
    if (path.startsWith('/api/preservation/whats-put-up')) return { groups: [] }
    return null
  }
  fn.state = state
  fn.calls = (method, prefix) => state.calls.filter(c => (!method || c.method === method) && (!prefix || c.path.startsWith(prefix)))
  return fn
}

// An API error the way api.js throws one: Error(body.error) with .status and .body.
export function apiError(status, body) {
  const e = new Error(body?.error ?? `HTTP ${status}`)
  e.status = status
  e.body = body
  return e
}

// A shipped jar record (the whats-put-up / GET /api/preservation/:id shape) as the Pantry row the
// contract's GET /api/pantry would answer for it — for the characterization suites that used to reach
// the jar editor through the retired RecordRow and now reach the SAME editor through the row sheet.
const STATUS = { use_soon: 'soon', past_use_by: 'past' }
export function rowFromRecord(rec, place = { id: rec.storage_location_id ?? 'loc-1', label: 'Garage freezer', kind: 'deep_freezer' }) {
  const left = rec.remaining_count ?? rec.package_count ?? null
  return jarRow({
    stock_id: rec.id, name: rec.label || rec.crop_display_name || rec.crop_type_slug || 'Put-up', place,
    group_key: place?.id ?? 'none', group_label: place?.label ?? 'No place',
    crop_type_slug: rec.crop_type_slug ?? null, batch_id: rec.batch_id ?? null, method: rec.method ?? null,
    stock_mode: rec.stock_mode ?? 'counted', count_left: left, count_made: rec.package_count ?? null,
    grams_left: rec.remaining_amount != null ? Number(rec.remaining_amount) : null,
    discard: { date: rec.use_by_target ?? null, basis: rec.use_by_basis ?? null, status: STATUS[rec.use_by_status] ?? (rec.use_by_target ? 'ok' : null) },
  })
}
