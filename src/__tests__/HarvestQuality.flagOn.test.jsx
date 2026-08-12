// HarvestQuality.flagOn.test.jsx — V4-HIDEQUALITY-001 (BD-006). The counterpart to
// HarvestQuality.flagOff.test.jsx.
//
// Two jobs, and only two:
//
// 1. It is the SINGLE pin on the flag's shipped value, taken via importActual so no mock anywhere can
//    launder it. That pin is deliberate: it means a future "show quality again" flip fails HERE, as
//    one explicit decision to re-approve, instead of scattering red across the suites that merely
//    happen to render a harvest.
// 2. It proves the flag-off suite's "it comes back" assertions are not passing VACUOUSLY. Every
//    surface that file asserts PRESENT under the mock is asserted ABSENT here under the real flag.
//    Without this, a typo'd import or a permanently-dead branch would read as a working lever.
//
// The EventNew absence assertions live in EventNew.test.jsx (its harness already owns that page).
// What this file adds on the output side is the Harvests list, which had no quality assertion at all
// before — its fixtures carried quality_rating and nothing ever checked what happened to it.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const { fetchSpy, searchParamsRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useSearchParams: () => [searchParamsRef.current, () => {}],
}))

import Harvests from '../pages/Harvests.jsx'

// V4-HARVDEFAULT-001: a bare arrival lands on TOTALS; every assertion here reads a LOG row, so the
// cases toggle in (design §2a: insert a toggle step, never weaken an assertion).
const toLog = () => fireEvent.click(screen.getByRole('radio', { name: 'Log' }))

const RATED_ROW = {
  event_id: 'e1', day_key: '2026-07-20', event_date: '2026-07-20T12:00:00Z',
  plant_id: 'p1', project_id: 'pr1', crop_type_slug: 'tomato', crop_name: 'Tomato',
  variety_name: 'Sungold', quantity: 4, unit: 'count', quality_rating: 4,
  harvest_log_id: 'h1', photos: [],
}

beforeEach(() => {
  fetchSpy.mockReset()
  searchParamsRef.current = new URLSearchParams()
  fetchSpy.mockImplementation((url) => {
    const u = String(url)
    if (u === '/api/projects') return Promise.resolve([])
    if (u.includes('include=aggregates') && !u.includes('entries')) {
      return Promise.resolve({ aggregates: { crop_list: [], crops: [], other: [] } })
    }
    return Promise.resolve({ entries: [RATED_ROW], aggregates: { crops: [], other: [], first_pick: [] }, cursor: null })
  })
})

describe('V4-HIDEQUALITY-001 — shipped flag value', () => {
  it('ships with harvest quality hidden', async () => {
    const actual = await vi.importActual('../lib/featureFlags.js')
    expect(actual.HARVEST_QUALITY_HIDDEN).toBe(true)
  })
})

describe('V4-HIDEQUALITY-001 — output surface is quiet at the shipped value', () => {
  it('renders no QualityDots even when the API returns a rating', async () => {
    render(<Harvests />)
    toLog()
    // Wait on the row itself, not on an absence — asserting "not there" before the fetch settles
    // would pass against an empty page and prove nothing. Anchor on the per-row Edit link: the crop
    // name appears in both the row and the crop filter, so a text match on it is ambiguous.
    await waitFor(() => expect(screen.getByLabelText('Open this harvest event')).toBeTruthy())
    expect(screen.queryByLabelText('Quality 4 of 5')).toBeNull()
    expect(screen.queryByRole('img', { name: /^Quality \d+ of \d+$/ })).toBeNull()
  })

  // BD-006 is HIDE, not drop, and the hide must be SURGICAL — the rest of the row is untouched. The
  // "the column and the API still carry the rating" half of that claim is owned server-side (nothing
  // in this change touches the harvests SELECT); a client test asserting its own fixture would prove
  // nothing, so this asserts what the client actually controls: only the dots left.
  it('leaves the rest of the harvest row intact', async () => {
    render(<Harvests />)
    toLog()
    await waitFor(() => expect(screen.getByLabelText('Open this harvest event')).toBeTruthy())
    expect(screen.getAllByText(/Sungold/).length).toBeGreaterThan(0)
    expect(screen.getByText('4 Tomatoes')).toBeTruthy()
  })
})
