// Lambda-side <-> client-side nav tab vocabulary parity. V5-ADMINCENTER-001.
//
// WHY A SECOND COPY EXISTS AT ALL. The Lambda has to refuse an unknown tab key at WRITE time — an
// accepted-but-unrenderable config is a save that reports success and changes nothing, which is
// worse than a 400. The client has to refuse one at READ time, because app_config.value is jsonb
// with no CHECK behind it and a hand-written row must still render a usable bar. Neither point can
// serve the other: the Lambda cannot import from src/, and the client cannot be the security
// boundary. So there are two copies, and this file is the thing that stops them drifting — the house
// pattern critterSpecies.parity.test.js established for exactly this shape of duplication.
//
// IF THIS FAILS, a copy diverged. Fix the divergence, or change the contract in BOTH places
// deliberately: adding or renaming a tab is a deploy of the SPA and the Lambda together, and a
// vocabulary the Lambda accepts but the renderer does not know is a config that saves and no-ops.

import { describe, it, expect } from 'vitest'
import { NAV_TAB_KEYS, validateAppConfigPatchBody } from './validators.js'
import { DEFAULT_NAV_TABS, TAB_REGISTRY, resolveNavTabs } from '../../src/lib/navConfig.js'

describe('nav tab vocabulary — Lambda writer <-> client renderer parity', () => {
  it('NAV_TAB_KEYS is identical to DEFAULT_NAV_TABS, order included', () => {
    // Order is asserted as well as membership: DEFAULT_NAV_TABS is also the SHIPPED order, the one
    // rendered when nothing is configured, so a reordered Lambda copy would silently redefine what
    // "the default" means on the only surface that is allowed to define it.
    expect(NAV_TAB_KEYS).toEqual(DEFAULT_NAV_TABS)
  })

  it('every key both sides know is a real entry in TAB_REGISTRY', () => {
    // Anti-vacuity for the equality above: two empty arrays are also equal. This pins both sides to
    // the registry that actually supplies a route, a label and an icon.
    expect(NAV_TAB_KEYS.length).toBeGreaterThan(0)
    for (const k of NAV_TAB_KEYS) expect(Object.hasOwn(TAB_REGISTRY, k)).toBe(true)
    expect(Object.keys(TAB_REGISTRY).sort()).toEqual([...NAV_TAB_KEYS].sort())
  })

  it('the two guards AGREE on every value: what the Lambda accepts, the renderer applies', () => {
    // The property that matters is not that the key lists match but that the two decisions match.
    // A config the server stores and the client silently ignores is the failure this catches.
    const cases = [
      ['harvests', 'today', 'create', 'garden', 'put-up'],   // a permutation
      [...DEFAULT_NAV_TABS],                                  // the identity permutation
      [],                                                     // hide everything
      ['today', 'garden'],                                    // hide some
      ['today', 'today', 'garden', 'create', 'harvests'],     // duplicate
      ['today', 'garden', 'create', 'harvests', 'moon'],       // unknown key
      ['today', 1, 'create', 'harvests', 'put-up'],            // non-string entry
    ]
    for (const value of cases) {
      const serverAccepts = validateAppConfigPatchBody({ nav_tabs: value }) === null
      // The renderer "applies" a config exactly when it does not fall back to the shipped default.
      const rendered = resolveNavTabs(value)
      const clientApplies = rendered !== DEFAULT_NAV_TABS
      expect({ value, serverAccepts }).toEqual({ value, serverAccepts: clientApplies })
    }
  })

  it('SELF-TEST: the agreement check can actually FAIL', () => {
    // Without this the loop above is green for a resolver that accepts everything, or for one that
    // accepts nothing. A value only the renderer would apply must be visible as a disagreement.
    const rogue = ['today', 'garden', 'create', 'harvests', 'put-up', 'today']
    expect(validateAppConfigPatchBody({ nav_tabs: rogue })).not.toBeNull()
    expect(resolveNavTabs(rogue)).toBe(DEFAULT_NAV_TABS)
    // ...and the identity of the fallback is what `clientApplies` reads, so pin it explicitly:
    // resolveNavTabs returns the SAME ARRAY REFERENCE on fallback and the caller's array otherwise.
    const good = ['harvests', 'today', 'create', 'garden', 'put-up']
    expect(resolveNavTabs(good)).toBe(good)
  })
})
