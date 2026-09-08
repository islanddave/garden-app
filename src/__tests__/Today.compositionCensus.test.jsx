/**
 * src/__tests__/Today.compositionCensus.test.jsx — V5-TODAYSHAPE-001, item 9.
 *
 * THE GAP THIS CLOSES. Today's only composition-order lock lives in Today.harvestSurface.test.jsx
 * and compares the cultivation lead against `screen.getByText(/on its way/i)` — the **noplan** empty
 * state. So the order of the page Dave actually sees, the HAS-PLAN one, was asserted by no test at
 * all. Likewise the `quiet` state (a plan exists, every list in it is empty) had zero PAGE-level
 * coverage: `CareNeeded.test.jsx` covers the "All caught up" card as a component, mounted alone,
 * which says nothing about what Today composes around it.
 *
 * WHAT THIS LAYER OWNS, AND WHAT IT DOES NOT. Everything here is DOM order and membership — the
 * things jsdom can actually answer. `compareDocumentPosition` is DOM order, and a CSS reorder
 * (`order:`, `flex-direction: column-reverse`, `position:absolute`) passes every assertion in this
 * file unchanged while moving the care list above the weather card on screen. VISUAL order is the
 * real-Chrome gate's half of the census (`scripts/layout-gate/today-shape.mjs`, which reads measured
 * rects and is proved against the `reorderStack` mutant). Neither layer is sufficient alone, and
 * writing a visibility or geometry claim in this file would be false confidence, not coverage —
 * jsdom returns 0 from every getBoundingClientRect.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

const { planState, fetchMock, toastMock, getTokenMock } = vi.hoisted(() => ({
  planState: { current: null },
  fetchMock: vi.fn(async () => ({ id: 'ev' })),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'harness-token'),
}))

vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))

import Today from '../pages/Today.jsx'

// Nine groups, the first far heavier than the rest — the shape Dave's real day takes and the reason
// 55% of the page is one group. `project` is the grouping proxy when the enrichment endpoints return
// nothing, which is what the fetch mock does below.
const LEAD_ROWS = 14
const row = (i, project) => ({ id: `p${project}-${i}`, name: `Planting ${project}-${i}`, crop: 'pepper', project: `Project ${project}`, project_id: `pr${project}`, overdue_by: 1, in_ground: false })
const busyPlan = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  weather: null,
  substrate: { msg: '12 planting(s) past the MG feed window', on_hold: false },
  water_due: [
    ...Array.from({ length: LEAD_ROWS }, (_, i) => row(i, 'A')),
    ...['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map(p => row(0, p)),
  ],
  rain_skipped: [{ id: 'rs1' }, { id: 'rs2' }],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})
const quietPlan = () => ({
  hydrology: { tomorrow_precip_in: 0, tomorrow_pop: 0 },
  weather: null,
  substrate: { msg: 'Feeding on HOLD', on_hold: true },
  water_due: [], rain_skipped: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})
const wrap = (plan) => ({
  data: { has_plan: true, plan_date: '2026-09-08', generated_at: '2026-09-08T09:30:00Z', plan },
  loading: false, error: null,
})

const precedes = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

beforeEach(() => {
  planState.current = null
  sessionStorage.clear()
  localStorage.clear()
  fetchMock.mockReset()
  // The enrichment endpoints return [] so grouping stays on the project proxy; everything else
  // returns an empty list so the self-fetching ambient bands render nothing and cannot add regions
  // this census did not ask for.
  fetchMock.mockImplementation(() => Promise.resolve([]))
})

describe('Today — has-plan composition census (DOM order)', () => {
  it('pins the order of every region on the page Dave actually sees', () => {
    planState.current = wrap(busyPlan())
    render(<Today />)

    // Read in the order the contract puts them, then assert each precedes the next. A list rather
    // than a pile of pairwise assertions on purpose: an inserted region has to be added HERE, which
    // is the moment somebody decides where it goes.
    const order = [
      screen.getByTestId('today-title'),
      screen.getByTestId('today-date'),
      screen.getByTestId('today-substrate-note'),
      screen.getByTestId('today-basis-stamp'),
      screen.getByTestId('today-care'),
      screen.getByTestId('care-heading'),
      screen.getByTestId('care-bulk-chips'),
      screen.getByTestId('care-rain-note'),
    ]
    for (let i = 0; i < order.length - 1; i++) {
      expect(precedes(order[i], order[i + 1])).toBe(true)
    }
  })

  it('auto-expands exactly ONE group and renders that group\'s rows, with the rest collapsed', () => {
    planState.current = wrap(busyPlan())
    render(<Today />)

    // Nine group cards, one open panel. The lead group opens even though it alone blows the 8-row
    // EXPAND_ROW_BUDGET (careNeeded.js autoExpandKeys) — without that carve-out the page opens
    // showing nothing, which is the failure the whole path exists to avoid. The pure function is
    // unit-tested in careNeeded.test.js; what is asserted HERE is that the page is actually wired to
    // it, which is a different claim and was previously made by no test.
    expect(screen.getAllByTestId('care-group').length).toBe(9)
    const panels = screen.getAllByTestId('care-group-panel')
    expect(panels.length).toBe(1)
    // Every rendered row belongs to the one open panel — eight collapsed groups contribute none.
    const rows = screen.getAllByTestId('care-row')
    expect(rows.length).toBe(LEAD_ROWS)
    expect(within(panels[0]).getAllByTestId('care-row').length).toBe(LEAD_ROWS)
    // NOTE ON THE NUMBER: 14, not Dave's real 70. The exact prod count is pinned against the real
    // prod payload in the real-Chrome gate (today-shape-budget.json: 70 rows / 9 groups / 1 panel).
    // What this layer pins is the SHAPE — one open group, eight closed, all rows inside the open
    // one — which is what a redesign of the disclosure would break and what jsdom can see.
  })
})

describe('Today — the quiet day (a plan ran; nothing is owed)', () => {
  it('renders the caught-up state, keeps the /sow door, and does NOT claim the engine is dormant', () => {
    planState.current = wrap(quietPlan())
    render(<Today />)

    expect(screen.getByTestId('care-empty')).toBeTruthy()
    expect(screen.getByText(/Nothing needs care today/i)).toBeTruthy()
    // The distinction the noplan copy exists to make. "Your first daily plan is on its way" means
    // the engine has not run; a quiet day means it ran and found nothing. Showing the first is a
    // lie about the system's state, and nothing at the page layer previously said so.
    expect(screen.queryByTestId('today-noplan-card')).toBeNull()
    expect(screen.queryByText(/on its way/i)).toBeNull()
    // Regions that must NOT appear when there is nothing to do.
    expect(screen.queryByTestId('care-heading')).toBeNull()
    expect(screen.queryByTestId('care-bulk-chips')).toBeNull()
    expect(screen.queryByTestId('care-rain-note')).toBeNull()
    expect(screen.queryAllByTestId('care-row').length).toBe(0)
    // ...and the ones that must survive it. CultivationLead renders unconditionally — it is Today's
    // durable door to /sow and the ONLY region present in all four measured states.
    expect(screen.getByTestId('cultivation-lead')).toBeTruthy()
    expect(screen.getByTestId('today-basis-stamp')).toBeTruthy()
    expect(precedes(screen.getByTestId('today-basis-stamp'), screen.getByTestId('care-empty'))).toBe(true)
  })

  it('suppresses the substrate note when feeding is on hold, even though the message is present', () => {
    // `on_hold` is true exactly when there are zero feed recommendations, and Today is an ACTION
    // surface — the long "Feeding on HOLD" explainer would otherwise reappear every day with
    // nothing to do. The message being non-empty is what makes this a real branch rather than a
    // vacuous one: a naive `plan.substrate?.msg &&` would render it.
    planState.current = wrap(quietPlan())
    render(<Today />)
    expect(screen.queryByTestId('today-substrate-note')).toBeNull()
    expect(screen.queryByText(/Feeding on HOLD/i)).toBeNull()
  })
})
