// BUG-CAREFEEDINHERIT-001 — the "no feed schedule" note on Today and its inline reveal. No jest-dom
// (L-182): role/attr/text + toBe/toBeTruthy/toBeNull only. Each assertion names the source mutation
// that turns it red.
//
// The reveal is asserted through DOM PRESENCE, never through an attribute or a CSS property. The
// component mounts/unmounts the chips rather than using <details> or display:none precisely because
// a hidden-but-present list makes "it is collapsed" false-pass in jsdom.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

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

// Engine row shape (engine.js:1104-1105); ids/names from the nine live suppressed plantings.
const REASON = 'Feeding suppressed — profile: NO calendar feeding; feed only on plant signals, never by interval'
const row = (id, name, crop) => ({ id, name, crop, project: 'Herbs', project_id: 'pr-herbs', rule: 'no_calendar_feed', reason: REASON })
const ROSEMARY = row('ec269765-bc63-4590-abe9-cf63e36af389', 'Rosemary', 'herb (Salvia rosmarinus)')
const OREGANO = row('78b064c6-027f-412e-b1c1-e6fc23f1ede2', 'Greek Oregano', 'herb')

// _fsOn OFF: no key at all. Nothing due either — the state Today is in most days.
const planAbsent = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [], water_due: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})
const planWith = (items) => ({ ...planAbsent(), feed_suppressed: items })
const SHOW = /Show the \d+ plantings? with no feed schedule/
const HIDE = /Hide the \d+ plantings? with no feed schedule/

beforeEach(() => {
  cleanup()
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  fetchMock.mockImplementation((path) =>
    (path === '/api/plants' || path === '/api/locations/with-path')
      ? Promise.resolve([])
      : Promise.resolve({ ok: true }))
  sessionStorage.clear(); localStorage.clear()
})

describe('the three payload states render differently', () => {
  // Mutation: delete the <FeedSuppressedList /> render and this goes red. That is the shipped state
  // this row fixes — nine plantings emit no Feed card and the screen says nothing about it.
  it('POPULATED — states the count and why, even with nothing else due', () => {
    render(<CareNeeded plan={planWith([ROSEMARY, OREGANO])} />)
    expect(screen.getByText('All caught up')).toBeTruthy()
    expect(screen.getByText(/No feed schedule for 2 plantings/)).toBeTruthy()
    expect(screen.getByText(/fed on plant signals, never by the calendar/)).toBeTruthy()
  })

  // Mutation: `if (state === FEED_SUPPRESSED_ABSENT) return null` alone (i.e. render for 'none' too)
  // and this goes red — a heading with no plantings under it.
  it('ZERO — the gate ran and suppressed nobody: nothing on screen', () => {
    render(<CareNeeded plan={planWith([])} />)
    expect(screen.queryByText(/No feed schedule for/)).toBeNull()
    expect(screen.queryByRole('button', { name: SHOW })).toBeNull()
  })

  // ABSENT is the pre-feature / nothing-suppressed payload. Mutation: read
  // `(plan.feed_suppressed || []).length` anywhere in the chain and this stays green while the
  // careNeededFeedSuppressed.test.js state assertions go red — which is why the absent/zero split
  // is asserted at the selector, and only its RENDERED consequence is asserted here.
  it('ABSENT — no key at all: nothing on screen, and no crash', () => {
    render(<CareNeeded plan={planAbsent()} />)
    expect(screen.queryByText(/No feed schedule for/)).toBeNull()
    expect(screen.getByText('All caught up')).toBeTruthy()
  })

  // Mutation: move <FeedSuppressedList /> inside the `total === 0` arm of the ternary and this goes
  // red — the note would vanish on any day something else needed water, i.e. on exactly the days
  // Dave is looking at the feed list.
  it('survives a day that does have care due', async () => {
    const p = planWith([ROSEMARY])
    p.water_due = [{ id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 3, in_ground: false }]
    render(<CareNeeded plan={p} />)
    await screen.findByText('Needs care today')
    expect(screen.getByText(/No feed schedule for 1 planting/)).toBeTruthy()
  })

  it('says "planting" not "plantings" for one', () => {
    render(<CareNeeded plan={planWith([ROSEMARY])} />)
    expect(screen.getByText(/No feed schedule for 1 planting —/)).toBeTruthy()
  })
})

describe('the inline reveal', () => {
  // BEHAVIOUR, not attributes: the names are absent from the DOM until the button is clicked. A
  // <details>/display:none implementation renders them at mount and this goes red.
  // Mutation: drop the `{open && …}` guard and render the chips unconditionally — also red.
  it('withholds the names until tapped, then shows them', () => {
    render(<CareNeeded plan={planWith([ROSEMARY, OREGANO])} />)
    expect(screen.queryByText('Rosemary')).toBeNull()
    expect(screen.queryByText('Greek Oregano')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: SHOW }))
    expect(screen.getByText('Rosemary')).toBeTruthy()
    expect(screen.getByText('Greek Oregano')).toBeTruthy()
  })

  // Mutation: `setOpen(true)` instead of the toggler and this goes red — the list would be a
  // one-way door, permanently occupying the screen once opened.
  it('closes again on a second tap', () => {
    render(<CareNeeded plan={planWith([ROSEMARY])} />)
    fireEvent.click(screen.getByRole('button', { name: SHOW }))
    expect(screen.getByText('Rosemary')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: HIDE }))
    expect(screen.queryByText('Rosemary')).toBeNull()
  })

  // The control is a real enabled button with a live handler, and its accessible name tracks state.
  // Mutation: drop aria-expanded, or freeze it at false, and this goes red.
  it('announces its own state', () => {
    render(<CareNeeded plan={planWith([ROSEMARY])} />)
    const btn = screen.getByRole('button', { name: SHOW })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.hasAttribute('disabled')).toBe(false)
    fireEvent.click(btn)
    expect(screen.getByRole('button', { name: HIDE }).getAttribute('aria-expanded')).toBe('true')
  })

  // Each name is a way IN to the record, not a dead end — same rule as the Dormant list.
  // Mutation: render a <span> instead of a <Link> and this goes red.
  it('links each name to its planting', () => {
    render(<CareNeeded plan={planWith([ROSEMARY, OREGANO])} />)
    fireEvent.click(screen.getByRole('button', { name: SHOW }))
    expect(screen.getByText('Rosemary').getAttribute('href')).toBe('/plantings/' + ROSEMARY.id)
    expect(screen.getByText('Greek Oregano').getAttribute('href')).toBe('/plantings/' + OREGANO.id)
  })

  // Never a modal: the reveal opens no dialog, so it takes no DismissRegistry layer and Android Back
  // cannot land on a surface nothing owns.
  it('opens no dialog', () => {
    render(<CareNeeded plan={planWith([ROSEMARY])} />)
    fireEvent.click(screen.getByRole('button', { name: SHOW }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
