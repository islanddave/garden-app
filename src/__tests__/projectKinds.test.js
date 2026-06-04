// Lane D / Phase B+C — project-kind centralization guard. PROJECT_KINDS must equal
// the live DB CHECK / Lambda ALLOWED_KINDS; projectKindOptions gates cultivar.
import { describe, it, expect } from 'vitest'
import { PROJECT_KINDS, PROJECT_KIND_MAP, projectKindOptions } from '../lib/constants.js'

describe('project kinds', () => {
  it('PROJECT_KINDS matches the canonical DB-CHECK / Lambda ALLOWED_KINDS set', () => {
    expect([...PROJECT_KINDS].sort()).toEqual(['campaign', 'category', 'cultivar'])
  })
  it('every kind has a label', () => {
    for (const k of PROJECT_KINDS) expect(PROJECT_KIND_MAP[k].label).toBeTruthy()
  })
  it('projectKindOptions gates cultivar behind the flag', () => {
    expect(projectKindOptions(false).map(o => o.value)).toEqual(['campaign', 'category'])
    expect(projectKindOptions(true).map(o => o.value)).toEqual(['campaign', 'category', 'cultivar'])
  })
})
