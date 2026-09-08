// navConfig — V5-ADMINCENTER-001. The tab bar's layout as DATA, so the admin centre can reorder it.
// Design: project-state/design-admincentre-V100-20260908.md §1, §6.
//
// WHAT MOVED. BottomNav's `TABS` was a module const — five literal rows. It is now this registry
// plus an ORDER, and the order is the only thing config can change. Everything else about the bar
// is untouched: the pinned More button (a hardcoded <button> emitted after the map), CREATE_ACTIONS,
// the More sheet, and the field/desk highlight swap are four separate mechanisms and none of them
// is named by the row this implements.
//
// V1 IS REORDER-ONLY, AND THAT IS ENFORCED HERE RATHER THAN IN THE UI. `resolveNavTabs` accepts a
// config only if it is a PERMUTATION of DEFAULT_NAV_TABS — same five keys, any order. A config that
// drops a key, adds one, or repeats one is not "partly applied"; it is rejected whole and the
// shipped default renders. Two reasons that is the right shape and not merely the cautious one:
//   1. Hiding a tab removes the only door to a page, which is the exact defect class
//      DebugMenu.reachability.test.jsx exists to catch, arriving by a different route. The
//      hide-vs-reorder question is reserved for Dave (design §7) and is unanswered.
//   2. It makes the renderer TOTAL over user data. nav_tabs is a jsonb column an admin writes; it
//      is not validated by a CHECK and never can be against a key list that lives in JS. Every
//      malformed value therefore has to have a defined, non-destructive rendering, and "the bar you
//      already had" is the only one that cannot strand Dave.
//
// NULL MEANS SHIPPED DEFAULT — the property the whole row rests on. A missing column, a failed
// prefs GET, an offline boot and a never-configured user all arrive here as null/undefined and all
// degrade to today's exact bar. See src/context/PrefsContext.jsx for the read side.

export const TAB_REGISTRY = {
  today:      { to: '/today',    label: 'Today',    iconName: 'nav.today' },
  garden:     { to: '/garden',   label: 'Garden',   iconName: 'nav.garden' },
  // The FAB. `highlight` is what BottomNav forks on to draw the circle — and, in field mode, to
  // swap it for the mic. Config may move it; it cannot remove it, because the permutation rule
  // above requires every default key to be present.
  create:     { to: '/log',      label: 'Create',   iconName: 'nav.plus', highlight: true },
  harvests:   { to: '/harvests', label: 'Harvests', iconName: 'nav.harvests' },
  'put-up':   { to: '/put-up',   label: 'Put-Up',   iconName: 'nav.putup' },
}

// The shipped bar, in shipped order (V4-PUTUPENGINE-001). Changing THIS is a deploy and a
// deliberate act; changing the config is not, which is the whole point of the split.
export const DEFAULT_NAV_TABS = ['today', 'garden', 'create', 'harvests', 'put-up']

// resolveNavTabs — user config in, a renderable key list out. NEVER throws, NEVER returns empty.
//
// Each guard below is independently killable: the test file names, for every one of them, the input
// that ONLY that guard catches and the mutation that turns that case red. Order is load-bearing for
// that property — the array check must come before anything that calls an array method, or deleting
// it would be masked by the arity check rather than surfacing as a failure.
export function resolveNavTabs(raw) {
  // Malformed payload: an object, a string, a number, JSON that parsed to something that is not a
  // list. jsonb accepts all of them.
  if (!Array.isArray(raw)) return DEFAULT_NAV_TABS
  // Unknown key. `in` also rejects non-string entries (numbers, nulls, nested objects), so a
  // separate typeof pass would be a redundant suppression that hides mutations in this one.
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
