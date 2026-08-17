// V4-STORAGEDEADLINE-001 — the storage-crop lift deadline as an OPERATIONAL ALERT, not a band.
//
// These tests run against the REAL `src/data/storageDeadlines.json`, on FIXED dates. That matters
// twice over:
//  1. The live dataset contains exactly one record (sweet_potato, check 09-11, deadline 09-25) and
//     the emptiness is the finding, not a TODO — so the only honest way to prove the surface works
//     is synthetic PLANTINGS against the real dataset, never invented dates.
//  2. The surface renders NOTHING on 2026-08-14, and that is correct, not a bug. There is an
//     explicit pin below asserting exactly that, so a future session cannot "fix" the silence by
//     loosening the criteria without a red test explaining why the silence was deliberate.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))

import StorageDeadlineAlert, {
  storageDeadlineGroups,
  STORAGE_DEADLINE_CAP,
  PAST_GRACE_DAYS,
} from '../components/today/StorageDeadlineAlert.jsx'

// The real dataset's sweet_potato record: check window opens 09-11, deadline 09-25
// (BUG-SWEETPOTATODEADLINE-001 moved both off the superseded 10-01 / 10-15).
const sweet = (over = {}) => ({
  id: 'p-sp1', name: 'Beauregard', status: 'vegetative',
  variety_ref: { id: 'v1', name: 'Beauregard', crop_type_slug: 'sweet_potato' },
  ...over,
})
// carrot IS in the dataset — in `no_calendar_deadline`, deliberately dateless. It must stay silent.
const carrot = (over = {}) => ({
  id: 'p-c1', name: 'Napoli', status: 'vegetative',
  variety_ref: { id: 'v2', name: 'Napoli', crop_type_slug: 'carrot' },
  ...over,
})

beforeEach(() => { fetchMock.mockReset() })

describe('storageDeadlineGroups — the time bounds are the feature', () => {
  it('is SILENT today (2026-08-14): the check window has not opened', () => {
    // The load-bearing pin. Silence here is the design, not a gap — the one sourced deadline in the
    // dataset opens on 09-11. Anything that makes this test go non-empty has widened the criteria.
    expect(storageDeadlineGroups([sweet()], '2026-08-14')).toEqual([])
  })

  it('is silent right up to the day before the check window opens', () => {
    expect(storageDeadlineGroups([sweet()], '2026-09-10')).toEqual([])
  })

  it('speaks on the day the check window opens, in CHECK form', () => {
    const g = storageDeadlineGroups([sweet()], '2026-09-11')
    expect(g).toHaveLength(1)
    expect(g[0].slug).toBe('sweet_potato')
    expect(g[0].phase).toBe('check')
    expect(g[0].copy).toMatch(/^Start checking sweet potatoes for lifting/)
    // Never assertion-form: the date is a regional proxy for a soil temperature nobody measures.
    expect(g[0].copy).not.toMatch(/are ready|is ready/i)
  })

  it('still speaks on the deadline day itself', () => {
    expect(storageDeadlineGroups([sweet()], '2026-09-25')[0].phase).toBe('check')
  })

  it('switches to past copy the day after the deadline', () => {
    const g = storageDeadlineGroups([sweet()], '2026-09-26')
    expect(g[0].phase).toBe('past')
    expect(g[0].copy).toMatch(/window has passed/i)
  })

  it('keeps saying so through the grace window, then goes SILENT', () => {
    expect(PAST_GRACE_DAYS).toBe(14)
    // 09-25 + 14 = 10-09, the last day inside the grace window.
    expect(storageDeadlineGroups([sweet()], '2026-10-09')).toHaveLength(1)
    // One day later it stops. Without this bound the lib's `past` phase would keep a "window has
    // passed" line standing on Today until Dec 31 — a standing list with extra steps.
    expect(storageDeadlineGroups([sweet()], '2026-10-10')).toEqual([])
  })

  it('resets across the year boundary rather than carrying a stale past line', () => {
    expect(storageDeadlineGroups([sweet()], '2027-01-05')).toEqual([])
  })
})

describe('storageDeadlineGroups — what it will and will not speak about', () => {
  it('groups two plantings of the same crop into ONE alert, naming both', () => {
    const g = storageDeadlineGroups(
      [sweet(), sweet({ id: 'p-sp2', name: 'Georgia Jet' })],
      '2026-09-12',
    )
    expect(g).toHaveLength(1)
    expect(g[0].names).toEqual(['Beauregard', 'Georgia Jet'])
  })

  it('drops ended/failed plantings — never tell him to lift something he closed out', () => {
    expect(storageDeadlineGroups([sweet({ status: 'ended' })], '2026-09-12')).toEqual([])
    expect(storageDeadlineGroups([sweet({ status: 'failed' })], '2026-09-12')).toEqual([])
  })

  it("does NOT drop status 'harvested' — that DB value is labelled 'Harvesting' (in progress)", () => {
    expect(storageDeadlineGroups([sweet({ status: 'harvested' })], '2026-09-12')).toHaveLength(1)
  })

  it('says nothing about a crop deliberately given no deadline (carrot)', () => {
    expect(storageDeadlineGroups([carrot()], '2026-09-12')).toEqual([])
    expect(storageDeadlineGroups([carrot()], '2026-11-15')).toEqual([])
  })

  it('says nothing about a planting with no variety or no crop type', () => {
    expect(storageDeadlineGroups([{ id: 'x', name: 'Mystery', variety_ref: null }], '2026-09-12')).toEqual([])
    expect(storageDeadlineGroups([{ id: 'x', name: 'M', variety_ref: { crop_type_slug: null } }], '2026-09-12')).toEqual([])
  })

  it('caps the group count and never throws on junk input', () => {
    expect(STORAGE_DEADLINE_CAP).toBe(2)
    expect(storageDeadlineGroups([sweet()], '2026-09-12', 0)).toEqual([])
    expect(storageDeadlineGroups([], '2026-09-12')).toEqual([])
    expect(storageDeadlineGroups(null, '2026-09-12')).toEqual([])
    expect(storageDeadlineGroups(undefined, '2026-09-12')).toEqual([])
    expect(storageDeadlineGroups([null, undefined, 7], '2026-09-12')).toEqual([])
    expect(storageDeadlineGroups([sweet()], 'not-a-date')).toEqual([])
  })
})

describe('StorageDeadlineAlert component', () => {
  it('renders NOTHING today, with real plantings wired', async () => {
    fetchMock.mockResolvedValue([sweet(), sweet({ id: 'p-sp2', name: 'Georgia Jet' }), carrot()])
    const { container } = render(<StorageDeadlineAlert todayISO="2026-08-14" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/plants'))
    expect(container.firstChild).toBeNull()
  })

  it('renders the sourced copy and the planting names once the window is open', async () => {
    fetchMock.mockResolvedValue([sweet(), sweet({ id: 'p-sp2', name: 'Georgia Jet' }), carrot()])
    render(<StorageDeadlineAlert todayISO="2026-09-12" />)
    const el = await screen.findByTestId('storage-deadline-alert')
    expect(el.textContent).toMatch(/Start checking sweet potatoes for lifting/)
    expect(el.textContent).toMatch(/Beauregard · Georgia Jet/)
    // One alert, not one per planting.
    expect(el.querySelectorAll('[data-testid^="storage-deadline-"]').length).toBe(1)
  })

  it('is an ambient in-flow note: no heading, no dialog/alert role, no count', async () => {
    fetchMock.mockResolvedValue([sweet()])
    const el = await (async () => {
      render(<StorageDeadlineAlert todayISO="2026-09-12" />)
      return screen.findByTestId('storage-deadline-alert')
    })()
    expect(el.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(el.querySelector('[role="dialog"],[role="alertdialog"],[role="alert"]')).toBeNull()
    expect(el.textContent).not.toMatch(/Showing \d+|\d+ of \d+|\(\d+\)/)
  })

  it('never asks for system notification permission', async () => {
    const req = vi.fn()
    const prev = globalThis.Notification
    globalThis.Notification = { requestPermission: req, permission: 'default' }
    try {
      fetchMock.mockResolvedValue([sweet()])
      render(<StorageDeadlineAlert todayISO="2026-09-12" />)
      await screen.findByTestId('storage-deadline-alert')
      expect(req).not.toHaveBeenCalled()
    } finally {
      if (prev === undefined) delete globalThis.Notification
      else globalThis.Notification = prev
    }
  })

  it('swallows a fetch error — renders nothing, never throws onto Today', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { container } = render(<StorageDeadlineAlert todayISO="2026-09-12" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing before the first load resolves, and nothing on an empty garden', async () => {
    fetchMock.mockResolvedValue([sweet()])
    const { container } = render(<StorageDeadlineAlert todayISO="2026-09-12" />)
    expect(container.firstChild).toBeNull()
    await screen.findByTestId('storage-deadline-alert')

    fetchMock.mockResolvedValue([])
    const second = render(<StorageDeadlineAlert todayISO="2026-09-12" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(second.container.firstChild).toBeNull()
  })

  it('tolerates a non-array payload without rendering or throwing', async () => {
    fetchMock.mockResolvedValue({ error: 'nope' })
    const { container } = render(<StorageDeadlineAlert todayISO="2026-09-12" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })
})
