// V3-EVENT-003 — planting/project status changes as first-class events (plants-lambda copy).
// Pure, DB-free: change predicate + the frozen auto-note string + the frozen metadata contract.
// The actual INSERT lives inline in each lambda's status-update transaction (event_log /
// entity_memory have RLS, so the caller must set_config the actor first). Labels are a server
// copy of src/lib/constants.js PLANT_STATUS_MAP / PROJECT_STATUS_MAP and get stored verbatim
// into event_log.notes at write time; keep them in lockstep with constants.js.
const PLANT_STATUS_LABELS = {
  seed: 'Seed', rooting: 'Rooting', seedling: 'Seedling', vegetative: 'Vegetative',
  flowering: 'Flowering', fruiting: 'Fruiting', harvested: 'Harvested', dormant: 'Dormant',
  ended: 'Ended', failed: 'Failed',
};
const PROJECT_STATUS_LABELS = {
  planning: 'Planning', seeding: 'Seeding', sprouting: 'Sprouting', growing: 'Growing',
  flowering: 'Flowering', fruiting: 'Fruiting', harvesting: 'Harvesting',
  active: 'Active', harvested: 'Harvested', ended: 'Ended',
};

export const STATUS_CHANGE_EVENT_TYPE = 'status_change';

function labelFor(level, status) {
  if (status == null) return '(unset)';
  const m = level === 'project' ? PROJECT_STATUS_LABELS : PLANT_STATUS_LABELS;
  return m[status] ?? status;
}

// Null-safe: true ONLY when the status actually changes (never on a same-status save).
export function isStatusChange(oldStatus, newStatus) {
  return (oldStatus ?? null) !== (newStatus ?? null);
}

// Frozen note format (display labels, arrow glyph). Pinned by unit test.
export function formatStatusChangeNote(oldStatus, newStatus, level) {
  return `Status: ${labelFor(level, oldStatus)} → ${labelFor(level, newStatus)}`;
}

// Frozen metadata contract: status_change.v1 — all four keys always present.
export function buildStatusChangeMetadata(oldStatus, newStatus, level) {
  return {
    schema: 'status_change.v1',
    status_from: oldStatus ?? null,
    status_to: newStatus ?? null,
    entity_level: level,
  };
}
