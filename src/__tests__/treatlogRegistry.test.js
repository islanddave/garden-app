import { describe, it, expect } from 'vitest'
import { EVENT_METADATA_FIELDS, ISSUE_OPTIONS, PEST_TARGET_SUGGESTIONS, TREATMENT_CATEGORY_OPTIONS } from '../lib/dropdownRegistry.js'

// V4-TREATLOG-001 — registry vocab for the dedicated treatment section.
describe('V4-TREATLOG-001 registry', () => {
  it('removes pest_treatment from the collapsible More-details panel (moved to TreatmentDetails)', () => {
    expect(EVENT_METADATA_FIELDS.pest_treatment).toBeUndefined()
  })
  it('adds the previously-missing common pests to the Pests group', () => {
    const pests = ISSUE_OPTIONS.find(g => g.group === 'Pests').options
    for (const p of ['Japanese beetle', 'Asiatic garden beetle', 'Cabbage moth / looper', 'Colorado potato beetle'])
      expect(pests).toContain(p)
  })
  it('PEST_TARGET_SUGGESTIONS is a flat non-empty list incl. the new pests', () => {
    expect(Array.isArray(PEST_TARGET_SUGGESTIONS)).toBe(true)
    expect(PEST_TARGET_SUGGESTIONS).toContain('Japanese beetle')
    expect(PEST_TARGET_SUGGESTIONS.length).toBeGreaterThan(20)
  })
  it('models fertilizer and amendment as DISTINCT treatment categories', () => {
    const vals = TREATMENT_CATEGORY_OPTIONS.map(o => o.value)
    expect(vals).toContain('fertilizer')
    expect(vals).toContain('amendment')
    expect(vals).toContain('pest_control')
  })
})
