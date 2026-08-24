// Slice 7 (V4-THEME-001) CareNeeded interaction tests. No jest-dom (L-182): role/attr/text +
// toBe/toBeTruthy/toBeNull only. Mocks: react-router Link, useApiFetch, ToastContext.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'

const { fetchMock, toastMock, getTokenMock, prefsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'tok'),
  // V4-TODAYLOC-002 cross-device skip sync. Mocked at the client-module seam rather than at fetch
  // so these tests assert the CONTRACT CareNeeded depends on (what it sends, what it merges),
  // not the wire format of a PATCH that notificationPrefsClient's own tests already cover.
  prefsMock: {
    fetchNotificationPrefs: vi.fn(async () => null),
    saveTodaySkipped: vi.fn(async () => null),
  },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
// getToken is part of the useApiFetch contract (api.js:163) and CareNeeded now reads it for the
// cross-device skip sync. A mock that omits it makes getToken undefined, which the prefs client
// treats as "no auth" and silently no-ops — the tests would pass while the sync never ran.
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
// readTodaySkipped is NOT mocked — it is the pure date-expiry rule under test, and stubbing it
// would make the "yesterday's set is ignored" case assert nothing.
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

beforeEach(() => {
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  // V4-TODAYLOC-001: enrichment endpoints (mount) return [] so grouping stays project-proxy;
  // event writes return a created id.
  fetchMock.mockImplementation((path) =>
    (path === '/api/plants' || path === '/api/locations/with-path')
      ? Promise.resolve([])
      : Promise.resolve({ id: 'ev-new' }))
  sessionStorage.clear()
  // V4-TODAYLOC-002 moved the suppress set from sessionStorage to localStorage (the row was filed
  // as cross-device, but sessionStorage also meant a skip died with the tab). Clearing only
  // sessionStorage silently broke isolation: the "skip suppresses a row" case leaked its skip into
  // every later test, and the four BULK cases then found no rows to act on. Both must be cleared.
  localStorage.clear()
})

describe('CareNeeded — Slice 7', () => {
  it('renders location-grouped need rows with a dominant Log target (default By location)', () => {
    render(<CareNeeded plan={plan()} />)
    expect(screen.getByText('Needs care today')).toBeTruthy()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
    expect(screen.getByRole('group', { name: /Group by/i })).toBeTruthy()
    const logBtns = screen.getAllByRole('button', { name: /^Log Water for/i })
    expect(logBtns.length).toBe(2)
  })

  it('one-tap log POSTs the mapped event, drops the row, and offers undo', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i }))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    const [path, opts] = fetchMock.mock.calls.find(c => c[0] === '/api/events')
    expect(path).toBe('/api/events')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.event_type).toBe('watering')
    expect(body.plant_id).toBe('p1')
    expect(body.project_id).toBe('prP')
    expect(toastMock.showUndo).toHaveBeenCalledTimes(1)
  })

  it('on write failure the row stays and an error toast shows (no fade-and-forget)', async () => {
    // Fail the WRITE specifically. This used to be a bare mockRejectedValueOnce, which relied on the
    // mount-time enrichment fetches being deferred by a microtask so the events POST was the first
    // call to land; the plants read now goes through useCachedFetch, whose no-sub PLAIN branch calls
    // fetch synchronously, and the once-rejection was being spent on /api/plants instead.
    fetchMock.mockImplementation((path) =>
      path === '/api/events' ? Promise.reject(new Error('boom')) : Promise.resolve([]))
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i }))
    await waitFor(() => expect(toastMock.show).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
  })

  it('skip suppresses a row for today without writing an event', () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Skip Habanero today/i }))
    expect(screen.queryByText('Habanero')).toBeNull()
    // Assert the named behaviour — no EVENT is written. A blanket not.toHaveBeenCalled() also
    // asserted that no mount-time enrichment read had fired yet, which was only ever true because
    // those reads were microtask-deferred; that is timing, not the contract this test is about.
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/events')).toBe(false)
  })

  // V4-TODAYLOC-002 / V4-USERPREFS-001 — the suppress set became durable and cross-device.
  describe('skip persistence (V4-TODAYLOC-002)', () => {
    const todayKey = () => {
      const d = new Date(); const off = d.getTimezoneOffset()
      return 'today-skipped:' + new Date(d.getTime() - off * 60000).toISOString().slice(0, 10)
    }

    it('writes the skip to localStorage, NOT sessionStorage — it must survive a tab close', () => {
      // The whole same-device half of the row. sessionStorage would pass a "skip hides the row"
      // assertion identically while still losing the skip the moment the PWA is evicted.
      render(<CareNeeded plan={plan()} />)
      fireEvent.click(screen.getByRole('button', { name: /Skip Habanero today/i }))
      expect(JSON.parse(localStorage.getItem(todayKey()) || '[]').length).toBe(1)
      expect(sessionStorage.getItem(todayKey())).toBeNull()
    })

    it('a skip present in localStorage suppresses the row on a COLD mount', () => {
      // "Come back to it later" — the path sessionStorage lost. The FIRST tree must be unmounted
      // for real (via the render result, then cleanup) or the second render mounts alongside it and
      // the queryByText below passes because the FIRST copy hid the row, proving nothing.
      const first = render(<CareNeeded plan={plan()} />)
      fireEvent.click(screen.getByRole('button', { name: /Skip Habanero today/i }))
      expect(JSON.parse(localStorage.getItem(todayKey()) || '[]').length).toBe(1)
      first.unmount()
      cleanup()
      expect(screen.queryByText('Habanero')).toBeNull()   // nothing mounted at all yet
      render(<CareNeeded plan={plan()} />)
      expect(screen.queryByText('Habanero')).toBeNull()   // ...and still hidden after remount
      expect(screen.getByText('Bhut Jolokia')).toBeTruthy() // the tree DID render — not vacuous
    })

    it('syncs the WHOLE set to the server after the local write', async () => {
      render(<CareNeeded plan={plan()} />)
      fireEvent.click(screen.getByRole('button', { name: /Skip Habanero today/i }))
      await waitFor(() => expect(prefsMock.saveTodaySkipped).toHaveBeenCalled())
      const arg = prefsMock.saveTodaySkipped.mock.calls.at(-1)[0]
      expect(Array.isArray(arg.keys)).toBe(true)
      expect(arg.keys.length).toBe(1)
      expect(typeof arg.date).toBe('string')
    })

    it('UNIONS the server set into local — a remote skip must not erase a local one', async () => {
      // Direction matters: replacing local with server would drop a skip made seconds earlier
      // offline on this device the instant a stale server value arrived.
      const plan1 = plan()
      render(<CareNeeded plan={plan1} />)
      fireEvent.click(screen.getByRole('button', { name: /Skip Habanero today/i }))
      const localAfter = JSON.parse(localStorage.getItem(todayKey()) || '[]')
      expect(localAfter.length).toBe(1)
      expect(prefsMock.fetchNotificationPrefs).toHaveBeenCalled()
    })

    it("IGNORES a server set dated other than today — yesterday's skips must not hide today's care", async () => {
      // The dangerous silent failure: a stale suppress set hides a watering row and nothing on
      // screen explains why the plant was never watered.
      prefsMock.fetchNotificationPrefs.mockResolvedValueOnce({
        today_skipped: { date: '2020-01-01', keys: ['watering:habanero'] },
      })
      await act(async () => { render(<CareNeeded plan={plan()} />) })
      expect(screen.getByText('Habanero')).toBeTruthy()
      expect(JSON.parse(localStorage.getItem(todayKey()) || '[]').length).toBe(0)
    })

    it('a failed/absent prefs read leaves the local set untouched', async () => {
      prefsMock.fetchNotificationPrefs.mockResolvedValueOnce(null)
      await act(async () => { render(<CareNeeded plan={plan()} />) })
      expect(screen.getByText('Habanero')).toBeTruthy()
    })
  })

  it('shows the all-clear empty state when nothing needs care', () => {
    render(<CareNeeded plan={{ water_due: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [], rain_skipped: [] }} />)
    expect(screen.getByText(/All caught up/i)).toBeTruthy()
  })

  it('primary bulk chip tap fans out one POST per row directly — no confirm sheet — with aggregate undo', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Log all watering \(2\)$/i }))
    // Fires immediately: no dialog is opened by the primary tap.
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => c[0] === '/api/events').length).toBe(2))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalled())
  })

  it('secondary "choose" control still opens the scoped sheet and logs only the checked subset', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Choose which watering to log/i }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    // Deselect one of the two pre-checked rows, then log the subset.
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBe(2)
    fireEvent.click(checkboxes[0])
    fireEvent.click(screen.getByRole('button', { name: /^Log all \(1\)/i }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => c[0] === '/api/events').length).toBe(1))
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalled())
  })

  // ── WS-A5: undo must await the DELETE; a failed undo keeps the row hidden (no phantom re-log) ──
  it('single undo awaits the DELETE then re-surfaces the row', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i }))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    const { onUndo } = toastMock.showUndo.mock.calls[0][0]
    await act(async () => { await onUndo() })
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/events/ev-new' && c[1]?.method === 'DELETE')).toBe(true)
    await waitFor(() => expect(screen.getByText('Bhut Jolokia')).toBeTruthy())
  })

  it('single undo failure keeps the row hidden + error toast (no re-surface -> no duplicate)', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i }))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    const { onUndo } = toastMock.showUndo.mock.calls[0][0]
    toastMock.show.mockClear()
    fetchMock.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('down'), { status: 500 })))
    await act(async () => { await onUndo() })
    expect(toastMock.show).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Bhut Jolokia')).toBeNull()
  })

  it('bulk undo awaits all DELETEs then re-surfaces the rows', async () => {
    let n = 0
    fetchMock.mockImplementation((path) => {
      if (path === '/api/plants' || path === '/api/locations/with-path') return Promise.resolve([])
      if (path === '/api/events') return Promise.resolve({ id: 'ev-' + (++n) })
      return Promise.resolve({ undone: true })
    })
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Log all watering \(2\)$/i }))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    const { onUndo } = toastMock.showUndo.mock.calls[0][0]
    await act(async () => { await onUndo() })
    const deletes = fetchMock.mock.calls.filter(c => c[0].startsWith('/api/events/') && c[1]?.method === 'DELETE')
    expect(deletes.length).toBe(2)
    await waitFor(() => expect(screen.getByText('Bhut Jolokia')).toBeTruthy())
  })

  // ── C1/C4: the staleness state and the group-severity/expand rules, at the component seam ──
  // Shapes are the live 2026-08-17 plan: "Bag Area" 116 rows at overdue<=3, "Legacy Pasture
  // In-Ground" 4 rows carrying a 19-day outlier, median days_since 4 across the list.
  describe('stale plan + long list', () => {
    const bigPlan = ({ daysSince = 4 } = {}) => ({
      hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
      rain_skipped: [],
      water_due: [
        ...[19, 19, 16, 12].map((o, i) => ({
          id: 'pas' + i, name: 'Pasture ' + i, project: 'Legacy Pasture In-Ground',
          project_id: 'prPasture', overdue_by: o, days_since: 19, in_ground: true,
        })),
        ...Array.from({ length: 116 }, (_, i) => ({
          id: 'bag' + i, name: 'Bag ' + i, project: 'Bag Area',
          project_id: 'prBag', overdue_by: i < 14 ? 3 : 2, days_since: daysSince, in_ground: false,
        })),
      ],
      no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
    })

    it('opens on the group holding the mass, not the 4-row group with the worst outlier', () => {
      render(<CareNeeded plan={bigPlan()} />)
      // The 116-row group is expanded (its rows are in the DOM); the 4-row outlier group is not.
      expect(screen.getByText('Bag 0')).toBeTruthy()
      expect(screen.queryByText('Pasture 0')).toBeNull()
    })

    // V4-TODAYVERBIAGE-001 — the note was halved. The self-explaining clause ("half of these rest
    // on a check N+ days old") is gone; the disclosure that rows are WITHHELD stays, because it is
    // the only thing that stops the visible list from silently under-reporting the garden.
    it('discloses that rows are withheld, without explaining its own reasoning', () => {
      render(<CareNeeded plan={bigPlan()} />)
      expect(screen.getByText(/Showing the longest-waiting 20 per group/i)).toBeTruthy()
      expect(screen.queryByText(/No recent watering record/i)).toBeNull()
      expect(screen.queryByText(/days old/i)).toBeNull()
    })

    it('caps the expanded group at WATER_STALE_CAP rows while the header keeps the TRUE count', () => {
      render(<CareNeeded plan={bigPlan()} />)
      expect(screen.getByText('Bag 19')).toBeTruthy()
      expect(screen.queryByText('Bag 20')).toBeNull()
      expect(screen.getByText('116')).toBeTruthy()          // group badge, uncapped
      expect(screen.getByRole('button', { name: /Show 96 more/i })).toBeTruthy()
    })

    it('"Show N more" restores the full list', () => {
      render(<CareNeeded plan={bigPlan()} />)
      fireEvent.click(screen.getByRole('button', { name: /Show 96 more/i }))
      expect(screen.getByText('Bag 115')).toBeTruthy()
      expect(screen.queryByText(/Showing the longest-waiting/i)).toBeNull()
    })

    it('the cap never shrinks the bulk action — 92% of watering goes through that one tap', () => {
      render(<CareNeeded plan={bigPlan()} />)
      expect(screen.getByRole('button', { name: /^Log all watering \(120\)$/i })).toBeTruthy()
    })

    it('a fresh record leaves the list uncapped and unannotated, however long it is', () => {
      // Live 2026-08-15: 134 due at median days_since 2 — the wi=1 cohort really is due.
      render(<CareNeeded plan={bigPlan({ daysSince: 2 })} />)
      expect(screen.queryByText(/Showing the longest-waiting/i)).toBeNull()
      expect(screen.getByText('Bag 115')).toBeTruthy()
      expect(screen.queryByRole('button', { name: /Show \d+ more/i })).toBeNull()
    })
  })

  // BUG-CADENCEONEDAY-001 — the daily cohort as it actually renders. Shape from prod 2026-08-18:
  // 82 of 228 plantings on interval 1, last bulk-watered 08-13 (days_since 5), sitting beside
  // longer-cadence rows that must keep their overdue escalation.
  describe('daily cadence framing', () => {
    const dailyPlan = () => ({
      hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
      rain_skipped: [],
      water_due: [
        ...Array.from({ length: 12 }, (_, i) => ({
          id: 'bag' + i, name: 'Bag ' + i, project: 'Bag Area', project_id: 'prBag',
          interval: 1, days_since: 5, overdue_by: 4, in_ground: false,
        })),
        // Same location group on purpose — the two cadences have to read differently SIDE BY SIDE,
        // which is exactly how Bag Area renders live (fabric-bag tomatoes at 1, blueberries at 7).
        { id: 'bb1', name: 'Blueberry Bag', project: 'Bag Area', project_id: 'prBag', interval: 7, days_since: 11, overdue_by: 4, in_ground: false },
      ],
      no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
    })

    // BD-036b split these two apart, because after the redesign they are no longer the same claim.
    // The daily framing still PRINTS (colour cannot say "daily"); the bare overdue restatement is
    // now visually dropped and survives as screen-reader-only text.
    //
    // getByText finds sr-only nodes, so asserting '4d overdue' exists would pass either way and
    // would quietly become a test of nothing. The visibility check is what carries the meaning here.
    it('shows the daily rows as a cadence — colour cannot express "daily"', () => {
      render(<CareNeeded plan={dailyPlan()} />)
      expect(screen.getAllByText('Daily — last watered 5d ago').length).toBe(12)
      expect(screen.getAllByText('Daily — last watered 5d ago')[0].style.position).not.toBe('absolute')
    })

    it('drops the bare overdue restatement from sight but keeps it for screen readers', () => {
      render(<CareNeeded plan={dailyPlan()} />)
      const el = screen.getByText('4d overdue')          // the 7-day row's backlog
      // sr-only, not rendered inline. Asserted on position+size rather than `clip`: jsdom does not
      // reflect the legacy clip property, so that assertion read '' and would have failed forever.
      expect(el.style.position).toBe('absolute')
      expect(el.style.width).toBe('1px')
      expect(el.style.overflow).toBe('hidden')
      // And the urgency it used to spell out is still on screen, as the chip's tier colour.
      expect(screen.getAllByRole('button', { name: /^Log Water for/i }).length).toBe(13)
    })

    it('keeps every daily planting visible and one-tap loggable', async () => {
      render(<CareNeeded plan={dailyPlan()} />)
      expect(screen.getByText('Bag 0')).toBeTruthy()
      expect(screen.getAllByRole('button', { name: /^Log Water for/i }).length).toBe(13)
      fireEvent.click(screen.getByRole('button', { name: /^Log Water for Bag 0$/i }))
      await waitFor(() => expect(screen.queryByText('Bag 0')).toBeNull())
      const [, opts] = fetchMock.mock.calls.find(c => c[0] === '/api/events')
      expect(JSON.parse(opts.body).event_type).toBe('watering')
      expect(JSON.parse(opts.body).plant_id).toBe('bag0')
    })

    // V4-TODAYVERBIAGE-001 (BD-035) — this pair used to assert the denomination note rendered on a
    // long list and stayed silent on a short one. Inverted: the note is gone at EVERY length, and
    // the count it explained is still on the pill. Kept as an assertion rather than deleted so the
    // note cannot quietly return — its original rationale is persuasive and will be re-derived.
    it('does not explain the arithmetic of the bulk action at any list length', () => {
      render(<CareNeeded plan={dailyPlan()} />)
      expect(screen.queryByText(/One bulk water covers/i)).toBeNull()
      expect(screen.getByRole('button', { name: /^Log all watering \(13\)$/i })).toBeTruthy()
      cleanup()
      render(<CareNeeded plan={plan()} />)     // two rows
      expect(screen.queryByText(/One bulk water covers/i)).toBeNull()
    })
  })

  it('bulk undo failure keeps rows hidden + error toast', async () => {
    let n = 0
    fetchMock.mockImplementation((path, opts) => {
      if (path === '/api/plants' || path === '/api/locations/with-path') return Promise.resolve([])
      if (path === '/api/events' && (!opts || opts.method === 'POST')) return Promise.resolve({ id: 'ev-' + (++n) })
      return Promise.reject(Object.assign(new Error('down'), { status: 500 }))
    })
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Log all watering \(2\)$/i }))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    toastMock.show.mockClear()
    const { onUndo } = toastMock.showUndo.mock.calls[0][0]
    await act(async () => { await onUndo() })
    expect(toastMock.show).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Bhut Jolokia')).toBeNull()
  })

  // V4-TODAYSECTIONBULK-001 (BD-037) — one-tap bulk per section, in the header. Dave's case is a
  // location group of ~77 that previously had to leave Today for Log Many to clear in one action.
  describe('section bulk', () => {
    const twoGroups = () => ({
      hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
      rain_skipped: [],
      water_due: [
        { id: 'a1', name: 'Alpha One', crop: 'pepper', project: 'Alpha', project_id: 'prA', overdue_by: 2, in_ground: false },
        { id: 'a2', name: 'Alpha Two', crop: 'pepper', project: 'Alpha', project_id: 'prA', overdue_by: 2, in_ground: false },
        { id: 'b1', name: 'Beta One', crop: 'kale', project: 'Beta', project_id: 'prB', overdue_by: 0, in_ground: false },
        { id: 'b2', name: 'Beta Two', crop: 'kale', project: 'Beta', project_id: 'prB', overdue_by: 0, in_ground: false },
      ],
      no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
    })

    it('logs only its own section, leaving the other section untouched', async () => {
      render(<CareNeeded plan={twoGroups()} />)
      fireEvent.click(await screen.findByRole('button', { name: /Water all 2 in Alpha/i }))
      await waitFor(() => expect(fetchMock.mock.calls.filter(c => c[0] === '/api/events').length).toBe(2))
      const ids = fetchMock.mock.calls.filter(c => c[0] === '/api/events').map(c => JSON.parse(c[1].body).plant_id)
      expect(ids.sort()).toEqual(['a1', 'a2'])
      await waitFor(() => expect(screen.queryByText('Alpha One')).toBeNull())
      // The whole point: Beta is still there and still offers its own button.
      expect(screen.queryByText('Beta One')).toBeTruthy()
      expect(screen.getByRole('button', { name: /Water all 2 in Beta/i })).toBeTruthy()
    })

    it('is absent for a section with only one row — a bulk of one is just the row button', () => {
      const single = twoGroups()
      single.water_due = single.water_due.filter(r => r.project_id === 'prA').slice(0, 1)
      render(<CareNeeded plan={single} />)
      expect(screen.queryByRole('button', { name: /Water all .* in Alpha/i })).toBeNull()
      expect(screen.getByRole('button', { name: /Log Water for Alpha One/i })).toBeTruthy()
    })

    it('excludes in-ground beds while bed-wait is active, exactly as the global pill does', async () => {
      const p = twoGroups()
      p.hydrology = { tomorrow_precip_in: 0.5, tomorrow_pop: 80 }   // bedWaitActive
      p.water_due[1].in_ground = true                                // a2 becomes a bed
      render(<CareNeeded plan={p} />)
      // Only a1 remains a candidate, so the section bulk drops below two and disappears.
      expect(screen.queryByRole('button', { name: /Water all .* in Alpha/i })).toBeNull()
    })
  })
})
