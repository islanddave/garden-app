// BUG-TODAYNOPROJECTLINK-001 — a Needs care row's tap opens the planting's own page whether or not the planting sits
// in a project. Before the fix a row with no project_id fell back to /garden: Penstemon on prod (2026-10-24, one of 8
// live plantings with no project) opened the Garden page. /plantings/:id is the canonical route; the project-scoped
// form only redirects to it (App.jsx ScopedPlantingRedirect). No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(async () => null), getToken: vi.fn(async () => 't') }) }))

import PlantCareRow from '../components/today/v2/PlantCareRow.jsx'
import { buildCareNeeded } from '../lib/careNeeded.js'
import { enrichRows } from '../lib/todayV2/spots.js'

const plan = {
  hydrology: {}, rain_skipped: [],
  water_due: [
    { id: 'pen1', name: 'Penstemon', crop: 'penstemon', project: null, project_id: null, interval: 7, days_since: 9, overdue_by: 2, in_ground: true },
    { id: 'bas1', name: 'Sweet Basil', crop: 'basil', project: 'Bag Area', project_id: 'prBag', interval: 7, days_since: 9, overdue_by: 2, in_ground: false },
  ],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
}
const noop = () => {}
const hrefOf = (name) => {
  const rows = enrichRows(buildCareNeeded(plan), { plan, plants: [], locations: { locations: [] } })
  const { container } = render(<div role="list">{rows.filter((r) => r.name === name).map((r) => <PlantCareRow key={r.key} row={r} onLog={noop} onSkip={noop} onMoist={noop} onRetry={noop} />)}</div>)
  return container.querySelector('a').getAttribute('href')
}

describe('Needs care row link', () => {
  it('a planting with no project opens its own page, not Garden', () => {
    expect(hrefOf('Penstemon')).toBe('/plantings/pen1')
  })
  it('a planting in a project opens the same canonical page', () => {
    expect(hrefOf('Sweet Basil')).toBe('/plantings/bas1')
  })
})
