// BUG-MOISTURECHECKNOBUTTON-001 — the "I checked it, still moist" control on the Today water rows.
// No jest-dom (L-182): role/attr/text + toBe/toBeTruthy/toBeNull only. Same mock seam as
// CareNeeded.test.jsx — react-router Link, useApiFetch, ToastContext, notificationPrefsClient.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { NON_REWARD_EVENT_TYPES, isRewardedEventType } from '../lib/eventTypes.js'

const { fetchMock, toastMock, getTokenMock, prefsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'tok'),
  prefsMock: {
    fetchNotificationPrefs: vi.fn(async () => null),
    saveTodaySkipped: vi.fn(async () => null),
  },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: prefsMock.fetchNotificationPrefs,
  saveTodaySkipped: prefsMock.saveTodaySkipped,
}))

import CareNeeded from '../components/today/CareNeeded.jsx'

const plan = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [],
  water_due: [
    { id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 3, in_ground: false },
    { id: 'p2', name: 'Habanero',     crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 1, in_ground: false },
  ],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})

const events = () => fetchMock.mock.calls.filter((c) => c[0] === '/api/events')
const moistBtn = (name = 'Bhut Jolokia') => screen.getByRole('button', { name: new RegExp('Checked ' + name, 'i') })

beforeEach(() => {
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  fetchMock.mockImplementation((path) =>
    (path === '/api/plants' || path === '/api/locations/with-path')
      ? Promise.resolve([])
      : Promise.resolve({ id: 'ev-moist' }))
  sessionStorage.clear()
  localStorage.clear()
})

describe('BUG-MOISTURECHECKNOBUTTON-001 — the control renders', () => {
  // The affordance that was missing. Mutation: drop <MoistureButton> from Row and this goes red —
  // which is the state prod has been in all along (zero moisture_check rows, all time).
  it('gives every water row a real, named button', () => {
    render(<CareNeeded plan={plan()} />)
    const btns = screen.getAllByRole('button', { name: /still moist/i })
    expect(btns.length).toBe(2)
    // A real <button>, not a role-less <div aria-label>: a generic role cannot be named, so the
    // label on a div is dropped and the control reaches AT unlabelled. getByRole already proves the
    // node is nameable; the tagName pins WHY it is.
    expect(btns[0].tagName).toBe('BUTTON')
    expect(btns[0].getAttribute('type')).toBe('button')
    // Dave is Android-only in an installed PWA and never hovers. Material's floor is 48dp; the
    // brief's is 44. Mutation: shrink either axis below 44 and this goes red.
    expect(parseInt(btns[0].style.width, 10)).toBeGreaterThanOrEqual(44)
    expect(parseInt(btns[0].style.minHeight, 10)).toBeGreaterThanOrEqual(44)
  })

  // Plain words, Dave's voice, and never the column name. Mutation: put 'moisture_check' in the
  // label or the visible text and this goes red.
  it('says it in plain words and never leaks the event type', () => {
    render(<CareNeeded plan={plan()} />)
    const btn = moistBtn()
    expect(btn.textContent).toBe('Moist')
    expect(btn.getAttribute('aria-label')).toBe('Checked Bhut Jolokia — still moist')
    expect(document.body.textContent.includes('moisture_check')).toBe(false)
  })

  // The server does NOT accept a moisture check as satisfying no_history (DONE_EVENTS.no_history is
  // ['watering','rain']), so offering it there would hide a row that comes straight back. Mutation:
  // widen canMoistureCheck past water_due and this goes red.
  it('stays off never-watered rows, which the server would not check off', () => {
    render(<CareNeeded plan={{
      ...plan(),
      water_due: [],
      no_history: [{ id: 'p3', name: 'Shishito', crop: 'pepper', project: 'Peppers', project_id: 'prP', never: true }],
    }} />)
    expect(screen.getByText('Shishito')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /still moist/i })).toBeNull()
  })

  // The overwintering row's PRIMARY chip already logs moisture_check, so a second control would post
  // the identical event. Mutation: let canMoistureCheck return true for overwintering → red.
  it('does not double up on the overwintering row', () => {
    render(<CareNeeded plan={{
      ...plan(),
      water_due: [],
      overwintering: [{ id: 'p4', name: 'Winterbor Kale', crop: 'kale', project: 'Winter Bed', project_id: 'prW', interval: 14, days_since: 60 }],
    }} />)
    expect(screen.getByRole('button', { name: /Log Check for Winterbor Kale/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /still moist/i })).toBeNull()
  })
})

describe('BUG-MOISTURECHECKNOBUTTON-001 — what the tap writes', () => {
  // Mutation: post row.eventType instead of MOISTURE_CHECK_EVENT and this goes red — the tap would
  // silently falsify last_water for a plant nobody watered.
  it('POSTs a moisture_check for that planting and checks the card off', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(moistBtn())
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    expect(events().length).toBe(1)
    const [, opts] = events()[0]
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.event_type).toBe('moisture_check')
    expect(body.plant_id).toBe('p1')
    expect(body.project_id).toBe('prP')
    // Scoped to the row it was tapped on. The sibling stays up.
    expect(screen.getByText('Habanero')).toBeTruthy()
  })

  // Reward-free is a property of the TYPE, enforced server-side (lambda/events/index.js gates the
  // flat grant, both recomputes and the critter award behind isRewardedEventType). The client's
  // obligation is exactly two things: post a type the partition excludes, and fire NOTHING else.
  // Mutation: point the button at 'watering', or add any extra request to the handler → red.
  it('fires no reward side effect — one write, to the ordinary single-event path', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(moistBtn())
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalledTimes(1))
    const posted = JSON.parse(events()[0][1].body)
    expect(NON_REWARD_EVENT_TYPES).toContain(posted.event_type)
    expect(isRewardedEventType(posted.event_type)).toBe(false)
    // Exactly one event write, and no critter / achievement / xp / batch traffic at all.
    expect(events().length).toBe(1)
    const paths = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(paths.some((p) => /critter|achievement|xp|stats|batch/i.test(p))).toBe(false)
    // The undo toast is operational, never a celebration (Reward-UX V101 §7): its own statement,
    // keyed apart from a Water run so it cannot be counted into "Logged Water for N plants".
    const t = toastMock.showUndo.mock.calls[0][0]
    expect(t.message).toBe('Checked Bhut Jolokia — still moist')
    expect(t.group).toBe('care-log-moisture_check')
    expect(t.groupMessage(4)).toBe('Checked 4 plants — still moist')
  })

  // Mutation: drop the DELETE from onUndo, or un-fade before it resolves, and this goes red.
  it('undo deletes the event and brings the row back', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(moistBtn())
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalledTimes(1))
    await act(async () => { await toastMock.showUndo.mock.calls[0][0].onUndo() })
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/events/ev-moist' && c[1]?.method === 'DELETE')).toBe(true)
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
  })

  // Never fade-and-forget (L-104). Mutation: move setLogged above the await → red.
  it('on write failure the row stays and an error toast shows', async () => {
    fetchMock.mockImplementation((path) =>
      path === '/api/events' ? Promise.reject(new Error('boom')) : Promise.resolve([]))
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(moistBtn())
    await waitFor(() => expect(toastMock.show).toHaveBeenCalledTimes(1))
    expect(toastMock.show.mock.calls[0][0].tone).toBe('error')
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
    expect(toastMock.showUndo).toHaveBeenCalledTimes(0)
  })

  // The control is ADDITIVE — the row still primarily wants watering, and moisture_check is in
  // BATCH_EXCLUDED_TYPES so it must never reach a bulk button. Mutation: point
  // NEED_EVENT_TYPE.water_due at moisture_check and this goes red.
  it('leaves the primary Water action and its bulk count untouched', () => {
    render(<CareNeeded plan={plan()} />)
    expect(screen.getAllByRole('button', { name: /^Log Water for/i }).length).toBe(2)
    expect(screen.getByRole('button', { name: /Log all watering \(2\)/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Log all .*moist/i })).toBeNull()
  })
})

describe('BUG-MOISTURECHECKNOBUTTON-001 — the in-flight guard', () => {
  // A double-tap is the normal failure of a thumb on a phone, and a second POST is a duplicate
  // observation the gardener cannot see or undo (the undo toast only holds the FIRST id).
  //
  // Both dispatches go inside ONE act() on purpose. That is what makes this non-vacuous: React has
  // not flushed, so `disabled` is not on the node yet and jsdom really does deliver both clicks —
  // the obvious version of this test (click, await, click the now-disabled button) proves nothing,
  // because jsdom silently drops a click on a disabled button whether or not any guard exists.
  //
  // Mutation: replace the moistInFlightRef guard with the `pendingKeys` state check and this goes
  // red at 2 POSTs — both handlers read the same un-flushed state and both pass.
  it('a double-tap inside one React batch posts exactly once', async () => {
    render(<CareNeeded plan={plan()} />)
    const btn = moistBtn()
    expect(btn.disabled).toBe(false)
    await act(async () => { btn.click(); btn.click() })
    expect(events().length).toBe(1)
  })

  // The two controls on one row share the row's pending key, so a moisture check in flight must
  // block the Water chip as well — otherwise one row yields both a watering and a "still moist".
  it('blocks the row\'s Water chip while the check is in flight', async () => {
    render(<CareNeeded plan={plan()} />)
    const moist = moistBtn()
    const water = screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i })
    await act(async () => { moist.click(); water.click() })
    expect(events().length).toBe(1)
    expect(JSON.parse(events()[0][1].body).event_type).toBe('moisture_check')
  })
})
