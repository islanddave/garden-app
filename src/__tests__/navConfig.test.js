/**
 * src/__tests__/navConfig.test.js
 *
 * V5-ADMINCENTER-001 — the guards on resolveNavTabs().
 *
 * WHY THIS FILE EXISTS. nav_tabs is a jsonb column an admin writes; it is not validated by a CHECK
 * against the key list (the vocabulary lives in JS and would go stale in the database) and it is
 * read on the boot path by the one component that is on every screen. So the renderer must be TOTAL
 * over that column's whole domain, and "total" here has a specific meaning: every value it will not
 * accept renders the shipped bar, not a broken one and never an empty one. A nav bar that renders
 * nothing is not a cosmetic failure in an installed PWA — it is the only navigation Dave has.
 *
 * EACH GUARD IS INDEPENDENTLY KILLABLE, AND THE MUTATION IS NAMED ON THE CASE. That is the point of
 * the input choices below: every case uses a payload that ONLY its own guard rejects, so deleting
 * that one line turns that one case red instead of being masked by a neighbouring check. Verified by
 * running the four mutations, 2026-09-08 — results are recorded per case.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_NAV_TABS, TAB_REGISTRY, resolveNavTabs } from '../lib/navConfig.js'

describe('resolveNavTabs — the shipped default is the answer to everything it will not accept', () => {
  // The floor. NULL is what an unconfigured user, a rolled-back column and a failed prefs GET all
  // look like, and it is the reason the migration is purely additive.
  it('null / undefined — the unset column — renders the shipped bar', () => {
    expect(resolveNavTabs(null)).toEqual(DEFAULT_NAV_TABS)
    expect(resolveNavTabs(undefined)).toEqual(DEFAULT_NAV_TABS)
  })

  it('honours a genuine reorder', () => {
    const reordered = ['harvests', 'today', 'create', 'garden', 'put-up']
    expect(resolveNavTabs(reordered)).toEqual(reordered)
  })

  // NON-VACUITY. Without this, a resolver hardcoded to `return DEFAULT_NAV_TABS` would satisfy every
  // other case in this file — which is exactly the shape of guard this project has shipped before.
  it('is not simply returning the default for everything', () => {
    expect(resolveNavTabs(['put-up', 'harvests', 'create', 'garden', 'today'])).not.toEqual(DEFAULT_NAV_TABS)
  })

  // GUARD 1 — malformed payload. jsonb accepts objects, strings, numbers and booleans, so all four
  // can genuinely be in the column.
  // KILLING MUTATION: delete `if (!Array.isArray(raw)) return DEFAULT_NAV_TABS`.
  // RESULT: RED — the next line calls raw.some(), which these values do not have, so the case fails
  // with "raw.some is not a function" rather than falling through to another guard. The array check
  // must stay FIRST for that reason; moved below the arity check it would be masked for objects and
  // numbers (undefined length !== 5) and this case would pass against a broken resolver.
  it('a malformed payload — object, string, number, boolean — renders the shipped bar', () => {
    expect(resolveNavTabs({ tabs: ['today'] })).toEqual(DEFAULT_NAV_TABS)
    expect(resolveNavTabs('today,garden')).toEqual(DEFAULT_NAV_TABS)
    expect(resolveNavTabs(42)).toEqual(DEFAULT_NAV_TABS)
    expect(resolveNavTabs(true)).toEqual(DEFAULT_NAV_TABS)
  })

  // GUARD 2 — an unknown key. Five entries, no duplicates, so nothing else here catches it.
  // KILLING MUTATION: delete the `Object.hasOwn(TAB_REGISTRY, k)` line.
  // RESULT: RED — the payload passes arity and uniqueness, so the resolver returns it verbatim and
  // the bar tries to render TAB_REGISTRY['nope'], which is undefined.
  it('an unknown tab key renders the shipped bar', () => {
    expect(resolveNavTabs(['today', 'garden', 'create', 'harvests', 'nope'])).toEqual(DEFAULT_NAV_TABS)
  })

  // Same guard, the non-string arm — `Object.hasOwn` rejects these too, which is why there is no
  // separate typeof check to mutate. A second check would be a redundant suppression: it would keep
  // this case green while the mutation it exists to catch went unnoticed.
  it('a non-string element renders the shipped bar', () => {
    expect(resolveNavTabs(['today', 'garden', 'create', 'harvests', 7])).toEqual(DEFAULT_NAV_TABS)
    expect(resolveNavTabs(['today', 'garden', 'create', 'harvests', null])).toEqual(DEFAULT_NAV_TABS)
    expect(resolveNavTabs(['today', 'garden', 'create', 'harvests', { to: '/x' }])).toEqual(DEFAULT_NAV_TABS)
  })

  // Inherited properties are NOT keys. `k in TAB_REGISTRY` would accept 'toString' and 'constructor'
  // and then render undefined; Object.hasOwn is what makes the check own-property-only, and this is
  // the case that tells the two apart.
  // KILLING MUTATION: change `Object.hasOwn(TAB_REGISTRY, k)` to `k in TAB_REGISTRY`.
  // RESULT: RED — the payload is accepted and TAB_REGISTRY.toString is a function, not a tab.
  it('a prototype-chain property is not a tab key', () => {
    expect(resolveNavTabs(['toString', 'garden', 'create', 'harvests', 'put-up'])).toEqual(DEFAULT_NAV_TABS)
    expect(resolveNavTabs(['constructor', 'garden', 'create', 'harvests', 'put-up'])).toEqual(DEFAULT_NAV_TABS)
  })

  // GUARD 3 — a duplicate key. Five entries, all known, so only the uniqueness check rejects it.
  // KILLING MUTATION: delete `if (new Set(raw).size !== raw.length) return DEFAULT_NAV_TABS`.
  // RESULT: RED — the payload is returned verbatim and the bar renders two Today tabs sharing one
  // React key, with Put-Up silently gone.
  it('a duplicate tab key renders the shipped bar', () => {
    expect(resolveNavTabs(['today', 'today', 'garden', 'create', 'harvests'])).toEqual(DEFAULT_NAV_TABS)
  })

  // GUARD 4 — arity, which is both the empty case and the reorder-only rule. An empty array is what
  // "hide every tab" would look like, and it is the single most destructive value the column can
  // hold: it renders a bar containing nothing but More.
  // KILLING MUTATION: delete `if (raw.length !== DEFAULT_NAV_TABS.length) return DEFAULT_NAV_TABS`.
  // RESULT: RED on the two cases below — [] is returned as [] and the short payload verbatim, so
  // the bar loses tabs. (Measured 2026-09-08; it also reds the hostile-inputs case.)
  it('an empty array renders the shipped bar rather than an empty nav', () => {
    expect(resolveNavTabs([])).toEqual(DEFAULT_NAV_TABS)
  })

  it('a config that DROPS a tab renders the shipped bar — v1 is reorder-only', () => {
    // Hiding a tab removes the only door to a page. It is reserved for a Dave decision (design §7)
    // and is refused whole here rather than partly applied.
    expect(resolveNavTabs(['today', 'garden', 'create', 'harvests'])).toEqual(DEFAULT_NAV_TABS)
  })

  // THE CAP, AND AN HONEST NOTE ABOUT WHICH GUARD HOLDS IT TODAY. A longer-than-default config
  // cannot be built out of five known keys without repeating one or inventing one, so right now
  // this case is killed by the duplicate and unknown-key guards, NOT by the arity guard — deleting
  // arity alone leaves both variants below green. That is fine and it is still a cap (the bar cannot
  // grow, by any route), but it means the arity guard's "too long" arm is UNPROVEN until the
  // registry holds more keys than the default order does. The day someone adds an optional tab is
  // the day this case starts testing arity, and the registry/default agreement test below is what
  // will flag that day.
  it('a config that ADDS a tab renders the shipped bar — this is the cap', () => {
    expect(resolveNavTabs(['today', 'garden', 'create', 'harvests', 'put-up', 'today'])).toEqual(DEFAULT_NAV_TABS)
    expect(resolveNavTabs(['today', 'garden', 'create', 'harvests', 'put-up', 'compost'])).toEqual(DEFAULT_NAV_TABS)
  })

  it('never returns an empty or short list for any input, including hostile ones', () => {
    // The invariant the whole file is really about, asserted directly so it cannot be lost to a
    // refactor that keeps every case above green while changing what "fall back" means.
    const hostile = [null, undefined, [], {}, '', 0, NaN, [[]], [{}], ['today'], new Array(50).fill('today')]
    for (const input of hostile) {
      const out = resolveNavTabs(input)
      expect(out.length, JSON.stringify(input)).toBe(DEFAULT_NAV_TABS.length)
      expect(out.every(k => Object.hasOwn(TAB_REGISTRY, k)), JSON.stringify(input)).toBe(true)
    }
  })

  it('does not mutate the payload it was handed', () => {
    const config = ['garden', 'today', 'create', 'harvests', 'put-up']
    const copy = [...config]
    resolveNavTabs(config)
    expect(config).toEqual(copy)
  })
})

describe('the registry and the default agree', () => {
  // DEFAULT_NAV_TABS and TAB_REGISTRY are two declarations of one fact, and the permutation rule in
  // resolveNavTabs is only equivalent to "is a reorder" while they hold the same keys. If a later
  // row adds an OPTIONAL tab to the registry without adding it to the default, this reds — which is
  // the moment to decide the hide/show question rather than to discover it as a rendering bug.
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
