import { describe, it, expect } from 'vitest'
import { buildLifeStory } from '../lib/lifeStory.js'

describe('buildLifeStory', () => {
  it('returns [] for null / dateless plantings', () => {
    expect(buildLifeStory(null)).toEqual([])
    expect(buildLifeStory({ variety_ref: {} })).toEqual([])
  })

  it('emits only milestones that have a date, in ascending order', () => {
    const rows = buildLifeStory({
      sown_at: '2026-02-01', germinated_at: '2026-02-10',
      transplanted_at: '2026-04-15', planted_out_at: null, first_harvest_at: '2026-06-20',
    })
    expect(rows.map(r => r.key)).toEqual(['sown', 'germinated', 'transplanted', 'first_harvest'])
    for (let i = 1; i < rows.length; i++) expect(rows[i].date >= rows[i - 1].date).toBe(true)
  })

  it('carries the approx flag through', () => {
    const rows = buildLifeStory({ sown_at: '2026-02-01', sown_at_approx: true })
    expect(rows[0].approx).toBe(true)
  })
})
