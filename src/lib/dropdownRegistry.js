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

// Per-type metadata field definitions for Tier 2 enrichment (moved from EventNew.jsx).
// Shape: { [event_type]: [{ key, label, type, options? }] }
export const EVENT_METADATA_FIELDS = {
  sowing:        [
    { key: 'depth_cm',                  label: 'Sowing depth (cm)',        type: 'number' },
    { key: 'spacing_cm',                label: 'Spacing (cm)',              type: 'number' },
    { key: 'germination_expected_days', label: 'Expected germination (days)', type: 'number' },
  ],
  germination:   [
    { key: 'days_to_germinate',      label: 'Days to germinate',    type: 'number' },
    { key: 'germination_rate_pct',   label: 'Germination rate (%)', type: 'number' },
  ],
  observation:   [
    { key: 'height_cm',   label: 'Height (cm)',  type: 'number' },
    { key: 'leaf_count',  label: 'Leaf count',   type: 'number' },
    { key: 'health',      label: 'Health',        type: 'select', options: ['excellent', 'good', 'fair', 'poor', 'critical'] },
  ],
  watering:      [
    { key: 'amount_ml', label: 'Amount (ml)', type: 'number' },
  ],
  fertilizing:   [
    { key: 'product',   label: 'Product / mix',   type: 'text' },
    { key: 'dilution',  label: 'Dilution ratio',  type: 'text' },
    { key: 'amount_ml', label: 'Amount (ml)',      type: 'number' },
  ],
  harvest:       [
    { key: 'weight_g', label: 'Weight (g)', type: 'number' },
    { key: 'count',    label: 'Count',      type: 'number' },
    { key: 'quality',  label: 'Quality',    type: 'select', options: ['excellent', 'good', 'fair', 'poor'] },
  ],
  first_harvest: [
    { key: 'weight_g', label: 'Weight (g)', type: 'number' },
    { key: 'count',    label: 'Count',      type: 'number' },
  ],
  pest_treatment: [
    { key: 'pest',      label: 'Pest / disease', type: 'text' },
    { key: 'treatment', label: 'Treatment used', type: 'text' },
  ],
}

// V1.2a-2 Wave 3: harvest panel — anchored quality scale (NOT a star widget).
// Moved from EventNew.jsx so EventDetail and any future harvest summary surfaces
// can share the same label map without re-declaring it.
export const HARVEST_QUALITY_LABELS = {
  1: 'inedible',
  2: 'poor',
  3: 'acceptable',
  4: 'good',
  5: 'excellent',
}
