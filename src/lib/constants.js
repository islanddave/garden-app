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
  // ── DESIGNSYS Pass A: drift-literal promotion (V4-DESIGNSYS-001) ──────────
  // Hexes lifted verbatim from status.js / formStyles bannerChrome / SeverityBadge.
  // Parity-preserving: same exact values, now single-sourced.
  statusInkGold:       '#7a5c00',  // status.js planning/harvesting text ink
  neutralFill:         '#eee',     // status.js harvested/ended/dormant bg
  bannerInk:           '#7a2a10',  // formStyles bannerChrome text
  severityStaleBorder: '#d4b556',  // SeverityBadge stale border/text/icon
  preparingFill:       '#f0e9e0',  // status.js preparing stage bg
  badgeInfoBg:         '#e8f0fa',  // forms/Badge info tone bg
  // ── FACET token set (contract §4) — additive, unused until TAGSUB. AA-checked draft. ──
  fTypeBg:     '#e6f0e8', fTypeText:     '#1f5138', fTypeBorder:     '#bcd7c4',
  fGroupBg:    '#eef0fa', fGroupText:    '#3a3f6b', fGroupBorder:    '#c9cdec',
  fLocationBg: '#f3ece2', fLocationText: '#6b4f2a', fLocationBorder: '#ddcdb6',
  fFreeformBg: '#f0efed', fFreeformText: '#4a4a4a', fFreeformBorder: '#d9d4cd',
}

// Soft enum — suggested event types shown in dropdown, free text always accepted.
// V3-EVENT-008: the master list moved to the canonical src/lib/eventTypes.js
// (single source of truth). Re-exported here so the 5 existing importers of
// EVENT_TYPES from constants.js keep working unchanged. Add new values in
// eventTypes.js, NOT here.
export { EVENT_TYPES } from './eventTypes.js'

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
  'preparing',
  'seeding',
  'sprouting',
  'growing',
  'flowering',
  'fruiting',
  'harvesting',
]

// Statuses for which a project appears in the event-logging picker (EventNew).
// Harvest is REPEATABLE (Dave directive 2026-06-04, E3): a 'harvested' project MUST stay
// loggable — you can harvest many times; harvesting is not the end of the process. So
// 'harvested' is loggable IN ADDITION to the active lifecycle stages. Only 'ended'
// (deliberately, truly done) and the legacy pre-lifecycle 'active' value stay excluded.
export const LOGGABLE_PROJECT_STATUSES = [...PROJECT_STATUSES, 'harvested']

// Display mapping — covers both new values and legacy DB values.
// Structure: { label, emoji } — add color here if needed later.
// This is the single source of truth for how any status value renders in UI.
// To re-key a value: update the key here + update PROJECT_STATUSES + run DB migration.
export const PROJECT_STATUS_MAP = {
  // ── New lifecycle values ──────────────────────────────────────────
  planning:   { label: 'Planning',   emoji: '📋' },
  preparing:  { label: 'Preparing',  emoji: '🛠️' },
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

// Plant lifecycle statuses — plants.status. The DB DOES enforce a CHECK constraint
// `chk_plants_status` (verified live on prod Neon 2026-06-08; the earlier "free-text,
// no CHECK" note was stale folklore). This list MUST stay a subset of that constraint —
// adding a value here requires widening chk_plants_status first (see
// v3-status-source-check-widen-migration-V100, V3-STATUS-002). Single source of truth for
// the plant-status vocabulary; do NOT redefine inline (was inline in Plants.jsx).
// V3-STATUS-003: custom lifecycle ORDER (not alpha) — StatusSelect renders plant statuses in this
// exact sequence. Values unchanged (subset of chk_plants_status); only order + the 'harvested' label.
export const PLANT_STATUSES = ['seed', 'seedling', 'vegetative', 'flowering', 'fruiting', 'harvested', 'ended', 'failed', 'rooting', 'dormant']

// Display mapping for plant statuses — { label, emoji }. Mirrors PROJECT_STATUS_MAP.
// Colors live in status.js STATUS_COLORS (shared with project stages).
export const PLANT_STATUS_MAP = {
  seed:       { label: 'Seed',       emoji: '🌰' },
  rooting:    { label: 'Rooting',    emoji: '🫚' },  // V3-STATUS-002: cuttings/propagation
  seedling:   { label: 'Seedling',   emoji: '🌱' },
  vegetative: { label: 'Vegetative', emoji: '🌿' },
  flowering:  { label: 'Flowering',  emoji: '🌸' },
  fruiting:   { label: 'Fruiting',   emoji: '🍅' },
  harvested:  { label: 'Harvesting', emoji: '✅' },  // V3-STATUS-003: label-only rename (DB value stays 'harvested')
  dormant:    { label: 'Dormant',    emoji: '💤' },
  ended:      { label: 'Ended',      emoji: '⏹️' },
  failed:     { label: 'Failed',     emoji: '✕' },
}

// Humanize any status value for display. Prefers the plant map, then the project
// map, else returns the raw value (so an unknown status still renders, un-snaked).
export function statusLabel(status) {
  return PLANT_STATUS_MAP[status]?.label ?? PROJECT_STATUS_MAP[status]?.label ?? status
}

// Project kinds — plant_projects.kind. Canonical values match the live DB CHECK
// (kind IN ('campaign','category','cultivar') OR NULL) + the projects Lambda
// ALLOWED_KINDS. Single source for ProjectNew (user) AND ProjectsAdminClassify
// (admin). `cultivar` is flag-gated in the USER UI until VARIETY_REF_UI_SHIPPED;
// the admin tool always includes it. Both derive options from projectKindOptions()
// so the gating logic lives in ONE place (was duplicated/divergent).
export const PROJECT_KINDS = ['campaign', 'category', 'cultivar']
export const PROJECT_KIND_MAP = {
  campaign: { label: 'Growing this season' },
  category: { label: 'Folder for organizing' },
  cultivar: { label: 'Cultivar reference' },
}
export function projectKindOptions(includeCultivar = false) {
  return PROJECT_KINDS
    .filter(k => k !== 'cultivar' || includeCultivar)
    .map(k => ({ value: k, label: PROJECT_KIND_MAP[k].label }))
}

// Task priorities
export const TASK_PRIORITIES = ['low', 'normal', 'high']

// Task statuses — matches schema check constraint on tasks.status
export const TASK_STATUSES = ['pending', 'done', 'skipped']

// Inventory enums moved to src/lib/inventoryEnums.js (V3-FORMSYS-001 §4). The prior
// item-types / subcategories / categories exports here were STALE (claimed schema-match
// but used dead 'equipment'/'fertilizer'/'hand_tools'/'misc' values not in the live
// inventory_items CHECK) and had zero importers. Use inventoryEnums.js.

// Project categories — used in project_types table and ProjectTypes.jsx
export const PROJECT_CATEGORIES = [
  { v: 'garden',         label: 'Garden' },
  { v: 'infrastructure', label: 'Infrastructure' },
]

export const APP_NAME = 'Gardens at Mathews'
export const PHOTO_BUCKET = 'garden-photos'

// Public URL base — used for canonical links, og:url, GCal descriptions (Phase 3+)
export const APP_URL = 'https://garden.futureishere.net'
