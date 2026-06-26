// V4-PLANTINGUI-001 — life-story milestone spine for a planting.
// Pure: derives an ordered list of lifecycle MILESTONES from the planting's own date fields.
// This is intentionally NOT the event ledger (the Event log section keeps that) — it's the
// crop's lifecycle arc, so the full event-log contract is untouched.

function parseDate(value) {
  if (!value) return null
  const d = new Date(typeof value === 'string' && value.length === 10 ? value + 'T00:00:00' : value)
  return isNaN(d.getTime()) ? null : d
}

// Ordered milestone definitions: [field, approxField, key, label, glyph].
const MILESTONES = [
  ['sown_at', 'sown_at_approx', 'sown', 'Sown', '🌰'],
  ['germinated_at', 'germinated_at_approx', 'germinated', 'Germinated', '🌱'],
  ['transplanted_at', 'transplanted_at_approx', 'transplanted', 'Transplanted', '🪴'],
  ['planted_out_at', 'planted_out_at_approx', 'planted_out', 'Planted out', '🌿'],
  ['first_harvest_at', null, 'first_harvest', 'First harvest', '🧺'],
]

// buildLifeStory(planting) -> [{ key, label, glyph, date(Date), approx(bool) }] ascending by date.
// Milestones with no date are omitted. Stable: ties keep MILESTONES declaration order.
export function buildLifeStory(planting) {
  if (!planting) return []
  const rows = []
  MILESTONES.forEach(([field, approxField, key, label, glyph], idx) => {
    const date = parseDate(planting[field])
    if (!date) return
    rows.push({ key, label, glyph, date, approx: approxField ? Boolean(planting[approxField]) : false, _ord: idx })
  })
  rows.sort((a, b) => (a.date - b.date) || (a._ord - b._ord))
  return rows.map(({ _ord, ...r }) => r)
}
