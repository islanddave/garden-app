// V5-LEGACYEXCEPTIONCARE-001 — the drought note on Today. No jest-dom (L-182): role/attr/text +
// toBe/toBeTruthy/toBeNull only. Each assertion names the source mutation that turns it red.
//
// The two behaviours worth proving are (a) it renders at all — the shipped state is that the engine
// computes the signal and no client reads it — and (b) it renders in the EMPTY state, because a
// drought note that vanishes on a quiet day vanishes exactly when it is most useful. DormantList and
// FeedSuppressedList sit outside the ternary for the same reason and this mirrors them.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const { fetchMock, toastMock, getTokenMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'tok'),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: vi.fn(async () => null),
  saveTodaySkipped: vi.fn(async () => null),
}))

import CareNeeded from '../components/today/CareNeeded.jsx'

// Engine row shape (engine.js:912-919), verified against a real generatePlan run. `d` omitted => the
// `ok` shape: droughtNote returns null, so no appended clause and no `drought` key.
const SUP = 'Watering suppressed — profile: NO calendar watering; water only on plant signals, never by interval'
const dry = (dry_days, truncated = false) => ({ dry_days, deep_soak_in: 0.6, last_deep_soak: truncated ? null : '2026-08-03', truncated })
const sup = (id, name, crop, d) => ({
  id, name, crop, project: 'Legacy Pasture', project_id: 'pr-legacy',
  rule: 'no_calendar_water', moisture: 'even',
  reason: SUP + (d ? ' — Drought signal — no deep soak (>=0.60 in of rain in one day) in ' + (d.truncated ? 'at least ' : '') + d.dry_days + ' days. Check soil moisture at root depth.' : ''),
  ...(d ? { drought: d } : {}),
})

// The four the hook reaches today; Blackberry and Wild Wineberry are status='dormant' and never reach
// the suppression branch (engine.js:885), so they are deliberately not here.
const PEACH = sup('p-peach', 'Peach tree', 'peach', dry(28))
const BLUEBERRY = sup('p-blue', 'Blueberries', 'blueberry', dry(28))
const DOGWOOD = sup('p-dog', 'Kousa Dogwood', 'dogwood')   // suppressed, but the space read `ok`

const planWith = (items) => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  water_due: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [], rain_skipped: [],
  dormancy_suppressed: items,
})

beforeEach(() => {
  cleanup()
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  fetchMock.mockImplementation((path) =>
    (path === '/api/plants' || path === '/api/locations/with-path')
      ? Promise.resolve([])
      : Promise.resolve({ ok: true }))
  sessionStorage.clear(); localStorage.clear()
})

describe('the drought note reaches the screen', () => {
  // Mutation: delete the <DroughtList /> render and this goes red. That deletion IS the shipped state
  // this row fixes — the signal lands in daily_plan.items and in CloudWatch and nowhere Dave looks.
  it('names the planting and states what was measured', () => {
    render(<CareNeeded plan={planWith([PEACH])} />)
    expect(screen.getByText('Dry — no deep soak')).toBeTruthy()
    expect(screen.getByText('Peach tree')).toBeTruthy()
    expect(screen.getByText('No deep soak (≥0.60 in) in 28 days')).toBeTruthy()
  })

  // THE empty-state test the brief asks for, and the one the second mutation proves. Mutation: move
  // <DroughtList /> inside the non-empty arm of the `total === 0` ternary and this goes red — the note
  // would disappear on precisely the quiet days when it is the only thing on the page worth reading.
  it('renders in the empty state, alongside "All caught up"', () => {
    render(<CareNeeded plan={planWith([PEACH, BLUEBERRY])} />)
    expect(screen.getByText('All caught up')).toBeTruthy()
    expect(screen.getByText('Peach tree')).toBeTruthy()
    expect(screen.getByText('Blueberries')).toBeTruthy()
    expect(screen.getAllByText('No deep soak (≥0.60 in) in 28 days')).toHaveLength(2)
  })

  // The twin of the above: outside the ternary means outside BOTH arms. Mutation: move it inside the
  // `total === 0` arm and this goes red instead.
  it('survives a day that does have care due', async () => {
    const p = planWith([PEACH])
    p.water_due = [{ id: 'w1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 3, in_ground: false }]
    render(<CareNeeded plan={p} />)
    await screen.findByText('Needs care today')
    expect(screen.getByText('Peach tree')).toBeTruthy()
    expect(screen.getByText('No deep soak (≥0.60 in) in 28 days')).toBeTruthy()
  })

  // Without this the list shows every suppressed planting and every test above passes for the wrong
  // reason. Mutation: drop the per-item `drought` guard in droughtRows and Kousa Dogwood appears.
  it('leaves out a suppressed planting the engine gave no note', () => {
    render(<CareNeeded plan={planWith([PEACH, DOGWOOD])} />)
    expect(screen.getByText('Peach tree')).toBeTruthy()
    expect(screen.queryByText('Kousa Dogwood')).toBeNull()
  })

  // Mutation: render the section unconditionally (drop `if (rows.length === 0) return null`) and this
  // goes red — a heading over nothing, every day, on a screen with a noise budget.
  it('says nothing at all when nobody is dry', () => {
    render(<CareNeeded plan={planWith([DOGWOOD])} />)
    expect(screen.queryByText('Dry — no deep soak')).toBeNull()
    expect(screen.queryByText(/No deep soak/)).toBeNull()
    expect(screen.getByText('All caught up')).toBeTruthy()
  })

  it('says nothing when the bucket is absent entirely', () => {
    const p = planWith([]); delete p.dormancy_suppressed
    render(<CareNeeded plan={p} />)
    expect(screen.queryByText('Dry — no deep soak')).toBeNull()
    expect(screen.getByText('All caught up')).toBeTruthy()
  })
})

describe('ambient, never a task', () => {
  // The design constraint, asserted rather than trusted: "not on calendar watering and it has been
  // dry" is context. Mutation: give the row a Log/Water button and this goes red. In the empty state
  // the rest of CareNeeded renders no controls at all, so any button here is one this section added.
  it('offers no action — no button anywhere on a quiet day', () => {
    render(<CareNeeded plan={planWith([PEACH, BLUEBERRY])} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // It must not read as work. Mutation: reuse the care-row copy ("Due today" / "Water") and this reds.
  it('never claims the planting needs watering', () => {
    render(<CareNeeded plan={planWith([PEACH])} />)
    expect(screen.queryByText(/Due today/)).toBeNull()
    expect(screen.queryByText(/overdue/)).toBeNull()
    expect(screen.getByText(/aren’t on calendar watering, and it has been dry/)).toBeTruthy()
  })

  // Dave's wording ruling: 0.60 in is the in-ground `deep` class, so both the heading and the row name
  // the deep soak. Mutation: reword either to "No rain in 28 days" and this goes red.
  it('says deep soak, never plain rain', () => {
    render(<CareNeeded plan={planWith([PEACH])} />)
    expect(screen.getByText('Dry — no deep soak')).toBeTruthy()
    expect(screen.getByText('No deep soak (≥0.60 in) in 28 days')).toBeTruthy()
    expect(screen.queryByText(/No rain in/i)).toBeNull()
    expect(screen.queryByText(/no measurable rain/i)).toBeNull()
  })

  // Each name is a way IN to the record, not a dead end — same rule as Dormant and FeedSuppressed.
  // Mutation: render a <span> instead of a <Link> and this goes red.
  it('links each name to its planting', () => {
    render(<CareNeeded plan={planWith([PEACH, BLUEBERRY])} />)
    expect(screen.getByText('Peach tree').getAttribute('href')).toBe('/plantings/p-peach')
    expect(screen.getByText('Blueberries').getAttribute('href')).toBe('/plantings/p-blue')
  })
})
