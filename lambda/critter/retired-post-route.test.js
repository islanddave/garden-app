// BUG-CRITTERSELFGRANT-001 — POST /api/critters is RETIRED, and must stay retired.
//
// The route inserted a critter_state row for ANY event in the caller's household with no event_type
// gate, no probability roll at all, and a caller-chosen species_id: a guaranteed self-grant of the
// only reward in this system that writes durable data. It was retired rather than gated because
// gating it would have meant teaching this Lambda the event-type vocabulary (a codegen change — the
// vocabulary generates into lambda/events/ only) purely to keep a route with no callers alive.
//
// Evidence checked before removal, not assumed:
//   * SPA — critterClient.awardCritter() had zero call sites since the events Lambda's server hook
//     replaced it (EventNew.jsx:1041).
//   * PROD — all 1277 live critter_state rows carry meta->>'deterministic_seed', which only
//     awardCritterServer writes. This route wrote the caller's meta (default {}). 0 rows, ever.
//
// TIER. These assertions EXECUTE: they import the real modules and check the surface that route
// needed is genuinely gone, rather than regexing for its absence — and "absence" is the one thing a
// source-text search is worst at, because a construct named in a comment is not that construct
// (this file's own header names the route four times). The route's own 404 fallthrough cannot be
// executed here: importing lambda/critter/index.js is impossible in this suite, whose Lambda runtime
// deps are deliberately not installed. The complementary guard is
// src/__tests__/clientRouteLambdaContract.test.js, which reds if any client path ever names a route
// no Lambda declares — so re-adding a caller without re-adding the route cannot pass.

import { describe, it, expect } from 'vitest'
import * as critterValidators from './validators.js'
import * as critterClient from '../../src/lib/critterClient.js'

describe('POST /api/critters stays retired (BUG-CRITTERSELFGRANT-001)', () => {
  it('the request-body validator that only that route used is gone', () => {
    expect(critterValidators.validateCritterPostBody).toBeUndefined()
    // Anti-vacuity: the module still loads and still exports its surviving validators, so the
    // assertion above is about one missing export and not about a failed import.
    expect(typeof critterValidators.validatePrefsPatchBody).toBe('function')
    expect(typeof critterValidators.validateSpeciesPrefsPatchBody).toBe('function')
    expect(typeof critterValidators.validateMarkViewedPatchBody).toBe('function')
  })

  it('the client function that called it is gone, along with the seed builder that fed it', () => {
    expect(critterClient.awardCritter).toBeUndefined()
    expect(critterClient.buildSeed).toBeUndefined()
    // Same anti-vacuity floor: the read-side client is untouched and still exported.
    expect(typeof critterClient.fetchActiveCritters).toBe('function')
    expect(typeof critterClient.markCrittersViewed).toBe('function')
  })

  it('no client-side grant path survives: nothing in the module can POST a critter', () => {
    // Every remaining export is a read or a preference write. Enumerated rather than sampled, so a
    // re-added grant function shows up here as an unexpected name instead of slipping past.
    expect(Object.keys(critterClient).sort()).toEqual([
      'fetchActiveCritters', 'fetchCollection', 'markCrittersViewed', 'patchSpeciesPrefs',
    ])
  })
})
