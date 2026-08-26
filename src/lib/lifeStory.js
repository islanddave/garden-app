// V4-PLANTINGUI-001 — life-story milestone spine for a planting.
// Pure: derives an ordered list of lifecycle MILESTONES from the planting's own date fields.
// This is intentionally NOT the event ledger (the Event log section keeps that) — it's the
// crop's lifecycle arc, so the full event-log contract is untouched.

function parseDate(value) {
  if (!value) return null
  const d = new Date(typeof value === 'string' && value.length === 10 ? value + 'T00:00:00' : value)
  return isNaN(d.getTime()) ? null : d
}

// Ordered milestone definitions: [field, approxField, key, label, iconName].
//
// V4-ICON-001 (done). These are lifecycle STAGES — meaningful — so each carries a registry KEY and
// LifeStoryTimeline resolves it; this module stays pure and JSX-free.
//
// `planted_out` was the one open design call, and it is care.plantedOut — a NEWLY DRAWN glyph, not
// a reuse. The obvious reuse was event.transplant, and it is wrong here for a specific reason: the
// `transplanted` row sits DIRECTLY ABOVE this one, so the same mark twice would make two adjacent
// milestones visually identical, which loses the distinction the timeline exists to draw. It could
// not live under event.* either — eventTypeIconWiring.test.js pins event.* 1:1 against EVENT_TYPES,
// and planted_out is a date field, not an event type. See iconAnchors.js for the form's rationale.
const MILESTONES = [
  ['sown_at', 'sown_at_approx', 'sown', 'Sown', 'event.sowing'],
  ['germinated_at', 'germinated_at_approx', 'germinated', 'Germinated', 'event.germination'],
  ['transplanted_at', 'transplanted_at_approx', 'transplanted', 'Transplanted', 'event.transplant'],
  ['planted_out_at', 'planted_out_at_approx', 'planted_out', 'Planted out', 'care.plantedOut'],
  ['first_harvest_at', null, 'first_harvest', 'First harvest', 'event.first_harvest'],
]

// buildLifeStory(planting) -> [{ key, label, iconName, date(Date), approx(bool) }] ascending by
// date. Milestones with no date are omitted. Stable: ties keep MILESTONES declaration order.
export function buildLifeStory(planting) {
  if (!planting) return []
  const rows = []
  MILESTONES.forEach(([field, approxField, key, label, iconName], idx) => {
    const date = parseDate(planting[field])
    if (!date) return
    rows.push({ key, label, iconName, date, approx: approxField ? Boolean(planting[approxField]) : false, _ord: idx })
  })
  rows.sort((a, b) => (a.date - b.date) || (a._ord - b._ord))
  return rows.map(({ _ord, ...r }) => r)
}
