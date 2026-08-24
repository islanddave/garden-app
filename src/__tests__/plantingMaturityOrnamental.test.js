// V4-CONSUMABLECLASS-001 (BD-042) — no harvest projection for a plant grown to be looked at.
//
// THE LIVE DEFECT, reproduced from the real prod row: a rescued Cobaea scandens "Violet"
// (crop_type_slug `cobaea`, DTM 75–95 from-transplant, transplanted 2026-07-21) rendered
// "⏳ Est. harvest Oct 4 – Oct 24" on its planting tab. Dave: nonsensical. Seven live ornamentals
// were doing it, eight more latent.
//
// The fixture is the ROW, not a convenient shape — same slug, same DTM, same basis, same date — so
// this file fails the day the gate is removed and the exact string Dave complained about comes back.
import { describe, it, expect } from 'vitest'
import { computeMaturity } from '../lib/plantingMaturity.js'

const TODAY = new Date('2026-08-24T12:00:00')

// The violet, as prod holds it.
const violet = () => ({
  id: 'v1', name: 'Violet', transplanted_at: '2026-07-21',
  variety_ref: {
    crop_type_slug: 'cobaea', name: 'Cobaea scandens',
    days_to_maturity_min: 75, days_to_maturity_max: 95,
    dtm_basis: 'from-transplant', harvest_habit: null,
  },
})
// Same shape, same dates, an EDIBLE crop — the control that proves the suppression is keyed on the
// crop and not on something incidental to the fixture.
const pepper = () => ({
  ...violet(),
  variety_ref: { ...violet().variety_ref, crop_type_slug: 'pepper', harvest_habit: 'repeat' },
})

describe('BD-042 — ornamentals get no harvest projection', () => {
  it('the violet renders NO harvest window, and not the string Dave reported', () => {
    const m = computeMaturity(violet(), TODAY)
    expect(m.harvestTracked).toBe(false)
    expect(m.harvestWindowLabel).toBeNull()
    expect(m.maturityMinDate).toBeNull()
    expect(m.maturityMaxDate).toBeNull()
    expect(m.isMature).toBeNull()
    expect(m.pctToMaturity).toBeNull()
    expect(m.awaitingTransplant).toBe(false)
  })

  it('AGE survives — suppressing the harvest claim must not blank the card', () => {
    // "Transplanted 34 days ago" is true, useful, and on an ornamental it is what the card is FOR.
    // If this ever goes null the fix overreached from "no harvest claim" into "no information".
    const m = computeMaturity(violet(), TODAY)
    expect(m.ageDays).toBe(34)
    expect(m.anchorField).toBe('transplanted_at')
    expect(m.anchorLabel).toBe('transplanted')
    // The catalogue figures are facts about the cultivar and are still reported; what is gone is
    // the projection built ON them.
    expect(m.dtmMin).toBe(75)
    expect(m.dtmMax).toBe(95)
  })

  it('CONTROL: the identical planting on an edible crop still projects its window', () => {
    const m = computeMaturity(pepper(), TODAY)
    expect(m.harvestTracked).toBe(true)
    expect(m.harvestWindowLabel).toBeTruthy()
    expect(m.maturityMinDate).not.toBeNull()
    // Non-vacuity: without this the suppression case would pass against a computeMaturity that had
    // simply stopped projecting for everyone.
    expect(m.harvestWindowLabel).toMatch(/harvest/i)
  })

  it('suppresses the awaiting-transplant claim too — it is also a harvest claim', () => {
    // "Est. harvest — set at transplant" is the from-transplant no-anchor branch. It is a promise of
    // a future harvest date, so it is gated by the same condition; gating only the dated window
    // would have left ornamentals reading as harvests-pending-a-date instead.
    const noAnchor = { ...violet(), transplanted_at: null, planted_out_at: null, sown_at: null }
    const m = computeMaturity(noAnchor, TODAY)
    expect(m.awaitingTransplant).toBe(false)
    expect(m.harvestWindowLabel).toBeNull()
    // CONTROL again: the edible twin DOES still get it.
    const ediblePending = { ...pepper(), transplanted_at: null, planted_out_at: null, sown_at: null }
    const me = computeMaturity(ediblePending, TODAY)
    expect(me.awaitingTransplant).toBe(true)
    expect(me.harvestWindowLabel).toBe('Est. harvest — set at transplant')
  })

  it('an unknown crop type keeps its window — the gate only removes, never withholds', () => {
    const unknown = { ...violet(), variety_ref: { ...violet().variety_ref, crop_type_slug: 'brand_new_crop' } }
    const m = computeMaturity(unknown, TODAY)
    expect(m.harvestTracked).toBe(true)
    expect(m.harvestWindowLabel).toBeTruthy()
  })
})
