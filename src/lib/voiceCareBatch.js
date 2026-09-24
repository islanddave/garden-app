// src/lib/voiceCareBatch.js
// V5-VOICECARE-001 — the network half of a spoken care command: the dry run that defines the area's
// plant set (R1), the write (R8) and the undo (R9). The decisions all live in voiceCareResolve.js,
// which is pure; this file only moves them across the wire.
//
// `apiFetch` is INJECTED — the `fetch` from useApiFetch() in the app, a stub in tests. Its contract
// (src/lib/api.js): resolves with the parsed JSON body; on a non-2xx throws an Error carrying
// `.status` and `.body` (the parsed error JSON); on a timeout or while offline throws with
// `.status === 0`.
//
// ── WHY THE WRITE NAMES IDS, NEVER "THE AREA MINUS THE SKIPS" ───────────────────────────────────
// The read-back is a promise about an exact set: "Feed 21 in Pasture In-Ground, skipping Zephyr
// Squash, Crimson Sweet, King Richard". With scope `space` + exclude_plant_ids the server re-resolves
// the area at write time, so a planting the other household member adds or ends between the read-back
// and "next" silently changes what gets written, and an exclusion id that is not in the area silently
// does nothing. With scope `ids` the same drift is a 409 SCOPE_IDS_UNRESOLVED and nothing is written
// (lambda/events/index.js, the count assertion). Log Many's pick mode made the same choice for the
// same reason; here it is a set he HEARD rather than one he can see.
//
// ── THE IDEMPOTENCY KEY IS MINTED AT THE READ-BACK ──────────────────────────────────────────────
// prepareCarePlan() mints it with the plan, so a "next" that times out and is said again replays the
// SAME key, and the server returns the batch it already wrote instead of writing a second one
// (index.js idempotency fast-path). A new command is a new plan and a new key.

import { resolveCareScope, resolveCareCommand } from './voiceCareResolve.js'

// Stamped on every row of a voice batch, as harvest voice stamps harvest_input_source, so voice care
// can be measured later. Accepted by the server as-is: validateEventMetadata polices only the
// water-depth keys, and buildBatchMetadataPlan keeps client keys under its own batch_id/batch_v.
export const CARE_INPUT_SOURCE = 'voice'

export const SCOPE_CHANGED_SPOKEN = 'Nothing was logged — something changed. Say it again.'
// Honest about what it does not know: a timeout can land AFTER the server committed. Retrying with the
// same key is safe either way, which is the one thing worth telling him.
export const NOT_CONFIRMED_SPOKEN = 'I couldn’t confirm that was logged. Say “next” to try again — it won’t log twice.'
export const REJECTED_SPOKEN = 'Nothing was logged — the app refused that request.'
export const UNDONE_SPOKEN = 'Undone.'
export const UNDO_FAILED_SPOKEN = 'Undo didn’t go through — that batch is still logged.'

// Mirrors LogMany.jsx genKey(): randomUUID where the platform has it, a timestamp key otherwise.
export function mintIdempotencyKey(cryptoImpl = globalThis.crypto) {
  try { if (cryptoImpl?.randomUUID) return cryptoImpl.randomUUID() } catch { /* fall through */ }
  return 'k-' + Date.now() + '-' + Math.random().toString(16).slice(2)
}

/**
 * R1 — the area's plant set S. POST /api/events/batch {dry_run:true, scope:{type:'space'}} writes
 * nothing and returns the server's own resolution (live plantings in the location's whole subtree).
 * Returned in the shape resolveCareCommand takes as `scopeSet`. Throws on transport failure and on a
 * body with no plantings list — an unreadable dry run must never be mistaken for an empty area.
 */
export async function fetchCareScopeSet(apiFetch, { eventType, locationId }) {
  const res = await apiFetch('/api/events/batch', {
    method: 'POST',
    body: JSON.stringify({ dry_run: true, event_type: eventType, scope: { type: 'space', location_id: locationId } }),
  })
  if (!res || !Array.isArray(res.plantings)) throw new Error('The area preview came back without a plant list')
  return { locationId, count: res.plantings.length, capped: res.capped === true, plantings: res.plantings }
}

/**
 * R0–R6 end to end: scope -> dry run -> resolve -> a plan armed with its idempotency key.
 * Returns null (not a care command), a refusal, or the plan with `idempotencyKey`. Nothing is written.
 */
export async function prepareCarePlan(apiFetch, {
  care, plantings, locations, aliasIndex = null, rainTomorrow = false, inGroundIds = null,
  mintKey = mintIdempotencyKey,
} = {}) {
  const scope = resolveCareScope(care, locations)
  if (scope == null || scope.kind !== 'care_scope') return scope
  let scopeSet
  try {
    scopeSet = await fetchCareScopeSet(apiFetch, { eventType: care.eventType, locationId: scope.location.id })
  } catch {
    return {
      kind: 'care_refusal', rule: 'R1', reason: 'scope-unavailable',
      spokenReason: `I couldn’t load ${scope.location.full_path ?? scope.location.name} to check it. Nothing was logged.`,
    }
  }
  const plan = resolveCareCommand({ care, plantings, locations, aliasIndex, scopeSet, rainTomorrow, inGroundIds })
  if (plan?.kind !== 'care_plan') return plan
  return { ...plan, idempotencyKey: mintKey() }
}

// R8's body. `ids` + the plan's key + the voice marker, and nothing that could widen the set.
export function careWriteBody(plan) {
  return {
    idempotency_key: plan.idempotencyKey,
    event_type: plan.eventType,
    scope: { type: 'ids', plant_ids: [...plan.keepIds] },
    metadata: { care_input_source: CARE_INPUT_SOURCE },
  }
}

// R9: "Logged <n>." — n is the server's re-read count, not the number asked for. On the (currently
// unreachable) divergence path the server writes fewer than it resolved; the sentence then says so
// rather than agreeing with a number that did not happen.
export function loggedSpoken(count, requested) {
  return count === requested ? `Logged ${count}.` : `Logged ${count} of ${requested}.`
}

/**
 * R8 — write the confirmed plan. Call again with the SAME plan to retry; the key makes it idempotent.
 *
 *   { ok:true, batchId, count, requested, idempotent, warning, spoken }
 *   { ok:false, code:'SCOPE_IDS_UNRESOLVED', retryable:false, unresolvedIds, spoken }  — re-resolve
 *   { ok:false, code:'REJECTED', retryable:false, status, detail, spoken }             — nothing written
 *   { ok:false, code:'NOT_CONFIRMED', retryable:true, status, spoken }                 — outcome unknown
 */
export async function writeCarePlan(apiFetch, plan) {
  if (!plan?.idempotencyKey) throw new Error('A care plan must be armed with its idempotency key at the read-back')
  if (!Array.isArray(plan.keepIds) || !plan.keepIds.length) throw new Error('A care plan must name at least one planting')
  const requested = plan.keepIds.length
  try {
    const res = await apiFetch('/api/events/batch', { method: 'POST', body: JSON.stringify(careWriteBody(plan)) })
    const count = Number(res?.count)
    if (!res?.batch_id || !Number.isFinite(count)) throw new Error('The batch response was unreadable')
    return {
      ok: true,
      batchId: res.batch_id,
      count,
      requested,
      idempotent: res.idempotent === true,
      warning: res.warning ?? null,
      spoken: loggedSpoken(count, requested),
    }
  } catch (e) {
    if (e?.status === 409 && e?.body?.code === 'SCOPE_IDS_UNRESOLVED') {
      return {
        ok: false, code: 'SCOPE_IDS_UNRESOLVED', retryable: false,
        unresolvedIds: e.body.unresolved_plant_ids ?? [], spoken: SCOPE_CHANGED_SPOKEN,
      }
    }
    // Every other 4xx is refused by validation or auth BEFORE the transaction opens, so nothing was
    // written and a retry would be refused the same way.
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
      return { ok: false, code: 'REJECTED', retryable: false, status: e.status, detail: e.message, spoken: REJECTED_SPOKEN }
    }
    return { ok: false, code: 'NOT_CONFIRMED', retryable: true, status: e?.status ?? 0, spoken: NOT_CONFIRMED_SPOKEN }
  }
}

/**
 * R9 — undo a whole voice batch with one durable call. A 404 on a batch id this flow was just handed
 * can only mean it is already undone (the route 404s once undone_at is set), so it reports success:
 * saying "still logged" there would be false.
 */
export async function undoCareBatch(apiFetch, batchId) {
  try {
    await apiFetch(`/api/events/batch/${encodeURIComponent(batchId)}`, { method: 'DELETE' })
    return { ok: true, alreadyUndone: false, spoken: UNDONE_SPOKEN }
  } catch (e) {
    if (e?.status === 404) return { ok: true, alreadyUndone: true, spoken: UNDONE_SPOKEN }
    return { ok: false, status: e?.status ?? 0, spoken: UNDO_FAILED_SPOKEN }
  }
}
