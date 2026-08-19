// V4-BATCHUNDO-001 — client helpers for the DURABLE undo of a Log-Many batch.
//
// WHY THIS FILE EXISTS. The whole server side has been live on prod since W-BATCHNULL and had ZERO
// callers in src/: `GET /api/events/batches` (lambda/events/index.js) and the hardened
// `DELETE /api/events/batch/:id` transaction next to it. Meanwhile the only undo the app ever
// offered lived inside LogMany's `result &&` success block — navigate away and a mis-scoped batch of
// up to 157 rows was unrecoverable by anything short of deleting each event by hand. This module is
// the seam that reaches the deployed capability; nothing here is a new contract.
//
// THE SERVER'S SHAPE, verbatim from the handler (do not widen it here — a client-side guess about a
// field the endpoint does not send is how a surface starts lying):
//   { batches: [ { id, event_type, scope_json, item_count, event_date, created_at } ] }
// filtered to `created_by = <viewer> AND undone_at IS NULL AND status = 'complete'`, newest first,
// LIMIT 10. Two consequences the UI must respect and this module encodes:
//   • Membership is the ONLY undoability test the client can make. A batch absent from this list is
//     already undone, older than the last ten, or someone else's — all three mean the DELETE would
//     404, so an Undo affordance must render from set membership, never from "this row has a
//     batch_id".
//   • Ten is a server cap, not a total. Nothing built on this may imply it lists every batch.

export const BATCHES_PATH = '/api/events/batches'

export const batchUndoPath = (id) => `/api/events/batch/${id}`

// Coerce the server's item_count to a number we are willing to PUT IN FRONT OF A DESTRUCTIVE BUTTON.
// Postgres bigint arrives as a string through some driver paths, so Number() is required; anything
// that is not a positive finite integer becomes null so the confirm falls back to non-numeric copy
// rather than promising to remove "NaN entries".
function rowCount(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

// Accepts the documented `{ batches: [...] }` envelope and, defensively, a bare array — several
// routes in this app return one or the other and a shape mismatch here would silently disable the
// feature rather than fail loudly. Rows with no id are dropped: an id is the DELETE path.
export function normalizeBatches(payload) {
  const raw = Array.isArray(payload) ? payload : (Array.isArray(payload?.batches) ? payload.batches : [])
  const out = []
  for (const b of raw) {
    if (!b || b.id == null) continue
    out.push({
      id: String(b.id),
      event_type: b.event_type ?? null,
      item_count: rowCount(b.item_count),
      event_date: b.event_date ?? null,
      created_at: b.created_at ?? null,
    })
  }
  return out
}

// id -> batch. A Map (not a Set) because the confirm needs the batch's OWN item_count: the feed row
// carries a count too, but it comes from a LEFT JOIN on the same column and the batches list is the
// record that actually governs whether the DELETE will succeed. Prefer the authority you are about
// to act against.
export function undoableById(batches) {
  const m = new Map()
  for (const b of normalizeBatches(batches)) m.set(b.id, b)
  return m
}

// The count the confirm sentence is built from: the batches list first, the collapsed feed entry's
// batch_count as the fallback (feed.js sets it from event_batches.item_count too, so the two agree
// in the normal case and the fallback only matters if one of them is missing).
export function undoRowCount(batch, fallback) {
  return batch?.item_count ?? rowCount(fallback)
}
