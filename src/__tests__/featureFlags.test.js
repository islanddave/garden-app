// V1.2a-4 S1 (PROJ-RESCOPE) — trivial flag-export assertion.
// Flips true when VARIETY-REF S4 lands the Cultivar-as-first-class flow.
// MVP-Critter Session 4: adds SYSTEM_NOTIFICATIONS_ENABLED bi-state literal.

import { describe, it, expect } from 'vitest'
import {
  VARIETY_REF_UI_SHIPPED,
  CATCH_UP_EDITOR_SHIPPED,
  SYSTEM_NOTIFICATIONS_ENABLED,
  PLANTING_REQUIRED_ENABLED,
} from '../lib/featureFlags.js'

describe('featureFlags', () => {
  it('VARIETY_REF_UI_SHIPPED is exported as false in S1', () => {
    expect(VARIETY_REF_UI_SHIPPED).toBe(false)
  })

  it('CATCH_UP_EDITOR_SHIPPED is exported as false (badge hidden until S1.1 editor ships)', () => {
    expect(CATCH_UP_EDITOR_SHIPPED).toBe(false)
  })

  it('SYSTEM_NOTIFICATIONS_ENABLED is exported as false in MVP-Critter Session 4 Phase A', () => {
    expect(SYSTEM_NOTIFICATIONS_ENABLED).toBe(false)
  })

  it('SYSTEM_NOTIFICATIONS_ENABLED is a literal boolean (not an env-var passthrough)', () => {
    // Per revision §6 deferred note: literal const in featureFlags.js, NOT an env var.
    // Future activation = code change + ship, not runtime config flip.
    expect(typeof SYSTEM_NOTIFICATIONS_ENABLED).toBe('boolean')
  })

  it('PLANTING_REQUIRED_ENABLED is a literal false in Lane 3 (client gate stays off until Lane 2 telemetry clears)', () => {
    // V4-PLANTREQUIRED-001: literal const, NOT an env var. Flip = code change + ship, criteria-gated
    // (spec D1 falsifier + D7 PWA-staleness). The server validator is deliberately never flipped in lockstep.
    expect(PLANTING_REQUIRED_ENABLED).toBe(false)
    expect(typeof PLANTING_REQUIRED_ENABLED).toBe('boolean')
  })
})
