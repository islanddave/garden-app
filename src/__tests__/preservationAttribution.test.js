// V4-PUTUPLINK-001 — pure-function coverage for the preservation Lambda's L7 planting attribution.
// These are the cross-field rules the DDL CANNOT express: chk_preservation_log_attribution only
// knows "crop OR variety", it has no way to assert that a put-up's planting grows the same crop.
// Design V101 L7 required it ("planting_id's crop must match"); it was never implemented until now,
// so this file is the only thing standing between an edit and a zucchini put-up filed under a
// tomato planting. No DB — the handler resolves the planting and hands the row in.
import { describe, it, expect } from 'vitest'
// Imports the DEP-FREE module, never index.js: index.js pulls neon/clerk/aws, which are absent
// under `npm ci` in CI even though they resolve on a dev machine (local-green / CI-red trap).
import { reconcilePlantAttribution, plantingLabel } from '../../lambda/preservation/attribution.js'

const PLANTING = {
  id: 'pl-w2',
  display_name: 'Dark Green Zucchini',
  crop_type_slug: 'squash',
  variety_id: 'var-dgz',
  sown_at: '2026-05-12',
  succession_order: 2,
}

describe('reconcilePlantAttribution — L7 cross-field integrity', () => {
  it('derives crop AND variety when the body carries neither', () => {
    // The whole point of "a planting is sufficient attribution": the user picks a wave, the server
    // fills in what the DB CHECK needs.
    expect(reconcilePlantAttribution({}, PLANTING)).toEqual({
      crop_type_slug: 'squash',
      variety_id: 'var-dgz',
    })
  })

  it('passes through a matching crop and variety unchanged', () => {
    const out = reconcilePlantAttribution({ crop_type_slug: 'squash', variety_id: 'var-dgz' }, PLANTING)
    expect(out.error).toBeUndefined()
    expect(out).toEqual({ crop_type_slug: 'squash', variety_id: 'var-dgz' })
  })

  it('REJECTS a crop that contradicts the planting rather than silently rewriting it', () => {
    const out = reconcilePlantAttribution({ crop_type_slug: 'tomato' }, PLANTING)
    expect(out.error).toMatch(/crop_type_slug does not match/)
    expect(out.crop_type_slug).toBeUndefined()
  })

  it('REJECTS a variety that contradicts the planting', () => {
    const out = reconcilePlantAttribution({ variety_id: 'var-cherokee' }, PLANTING)
    expect(out.error).toMatch(/variety_id does not match/)
  })

  it('rejects an unresolvable planting without confirming whether it exists', () => {
    // loadPlanting returns null for BOTH "no such row" and "not your household" — the message must
    // not distinguish them, or it becomes an existence oracle for other households' plant ids.
    const out = reconcilePlantAttribution({ crop_type_slug: 'squash' }, null)
    expect(out.error).toMatch(/does not match a planting you can log against/)
    expect(out.error).not.toMatch(/exist|household|permission/i)
  })

  it('fills only the missing half when the body supplies one side', () => {
    expect(reconcilePlantAttribution({ crop_type_slug: 'squash' }, PLANTING).variety_id).toBe('var-dgz')
    expect(reconcilePlantAttribution({ variety_id: 'var-dgz' }, PLANTING).crop_type_slug).toBe('squash')
  })

  it('tolerates a planting with no variety — crop still derives, no false mismatch', () => {
    const bare = { ...PLANTING, variety_id: null, crop_type_slug: 'squash' }
    const out = reconcilePlantAttribution({ variety_id: 'var-anything' }, bare)
    expect(out.error).toBeUndefined()          // nothing to contradict
    expect(out.variety_id).toBe('var-anything')
    expect(out.crop_type_slug).toBe('squash')
  })

  it('compares as strings so a uuid/text type mismatch is not a false rejection', () => {
    const numeric = { ...PLANTING, variety_id: 42 }
    expect(reconcilePlantAttribution({ variety_id: '42' }, numeric).error).toBeUndefined()
  })
})

describe('plantingLabel — succession disambiguation', () => {
  it('carries wave ordinal and sown date so same-named waves are tellable apart', () => {
    const label = plantingLabel({
      planting_name: 'Dark Green Zucchini', planting_succession_order: 2, planting_sown_at: '2026-05-12',
    })
    expect(label).toMatch(/Dark Green Zucchini/)
    expect(label).toMatch(/wave 2/)
    expect(label).toMatch(/May 12/)
  })

  it('renders the sown date in UTC — a local-timezone read shifts it a day behind UTC', () => {
    // The neon driver hands dates back as JS Date objects; naive toLocaleDateString would render
    // 2026-05-12T00:00Z as "May 11" anywhere west of Greenwich.
    expect(plantingLabel({ planting_name: 'X', planting_sown_at: new Date('2026-05-12T00:00:00Z') }))
      .toMatch(/May 12/)
  })

  it('degrades cleanly with no succession ordinal, no date, or no name', () => {
    expect(plantingLabel({ planting_name: 'Solo' })).toBe('Solo')
    expect(plantingLabel({ planting_variety_name: 'Fallback' })).toBe('Fallback')
    expect(plantingLabel({})).toBe('Planting')
  })

  it('ignores an unparseable sown date instead of emitting "Invalid Date"', () => {
    expect(plantingLabel({ planting_name: 'X', planting_sown_at: 'not-a-date' })).toBe('X')
  })

  it('treats wave 0 as a real ordinal, not a falsy blank', () => {
    expect(plantingLabel({ planting_name: 'X', planting_succession_order: 0 })).toMatch(/wave 0/)
  })
})
