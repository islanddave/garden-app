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
  SEED_ADD_TO_LOT,
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

  it('SEED_MULTI_PARENT is a literal boolean, declared exactly once', async () => {
    // V5-SEEDMULTIPARENT-001 release 2b. The VALUE is not pinned here: turning it off is the release's
    // forward undo (the runbook is on the constant), and scripts/forward-undo.py flips the literal and
    // edits no test, so a build with it false has to be green as it stands. Every flag-on test file holds
    // the flag on and every flag-off one mocks it off; `npm run test:flag-off:seed` rehearses that build.
    expect(typeof SEED_MULTI_PARENT).toBe('boolean')
    // forward-undo.py flips `export const <FLAG> = true` by regex, so the line must be a literal and unique.
    // Read from disk, so it is the tree's own line whatever a rehearsal is serving in memory.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'src/lib/featureFlags.js'), 'utf8')
    const declared = src.match(/^export const SEED_MULTI_PARENT\s*=\s*(true|false)\b/gm)
    expect(declared).toHaveLength(1)
    expect(['export const SEED_MULTI_PARENT = true', 'export const SEED_MULTI_PARENT = false']).toContain(declared[0])
  })

  it('SEED_ADD_TO_LOT is a literal boolean, declared exactly once, directly under SEED_MULTI_PARENT', async () => {
    // V5-SEEDLOTADDITION-001 (seed release 3). Same rule as the flag above it and for the same reason:
    // the value is not pinned (flag off is the forward undo, rehearsed by `npm run test:flag-off:seedadd`),
    // the line is, because forward-undo.py flips it by regex. Read from disk.
    expect(typeof SEED_ADD_TO_LOT).toBe('boolean')
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'src/lib/featureFlags.js'), 'utf8')
    const declared = src.match(/^export const SEED_ADD_TO_LOT\s*=\s*(true|false)\b/gm)
    expect(declared).toHaveLength(1)
    expect(['export const SEED_ADD_TO_LOT = true', 'export const SEED_ADD_TO_LOT = false']).toContain(declared[0])
    // Under its neighbour with only its own runbook comment between: release 3 is undone before 2b.
    const lines = src.split('\n')
    const at = lines.findIndex((l) => /^export const SEED_MULTI_PARENT\s*=/.test(l))
    const next = lines.slice(at + 1).find((l) => !l.startsWith('//'))
    expect(next).toBe(declared[0])
  })
})
