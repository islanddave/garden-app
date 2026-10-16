// V4-DORMANTRESUME-001 — the Dormant list on Today and its Resume action. No jest-dom (L-182):
// role/attr/text + toBe/toBeTruthy/toBeNull only. Each assertion names the source mutation that
// turns it red.
//
// V5-TODAYREDESIGN-001 S8c (L8): ported from CareNeededDormant.test.jsx when the old Today page and its care list
// were removed. DormantList moved to components/today/AmbientCareLists.jsx; the redesign mounts it `bare` as
// Resting's rows (TodayV2.s6.test.jsx "Resting — DormantList bare" pins the mount, the count and the held
// resumed set; DormantList.bare.test.jsx the seams). Each case below renders the list itself, bare as Today does.
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

import { DormantList } from '../components/today/AmbientCareLists.jsx'

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
  fetchMock.mockImplementation(() => Promise.resolve({ ok: true }))
})

// The old list's "even when nothing needs care" / "alongside a day that does have care due" were about where
// it sat in CareNeeded's ternary. In the redesign the list is Resting's body, a section of its own whatever
// Needs care holds — TodayV2.test.jsx ("Resting names its plants") and TodayV2.s6.test.jsx pin that.
describe('dormant plantings are listed', () => {
  it('lists a dormant planting', () => {
    render(<DormantList plan={emptyPlan([GARLIC])} bare />)
    expect(screen.getByText('Garlic')).toBeTruthy()
    expect(screen.getByTestId('care-dormant')).toBeTruthy()
  })

  it('renders nothing at all when the bucket is empty, or there is no plan', () => {
    expect(render(<DormantList plan={emptyPlan([])} bare />).container.innerHTML).toBe('')
    expect(render(<DormantList plan={null} bare />).container.innerHTML).toBe('')
  })

  // The name links to the planting, so the list is a way IN to the record and not a dead end.
  it('links each row to its planting', () => {
    render(<DormantList plan={emptyPlan([GARLIC])} bare />)
    expect(screen.getByText('Garlic').getAttribute('href')).toBe('/plantings/' + GARLIC.id)
  })
})

describe('Resume', () => {
  // Mutation: render the button for every row instead of `row.resumable` and this goes red. The
  // live consequence is a Resume button on the one plant class whose care note says watering it
  // now kills it.
  it('is offered for status dormancy and withheld from the cadence-flag class', () => {
    render(<DormantList plan={emptyPlan([GARLIC, LITHOPS])} bare />)
    expect(screen.getByText('Lithops')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume Garlic' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Resume Lithops' })).toBeNull()
  })

  // Mutation: change the body to any other status, or the method to POST, and this goes red.
  // Same endpoint + payload as the hero StatusPicker: one status write path in the app, not two.
  it('writes status=vegetative through PUT /api/plants/:id', async () => {
    render(<DormantList plan={emptyPlan([GARLIC])} bare />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume Garlic' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(c => c[0] === '/api/plants/' + GARLIC.id)
      expect(call).toBeTruthy()
      expect(call[1].method).toBe('PUT')
      expect(JSON.parse(call[1].body)).toEqual({ status: 'vegetative' })
    })
  })

  it('drops the row and confirms once the write lands', async () => {
    render(<DormantList plan={emptyPlan([GARLIC])} bare />)
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
    render(<DormantList plan={emptyPlan([GARLIC])} bare />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume Garlic' }))
    await waitFor(() => expect(toastMock.show.mock.calls.some(c => c[0].tone === 'error')).toBe(true))
    expect(screen.getByText('Garlic')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume Garlic' })).toBeTruthy()
  })

  // Cross-deploy window: a plan stored before the engine emitted `reason` lists but cannot resume.
  // Mutation: default resumable to true in dormantRows and this goes red.
  it('is withheld from a pre-discriminator plan row', () => {
    const legacy = { id: 'old1', name: 'Asparagus', note: 'Dormant — skip routine care' }
    render(<DormantList plan={emptyPlan([legacy])} bare />)
    expect(screen.getByText('Asparagus')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Resume Asparagus' })).toBeNull()
  })
})
