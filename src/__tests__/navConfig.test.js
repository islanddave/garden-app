/**
 * src/__tests__/navConfig.test.js
 *
 * V5-NAVCUSTOM-001 — the guards on resolveBarLayout(), the per-person bar (D4, Dave 2026-09-24).
 * V5-ADMINCENTER-001 — the guards on resolveNavTabs(), the retired global resolver, which survives
 * only because the dormant /api/app-config route's parity test still reads it (CONTRACT §6).
 *
 * WHY THIS FILE EXISTS. bar_layout is a jsonb column a person writes, and the launch cache in
 * localStorage is read before any server answers. So the resolver must be TOTAL over that column's
 * whole domain, and "total" has a specific meaning here: every value it will not accept renders the
 * shipped bar for THAT FIELD — a bad order renders the shipped order, a bad hidden list hides nothing
 * — so a failure only ever adds doors. A nav bar that loses a door is not a cosmetic failure in an
 * installed PWA with no address bar: it is a page nobody can reach.
 *
 * EACH GUARD IS INDEPENDENTLY KILLABLE, AND THE MUTATION IS NAMED ON THE CASE. Every case uses a
 * payload that ONLY its own guard rejects, so deleting that one line turns that one case red instead
 * of being masked by a neighbouring check.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_NAV_TABS, MOVABLE_TAB_KEYS, TAB_REGISTRY, resolveBarLayout, resolveNavTabs,
} from '../lib/navConfig.js'

const SHIPPED = {
  order: DEFAULT_NAV_TABS, hidden: [], bar: DEFAULT_NAV_TABS, moved: [],
  applied: { order: false, hidden: false },
}

// Every permutation of a list — 120 orders for the five keys.
function permutations(list) {
  if (list.length <= 1) return [list]
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map(p => [x, ...p]))
}
// Every ORDERED selection of distinct movable keys, [] included: 1 + 3 + 6 + 6 = 16 hidden lists.
function orderedSubsets(list) {
  const out = [[]]
  for (let n = 1; n <= list.length; n++) {
    for (const p of permutations(list)) {
      const head = p.slice(0, n)
      if (!out.some(o => o.length === n && o.every((k, i) => k === head[i]))) out.push(head)
    }
  }
  return out
}

describe('resolveBarLayout — the shipped bar is the answer to everything it will not accept', () => {
  // The floor. NULL is what a person who never touched the editor, a failed prefs GET, an offline
  // boot and an empty launch cache all look like.
  it('null / undefined — no layout stored — renders the shipped bar with nothing moved', () => {
    expect(resolveBarLayout(null)).toEqual(SHIPPED)
    expect(resolveBarLayout(undefined)).toEqual(SHIPPED)
  })

  it('honours a stored order and a stored move together', () => {
    const r = resolveBarLayout({ order: ['harvests', 'today', 'create', 'garden', 'put-up'], hidden: ['put-up'] })
    expect(r.order).toEqual(['harvests', 'today', 'create', 'garden', 'put-up'])
    expect(r.hidden).toEqual(['put-up'])
    expect(r.bar).toEqual(['harvests', 'today', 'create', 'garden'])
    expect(r.moved).toEqual(['put-up'])
    expect(r.applied).toEqual({ order: true, hidden: true })
  })

  // THE INVERSION, and it is deliberate. Under V5-ADMINCENTER-001 the bar was reorder-only: a config
  // that dropped a tab rendered the shipped bar whole (resolveNavTabs still does, below). D4 made the
  // bar personal and let Garden, Harvests and Put-Up move into More, so a layout that moves one is now
  // HONOURED. What the old case protected — no page loses its door — is kept a different way: a moved
  // key comes back out as `moved`, which BottomNav draws as a More row.
  // KILLING MUTATION: make resolveBarLayout ignore `hidden` (always []). RESULT: RED here.
  it('INVERTED — a layout that moves a tab into More is honoured, and the tab comes back as a More row', () => {
    const r = resolveBarLayout({ order: [...DEFAULT_NAV_TABS], hidden: ['harvests'] })
    expect(r.bar).toEqual(['today', 'garden', 'create', 'put-up'])
    expect(r.moved).toEqual(['harvests'])
  })

  // The smallest bar the design allows: Today · ＋ · More. Non-vacuity for the floor case below.
  it('moving all three movable tabs leaves Today and ＋ on the bar, and moves them in BAR order', () => {
    const r = resolveBarLayout({ order: ['put-up', 'today', 'harvests', 'create', 'garden'], hidden: ['garden', 'put-up', 'harvests'] })
    expect(r.bar).toEqual(['today', 'create'])
    // `moved` follows the ORDER, not the order they were ticked in: that is the order More lists them.
    expect(r.moved).toEqual(['put-up', 'harvests', 'garden'])
    expect(r.hidden).toEqual(['garden', 'put-up', 'harvests'])
  })

  // NON-VACUITY: a resolver hardcoded to return SHIPPED would satisfy every fallback case below.
  it('is not simply returning the shipped bar for everything', () => {
    expect(resolveBarLayout({ order: ['put-up', 'harvests', 'create', 'garden', 'today'], hidden: [] }).order)
      .not.toEqual(DEFAULT_NAV_TABS)
    expect(resolveBarLayout({ order: [...DEFAULT_NAV_TABS], hidden: ['garden'] }).bar).not.toEqual(DEFAULT_NAV_TABS)
  })

  // PER FIELD — the property the contract names (CONTRACT §5). A bad `hidden` must not throw away a
  // good order, and a bad `order` must not throw away a good move.
  // KILLING MUTATION: fall back WHOLE (return SHIPPED when either field is bad). RESULT: RED on both.
  it('falls back per field: a bad hidden keeps the order, a bad order keeps the move', () => {
    const custom = ['garden', 'today', 'create', 'harvests', 'put-up']
    const a = resolveBarLayout({ order: custom, hidden: ['today'] })
    expect(a.order).toEqual(custom)
    expect(a.hidden).toEqual([])
    expect(a.applied).toEqual({ order: true, hidden: false })
    const b = resolveBarLayout({ order: ['today'], hidden: ['put-up'] })
    expect(b.order).toEqual(DEFAULT_NAV_TABS)
    expect(b.moved).toEqual(['put-up'])
    expect(b.applied).toEqual({ order: false, hidden: true })
  })

  // Malformed payloads. jsonb accepts objects, arrays, strings, numbers and booleans, and a legacy
  // nav_tabs-shaped ARRAY is the likeliest wrong thing to find in the column. `raw?.order` is what
  // makes all of these safe — none of them throws.
  it('a malformed payload — array, string, number, boolean, empty object — renders the shipped bar', () => {
    for (const raw of [['today', 'garden'], 'today', 42, true, {}, { order: null, hidden: null }]) {
      expect(resolveBarLayout(raw), JSON.stringify(raw)).toEqual(SHIPPED)
    }
  })
})

describe('resolveBarLayout — the order guards, one killing input each', () => {
  const layout = (order) => resolveBarLayout({ order, hidden: [] })

  // GUARD O1 — not an array.
  // KILLING MUTATION: delete `if (!Array.isArray(order)) return false`.
  // RESULT: RED — the next line calls order.some(), which a string does not have, so the resolver
  // THROWS rather than falling back. The array check must stay first for that reason.
  it('O1 — a non-array order renders the shipped order', () => {
    expect(layout('today,garden,create,harvests,put-up').order).toEqual(DEFAULT_NAV_TABS)
    expect(layout({ 0: 'today' }).order).toEqual(DEFAULT_NAV_TABS)
  })

  // GUARD O2a — the typeof half. Object.hasOwn COERCES its key, so ['today'] (an array whose string
  // form is 'today') passes hasOwn; five distinct values of length five pass the other two guards.
  // KILLING MUTATION: drop `typeof k === 'string' &&` from validOrder.
  // RESULT: RED — the order is accepted and the bar is asked to render TAB_REGISTRY[['today']].
  it('O2a — an array-wrapped key is not a key, even though its string form is one', () => {
    expect(layout([['today'], 'garden', 'create', 'harvests', 'put-up']).order).toEqual(DEFAULT_NAV_TABS)
  })

  // GUARD O2b — an unknown key. Five entries, no duplicates, so nothing else here catches it.
  // KILLING MUTATION: drop `Object.hasOwn(TAB_REGISTRY, k)`. RESULT: RED — 'nope' renders undefined.
  it('O2b — an unknown key renders the shipped order', () => {
    expect(layout(['today', 'garden', 'create', 'harvests', 'nope']).order).toEqual(DEFAULT_NAV_TABS)
  })

  // Same guard, the prototype arm. KILLING MUTATION: `Object.hasOwn(TAB_REGISTRY, k)` → `k in
  // TAB_REGISTRY`. RESULT: RED — 'toString' is inherited, so `in` accepts it.
  it('O2b — a prototype-chain property is not a tab key', () => {
    expect(layout(['toString', 'garden', 'create', 'harvests', 'put-up']).order).toEqual(DEFAULT_NAV_TABS)
    expect(layout(['constructor', 'garden', 'create', 'harvests', 'put-up']).order).toEqual(DEFAULT_NAV_TABS)
  })

  // GUARD O3 — a duplicate. Five known entries, so only uniqueness rejects it.
  // KILLING MUTATION: delete the Set-size check. RESULT: RED — two Todays, Put-Up silently gone.
  it('O3 — a duplicate key renders the shipped order', () => {
    expect(layout(['today', 'today', 'garden', 'create', 'harvests']).order).toEqual(DEFAULT_NAV_TABS)
  })

  // GUARD O4 — arity. A SHORT order is not a way to hide a tab (that is `hidden`'s job, and `hidden`
  // is what routes the tab into More). A short order would drop the tab with no door at all.
  // KILLING MUTATION: delete `order.length === DEFAULT_NAV_TABS.length`.
  // RESULT: RED — the four-key order is accepted and Put-Up is on neither the bar nor in More.
  it('O4 — an order missing a key renders the shipped order, so no tab can vanish through `order`', () => {
    expect(layout(['today', 'garden', 'create', 'harvests']).order).toEqual(DEFAULT_NAV_TABS)
    expect(layout([]).order).toEqual(DEFAULT_NAV_TABS)
  })

  // THE CAP, and an honest note about which guard holds it. A longer order cannot be built out of
  // five known keys without repeating one or inventing one, so today this is killed by O2b/O3, NOT by
  // O4 — deleting O4 alone leaves it green. The registry/default agreement test at the bottom is what
  // will flag the day an optional key makes O4's "too long" arm testable on its own.
  it('an order that ADDS a slot renders the shipped order — the bar cannot grow', () => {
    expect(layout(['today', 'garden', 'create', 'harvests', 'put-up', 'today']).order).toEqual(DEFAULT_NAV_TABS)
    expect(layout(['today', 'garden', 'create', 'harvests', 'put-up', 'compost']).order).toEqual(DEFAULT_NAV_TABS)
  })
})

describe('resolveBarLayout — the hidden guards, one killing input each', () => {
  const moved = (hidden) => resolveBarLayout({ order: [...DEFAULT_NAV_TABS], hidden })

  // GUARD H1 — not an array. KILLING MUTATION: delete `if (!Array.isArray(hidden)) return false`.
  // RESULT: RED — 'put-up'.some is not a function, so the resolver throws.
  it('H1 — a non-array hidden list hides nothing', () => {
    expect(moved('put-up').hidden).toEqual([])
    expect(moved('put-up').bar).toEqual(DEFAULT_NAV_TABS)
  })

  // GUARD H2 — only a movable key may move. This is the guard that keeps Today and ＋ on the bar:
  // ＋ is the only door to the create sheet, and in field mode its mic is the only door to /field.
  // KILLING MUTATION: delete the MOVABLE_TAB_KEYS check.
  // RESULT: RED — ＋ (or Today) leaves the bar; 'more' and 'nope' would be accepted as moves.
  it('H2 — Today, ＋, More and unknown keys can never be hidden', () => {
    for (const bad of [['create'], ['today'], ['more'], ['nope'], ['garden', 'create']]) {
      const r = moved(bad)
      expect(r.hidden, JSON.stringify(bad)).toEqual([])
      expect(r.bar, JSON.stringify(bad)).toEqual(DEFAULT_NAV_TABS)
    }
  })

  // Same guard, the non-string arm: `includes` compares strictly, so no separate typeof check exists
  // to be deleted. ['put-up'] wrapped in an array is not 'put-up'.
  it('H2 — a non-string entry hides nothing', () => {
    for (const bad of [[['put-up']], [7], [null], [{ key: 'garden' }]]) {
      expect(moved(bad).hidden, JSON.stringify(bad)).toEqual([])
    }
  })

  // GUARD H3 — a repeat. Every entry is movable, so only uniqueness rejects it.
  // KILLING MUTATION: delete the Set-size check in validHidden.
  // RESULT: RED — `hidden` comes back as ['put-up','put-up'], which the server validator refuses, so
  // the next Save of an untouched editor would 400 (CONTRACT §5 invariant 2).
  it('H3 — a repeated key hides nothing', () => {
    expect(moved(['put-up', 'put-up']).hidden).toEqual([])
  })
})

describe('resolveBarLayout — invariants over every input', () => {
  const hostile = [
    null, undefined, [], {}, '', 0, NaN, true, [[]], [{}], ['today'],
    { order: [], hidden: [] }, { order: 'x', hidden: 'y' }, { order: {}, hidden: {} },
    { order: new Array(50).fill('today'), hidden: new Array(50).fill('garden') },
    { order: [...DEFAULT_NAV_TABS], hidden: [...DEFAULT_NAV_TABS] },
    { order: [...DEFAULT_NAV_TABS], hidden: ['today', 'create'] },
    { hidden: ['garden', 'harvests', 'put-up'] },
  ]

  // The invariants the whole file is really about, asserted directly so a refactor cannot keep every
  // case above green while changing what "fall back" means. KILLING MUTATION: any of the guard
  // mutations above that lets Today/＋ leave the bar, or that drops a key from both bar and More.
  it('never throws; ＋ and Today always stay; every key is on the bar or in More, never both', () => {
    for (const input of hostile) {
      const label = JSON.stringify(input)
      const r = resolveBarLayout(input)
      expect([...r.order].sort(), label).toEqual([...DEFAULT_NAV_TABS].sort())
      expect(r.bar, label).toContain('today')
      expect(r.bar, label).toContain('create')
      expect(r.bar.length + r.moved.length, label).toBe(DEFAULT_NAV_TABS.length)
      expect(r.bar.filter(k => r.moved.includes(k)), label).toEqual([])
      for (const k of r.moved) expect(MOVABLE_TAB_KEYS, label).toContain(k)
    }
  })

  // CONTRACT §5 invariant 1, from the client's side: every layout the server can accept — all 120
  // orders × every ordered list of distinct movable keys (1,920 cases) — is applied EXACTLY, field by
  // field. The integration step adds the server-side half against the real validator.
  // KILLING MUTATION: any guard that rejects a legal layout (e.g. require hidden.length === 0, or
  // require order[0] === 'today'). RESULT: RED on the first legal case it refuses.
  it('applies every legal layout exactly as stored', () => {
    let n = 0
    for (const order of permutations(DEFAULT_NAV_TABS)) {
      for (const hidden of orderedSubsets(MOVABLE_TAB_KEYS)) {
        const r = resolveBarLayout({ order, hidden })
        expect(r.order).toEqual(order)
        expect(r.hidden).toEqual(hidden)
        expect(r.applied).toEqual({ order: true, hidden: true })
        n++
      }
    }
    expect(n).toBe(120 * 16)
  })

  // CONTRACT §5 invariant 2: whatever the resolver returns, {order, hidden} is a value the server
  // accepts — so an editor that opens on a resolved layout and saves it untouched can never 400.
  // Restated here from the contract text (the Lambda cannot be imported from src/); the integration
  // parity test runs the same property against lambda/critter/validators.js.
  it('every output is a layout the contract accepts', () => {
    const accepts = ({ order, hidden }) =>
      Array.isArray(order) && order.length === 5 && new Set(order).size === 5 &&
      order.every(k => DEFAULT_NAV_TABS.includes(k)) &&
      Array.isArray(hidden) && new Set(hidden).size === hidden.length &&
      hidden.every(k => MOVABLE_TAB_KEYS.includes(k))
    for (const input of hostile) {
      const r = resolveBarLayout(input)
      expect(accepts({ order: r.order, hidden: r.hidden }), JSON.stringify(input)).toBe(true)
    }
  })

  it('does not mutate the payload it was handed', () => {
    const raw = { order: ['garden', 'today', 'create', 'harvests', 'put-up'], hidden: ['put-up'] }
    const copy = JSON.parse(JSON.stringify(raw))
    const r = resolveBarLayout(raw)
    r.order.reverse(); r.hidden.push('garden')
    expect(raw).toEqual(copy)
  })

  // The fallback is a COPY. KILLING MUTATION: return DEFAULT_NAV_TABS itself on fallback.
  // RESULT: RED — a consumer that sorts its layout would reorder the shipped bar for everyone after it.
  it('the fallback order is a copy — mutating an output cannot corrupt DEFAULT_NAV_TABS', () => {
    const before = [...DEFAULT_NAV_TABS]
    resolveBarLayout(null).order.reverse()
    resolveBarLayout(null).bar.reverse()
    expect(DEFAULT_NAV_TABS).toEqual(before)
  })
})

describe('MOVABLE_TAB_KEYS — the contract constant', () => {
  // CONTRACT §4: the Lambda's MOVABLE_TAB_KEYS must equal this; the integration step parity-tests it.
  it('is exactly Garden, Harvests and Put-Up', () => {
    expect(MOVABLE_TAB_KEYS).toEqual(['garden', 'harvests', 'put-up'])
  })

  it('never includes Today or the FAB, and names only real tabs', () => {
    expect(MOVABLE_TAB_KEYS).not.toContain('today')
    for (const k of MOVABLE_TAB_KEYS) {
      expect(Object.hasOwn(TAB_REGISTRY, k), k).toBe(true)
      expect(TAB_REGISTRY[k].highlight, k).toBeFalsy()
    }
  })
})

// ── The retired global resolver. Kept ONLY for lambda/critter/appConfig.parity.test.js, which pins
//    the dormant /api/app-config validator against it (CONTRACT §6). No SPA code calls it. Its rule
//    is still reorder-only, and these cases still describe it exactly; the per-person resolver above
//    is where moving a tab lives. ─────────────────────────────────────────────────────────────────
describe('resolveNavTabs (retired global path) — still reorder-only, for the dormant route', () => {
  it('null / undefined render the shipped bar', () => {
    expect(resolveNavTabs(null)).toEqual(DEFAULT_NAV_TABS)
    expect(resolveNavTabs(undefined)).toEqual(DEFAULT_NAV_TABS)
  })

  it('honours a genuine reorder, returning the caller’s own array', () => {
    const reordered = ['harvests', 'today', 'create', 'garden', 'put-up']
    expect(resolveNavTabs(reordered)).toBe(reordered)
  })

  // KILLING MUTATION: delete the Array.isArray guard. RESULT: RED — raw.some is not a function.
  it('a malformed payload renders the shipped bar', () => {
    expect(resolveNavTabs({ tabs: ['today'] })).toBe(DEFAULT_NAV_TABS)
    expect(resolveNavTabs('today,garden')).toBe(DEFAULT_NAV_TABS)
    expect(resolveNavTabs(42)).toBe(DEFAULT_NAV_TABS)
  })

  // KILLING MUTATIONS: drop the typeof half ([['today'],…] accepted); drop hasOwn ('nope' accepted);
  // hasOwn → `in` ('toString' accepted).
  it('an unknown, prototype or array-wrapped key renders the shipped bar', () => {
    expect(resolveNavTabs(['today', 'garden', 'create', 'harvests', 'nope'])).toBe(DEFAULT_NAV_TABS)
    expect(resolveNavTabs(['toString', 'garden', 'create', 'harvests', 'put-up'])).toBe(DEFAULT_NAV_TABS)
    expect(resolveNavTabs([['today'], 'garden', 'create', 'harvests', 'put-up'])).toBe(DEFAULT_NAV_TABS)
  })

  // KILLING MUTATION: delete the Set-size check. RESULT: RED.
  it('a duplicate renders the shipped bar', () => {
    expect(resolveNavTabs(['today', 'today', 'garden', 'create', 'harvests'])).toBe(DEFAULT_NAV_TABS)
  })

  // Still reorder-only, BY DESIGN for this function: the global value it reads can no longer be
  // written by the app, and it never learned to move tabs. Contrast the INVERTED case in
  // resolveBarLayout above, which is where a short list's intent (a move) is now expressed.
  // KILLING MUTATION: delete the arity check. RESULT: RED.
  it('a list that DROPS a tab renders the shipped bar — this path never learned to move tabs', () => {
    expect(resolveNavTabs(['today', 'garden', 'create', 'harvests'])).toBe(DEFAULT_NAV_TABS)
    expect(resolveNavTabs([])).toBe(DEFAULT_NAV_TABS)
  })
})

describe('the registry and the default agree', () => {
  // DEFAULT_NAV_TABS and TAB_REGISTRY are two declarations of one fact, and the permutation rule in
  // both resolvers is only equivalent to "is a reorder" while they hold the same keys. If a later row
  // adds an OPTIONAL tab to the registry without adding it to the default, this reds — which is the
  // moment to decide where that tab lives, rather than to discover it as a rendering bug.
  it('every default key exists in the registry and vice versa', () => {
    expect([...DEFAULT_NAV_TABS].sort()).toEqual(Object.keys(TAB_REGISTRY).sort())
  })

  it('every registry row carries what the bar renders', () => {
    for (const [key, tab] of Object.entries(TAB_REGISTRY)) {
      expect(typeof tab.to, key).toBe('string')
      expect(tab.to.startsWith('/'), key).toBe(true)
      expect(typeof tab.label, key).toBe('string')
      expect(typeof tab.iconName, key).toBe('string')
    }
  })

  // The FAB is what BottomNav forks on to draw the circle and — in field mode — the mic. Exactly one
  // row may carry it: none and there is no create button, two and the bar draws two circles.
  it('exactly one tab is the highlight (the FAB)', () => {
    expect(Object.values(TAB_REGISTRY).filter(t => t.highlight)).toHaveLength(1)
  })
})
