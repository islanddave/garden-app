// ============================================================
// Shared constants — palette, enums, config
// ============================================================

// Color palette — consistent with peppers.futureishere.net
export const P = {
  cream:       '#f8f5f0',
  green:       '#2d6a4f',
  greenLight:  '#52b788',
  greenPale:   '#d8f3dc',
  terra:       '#b7532a',
  gold:        '#8a6e2a',  // darkened for WCAG AA contrast on cream (was #c9a84c)
  dark:        '#1a1a1a',
  mid:         '#4a4a4a',
  light:       '#777',
  border:      '#d4c9be',
  warn:        '#fff8e6',
  warnBorder:  '#c9a84c',
  alert:       '#fde8e0',
  alertBorder: '#b7532a',
  purple:      '#7b5ea7',
  blue:        '#4a7fb5',
  brown:       '#7a5c3c',
  white:       '#ffffff',
}

// Soft enum — suggested event types shown in dropdown, free text always accepted.
// Add new values here as you discover them — no schema change needed.
export const EVENT_TYPES = [
  'sowing',
  'seed_soak',
  'germination',
  'thinning',
  'potting_up',
  'transplant',
  'hardening_off',
  'watering',
  'fertilizing',
  'pest_treatment',
  'pruning',
  'cover',
  'uncover',
  'first_harvest',
  'harvest',
  'observation',
  'photo',
  'other',
]

// Location type_label values for UI icons/display
export const LOCATION_TYPE_LABELS = [
  'zone',
  'rack',
  'shelf',
  'planter',
  'bed',
  'container',
  'tray',
  'row',
  'window',
  'bench',
  'slot',
  'other',
]

// Project statuses — V1+ lifecycle (matches new DB check constraint)
export const PROJECT_STATUSES = [
  'planning',
  'seeding',
  'sprouting',
  'growing',
  'flowering',
  'fruiting',
  'harvesting',
]

// Display mapping — covers both new values and legacy DB values.
// Structure: { label, emoji } — add color here if needed later.
// This is the single source of truth for how any status value renders in UI.
// To re-key a value: update the key here + update PROJECT_STATUSES + run DB migration.
export const PROJECT_STATUS_MAP = {
  // ── New lifecycle values ──────────────────────────────────────────
  planning:   { label: 'Planning',   emoji: '📋' },
  seeding:    { label: 'Seeding',    emoji: '🌰' },
  sprouting:  { label: 'Sprouting',  emoji: '🌱' },
  growing:    { label: 'Growing',    emoji: '🌿' },
  flowering:  { label: 'Flowering',  emoji: '🌸' },
  fruiting:   { label: 'Fruiting',   emoji: '🍅' },
  harvesting: { label: 'Harvesting', emoji: '🧺' },
  // ── Legacy values (existing DB rows — display-only) ───────────────
  active:     { label: 'Active',     emoji: '✅' },
  harvested:  { label: 'Harvested',  emoji: '✓'  },
  ended:      { label: 'Ended',      emoji: '◼'  },
}

// Task priorities
export const TASK_PRIORITIES = ['low', 'normal', 'high']

// Task statuses — matches schema check constraint on tasks.status
export const TASK_STATUSES = ['pending', 'done', 'skipped']

// Inventory item types — matches schema check constraint on inventory.item_type
export const INVENTORY_ITEM_TYPES = ['consumable', 'equipment']

// Inventory subcategories — matches schema check constraint on inventory.subcategory
// Used in both Inventory.jsx and the SQL schema CHECK constraint
// {v: db value, label: display label, types: item_types this applies to}
export const INVENTORY_SUBCATEGORIES = [
  { v: 'seeds',        label: 'Seeds',          types: ['consumable'] },
  { v: 'growing_media',label: 'Growing media',  types: ['consumable'] },
  { v: 'fertilizer',   label: 'Fertilizer',     types: ['consumable'] },
  { v: 'pest_control', label: 'Pest control',   types: ['consumable'] },
  { v: 'containers',   label: 'Containers',     types: ['consumable', 'equipment'] },
  { v: 'lighting',     label: 'Lighting',       types: ['equipment'] },
  { v: 'shelving',     label: 'Shelving',       types: ['equipment'] },
  { v: 'hand_tools',   label: 'Hand tools',     types: ['equipment'] },
  { v: 'misc',         label: 'Misc',           types: ['consumable', 'equipment'] },
]

// Legacy — kept for any code that still references INVENTORY_CATEGORIES
// TODO: remove after confirming no other code uses this
export const INVENTORY_CATEGORIES = [
  'seed', 'fertilizer', 'soil_amendment', 'container', 'tool', 'pest_control', 'other',
]

// Project categories — used in project_types table and ProjectTypes.jsx
export const PROJECT_CATEGORIES = [
  { v: 'garden',         label: 'Garden' },
  { v: 'infrastructure', label: 'Infrastructure' },
]

export const APP_NAME = 'Gardens at Home'
export const PHOTO_BUCKET = 'garden-photos'

// Public URL base — used for canonical links, og:url, GCal descriptions (Phase 3+)
export const APP_URL = 'https://garden.futureishere.net'
