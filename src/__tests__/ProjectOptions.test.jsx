import { describe, it, expect } from 'vitest'
import ProjectOptions from '../components/ProjectOptions.jsx'

// FIX-4: depth-indented, fully-selectable grouped project picker options.
const P = [
  { id: 'c1', name: 'Fruiting Plants' },
  { id: 'p1', name: 'Peppers', parent_project_id: 'c1' },
  { id: 'p2', name: 'Tomatoes', parent_project_id: 'c1' },
  { id: 'a1', name: 'Annuals' },
]
const txt = e => (Array.isArray(e.props.children) ? e.props.children.join('') : String(e.props.children))

describe('ProjectOptions', () => {
  it('renders one selectable option per project keyed by id', () => {
    const els = ProjectOptions({ projects: P })
    expect(els).toHaveLength(4)
    expect(new Set(els.map(e => e.props.value))).toEqual(new Set(['c1', 'p1', 'p2', 'a1']))
  })
  it('indents children under their parent, roots flush', () => {
    const byId = Object.fromEntries(ProjectOptions({ projects: P }).map(e => [e.props.value, e]))
    expect(txt(byId['c1'])).toBe('Fruiting Plants')
    expect(txt(byId['p1'])).toContain('↳ Peppers')
    expect(txt(byId['p1']).startsWith(' ')).toBe(true)
  })
  it('orders roots alphabetically with children grouped+sorted under their parent', () => {
    expect(ProjectOptions({ projects: P }).map(e => e.props.value)).toEqual(['a1', 'c1', 'p1', 'p2'])
  })
  it('handles empty / null input without throwing', () => {
    expect(ProjectOptions({ projects: [] })).toHaveLength(0)
    expect(ProjectOptions({ projects: null })).toHaveLength(0)
  })
})
