// ============================================================
// Shared constants — palette, enums, config
// ============================================================

// Color palette — consistent with peppers.futureishere.net
export const P = {
  cream:       '#f8f5f0',
  green:       '#2d6a4f',
  greenLight:  '#52b788',
  greenPale:   '#d8f3dc',
  sage:        '#7c9885',  // muted sage; LocationDetail card borders and PhotoUpload reference it
  terra:       '#b7532a',
  gold:        '#8a6e2a',  // darkened for WCAG AA contrast on cream
  dark:        '#1a1a1a',
  mid:         '#4a4a4a',
  light:       '#707070',  // darkened for WCAG AA on cream and white; #717171 fails on cream, so this is the boundary, not a round number
  border:      '#d4c9be',
  warn:        '#fff8e6',
  warnBorder:  '#c9a84c',
  alert:       '#fde8e0',
  alertBorder: '#b7532a',
  purple:      '#7b5ea7',
  blue:        '#4a7fb5',
  brown:       '#7a5c3c',
  white:       '#ffffff',
  // On-photo (scrim) surface tokens. The scrim GRADIENTS are rgba-black
  // literals authored inline in HeroPhoto (no palette token — they're translucent black,
  // like Lightbox's backdrop); onPhotoFg is the white ink that rides on those scrims.
  onPhotoFg:    '#ffffff',  // on-photo foreground (name/icon ink over a dark scrim)
  photoScrim:   '#000000',  // base color the hero scrim gradients fade from/to (rgba()'d inline)
  greenDeep:    '#1f5138',  // named icon-default ink (= fTypeText value, AAA on cream)
  // ── Drift-literal promotion ───────────────────────────────────────────────
  // Hexes lifted verbatim from status.js / formStyles bannerChrome / SeverityBadge.
  // Same exact values, now single-sourced.
  statusInkGold:       '#7a5c00',  // status.js planning/harvesting text ink
  neutralFill:         '#eee',     // status.js harvested/ended/dormant bg
  bannerInk:           '#7a2a10',  // formStyles bannerChrome text
  severityStaleBorder: '#d4b556',  // SeverityBadge stale border/text/icon
  severityUrgent:      '#9c2b1a',  // SeverityBadge sev-3 'Urgent' red (AA on cream)
  severityStaleInk:    '#7a5e24',  // darker gold for stale/sev-1 badge text+border+icon (AA on cream and white; #d4b556 and #8a6e2a both fail)
  preparingFill:       '#f0e9e0',  // status.js preparing stage bg
  badgeInfoBg:         '#e8f0fa',  // forms/Badge info tone bg
  // ── Photo tile placeholder ──
  // Warm stone that fills a photo tile's aspect-ratio box BEFORE the image paints (and stays
  // visible behind transparent PNGs). Shared by PhotoLibrary's grid tile, LocationDetail's
  // attached-photo tile and FacebookShareSheet's 64px thumb.
  photoPlaceholder:    '#e8e2da',  // photo tile fill before/behind the image
  // ── PhotoUpload's inline upload-error ink. Promoted at its EXACT value, NOT remapped to
  // P.terra (#b7532a) or P.severityUrgent (#9c2b1a): both are near neighbours, and swapping
  // to one would be a visible colour change.
  photoErrorInk:       '#b14a3c',  // PhotoUpload upload-error message text
  // ── FACET token set: type, group, location, freeform ──
  fTypeBg:     '#e6f0e8', fTypeText:     '#1f5138', fTypeBorder:     '#bcd7c4',
  fGroupBg:    '#eef0fa', fGroupText:    '#3a3f6b', fGroupBorder:    '#c9cdec',
  fLocationBg: '#f3ece2', fLocationText: '#6b4f2a', fLocationBorder: '#ddcdb6',
  fFreeformBg: '#f0efed', fFreeformText: '#4a4a4a', fFreeformBorder: '#d9d4cd',
  // Lifecycle facet value palette: each lifecycle value gets its own cohesive token
  // rather than the neutral freeform fallback. annual=gold, biennial=violet,
  // perennial=teal, tender_perennial=mint-green. Soft bg / dark text / mid border like the
  // other facet tokens; hues chosen distinct from type(green)/group(indigo)/location(tan)/freeform(gray).
  fLcAnnualBg:    '#faf2da', fLcAnnualText:    '#6b520f', fLcAnnualBorder:    '#e8d496',
  fLcBiennialBg:  '#efe9f4', fLcBiennialText:  '#534079', fLcBiennialBorder:  '#cfc3e2',
  fLcPerennialBg: '#def0ea', fLcPerennialText: '#14564a', fLcPerennialBorder: '#b4ddd0',
  fLcTenderBg:    '#e8f2e9', fLcTenderText:    '#2f5d44', fLcTenderBorder:    '#c6e0cd',
}

// Soft enum — suggested event types shown in dropdown, free text always accepted.
// The master list lives in the canonical src/lib/eventTypes.js (single source of truth) and is
// re-exported here so existing importers of EVENT_TYPES from constants.js keep working.
// Add new values in eventTypes.js, NOT here.
export { EVENT_TYPES, SELECTABLE_EVENT_TYPES } from './eventTypes.js'

// Location type_label values for UI icons/display
export const LOCATION_TYPE_LABELS = [
  // 'area' is the most common value in live data. A <Select> whose stored value is absent from its
  // options renders the placeholder, which made those locations' real type invisible and
  // un-editable; keep this vocabulary in step with the data.
  'area',
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
// Harvest is REPEATABLE: a 'harvested' project MUST stay
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
  planning:   { label: 'Planning' },
  preparing:  { label: 'Preparing' },
  seeding:    { label: 'Seeding' },
  sprouting:  { label: 'Sprouting' },
  growing:    { label: 'Growing' },
  flowering:  { label: 'Flowering' },
  fruiting:   { label: 'Fruiting' },
  harvesting: { label: 'Harvesting' },
  // ── Legacy values (existing DB rows — display-only) ───────────────
  active:     { label: 'Active' },
  harvested:  { label: 'Harvested'  },
  ended:      { label: 'Ended'  },
}

// Plant lifecycle statuses — plants.status. The DB enforces CHECK constraint `chk_plants_status`;
// this list MUST stay a subset of it — adding a value here requires widening chk_plants_status first
// (see v3-status-source-check-widen-migration-V100). Single source of truth for the plant-status
// vocabulary; do NOT redefine inline.
// Custom lifecycle ORDER (not alpha) — StatusSelect renders plant statuses in this exact sequence.
export const PLANT_STATUSES = ['seed', 'seedling', 'vegetative', 'flowering', 'fruiting', 'harvested', 'ended', 'failed', 'rooting', 'dormant']

// Display mapping for plant statuses — { label, emoji }. Mirrors PROJECT_STATUS_MAP.
// Colors live in status.js STATUS_COLORS (shared with project stages).
export const PLANT_STATUS_MAP = {
  seed:       { label: 'Seed' },
  rooting:    { label: 'Rooting' },  // cuttings/propagation
  seedling:   { label: 'Seedling' },
  vegetative: { label: 'Vegetative' },
  flowering:  { label: 'Flowering' },
  fruiting:   { label: 'Fruiting' },
  harvested:  { label: 'Harvesting' },  // label-only rename (DB value stays 'harvested')
  dormant:    { label: 'Dormant' },
  ended:      { label: 'Ended' },
  failed:     { label: 'Failed' },
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
// so the gating logic lives in ONE place.
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

// Inventory enums live in src/lib/inventoryEnums.js; the item-type / subcategory / category exports
// that used to be here were stale (dead values not in the live inventory_items CHECK) and had zero
// importers.

// Project categories — used in project_types table and ProjectTypes.jsx
export const PROJECT_CATEGORIES = [
  { v: 'garden',         label: 'Garden' },
  { v: 'infrastructure', label: 'Infrastructure' },
]

// Where a completed sign-in lands. Every redirect in the auth path MUST use this — never a literal:
// a route-table change once left THREE literal '/dashboard' redirects behind in the Clerk sign-in
// path, so signing in still landed on Dashboard. Keep this the single source.
export const POST_LOGIN_ROUTE = '/today'

export const APP_NAME = 'Gardens at Mathews'

// The BottomNav's real height, and the single source of truth for --bottom-nav-height. It LIVES
// here rather than in BottomNav.jsx (which re-exports it for its existing importers) so a page can
// reference the nav's height without pulling the nav's whole module graph -- auth, api, Sheet -- in
// behind it. BottomNav.jsx owns the CSS VARIABLE; this owns the NUMBER.
export const BOTTOM_NAV_HEIGHT_PX = 56

// TopChrome's bar height, the number the redesigned Today's sticky jump bar hangs under.
// TopChrome.jsx keeps its own literal bar-height constant ON PURPOSE: seven layout gates parse that exact
// source line (today-shape, page-scroll, seeds-page, seeds-scroll, seed-detail, today-shape-v2,
// today-shell-v2), so pointing it at this constant would crash every one of them at startup.
// topChromeHeight.test.js reds if the two numbers ever disagree.
export const TOP_CHROME_HEIGHT_PX = 52

// Public URL base — used for canonical links, og:url, GCal descriptions (Phase 3+)
export const APP_URL = 'https://garden.futureishere.net'
