// V1.2a-4 S1 (PROJ-RESCOPE) — trivial flag-export assertion.
// Flips true when VARIETY-REF S4 lands the Cultivar-as-first-class flow.
// MVP-Critter Session 4: adds SYSTEM_NOTIFICATIONS_ENABLED bi-state literal.

import { describe, it, expect } from 'vitest'
import {
  VARIETY_REF_UI_SHIPPED,
  CATCH_UP_EDITOR_SHIPPED,
  SYSTEM_NOTIFICATIONS_ENABLED,
  PLANTING_REQUIRED_ENABLED,
  SEED_MULTI_PARENT,
} from '../lib/featureFlags.js'

describe('featureFlags', () => {
  it('VARIETY_REF_UI_SHIPPED is exported as false in S1', () => {
    expect(VARIETY_REF_UI_SHIPPED).toBe(false)
  })

  it('CATCH_UP_EDITOR_SHIPPED is a literal true — the start-date editor shipped (V5-PLANTSTARTDATES-001)', () => {
    // Pins the SHIPPED value so a future flip is deliberate. Off hides the More row only.
    expect(CATCH_UP_EDITOR_SHIPPED).toBe(true)
  })

  it('SYSTEM_NOTIFICATIONS_ENABLED is exported as false in MVP-Critter Session 4 Phase A', () => {
    expect(SYSTEM_NOTIFICATIONS_ENABLED).toBe(false)
  })

  it('SYSTEM_NOTIFICATIONS_ENABLED is a literal boolean (not an env-var passthrough)', () => {
    // Per revision §6 deferred note: literal const in featureFlags.js, NOT an env var.
    // Future activation = code change + ship, not runtime config flip.
    expect(typeof SYSTEM_NOTIFICATIONS_ENABLED).toBe('boolean')
  })

  it('PLANTING_REQUIRED_ENABLED is a literal true — Lane 2 telemetry cleared, gate is LIVE', () => {
    // V4-PLANTREQUIRED-001: literal const, NOT an env var. Flip = code change + ship, criteria-gated
    // (spec D1 falsifier + D7 PWA-staleness). The server validator is deliberately never flipped in lockstep.
    //
    // FLIPPED false -> true 2026-08-10 on Dave's approval. D1 falsifier measured MET 2026-08-06:
    // orphan rate for REQUIRED types 0.08% over 30d on 5,156 events, a 4x improvement on the 0.31%
    // of the 31-90d window. This assertion pins the SHIPPED value; it is intended to RED on any
    // future flip so the change is deliberate. Rollback = one-line revert, no data to unwind.
    expect(PLANTING_REQUIRED_ENABLED).toBe(true)
    expect(typeof PLANTING_REQUIRED_ENABLED).toBe('boolean')
  })

  it('SEED_MULTI_PARENT is a literal true — release 2b ships ON, declared exactly once', async () => {
    // V5-SEEDMULTIPARENT-001 release 2b. Pins the SHIPPED value so a flip is deliberate: turning it off is
    // the release's forward undo (the runbook is on the constant), and this is the one assertion such a
    // build edits. The model's own tests hold the flag on or mock it off, so they do not move.
    expect(SEED_MULTI_PARENT).toBe(true)
    // forward-undo.py flips `export const <FLAG> = true` by regex, so the line must be a literal and unique.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'src/lib/featureFlags.js'), 'utf8')
    expect(src.match(/^export const SEED_MULTI_PARENT\s*=\s*(true|false)\b/gm)).toEqual(['export const SEED_MULTI_PARENT = true'])
  })
})
