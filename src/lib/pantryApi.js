// src/lib/pantryApi.js
// Put-Up B′ release 2 (V4 §2.5, §5.1; the pinned cross-lane contract) — THE ONE client helper for the
// Pantry routes. Every lane that reads the Pantry list, writes a bought item, records a use or undoes
// one imports it from here; nobody builds a second helper (contract: "other lanes import it and must
// not create a competing helper").
//
// THIN on purpose: each function is one call through the caller's `fetch` (useApiFetch().fetch, which
// resolves '/api/pantry…' to the preservation Lambda through api.js's prefix table and throws Error
// carrying `.status` and `.body` on a non-2xx). No retries, no caching, no state — a failed write keeps
// its inputs and its key in the CALLER (V4 §6.5), which is the only place that knows what to keep.
//
// Keys: every create and every use carries an idempotency key the caller minted once per draft or per
// tap (V4 §5.2; components/kitchen/idempotencyKey.js mintKey). The helpers mint one only when the
// caller passed none, so a caller that retries passes the SAME key back in and gets the replay.
import { mintKey } from '../components/kitchen/idempotencyKey.js'
import { existingPlaceId } from './putUpErrors.js'

export const PANTRY_PATH = '/api/pantry'
export const PANTRY_ITEMS_PATH = '/api/pantry/items'
export const PANTRY_USES_PATH = '/api/pantry/uses'

export const PANTRY_GROUPS = Object.freeze(['place', 'kind'])

// GET /api/pantry?group=place|kind&q=&place_id= — the query string, with every empty part left out.
export function pantryUrl({ group = 'place', q = '', placeId = null } = {}) {
  const params = new URLSearchParams()
  params.set('group', PANTRY_GROUPS.includes(group) ? group : 'place')
  const text = String(q ?? '').trim()
  if (text) params.set('q', text)
  if (placeId != null && String(placeId) !== '') params.set('place_id', String(placeId))
  return `${PANTRY_PATH}?${params.toString()}`
}

// The list's rows, whatever envelope answered: `{ rows }` is the contract; a bare array is read too so
// a server that answers the bare form never silently empties the page (the BUG-GOINGNOWENVELOPE-001
// lesson — coercing an unrecognised payload to [] is what hid a whole feature once already).
export function pantryRows(payload) {
  if (Array.isArray(payload)) return payload
  return Array.isArray(payload?.rows) ? payload.rows : []
}

export async function listPantry(fetch, opts = {}) {
  return pantryRows(await fetch(pantryUrl(opts)))
}

// POST /api/pantry/items → 201 {item} (replay 200 {item, replayed: true}). `body` is the contract
// shape: name, storage_location_id | place:{kind,label}, acquired_at?, acquired_precision?,
// use_by_target?, notes?, plant_id?, crop_type_slug?. Absent keys stay absent.
export async function createPantryItem(fetch, body = {}) {
  const payload = { ...body, idempotency_key: body.idempotency_key ?? mintKey() }
  return fetch(PANTRY_ITEMS_PATH, { method: 'POST', body: JSON.stringify(payload) })
}

// PATCH /api/pantry/items/:id — presence-sentinel: only the keys in `patch` are sent, and an absent
// key is "unchanged". used_up_at takes "now" or null.
export async function patchPantryItem(fetch, id, patch = {}) {
  return fetch(`${PANTRY_ITEMS_PATH}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

// DELETE /api/pantry/items/:id — a soft delete (Remove: "logged by mistake").
export async function deletePantryItem(fetch, id) {
  return fetch(`${PANTRY_ITEMS_PATH}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// POST /api/pantry/uses → {use, jar}. `body`: {preservation_log_id, count_used | all_remaining: true,
// fate?: 'discarded' | 'given_away', idempotency_key?}. Used one = count_used 1; Used it up =
// all_remaining; Gave it away = count_used n + given_away; Went bad = discarded, as a count or as all
// that is left — the row sheet sends all_remaining whenever everything left went bad (what is left
// right now, on a server of any age) and count_used n only for fewer. One of the two, never both.
export async function useJar(fetch, body = {}) {
  const payload = { ...body, idempotency_key: body.idempotency_key ?? mintKey() }
  return fetch(PANTRY_USES_PATH, { method: 'POST', body: JSON.stringify(payload) })
}

// POST /api/pantry/uses/:id/undo {idempotency_key} → {use (the reversing row), jar}. `useId` is the
// use being undone (the `use.id` useJar answered with).
export async function undoUse(fetch, useId, { idempotencyKey } = {}) {
  return fetch(`${PANTRY_USES_PATH}/${encodeURIComponent(useId)}/undo`, {
    method: 'POST', body: JSON.stringify({ idempotency_key: idempotencyKey ?? mintKey() }),
  })
}

// ── The batches the Pantry's jars came from ───────────────────────────────────────────────────────
// GET /api/pantry sends a jar's `batch_id` and nothing else about its batch. The names come from ONE
// read of every batch the household has, going and closed (a jar's batch is usually closed):
// GET /api/kitchen-batches?state=all → { state, batches: [{ id, label, … }] }. `batchNames` turns
// whatever envelope answered into { [batch id]: its name } — the route's `{ state, batches }`, and a
// bare array too, for the reason pantryRows above reads both. A batch with no id or a blank name is
// left out, so a jar whose batch is not in the map says nothing about it rather than "from undefined".
export const BATCH_NAMES_PATH = '/api/kitchen-batches?state=all'

export function batchNames(payload) {
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.batches) ? payload.batches : [])
  const names = {}
  for (const b of list) {
    const label = typeof b?.label === 'string' ? b.label.trim() : ''
    if (b?.id != null && label) names[String(b.id)] = label
  }
  return names
}

export async function listBatchNames(fetch) {
  return batchNames(await fetch(BATCH_NAMES_PATH))
}

// ── Places ───────────────────────────────────────────────────────────────────────────────────────
// A pantry item's Move is a PATCH of storage_location_id, which takes an id. A template chip ("Fridge"
// with no place of that kind yet, putItUp.js placeChips) has none, so it is made first through the
// storage Lambda's find-or-create (200 `existing: true` for a place already there; a 409 place_exists
// from an older server names the place meant). Returns the place's id as a string.
export async function ensurePlaceId(fetch, place) {
  if (!place) throw new Error('no place')
  if (place.id != null && String(place.id) !== '') return String(place.id)
  try {
    const row = await fetch('/api/storage-locations', {
      method: 'POST', body: JSON.stringify({ label: String(place.label ?? '').trim(), kind: place.kind }),
    })
    if (row?.id == null) throw new Error('no place came back')
    return String(row.id)
  } catch (e) {
    const existing = existingPlaceId(e)
    if (existing != null) return existing
    throw e
  }
}
