// V1.2a-4 S1 (PROJ-RESCOPE) — trivial flag-export assertion.
// Flips true when VARIETY-REF S4 lands the Cultivar-as-first-class flow.

import { describe, it, expect } from 'vitest'
import { VARIETY_REF_UI_SHIPPED, CATCH_UP_EDITOR_SHIPPED } from '../lib/featureFlags.js'

describe('featureFlags', () => {
  it('VARIETY_REF_UI_SHIPPED is exported as false in S1', () => {
    expect(VARIETY_REF_UI_SHIPPED).toBe(false)
  })

  it('CATCH_UP_EDITOR_SHIPPED is exported as false (badge hidden until S1.1 editor ships)', () => {
    expect(CATCH_UP_EDITOR_SHIPPED).toBe(false)
  })
})
