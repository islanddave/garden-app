// src/lib/dropdownRegistry.js
// V3-CONFIG-001 — canonical home for cross-view dropdown vocabulary. A value set defined
// here is the SINGLE source of truth so a form Select and a detail-page label map can never
// drift. First consolidation: planting source_type (was duplicated in PlantForm.jsx as
// PLANT_SOURCE_OPTIONS and PlantingDetail.jsx as SOURCE_LABELS). Future consolidations land
// here too (event metadata fields + harvest quality labels currently trapped in EventNew.jsx;
// location-type labels). Plain JS, no framework deps.

// Mirrors the plants Lambda ALLOWED_SOURCE enum verbatim. The empty sentinel is the form
// Select's "not specified" option; the host coerces '' -> null before sending.
export const PLANT_SOURCE_OPTIONS = [
  { value: '', label: '— Not specified —' },
  { value: 'seed_packet', label: 'Seed packet' },
  { value: 'nursery_transplant', label: 'Bought as transplant' },
  { value: 'division', label: 'Divided from another plant' },
  { value: 'volunteer', label: 'Volunteer / self-sown' },
  { value: 'gift', label: 'Gift' },
  { value: 'saved_seed', label: 'Saved seed' },
  { value: 'cutting_taken', label: 'Cutting taken' },
  { value: 'rescued', label: 'Rescued' },
  { value: 'unknown', label: 'Not sure' },
]

// Display label lookup (value -> label), derived from the options so it cannot drift.
// The empty sentinel is excluded: a null/absent source_type renders nothing, not the placeholder.
export const PLANT_SOURCE_LABELS = Object.fromEntries(
  PLANT_SOURCE_OPTIONS.filter(o => o.value !== '').map(o => [o.value, o.label])
)
