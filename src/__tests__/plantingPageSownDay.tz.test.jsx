// BUG-PLANTINGPAGESOWNDAYEARLY-001 — the planting page printed Sown and Transplanted a day early.
//
// THE WIRE. plants.sown_at / germinated_at / transplanted_at / planted_out_at are DATE columns.
// GET /api/plants/:id selects them raw (lambda/plants/index.js), the driver turns a DATE into local
// midnight in the Lambda's zone (UTC) and JSON.stringify sends "2026-04-10T00:00:00.000Z" (the
// mechanism is established in putUpDateEcho.tz.test.js). The page's parsers special-cased only the
// bare 10-character form, so the shape the server actually sends went through `new Date()` and
// landed on the evening before.
//
// THE PHONE is in America/New_York. This file switches the process zone itself rather than trusting
// the runner's: CI runs the suite once in UTC, where the defect cannot show.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }),
}))
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import PlantingDetail from '../pages/PlantingDetail.jsx'
import { parseDayOrInstant } from '../lib/dateLocal.js'
import { buildLifeStory } from '../lib/lifeStory.js'
import { computeMaturity } from '../lib/plantingMaturity.js'

const PHONE_TZ = 'America/New_York'
const ORIGINAL_TZ = process.env.TZ
const setZone = (tz) => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz }

beforeEach(() => {
  setZone(PHONE_TZ)
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
})
afterEach(() => setZone(ORIGINAL_TZ))

// Every shape the server can send for a DATE, plus the bare form fixtures and optimistic writes use.
const APR_10 = ['2026-04-10', '2026-04-10T00:00:00.000Z', '2026-04-10T00:00:00Z', '2026-04-10T00:00:00+00:00']
const ymd = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()]
const longDay = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

describe('the zone this proof depends on is really in force', () => {
  // INSTRUMENT CHECK. If the runtime ignored the TZ change, the cases below would pass for the wrong reason.
  it('the phone zone reads UTC midnight as the evening before', () => {
    expect(new Date('2026-04-10T00:00:00.000Z').getDate()).toBe(9)
  })
})

describe('parseDayOrInstant (run in ET)', () => {
  it.each(APR_10)('reads %s as local midnight of Apr 10', (wire) => {
    const d = parseDayOrInstant(wire)
    expect(ymd(d)).toEqual([2026, 4, 10])
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 0])
  })

  it('the first of a month does not fall back into the month before', () => {
    expect(ymd(parseDayOrInstant('2026-05-01T00:00:00.000Z'))).toEqual([2026, 5, 1])
    expect(ymd(parseDayOrInstant('2026-01-01T00:00:00.000Z'))).toEqual([2026, 1, 1])
  })

  // A value with a real time of day IS an instant: 02:30 UTC on Apr 10 is 22:30 on Apr 9 in New York.
  it('a real timestamp is still an instant and renders in local time', () => {
    const late = parseDayOrInstant('2026-04-10T02:30:00.000Z')
    expect(late.getTime()).toBe(Date.parse('2026-04-10T02:30:00.000Z'))
    expect(ymd(late)).toEqual([2026, 4, 9])
    expect(ymd(parseDayOrInstant('2026-04-10T12:00:00Z'))).toEqual([2026, 4, 10])
    expect(ymd(parseDayOrInstant('2026-04-10T00:00:00.001Z'))).toEqual([2026, 4, 9])
  })

  it('a Date passes through untouched and an unreadable or absent value is null', () => {
    const now = new Date('2026-04-10T02:30:00.000Z')
    expect(parseDayOrInstant(now).getTime()).toBe(now.getTime())
    expect(parseDayOrInstant('not a date')).toBeNull()
    expect(parseDayOrInstant('2026-02-31')).toBeNull()
    expect(parseDayOrInstant('2026-13-01')).toBeNull()
    expect(parseDayOrInstant(null)).toBeNull()
    expect(parseDayOrInstant('')).toBeNull()
  })
})

describe('the life-story spine and the maturity card keep the stored day (run in ET)', () => {
  it.each(APR_10)('buildLifeStory dates a sowing of %s on April 10', (wire) => {
    const [row] = buildLifeStory({ sown_at: wire })
    expect(longDay(row.date)).toBe('April 10, 2026')
  })

  it.each(APR_10)('computeMaturity anchors a sowing of %s on Apr 10 and projects from it', (wire) => {
    const m = computeMaturity(
      { sown_at: wire, variety_ref: { days_to_maturity_min: 60, days_to_maturity_max: 70 } },
      new Date(2026, 3, 20, 9, 0),
    )
    expect(ymd(m.anchorDate)).toEqual([2026, 4, 10])
    expect(m.ageDays).toBe(10)
    expect(ymd(m.maturityMinDate)).toEqual([2026, 6, 9])
    expect(m.harvestWindowLabel).toContain('Jun 9, 2026')
  })

  // The age is whole local days since the stored day. Read as UTC midnight, the count turned over
  // at 8 pm the evening before instead of at midnight.
  it('the age turns over at local midnight, not at 8 pm', () => {
    const p = { sown_at: '2026-04-10T00:00:00.000Z' }
    expect(computeMaturity(p, new Date(2026, 3, 19, 23, 0)).ageDays).toBe(9)
    expect(computeMaturity(p, new Date(2026, 3, 20, 0, 30)).ageDays).toBe(10)
  })
})

describe('PlantingDetail prints the day that is stored (run in ET)', () => {
  const planting = (sown_at, transplanted_at) => ({
    id: 'pl1', name: 'Dark Green Zucchini', project_id: 'proj1', project_name: 'Squash 2026',
    status: 'growing', quantity: 1, sown_at, transplanted_at,
    variety_ref: { name: 'Dark Green', species: 'Cucurbita pepo' },
    featured_photo_view_url: null,
  })
  // 02:30 UTC on Jun 2 is 10:30 pm on Jun 1 in New York: a real event time, kept local.
  const EVENTS = [
    { id: 'e1', event_type: 'first_harvest', event_date: '2026-06-02T02:30:00.000Z', plant_id: 'pl1', title: null },
  ]

  function renderAt(pl) {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(pl)
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    return render(
      <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
        <Routes>
          <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it.each([
    ['a bare date', '2026-04-10', '2026-05-01'],
    ['the DATE column as the Lambda serialises it', '2026-04-10T00:00:00.000Z', '2026-05-01T00:00:00.000Z'],
  ])('%s: Sown April 10 and Transplanted May 1, on the spine and in Details', async (_, sown, transplanted) => {
    renderAt(planting(sown, transplanted))
    await screen.findByRole('heading', { name: 'Dark Green Zucchini' })
    const count = (text) => document.body.textContent.split(text).length - 1
    const spine = { sown: count('April 10, 2026'), transplanted: count('May 1, 2026') }
    expect(spine.sown).toBeGreaterThan(0)
    expect(spine.transplanted).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /Details/ }))
    await waitFor(() => expect(count('April 10, 2026')).toBeGreaterThan(spine.sown))
    expect(count('May 1, 2026')).toBeGreaterThan(spine.transplanted)
    expect(count('April 9, 2026')).toBe(0)
    expect(count('April 30, 2026')).toBe(0)
  })

  it('a real event time still renders in local time', async () => {
    renderAt(planting('2026-04-10T00:00:00.000Z', null))
    await screen.findByRole('heading', { name: 'Dark Green Zucchini' })
    fireEvent.click(screen.getByRole('button', { name: /Details/ }))
    fireEvent.click(await screen.findByRole('radio', { name: 'More' }))
    const cell = (await screen.findByText('First harvest')).parentElement
    expect(cell.textContent).toContain('June 1, 2026')
  })
})
