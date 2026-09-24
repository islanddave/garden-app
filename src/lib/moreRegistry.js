// moreRegistry — V5-NAVCUSTOM-001. The More sheet as DATA, so each row has an id a person can pin.
// Design: project-state/design-navcustom-V100-20260924.md §8 (binding over §1–§3); ids and read-time
// rules: _navcustom-panel-20260924/seat-state.md §2–§3; contract: _navcustom-build-20260924/CONTRACT.md.
//
// A LEAF: no React, no page import. BottomNav, NavPrefsContext and the tests all read it.
//
// IDS ARE MINTED ONCE AND FROZEN. A pin is stored as an id in user_notification_prefs.more_pins, so an
// id is a promise to every stored list: never renamed, never reused, never derived at runtime from a
// label or a route (Spaces→Zones and /sow→/seeds both happened; a pin keyed by label or href would
// have silently let go both times). A new label, route or icon keeps its id. A REMOVED row moves its id
// to RETIRED_MORE_IDS. A MERGED row maps its old id in MORE_ID_ALIASES. moreRegistry.test.js snapshots
// the id list so a rename or removal reds.
//
// The three movable bar tabs (navConfig.MOVABLE_TAB_KEYS) share this id namespace: a page has ONE id
// whether it sits on the bar or in More, so a pin on Put-Up survives Put-Up moving in and out.
//
// Rows appear here in today's sheet order, section by section. Row extras that a generic renderer
// could silently drop are fields, not JSX: the Seeds subtitle and its `more-seeds` testid, the Critters
// subtitle (ambient — Reward UX V102 forbids a badge or count here), the What's-New dot on Release Notes.
import { CATCH_UP_EDITOR_SHIPPED, SPACE_PHOTOS_ENABLED } from './featureFlags.js'
import { SEEDS_PATH } from './seedsRoutes.js'
import { TAB_REGISTRY } from './navConfig.js'

// Sections in sheet order. 'debug' carries no label: Debug & smoke sits directly under Help & account,
// as it always has (OPS-DEBUGMENU-001 — the least-used row, last by design).
export const MORE_SECTIONS = [
  { key: 'garden',  label: 'Your garden' },
  { key: 'rewards', label: 'Rewards' },
  { key: 'help',    label: 'Help & account' },
  { key: 'debug',   label: null },
]

// Fields: id, to, label, sub?, iconName, section, enabled? (a BUILD flag — a flag-off row is not
// drawn and its pin sleeps), pinnable? (default true), adornment? ('whatsNew'), testId?, component?
// (a row that renders its own component rather than a link — only catch-up).
export const MORE_ROWS = [
  { id: 'dashboard',  to: '/dashboard',  label: 'Dashboard', iconName: 'nav.dashboard',  section: 'garden' },
  // V4-NAVHARVEST-001 — DrG demoted here from the tab bar. /findings keeps its route and its icon.
  { id: 'findings',   to: '/findings',   label: 'DrG',       iconName: 'nav.findings',   section: 'garden' },
  { id: 'photos',     to: '/photos',     label: 'Photos',    iconName: 'media.camera',   section: 'garden' },
  // V4-SPACEPHOTO-001 — the property itself, ABOVE the zones beneath it. SPACE_PHOTOS_ENABLED is also
  // the rollback lever: with it off the row is not drawn and a stored pin sleeps until it returns.
  { id: 'space',      to: '/space',      label: 'Space',     iconName: 'nav.space',      section: 'garden', enabled: SPACE_PHOTOS_ENABLED },
  // V4-SPACECLIENTGAP-001 — "Zones", unconditionally; the id stays the route's.
  { id: 'locations',  to: '/locations',  label: 'Zones',     iconName: 'facet.location', section: 'garden' },
  { id: 'inventory',  to: '/inventory',  label: 'Inventory', iconName: 'nav.inventory',  section: 'garden' },
  // V5-SEEDSTAB-001 — ONE Seeds row where Sow now and Saved seeds used to sit (their ids alias here).
  // The subtitle keeps both old names in the menu; the testid is pinned by BottomNav.test.jsx.
  { id: 'seeds',      to: SEEDS_PATH,    label: 'Seeds',     iconName: 'lifecycle.sprout', section: 'garden',
    sub: 'My seeds · Saved seeds · Sow now', testId: 'more-seeds' },
  { id: 'achievements', to: '/achievements', label: 'Achievements', iconName: 'nav.achievements', section: 'garden' },
  // Gated off (CATCH_UP_EDITOR_SHIPPED=false). A COMPONENT row — CatchUpBadge renders its own link —
  // so it is not pinnable: a pin button beside it would pin a row that is not a SheetRowLink, which is
  // the one shape that orphans the armed Back entry.
  { id: 'catch-up',   to: '/plants/catch-up', label: 'Catch up', section: 'garden',
    enabled: CATCH_UP_EDITOR_SHIPPED, pinnable: false, component: 'catchUpBadge' },
  { id: 'collection', to: '/collection', label: 'Critters',  iconName: 'nav.critters',   section: 'rewards',
    sub: "Who's been visiting" },
  { id: 'helper',     to: '/helper',     label: 'Garden Helper', iconName: 'nav.helper',  section: 'help' },
  { id: 'settings',   to: '/settings',   label: 'Settings',  iconName: 'action.settings', section: 'help' },
  // V4-HANDEDNESSCONTROLS-001 — its own row; /settings is still the notifications redirect.
  { id: 'settings-controls', to: '/settings/controls', label: 'Controls', iconName: 'action.settings', section: 'help' },
  { id: 'about',      to: '/about',      label: 'About',     iconName: 'action.info',    section: 'help' },
  { id: 'releases',   to: '/releases',   label: 'Release Notes', iconName: 'nav.notes',  section: 'help', adornment: 'whatsNew' },
  // OPS-DEBUGMENU-001 — the ONLY nav door to every /admin/* page (DebugMenu.reachability.test.jsx).
  { id: 'admin',      to: '/admin',      label: 'Debug & smoke', iconName: 'mode.desk',  section: 'debug' },
]

// Removed rows. An id here is never reused; a stored pin carrying it is dropped at read time, and the
// next save from that person writes the list without it. EMPTY ON PURPOSE: no id existed before this
// release, so nothing has been retired yet.
export const RETIRED_MORE_IDS = []

// Merged rows: old id -> the live id that absorbed it. The precedent is V5-SEEDSTAB-001, which folded
// the Sow now and Saved seeds rows into Seeds.
export const MORE_ID_ALIASES = {
  sow: 'seeds',
  'saved-seeds': 'seeds',
}

// CONTRACT §4 — shared with the Lambda validator (parity-tested at integration).
export const MORE_PIN_ID_RE = /^[a-z][a-z0-9-]{0,39}$/
export const MORE_PINS_MAX_STORED = 32
// Client only: the Pinned block's cap (the house glance-surface cap). A 5th pin is refused inline.
export const MORE_PINS_MAX_SHOWN = 4

export const MOVED_SUB = 'Moved here from the tab bar'

export const rowEnabled = (row) => row.enabled !== false
export const rowPinnable = (row) => row.pinnable !== false

// resolvePins — a stored more_pins value in, a clean ordered id list out. NEVER throws.
//
// ENTRY BY ENTRY, unlike the bar: each pin stands alone, so one bad entry costs that entry and never
// the list (precedent: readTodaySkipped). Order of operations, each with a killing case in
// moreRegistry.test.js: not an array → []; drop non-strings and ids failing MORE_PIN_ID_RE; map
// aliases; drop repeats (first wins, so an alias landing on a pin already held collapses into it);
// drop retired ids; stop at MORE_PINS_MAX_STORED.
//
// UNKNOWN IDS ARE KEPT. An id this build does not know — minted by a newer bundle, or a row behind a
// flag that is off — is not drawn, but it is carried through the next save, so a person using two
// devices on two builds does not lose the other build's pins. `retired`/`aliases` are injectable for
// the tests only; production reads the constants.
export function resolvePins(raw, { retired = RETIRED_MORE_IDS, aliases = MORE_ID_ALIASES } = {}) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !MORE_PIN_ID_RE.test(entry)) continue
    const id = Object.hasOwn(aliases, entry) ? aliases[entry] : entry
    if (out.includes(id)) continue
    if (retired.includes(id)) continue
    out.push(id)
    if (out.length === MORE_PINS_MAX_STORED) break
  }
  return out
}

// A moved bar tab drawn as a More row. Same id, route, label and icon as its bar slot, plus the
// subtitle that says where it came from — the one line that answers "where did Put-Up go?" in place.
export function movedTabRow(key) {
  const tab = TAB_REGISTRY[key]
  return { id: key, to: tab.to, label: tab.label, iconName: tab.iconName, section: 'garden', sub: MOVED_SUB, moved: true }
}

// Every row the sheet can draw right now: moved tabs FIRST (in bar order), then the registry rows
// whose build flag is on.
export function drawableMoreRows({ moved = [], rows = MORE_ROWS } = {}) {
  return [...moved.map(movedTabRow), ...rows.filter(rowEnabled)]
}

// The ids that count toward MORE_PINS_MAX_SHOWN: pins that would actually be DRAWN. A sleeping pin (an
// unknown id, a flag-off row, a tab that is back on the bar) is kept but does not take a slot — a
// person who can see three pins must be able to add a fourth.
export function drawnPinIds(pins, { moved = [], rows = MORE_ROWS } = {}) {
  const drawable = drawableMoreRows({ moved, rows }).filter(rowPinnable).map(r => r.id)
  return pins.filter(id => drawable.includes(id)).slice(0, MORE_PINS_MAX_SHOWN)
}

// layoutMoreSheet — the sheet's rows, computed ONCE when the sheet opens (BottomNav freezes the
// result; see I11 there). Every drawable row appears EXACTLY ONCE: in Pinned when it is one of the
// first MORE_PINS_MAX_SHOWN drawn pins, otherwise at home in its section. Pinned follows pin order.
//   out: { pinned: [row], sections: [{ key, label, rows: [row] }] }
export function layoutMoreSheet({ pins = [], moved = [], rows = MORE_ROWS } = {}) {
  const drawable = drawableMoreRows({ moved, rows })
  const pinnedIds = drawnPinIds(pins, { moved, rows })
  const pinned = pinnedIds.map(id => drawable.find(r => r.id === id))
  const home = drawable.filter(r => !pinnedIds.includes(r.id))
  return {
    pinned,
    sections: MORE_SECTIONS.map(s => ({ ...s, rows: home.filter(r => r.section === s.key) })),
  }
}
