// V4-DORMANTRESUME-001 — the Dormant list on Today and its Resume action. No jest-dom (L-182):
// role/attr/text + toBe/toBeTruthy/toBeNull only. Each assertion names the source mutation that
// turns it red.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

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

// Real prod row shape (daily_plan.items->'dormant', 2026-08-20) plus the `reason` discriminator.
const GARLIC = {
  id: '7bfaea51-8ad6-4063-948c-9b6e78616418', crop: 'garlic', name: 'Garlic',
  note: 'Dormant — skip routine care', project: 'Garlic',
  project_id: '6b5fa440-72f6-41a1-a116-39e7361898f2', reason: 'status',
}
const LITHOPS = {
  id: 'lith1', crop: 'lithops', name: 'Lithops', project: 'Windowsill', project_id: 'prW',
  note: 'DO NOT WATER NOW — summer dormancy; resume Sept; watering now = rot/death',
  reason: 'profile',
}

// No care due — the state the five live dormant plantings are actually in most days.
const emptyPlan = (dormant) => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [], water_due: [], no_history: [], fertilize: [], pest: [], cold: [],
  dormant,
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

describe('dormant plantings are visible on Today', () => {
  // Mutation: delete the <DormantList /> render and this goes red. That is the shipped state before
  // this row — the plan carries the bucket and no surface reads it.
  it('lists a dormant planting even when nothing needs care', async () => {
    render(<CareNeeded plan={emptyPlan([GARLIC])} />)
    expect(screen.getByText('All caught up')).toBeTruthy()
    expect(screen.getByText('Garlic')).toBeTruthy()
    expect(screen.getByText('Dormant')).toBeTruthy()
  })

  // Mutation: move <DormantList /> inside the `total === 0` arm of the ternary and this goes red —
  // a dormant planting would vanish again on any day something else needed water.
  it('lists it alongside a day that does have care due', async () => {
    const p = emptyPlan([GARLIC])
    p.water_due = [{ id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 3, in_ground: false }]
    render(<CareNeeded plan={p} />)
    await screen.findByText('Needs care today')
    expect(screen.getByText('Garlic')).toBeTruthy()
  })

  it('renders nothing at all when the bucket is empty', () => {
    render(<CareNeeded plan={emptyPlan([])} />)
    expect(screen.queryByText('Dormant')).toBeNull()
  })

  // The name links to the planting, so the list is a way IN to the record and not a dead end.
  it('links each row to its planting', () => {
    render(<CareNeeded plan={emptyPlan([GARLIC])} />)
    expect(screen.getByText('Garlic').getAttribute('href')).toBe('/plantings/' + GARLIC.id)
  })
})

describe('Resume', () => {
  // Mutation: render the button for every row instead of `row.resumable` and this goes red. The
  // live consequence is a Resume button on the one plant class whose care note says watering it
  // now kills it.
  it('is offered for status dormancy and withheld from the cadence-flag class', () => {
    render(<CareNeeded plan={emptyPlan([GARLIC, LITHOPS])} />)
    expect(screen.getByText('Lithops')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume Garlic' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Resume Lithops' })).toBeNull()
  })

  // Mutation: change the body to any other status, or the method to POST, and this goes red.
  // Same endpoint + payload as the hero StatusPicker: one status write path in the app, not two.
  it('writes status=vegetative through PUT /api/plants/:id', async () => {
    render(<CareNeeded plan={emptyPlan([GARLIC])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume Garlic' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(c => c[0] === '/api/plants/' + GARLIC.id)
      expect(call).toBeTruthy()
      expect(call[1].method).toBe('PUT')
      expect(JSON.parse(call[1].body)).toEqual({ status: 'vegetative' })
    })
  })

  it('drops the row and confirms once the write lands', async () => {
    render(<CareNeeded plan={emptyPlan([GARLIC])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume Garlic' }))
    await waitFor(() => expect(screen.queryByText('Garlic')).toBeNull())
    expect(toastMock.show.mock.calls.some(c => c[0].message === 'Garlic is growing again')).toBe(true)
  })

  // Never optimistic. Mutation: move the setResumed call above the await, or out of the try, and
  // this goes red — a failed resume would hide a planting that is still dormant, restoring exactly
  // the invisibility this list exists to end.
  it('keeps the row when the write fails', async () => {
    fetchMock.mockImplementation((path) =>
      path === '/api/plants/' + GARLIC.id
        ? Promise.reject(new Error('offline'))
        : Promise.resolve([]))
    render(<CareNeeded plan={emptyPlan([GARLIC])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume Garlic' }))
    await waitFor(() => expect(toastMock.show.mock.calls.some(c => c[0].tone === 'error')).toBe(true))
    expect(screen.getByText('Garlic')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume Garlic' })).toBeTruthy()
  })

  // Cross-deploy window: a plan stored before the engine emitted `reason` lists but cannot resume.
  // Mutation: default resumable to true in dormantRows and this goes red.
  it('is withheld from a pre-discriminator plan row', () => {
    const legacy = { id: 'old1', name: 'Asparagus', note: 'Dormant — skip routine care' }
    render(<CareNeeded plan={emptyPlan([legacy])} />)
    expect(screen.getByText('Asparagus')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Resume Asparagus' })).toBeNull()
  })
})
