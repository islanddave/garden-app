// navConfig — the tab bar's layout as DATA. V5-ADMINCENTER-001 made the order configurable;
// V5-NAVCUSTOM-001 made it PER PERSON and let three tabs move into More.
// Design: project-state/design-navcustom-V100-20260924.md §8 (binding over its §1–§3).
//
// WHAT MOVED. BottomNav's `TABS` was a module const — five literal rows. It is now this registry
// plus a LAYOUT, and the layout is the only thing a person's settings can change. Everything else
// about the bar is untouched: the More button (a hardcoded <button> emitted after the map),
// CREATE_ACTIONS, the More sheet, and the field/desk highlight swap are separate mechanisms.
//
// PER PERSON (D4 — Dave, 2026-09-24: "only my bar changes"). The layout is
// user_notification_prefs.bar_layout, keyed by the Clerk sub, so Dave's reorder or move never
// shifts Jen's bar. This REVERSES the 2026-09-08 "one global nav order" ruling, and it reverses it
// for the ORDER as well as for which tabs sit on the bar: a global order beside a personal hide
// would still let Dave's reorder move Jen's bar, which is the exact thing D4 ruled out. The global
// public.app_config path is retired from the SPA; see resolveNavTabs at the bottom for the one
// piece of it that survives, and why.
//
// A TAB THAT LEAVES THE BAR LANDS IN MORE, it never disappears. `hidden` means "moved into More":
// BottomNav draws every hidden key as a row at the top of "Your garden", so no page loses its door.
// Only MOVABLE_TAB_KEYS can move. Today is where the app opens (bare `/`, unknown URLs and the
// post-login route all land there) and ＋ is the only door to the create sheet — and, in field mode,
// its mic is the only door to /field — so neither can ever be hidden. More is not a key at all.
//
// TOTAL, PER FIELD. resolveBarLayout never throws, and a bad field falls back ALONE: a bad `order`
// renders the shipped order, a bad `hidden` renders nothing hidden. Failure therefore only ever ADDS
// doors, never removes one. The column has a shape CHECK and the Lambda validates both fields at
// write time (lambda/critter/validators.js), but this is the guard that cannot be bypassed — a row
// can be written by hand, and the launch cache in localStorage is read before any server answers.
//
// NULL MEANS SHIPPED DEFAULT. No prefs row, a NULL column, a failed GET, an offline boot and a
// first launch all arrive here as null/undefined and render today's exact bar.

export const TAB_REGISTRY = {
  today:      { to: '/today',    label: 'Today',    iconName: 'nav.today' },
  garden:     { to: '/garden',   label: 'Garden',   iconName: 'nav.garden' },
  // The FAB. `highlight` is what BottomNav forks on to draw the circle — and, in field mode, to
  // swap it for the mic. A layout may move it; it cannot hide it, because it is not in
  // MOVABLE_TAB_KEYS and `order` must be a permutation of every default key.
  create:     { to: '/log',      label: 'Create',   iconName: 'nav.plus', highlight: true },
  harvests:   { to: '/harvests', label: 'Harvests', iconName: 'nav.harvests' },
  'put-up':   { to: '/put-up',   label: 'Put-Up',   iconName: 'nav.putup' },
}

// The shipped bar, in shipped order (V4-PUTUPENGINE-001). Changing THIS is a deploy and a
// deliberate act; changing a person's layout is not, which is the whole point of the split.
// The Lambda's NAV_TAB_KEYS must equal this, order included (CONTRACT §4; parity-tested).
export const DEFAULT_NAV_TABS = ['today', 'garden', 'create', 'harvests', 'put-up']

// The tabs a person may move into More. Today and ＋ are absent on purpose (see the header), and so
// is More, which is not a key. The Lambda's MOVABLE_TAB_KEYS must equal this (CONTRACT §4).
export const MOVABLE_TAB_KEYS = ['garden', 'harvests', 'put-up']

// resolveBarLayout — a stored bar_layout in, a renderable layout out. NEVER throws.
//
//   in:  anything (the jsonb column, the launch cache, undefined)
//   out: { order, hidden, bar, moved, applied: { order, hidden } }
//        order  — all five keys; the stored order when valid, else DEFAULT_NAV_TABS
//        hidden — movable keys moved into More; the stored list when valid, else []
//        bar    — order minus hidden: the slots BottomNav draws before More
//        moved  — the hidden keys in bar order: the rows More draws at the top of "Your garden"
//        applied — per field, whether the stored value was used rather than the fallback. Stated
//                  explicitly so a parity test reads a flag instead of comparing array identity.
//
// Each guard is independently killable: navConfig.test.js names, for every one, the input that ONLY
// it catches and the mutation that turns that case red. `raw?.order` is what makes the function total
// over every JSON value — null/undefined short-circuit, and a primitive simply has no such property.
export function resolveBarLayout(raw) {
  const order = validOrder(raw?.order) ? [...raw.order] : [...DEFAULT_NAV_TABS]
  const hidden = validHidden(raw?.hidden) ? [...raw.hidden] : []
  return {
    order,
    hidden,
    bar: order.filter(k => !hidden.includes(k)),
    moved: order.filter(k => hidden.includes(k)),
    applied: { order: validOrder(raw?.order), hidden: validHidden(raw?.hidden) },
  }
}

// `order` must be a PERMUTATION of the five keys. The array check comes first so that deleting it
// surfaces as a failure rather than being masked by the arity check below it.
function validOrder(order) {
  if (!Array.isArray(order)) return false
  // Known key. BOTH halves are load-bearing: `typeof` is the only thing that rejects ['today'] —
  // an array whose string form IS a key, which Object.hasOwn would accept by coercion — and
  // Object.hasOwn (not `in`) is what rejects 'toString' and 'constructor'.
  if (order.some(k => !(typeof k === 'string' && Object.hasOwn(TAB_REGISTRY, k)))) return false
  if (new Set(order).size !== order.length) return false
  // Arity: all five, every time. A short order is not a way to hide a tab — `hidden` is.
  return order.length === DEFAULT_NAV_TABS.length
}

// `hidden` must be distinct movable keys. `includes` compares strictly, so it already rejects every
// non-string; a separate typeof check here would be a redundant guard no test could kill.
function validHidden(hidden) {
  if (!Array.isArray(hidden)) return false
  if (hidden.some(k => !MOVABLE_TAB_KEYS.includes(k))) return false
  return new Set(hidden).size === hidden.length
}

// resolveNavTabs — THE RETIRED GLOBAL PATH'S RESOLVER, kept for one reader. No SPA code calls it any
// more: the bar comes from resolveBarLayout over the per-person prefs row (D4). The critter Lambda
// keeps GET/PATCH /api/app-config dormant for one release (CONTRACT §6) so clients still rolling out
// get a 200 rather than a 404, and lambda/critter/appConfig.parity.test.js still pins that dormant
// route's validator against THIS function — including its same-array-reference-on-fallback contract.
// Delete it together with the dormant route, not before.
//
// Its rule is the V5-ADMINCENTER-001 one and is unchanged: a config is accepted only if it is a
// permutation of DEFAULT_NAV_TABS, and anything else returns the shipped default whole. NEVER throws,
// NEVER returns empty. Each guard has its own killing input in navConfig.test.js.
export function resolveNavTabs(raw) {
  // Malformed payload: an object, a string, a number, JSON that parsed to something that is not a
  // list. jsonb accepts all of them.
  if (!Array.isArray(raw)) return DEFAULT_NAV_TABS
  // Unknown key. The typeof half is NOT redundant with Object.hasOwn: hasOwn coerces its key, so
  // ['today'] (an array whose string form is a key) passes it — see validOrder above.
  if (raw.some(k => !(typeof k === 'string' && Object.hasOwn(TAB_REGISTRY, k)))) return DEFAULT_NAV_TABS
  // Duplicate key. Rendering it would emit two React children with the same key and two identical
  // tabs, which is a broken bar rather than a configured one.
  if (new Set(raw).size !== raw.length) return DEFAULT_NAV_TABS
  // Arity — the reorder-only rule, and the cap. Short arrays (including []) are a hide attempt;
  // long ones are an add. Combined with the two guards above this makes `raw` a permutation of the
  // default set, so the bar always renders exactly its shipped slot count.
  if (raw.length !== DEFAULT_NAV_TABS.length) return DEFAULT_NAV_TABS
  return raw
}
