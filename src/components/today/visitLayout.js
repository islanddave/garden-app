// visitLayout — the Today care list's VISIT layer: the section order a list held and the sections that
// were open on it, kept for the rest of the plan day in this tab (BUG-TODAYBACKRESORT-001).
//
// WHY. Planting routes are not overlays: tapping a plant on Today unmounts Today, and Back mounts a new
// CareNeeded, which took a fresh layout from the refetched plan — so the sections Dave had been working
// down came back in a different order, with the work he had just done ranked out of them. Dave,
// 2026-09-28: Back keeps the Needs-care order for the rest of the plan day. CareNeeded reads this in a
// state initialiser, so a remount adopts the held layout during render and never paints a fresh one
// over it; it writes here whenever the held layout or the open set changes.
//
// sessionStorage, NOT localStorage: this is the tab's visit, not a preference. It must not outlive the
// tab, and a new tab (a fresh visit) must take a fresh layout exactly as before.
//
// Keyed by signed-in user + plan_date + list ('own', or the household member's id — each list holds its
// own order). No user or no plan date = no key = nothing held: an identity-less entry could be read by
// the next person to sign in, and an undated one could never reset. The date is in the key so a new plan
// day starts fresh; writing prunes every other day's keys. Sign-out removes the whole family
// (clientPrefs.js CLIENT_SESSION_KEY_PREFIXES).
//
// Holds ONLY the section order and the open set, plus the two facts needed to read that order back: the
// grouping it is in (`mode`; By type keys are need names, By location keys are place ids) and whether it
// was taken after the location names landed (`enriched`; before that the same rows are keyed by project,
// a different set of sections). Never rows — row order inside a section follows each plan refresh, on
// purpose — and never the fades, pendingKeys or any in-flight guard: those stay in memory, because a
// restored fade could hide a row that is due.
//
// V2 reuses this store for its own Back restore (plan-v2 §2.1 Layer 2) under its own `list` names.

export const VISIT_PREFIX = 'today-visit:'

const enc = (s) => encodeURIComponent(String(s))

export function visitLayoutKey(userId, planDate, list = 'own') {
  if (!userId || !planDate) return null
  return VISIT_PREFIX + enc(userId) + ':' + enc(planDate) + ':' + enc(list || 'own')
}

function valid(v) {
  return !!v && v.v === 1 && (v.mode === 'location' || v.mode === 'type') && typeof v.enriched === 'boolean'
    && Array.isArray(v.order) && Array.isArray(v.open)
}

// -> { mode, enriched, order: [groupKey…], open: [groupKey…] } | null. Anything unreadable is null: a
// fresh take, never an error on the way into Today.
export function readVisitLayout(key) {
  if (!key) return null
  try {
    const v = JSON.parse(sessionStorage.getItem(key) || 'null')
    return valid(v) ? { mode: v.mode, enriched: v.enriched, order: v.order, open: v.open } : null
  } catch { return null }
}

// `layout` null removes the entry (nothing is held, so a remount takes fresh — as the mounted list would).
export function writeVisitLayout(key, layout) {
  if (!key) return
  try {
    if (!layout) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify({
      v: 1, mode: layout.mode, enriched: !!layout.enriched, order: [...layout.order], open: [...layout.open],
    }))
    pruneOtherDays(key)
  } catch { /* storage full or blocked: the list simply holds nothing across a remount */ }
}

// ── V2 (V5-TODAYREDESIGN-001 S2, plan-v2 §2.1 Layer 2, §2.2) ──────────────────────────────────────────────
// The redesigned Today's visit, in THIS store: the same key shape (user + plan_date + list, V2's list being
// 'v2'), the same per-day prune, the same sign-out scrub. A different RECORD, tagged kind 'v2', because a
// V2 visit holds what V1's never needed — the open state it started with (`layer1`, Layer 1 as read at the
// visit's ready point), the visit overlays (Expand/Collapse all, a chip jump, a trigger), the triggers that
// fired, and the sections present at the ready point (their slots are held for the visit). Later slices add
// their own fields (spots, done lines, failed rows); the whole record round-trips, so they need no new store.
// V1's readVisitLayout rejects a V2 record (no mode), and V1 never reads a 'v2' key anyway.
export const V2_LIST = 'v2'

function validV2(v) {
  return !!v && v.v === 1 && v.kind === 'v2' && typeof v.id === 'string' && !!v.order && Array.isArray(v.order.sections)
    && !!v.layer1 && typeof v.layer1 === 'object' && !!v.overlay && typeof v.overlay === 'object'
}

// -> the stored V2 record | null. Unreadable, invalid or another record kind = null (a fresh visit).
export function readVisitRecord(key) {
  if (!key) return null
  try {
    const v = JSON.parse(sessionStorage.getItem(key) || 'null')
    return validV2(v) ? v : null
  } catch { return null }
}

// `record` null removes the entry.
export function writeVisitRecord(key, record) {
  if (!key) return
  try {
    if (!record) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify({ ...record, v: 1, kind: 'v2' }))
    pruneOtherDays(key)
  } catch { /* storage full or blocked: Back simply takes a fresh visit */ }
}

// Every visit key whose plan_date is not this key's. Snapshot first: Storage.key(i) re-indexes on removal.
function pruneOtherDays(key) {
  const day = key.slice(VISIT_PREFIX.length).split(':')[1]
  const stale = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i)
    if (k && k.startsWith(VISIT_PREFIX) && k.slice(VISIT_PREFIX.length).split(':')[1] !== day) stale.push(k)
  }
  for (const k of stale) sessionStorage.removeItem(k)
}
