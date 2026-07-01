// Event -> planting status transitions (V3-FRUITSET-001).
// Single source of truth for which prior statuses may auto-advance to 'fruiting'
// when a `fruit_set` event is logged on a specific planting. Forward-only:
// terminal/past states (fruiting/harvested/dormant/failed/ended) and NULL never advance.
// garden_node has NO row-level security (verified 2026-06-18), so the consuming UPDATE
// MUST scope ownership explicitly via container.created_by = ANY(householdIds) — actor
// set_config does NOT protect this table (L-087). The IN-list below is the only knob;
// the UPDATE in index.js binds this array directly (status = ANY(${FRUITING_SOURCE_STATUSES})).
export const FRUITING_SOURCE_STATUSES = ['seed', 'rooting', 'seedling', 'vegetative', 'flowering'];

// Pure predicate mirror for unit tests + any future JS-side use. The DB UPDATE is the
// authoritative enforcement; this stays in lockstep with FRUITING_SOURCE_STATUSES.
export function advancesToFruiting(eventType, status) {
  return eventType === 'fruit_set' && FRUITING_SOURCE_STATUSES.includes(status);
}

// V3-FLOWERING-001 — forward-only flowering -> flowering transition guard (mirrors the
// fruit_set pattern above). Which prior statuses may auto-advance to 'flowering' when a
// `flowering` event is logged on a specific planting. Forward-only: 'flowering' itself and
// every later/terminal state (fruiting/harvested/dormant/failed/ended) and NULL never advance.
// Same no-RLS caveat: the consuming UPDATE in index.js scopes ownership explicitly via
// container.created_by = ANY(householdIds) (L-087). The IN-list below is the only knob.
export const FLOWERING_SOURCE_STATUSES = ['seed', 'rooting', 'seedling', 'vegetative'];

// Pure predicate mirror for unit tests + any future JS-side use. The DB UPDATE is the
// authoritative enforcement; this stays in lockstep with FLOWERING_SOURCE_STATUSES.
export function advancesToFlowering(eventType, status) {
  return eventType === 'flowering' && FLOWERING_SOURCE_STATUSES.includes(status);
}
