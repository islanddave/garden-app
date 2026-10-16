// BUG-CADENCEONEDAY-001 — the daily cohort as Today's row draws it. Shape from prod 2026-08-18: 82 of 228 plantings on
// interval 1, last bulk-watered 08-13 (days_since 5), beside longer-cadence rows that must keep their overdue
// escalation.
//
// V5-TODAYREDESIGN-001 S8c (L8): ported from CareNeeded.test.jsx ("daily cadence framing") when the old Today page
// and its care list were removed. The row is now the redesign's PlantCareRow over the row as Needs care joins it
// (buildCareNeeded + spots.js enrichRows). One claim changed with the redesign, by design: the old list dropped the
// bare overdue restatement from sight (screen-reader only); the redesign's row says it in its meta with the warning
// mark (finish plan §3.6, Dave's D18 — "2d overdue"). The cadence words and the one-tap action are unchanged.
// The selector's own rules (interval 1 exactly, no escalation on elapsed days alone) are careNeededDailyCadence.test.js.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(async () => null), getToken: vi.fn(async () => 't') }) }))

import PlantCareRow from '../components/today/v2/PlantCareRow.jsx'
import { buildCareNeeded } from '../lib/careNeeded.js'
import { enrichRows } from '../lib/todayV2/spots.js'

const dailyPlan = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [],
  water_due: [
    ...Array.from({ length: 3 }, (_, i) => ({
      id: 'bag' + i, name: 'Bag ' + i, project: 'Bag Area', project_id: 'prBag',
      interval: 1, days_since: 5, overdue_by: 4, in_ground: false,
    })),
    // Same spot on purpose — the two cadences have to read differently SIDE BY SIDE.
    { id: 'bb1', name: 'Blueberry Bag', project: 'Bag Area', project_id: 'prBag', interval: 7, days_since: 11, overdue_by: 4, in_ground: false },
  ],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})
const noop = () => {}
const rowsOf = (plan) => enrichRows(buildCareNeeded(plan), { plan, plants: [], locations: { locations: [] } })
const renderRows = (plan) => render(<div role="list">{rowsOf(plan).map((r) => <PlantCareRow key={r.key} row={r} onLog={noop} onSkip={noop} onMoist={noop} onRetry={noop} />)}</div>)
const metaOf = (name) => screen.getByText(name).closest('[data-row-text]').querySelector('[data-row-meta]')

describe('daily cadence framing, on the redesign\'s row', () => {
  it('shows the daily rows as a cadence, on screen — colour cannot express "daily"', () => {
    renderRows(dailyPlan())
    for (const n of ['Bag 0', 'Bag 1', 'Bag 2']) {
      const meta = metaOf(n)
      expect(meta.textContent).toBe('Daily — last watered 5d ago')
      expect(meta.style.position).not.toBe('absolute')
    }
  })

  it('a daily row never reads as a backlog: no overdue words, no warning mark', () => {
    renderRows(dailyPlan())
    const meta = metaOf('Bag 0')
    expect(meta.textContent).not.toMatch(/overdue/)
    expect(meta.querySelector('svg')).toBeNull()
  })

  it('the 7-day row beside them keeps its escalation: "4d overdue", visibly, behind the warning mark', () => {
    renderRows(dailyPlan())
    const meta = metaOf('Blueberry Bag')
    expect(meta.textContent).toMatch(/^4d overdue/)
    expect(meta.querySelector('svg')).toBeTruthy()
  })

  it('keeps every daily planting visible and one-tap loggable — the main action is exactly "Log Water for X"', () => {
    renderRows(dailyPlan())
    expect(screen.getAllByRole('button', { name: /^Log Water for /i }).length).toBe(4)
    expect(screen.getByRole('button', { name: 'Log Water for Bag 0' })).toBeTruthy()
  })
})
