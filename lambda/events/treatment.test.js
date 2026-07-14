import { describe, it, expect } from 'vitest'
import { validatePostBody } from './validators.js'

// V4-TREATLOG-001 — treatment_category is validated on the POST body.
describe('V4-TREATLOG-001 treatment_category validation', () => {
  const base = { event_type: 'pest_treatment', project_id: 'p1' }
  it('accepts every valid treatment_category', () => {
    for (const c of ['fertilizer', 'amendment', 'pest_control', 'other'])
      expect(validatePostBody({ ...base, treatment_category: c })).toBeNull()
  })
  it('accepts an absent treatment_category', () => {
    expect(validatePostBody(base)).toBeNull()
  })
  it('rejects an unknown treatment_category', () => {
    const r = validatePostBody({ ...base, treatment_category: 'bogus' })
    expect(r?.status).toBe(400)
    expect(r?.error).toMatch(/treatment_category/)
  })
})
