import { describe, it, expect } from 'vitest'
import {
  buildProjectsById, effectiveAssignee, buildCaretakerMap, lensOptions, hasMixedCaretakers,
} from '../lib/caretakers.js'

const projects = [{ id: 'pj1', assignee_user_id: 'jen' }, { id: 'pj2', assignee_user_id: null }]
const pbid = buildProjectsById(projects)

describe('effectiveAssignee', () => {
  it('uses the planting own assignee first', () => {
    expect(effectiveAssignee({ assignee_user_id: 'dave', project_id: 'pj1' }, pbid)).toBe('dave')
  })
  it('inherits the project assignee when own is null', () => {
    expect(effectiveAssignee({ assignee_user_id: null, project_id: 'pj1' }, pbid)).toBe('jen')
  })
  it('returns null when neither planting nor project is assigned', () => {
    expect(effectiveAssignee({ assignee_user_id: null, project_id: 'pj2' }, pbid)).toBe(null)
    expect(effectiveAssignee({ assignee_user_id: null, project_id: 'nope' }, pbid)).toBe(null)
  })
  it('treats a System sub as unassigned (null)', () => {
    const sys = new Set(['sysbot'])
    expect(effectiveAssignee({ assignee_user_id: 'sysbot', project_id: 'pj1' }, pbid, sys)).toBe(null)
  })
})

describe('buildCaretakerMap', () => {
  const members = [{ id: 'dave', display_name: 'Dave Nichols' }, { id: 'jen', display_name: 'Jen Smith' }]
  it('marks the current user isMe with the "Mine" short label and an initial', () => {
    const m = buildCaretakerMap(members, 'dave')
    expect(m.get('dave').isMe).toBe(true)
    expect(m.get('dave').short).toBe('Mine')
    expect(m.get('jen').isMe).toBe(false)
    expect(m.get('jen').initial).toBe('J')
    expect(m.get('jen').short).toBe('Jen')
  })
  it('gives distinct colors to me vs other', () => {
    const m = buildCaretakerMap(members, 'dave')
    expect(m.get('dave').color).not.toBe(m.get('jen').color)
  })
})

describe('lensOptions', () => {
  it('is [Mine, <others…>, Everyone] with Everyone last', () => {
    const opts = lensOptions([{ id: 'dave', display_name: 'Dave' }, { id: 'jen', display_name: 'Jen' }], 'dave')
    expect(opts.map(o => o.label)).toEqual(['Mine', 'Jen', 'Everyone'])
    expect(opts[0].value).toBe('dave')
    expect(opts[opts.length - 1].value).toBe('all')
  })
  it('single-user household yields only [Mine, Everyone] (length 2 -> lens hidden)', () => {
    const opts = lensOptions([{ id: 'dave', display_name: 'Dave' }], 'dave')
    expect(opts.length).toBe(2)
  })
})

describe('hasMixedCaretakers', () => {
  it('true when >1 distinct effective caretaker (incl. unassigned)', () => {
    const plants = [
      { assignee_user_id: 'dave', project_id: 'pj2' },
      { assignee_user_id: null, project_id: 'pj1' }, // -> jen
    ]
    expect(hasMixedCaretakers(plants, pbid)).toBe(true)
  })
  it('false when all share one caretaker', () => {
    const plants = [
      { assignee_user_id: 'dave', project_id: 'pj2' },
      { assignee_user_id: 'dave', project_id: 'pj1' },
    ]
    expect(hasMixedCaretakers(plants, pbid)).toBe(false)
  })
})
