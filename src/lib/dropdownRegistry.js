// src/lib/dropdownRegistry.js
// V3-CONFIG-001 — canonical home for cross-view dropdown vocabulary. A value set defined
// here is the SINGLE source of truth so a form Select and a detail-page label map can never
// drift. First consolidation: planting source_type (was duplicated in PlantForm.jsx as
// PLANT_SOURCE_OPTIONS and PlantingDetail.jsx as SOURCE_LABELS). Future consolidations land
// here too (event metadata fields + harvest quality labels currently trapped in EventNew.jsx;
// location-type labels). Plain JS, no framework deps.

// Canonical taxonomies consumed below (V3-CONFIG-001 ext). These are the SINGLE
// sources; the option/label sets here are DERIVED from them so they cannot drift.
import { EVENT_TYPES, EVENT_TYPE_META } from './eventTypes.js'
import { PROJECT_CATEGORIES } from './constants.js'

// V4-SOURCEFREE-001 (2026-07-07): single source of truth for planting source_type. The server
// field is now FREE-TEXT (no Lambda allowlist) and the DB CHECK was dropped, so options can be
// added here freely without a backend/DDL change. Empty sentinel = the form Select's "not
// specified" option; the host coerces '' -> null before sending.
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
  { value: 'plant_swap', label: 'Plant swap' },
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
// PLANT-CONTAINER-001 / V4-POT-001: container type for pot/bag descriptor
export const PLANT_CONTAINER_TYPE_OPTIONS = [
  { value: '', label: '— Not specified —' },
  { value: 'fabric_bag', label: 'Fabric grow bag' },
  { value: 'plastic_pot', label: 'Plastic pot' },
  { value: 'terracotta', label: 'Terracotta / clay' },
  { value: 'ceramic', label: 'Ceramic / glazed' },
  { value: 'raised_bed', label: 'Raised bed' },
  { value: 'in_ground', label: 'In ground' },
  { value: 'tray_cell', label: 'Seedling tray / cell' },
  { value: 'hanging_basket', label: 'Hanging basket' },
  { value: 'window_box', label: 'Window box' },
  { value: 'trough', label: 'Trough' },
  { value: 'whiskey_barrel', label: 'Whiskey barrel' },
  { value: 'soil_block', label: 'Soil block' },
  { value: 'solo_cup', label: 'Solo cup' },
  { value: 'other', label: 'Other' },
]
export const PLANT_CONTAINER_TYPE_LABELS = Object.fromEntries(
  PLANT_CONTAINER_TYPE_OPTIONS.filter(o => o.value !== '').map(o => [o.value, o.label])
)

// V3-CONFIG-001 ext: event-type vocab for plain <select> edit surfaces (EventDetail).
// Sourced from the canonical EVENT_TYPES taxonomy + EVENT_TYPE_META emojis (single
// source — labels are DERIVED, never hand-listed, so they cannot drift from EVENT_TYPES).
// Label shape mirrors the legacy EventDetail rendering exactly: emoji + de-snaked value
// (e.g. "🌰 sowing"), NOT the META prose label — this is a sourcing refactor, not a UX
// change. Options are pre-sorted alpha by the raw value (matching the old in-place sort).
const eventTypeLabel = (t) => (EVENT_TYPE_META[t]?.emoji ?? '📝') + ' ' + t.replace(/_/g, ' ')

export const EVENT_TYPE_OPTIONS = [...EVENT_TYPES]
  .sort((a, b) => a.localeCompare(b))
  .map(t => ({ value: t, label: eventTypeLabel(t) }))

export const EVENT_TYPE_LABELS = Object.fromEntries(
  EVENT_TYPE_OPTIONS.map(o => [o.value, o.label])
)

// V3-CONFIG-001 ext: project-category vocab (project_types.category). Sourced from the
// canonical PROJECT_CATEGORIES taxonomy in constants.js (which uses the {v,label} shape).
// Re-exported as {value,label} so it composes with the Select primitive uniformly; the
// label map is derived so it cannot drift from the option set.
export const PROJECT_CATEGORY_OPTIONS = PROJECT_CATEGORIES.map(c => ({ value: c.v, label: c.label }))

export const PROJECT_CATEGORY_LABELS = Object.fromEntries(
  PROJECT_CATEGORY_OPTIONS.map(o => [o.value, o.label])
)


// V4-FLAG-001 — flag-issue vocabulary (single source of truth; consumed by EventNew Flag mode).
export const SEVERITY_LEVELS = [
  { value: 1, label: 'Keeping an eye on it', tone: 'gold' },
  { value: 2, label: 'Needs attention', tone: 'terra' },
  { value: 3, label: 'Urgent', tone: 'red' },
]

// Static seeded issue list (Slice 1). Values ARE the stored label (metadata.issue_label, free text).
export const ISSUE_OPTIONS = [
  { group: 'Pests', options: ['Aphids', 'Spider mites', 'Whiteflies', 'Thrips', 'Fungus gnats', 'Caterpillars / loopers', 'Slugs / snails', 'Squash bugs', 'Cucumber beetles', 'Flea beetles', 'Tomato hornworm', 'Scale', 'Mealybugs'] },
  { group: 'Disease', options: ['Powdery mildew', 'Downy mildew', 'Early blight', 'Late blight', 'Leaf spot', 'Gray mold (botrytis)', 'Rust', 'Damping off', 'Bacterial wilt', 'Mosaic virus'] },
  { group: 'Disorders', options: ['Blossom-end rot', 'Cracking / splitting', 'Sunscald', 'Catfacing', 'Bolting', 'Edema'] },
  { group: 'Deficiency', options: ['Nitrogen deficiency', 'Phosphorus deficiency', 'Potassium deficiency', 'Magnesium deficiency', 'Iron chlorosis', 'Calcium deficiency'] },
  { group: 'Environmental & damage', options: ['Heat stress', 'Cold / frost damage', 'Wind damage', 'Drought stress', 'Overwatering', 'Transplant shock', 'Physical damage'] },
  { group: 'Animal', options: ['Deer browsing', 'Rabbit damage', 'Rodent damage', 'Bird damage', 'Groundhog / woodchuck'] },
]
