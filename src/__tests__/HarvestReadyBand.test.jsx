// V4-HARVESTSURF-001 — the Today "ready to pick" ambient card. Hidden when empty, ordered by overdue
// ratio, navigates (never one-tap POSTs), and Reward-UX V102 ambient-only compliant.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RETRY_DELAY_MS } from '../lib/useAmbientBandFetch.js'
import { rankHarvestReady } from '../lib/harvestReadiness.js'

const navigateMock = vi.fn()
const locationRef = { pathname: '/today' }
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => locationRef,
  Link: ({ children }) => <a>{children}</a>,
}))
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))

import HarvestReadyBand from '../components/HarvestReadyBand.jsx'

const cand = (over = {}) => ({
  plant_id: 'p1', project_id: 'proj1', name: 'Wild Wineberry',
  // crop_type_slug is the rollup key and is non-null in the real payload (INNER JOIN on ct.slug), so
  // every fixture carries one — a slugless fixture would fall through to the per-planting fallback
  // and quietly test the degraded path instead of the shipped one.
  crop_type_slug: 'wineberry',
  // interval 3 / 7 days = ratio 2.33, deliberately INSIDE the BD-001 staleness ceiling
  // (MAX_OVERDUE_RATIO = 3) so this shared fixture keeps testing rendering, not the predicate.
  harvest_habit: 'repeat', repeat_interval_days: 3, days_since_last_harvest: 7,
  harvest_season_start_doy: null, harvest_season_end_doy: null, ...over,
})

const payload = (candidates, et_doy = 202) => fetchMock.mockImplementation((url) =>
  Promise.resolve(url === '/api/events/harvest-ready' ? { time_zone: 'America/New_York', et_doy, candidates } : null))

beforeEach(() => { navigateMock.mockReset(); fetchMock.mockReset(); sessionStorage.clear() })

describe('HarvestReadyBand', () => {
  it('renders ready plantings with neutral cadence copy', async () => {
    payload([cand()])
    render(<HarvestReadyBand />)
    await screen.findByRole('region', { name: /Due for a pick/i })
    expect(screen.getByRole('button', { name: /Wild Wineberry/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /last picked 7 days ago/i })).toBeTruthy()
  })

  it('orders rows by overdue ratio, most overdue first', async () => {
    payload([
      cand({ plant_id: 'sq', name: 'Zephyr Squash', crop_type_slug: 'summer_squash', repeat_interval_days: 2, days_since_last_harvest: 2 }),
      cand({ plant_id: 'wb', name: 'Wild Wineberry', crop_type_slug: 'wineberry', repeat_interval_days: 3, days_since_last_harvest: 7 }),
      cand({ plant_id: 'br', name: 'Green Magic', crop_type_slug: 'broccoli', repeat_interval_days: 6, days_since_last_harvest: 11 }),
    ])
    render(<HarvestReadyBand />)
    await screen.findByRole('region', { name: /Due for a pick/i })
    const names = screen.getAllByRole('button').map(b => b.textContent)
    expect(names[0]).toMatch(/Wild Wineberry/)
    expect(names[1]).toMatch(/Green Magic/)
    expect(names[2]).toMatch(/Zephyr Squash/)
  })

  it('renders nothing when no candidate is ready', async () => {
    payload([cand({ days_since_last_harvest: 1, repeat_interval_days: 5 })])
    const { container } = render(<HarvestReadyBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/events/harvest-ready'))
    expect(container.querySelector('section')).toBeNull()
  })

  it('renders nothing on an empty candidate list', async () => {
    payload([])
    const { container } = render(<HarvestReadyBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/events/harvest-ready'))
    expect(container.querySelector('section')).toBeNull()
  })

  it('suppresses an out-of-window DOY planting entirely (asparagus after the window)', async () => {
    // ratio 2.0 — inside the staleness ceiling on purpose, so DOY suppression is the ONLY reason
    // this renders nothing (the old interval-1/30-day fixture was ratio 30 and would now be
    // double-suppressed, passing for the wrong reason).
    payload([cand({ name: 'Asparagus Bed', repeat_interval_days: 15, days_since_last_harvest: 30,
      harvest_season_start_doy: 115, harvest_season_end_doy: 166 })], 202)
    const { container } = render(<HarvestReadyBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/events/harvest-ready'))
    expect(container.querySelector('section')).toBeNull()
  })

  it('drops a staleness-ceiling row from the band (BD-001: the wineberry at 10.5x)', async () => {
    payload([
      cand({ plant_id: 'ok', name: 'Aster Blackberry', crop_type_slug: 'blackberry', repeat_interval_days: 2, days_since_last_harvest: 4 }),
      cand({ plant_id: 'stale', name: 'Long Gone', crop_type_slug: 'wineberry', repeat_interval_days: 2, days_since_last_harvest: 21 }),
    ])
    render(<HarvestReadyBand />)
    await screen.findByRole('region', { name: /Due for a pick/i })
    expect(screen.getByRole('button', { name: /Aster Blackberry/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Long Gone/i })).toBeNull()
  })

  // BUG-READYBANDFETCH-001 — the error is still swallowed (no throw, no banner, no alert colour),
  // but it no longer renders IDENTICALLY to an empty queue. Full semantics: AmbientBandFetch.test.jsx.
  it('a persistent fetch error renders the muted notice, not the empty state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      fetchMock.mockRejectedValue(new Error('boom'))
      render(<HarvestReadyBand />)
      await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 50) })
      expect(screen.getByText(/Couldn’t check just now/i)).toBeTruthy()
      expect(screen.queryByRole('region', { name: /Due for a pick/i })).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('shows nothing while the transient retry is still outstanding — never throws', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { container } = render(<HarvestReadyBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/events/harvest-ready'))
    // Real timers: the RETRY_DELAY_MS gap has not elapsed, so a one-off blip is still invisible.
    expect(container.querySelector('section')).toBeNull()
  })

  it('navigates to the prefilled harvest form — never one-tap POSTs', async () => {
    payload([cand()])
    render(<HarvestReadyBand />)
    const row = await screen.findByRole('button', { name: /Wild Wineberry/i })
    await userEvent.click(row)
    expect(navigateMock.mock.calls[0][0]).toBe('/log?project=proj1&plant=p1&event_type=harvest')
    const posts = fetchMock.mock.calls.filter(([, opts]) => opts?.method && opts.method !== 'GET')
    expect(posts).toHaveLength(0)
  })

  it('Reward-UX V102: ambient only — no count badge, no urgency/loss-aversion copy', async () => {
    payload([cand()])
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    expect(card.textContent).not.toMatch(/streak|don't let|hurry|overdue|urgent|!|days left|waste|rot/i)
    expect(card.querySelector('[role="dialog"], [role="alert"], [role="status"]')).toBeNull()
  })

  // Panel Q1: the heading states the cadence fact ("Due for a pick" — true by construction), never
  // the ripeness assertion the model cannot back.
  it('titles the band "Due for a pick", not the assertion form', async () => {
    payload([cand()])
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    expect(card.textContent).toMatch(/Due for a pick/)
    expect(card.textContent).not.toMatch(/Ready to pick/)
  })
})

// PANEL Q4 — the tail on the SHIPPED band, the one Dave actually named ("the plus twenty three
// more hidden below the cut. I need that to be expandable. That can't be lost there anywhere.").
// Pure client change: this band already holds every candidate and computed `more` in the browser.
describe('HarvestReadyBand — the tail (panel Q4)', () => {
  // Distinct intervals keep every row inside the staleness ceiling; identical ratios rank on
  // days_since then name, so the order is deterministic without mattering to these tests.
  // One crop PER ROW on purpose: these tests measure tail mechanics, so every row must survive the
  // crop rollup as its own row. Crowding is exercised separately, in the rollup describe below.
  const many = (n) => Array.from({ length: n }, (_, i) =>
    cand({ plant_id: `p${String(i).padStart(2, '0')}`, name: `Row ${String(i).padStart(2, '0')}`,
      crop_type_slug: `crop${String(i).padStart(2, '0')}` }))

  it('caps the collapsed band at five rows', async () => {
    payload(many(9))
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    expect(card.querySelectorAll('li').length).toBe(5)
  })

  it('the old dead "+N more" text is gone; the count lives on a real expand control', async () => {
    payload(many(9))
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    expect(card.textContent).not.toMatch(/\+\d+ more in the garden/)
    expect(card.textContent).not.toMatch(/Showing \d+ of \d+/i)
    const btn = screen.getByRole('button', { name: 'Show 4 more due for a pick' })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.getAttribute('aria-controls')).toBe('harvest-ready-tail')
    expect(btn.style.width).toBe('100%')
    expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(48)
  })

  it('expands in place, downward, with a second collapse control at the bottom', async () => {
    payload(many(9))
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    const btn = screen.getByRole('button', { name: 'Show 4 more due for a pick' })
    await userEvent.click(btn)
    expect(card.querySelectorAll('li').length).toBe(9)
    // Content is inserted AFTER the trigger — its top edge keeps its viewport y.
    const panel = card.querySelector('#harvest-ready-tail')
    expect(btn.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const fewer = screen.getByRole('button', { name: /Show fewer/ })
    await userEvent.click(fewer)
    expect(card.querySelectorAll('li').length).toBe(5)
  })

  it('reveals 20 at a time above 25 hidden', async () => {
    payload(many(40))
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    await userEvent.click(screen.getByRole('button', { name: 'Show 35 more due for a pick' }))
    expect(card.querySelectorAll('li').length).toBe(25)
    await userEvent.click(screen.getByRole('button', { name: 'Show 15 more due for a pick' }))
    expect(card.querySelectorAll('li').length).toBe(40)
    expect(screen.queryByRole('button', { name: /more due for a pick/ })).toBeNull()
  })

  it('expanded rows keep the navigate-only contract (no one-tap POST)', async () => {
    payload(many(7))
    render(<HarvestReadyBand />)
    await screen.findByRole('region', { name: /Due for a pick/i })
    await userEvent.click(screen.getByRole('button', { name: 'Show 2 more due for a pick' }))
    await userEvent.click(screen.getByRole('button', { name: /Row 06/i }))
    expect(navigateMock.mock.calls[0][0]).toBe('/log?project=proj1&plant=p06&event_type=harvest')
    const posts = fetchMock.mock.calls.filter(([, opts]) => opts?.method && opts.method !== 'GET')
    expect(posts).toHaveLength(0)
  })
})

// ── THE CROP ROLLUP (7-seat crucible 2026-08-20) ────────────────────────────────────────────────
// A row is a CROP, not a planting. The fixture below is the whole point of this block: a balanced
// 5-and-5 fixture passes identically before and after the rollup and proves nothing, so this one
// reproduces the measured prod population — 72 fruiting plantings against 14 herb plantings, at the
// measured 3.0x interval gap (fruiting mean 4.5d, herb mean 13.3d) — and every assertion below is
// anchored to a baseline assertion that the SHIPPED per-planting shape fails it.
describe('HarvestReadyBand — crop rollup', () => {
  // 45 tomato @ iv 3 + 27 pepper @ iv 7 = 72 rows, mean interval exactly 4.5d (prod: 43 tomato
  // plantings share interval 3, 37 pepper share 7).
  const fruiting = () => [
    ...Array.from({ length: 45 }, (_, i) => cand({
      plant_id: `tom${i}`, name: `Tomato ${i}`, crop_type_slug: 'tomato', crop_display_name: 'Tomato',
      harvest_habit: 'repeat', repeat_interval_days: 3, days_since_last_harvest: 8 - (i % 5),
    })),
    ...Array.from({ length: 27 }, (_, i) => cand({
      plant_id: `pep${i}`, name: `Pepper ${i}`, crop_type_slug: 'pepper', crop_display_name: 'Pepper',
      harvest_habit: 'repeat', repeat_interval_days: 7, days_since_last_harvest: 20 - (i % 13),
    })),
  ]
  // 14 cut_and_come_again rows, mean interval 13.3d — 8 basil @12, 3 chives @14, 2 tarragon @18,
  // 1 parsley @12. Every ratio here is below every fruiting ratio at the top of the list, which is
  // exactly the burial the panel measured.
  const herbs = () => [
    ...Array.from({ length: 8 }, (_, i) => cand({
      plant_id: `bas${i}`, name: `Basil ${i}`, crop_type_slug: 'basil', crop_display_name: 'Basil',
      harvest_habit: 'cut_and_come_again', repeat_interval_days: 12, days_since_last_harvest: 20 - i,
    })),
    ...Array.from({ length: 3 }, (_, i) => cand({
      plant_id: `chv${i}`, name: `Chives ${i}`, crop_type_slug: 'chives', crop_display_name: 'Chives',
      harvest_habit: 'cut_and_come_again', repeat_interval_days: 14, days_since_last_harvest: 18 - i,
    })),
    ...Array.from({ length: 2 }, (_, i) => cand({
      plant_id: `tar${i}`, name: `Tarragon ${i}`, crop_type_slug: 'tarragon', crop_display_name: 'Tarragon',
      harvest_habit: 'cut_and_come_again', repeat_interval_days: 18, days_since_last_harvest: 22 - i,
    })),
    cand({ plant_id: 'par0', name: 'Italian Parsley', crop_type_slug: 'parsley', crop_display_name: 'Parsley',
      harvest_habit: 'cut_and_come_again', repeat_interval_days: 12, days_since_last_harvest: 15 }),
  ]
  const crowded = () => [...fruiting(), ...herbs()]
  const headlines = (card) => [...card.querySelectorAll('li')].map(li => li.querySelectorAll('span span')[0].textContent)
  const sublines = (card) => [...card.querySelectorAll('li')].map(li => li.querySelectorAll('span span')[1].textContent)

  it('folds a crop’s siblings into one row — five slots hold five crops, not two', async () => {
    // BASELINE, so this guard cannot pass vacuously: on the SHIPPED per-planting shape the same
    // fixture puts ONE crop in all five slots (the 2026-08-16 case the panel replayed).
    const perPlanting = rankHarvestReady(crowded(), 202).slice(0, 5)
    expect(new Set(perPlanting.map(r => r.crop_type_slug)).size).toBe(1)

    payload(crowded())
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    expect(card.querySelectorAll('li').length).toBe(5)
    expect(headlines(card)).toEqual(['Pepper', 'Tomato', 'Basil', 'Chives', 'Parsley'])
  })

  it('lifts the buried cut_and_come_again herbs into the visible slots', async () => {
    expect(rankHarvestReady(crowded(), 202).slice(0, 5)
      .filter(r => r.harvest_habit === 'cut_and_come_again')).toHaveLength(0)

    payload(crowded())
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    expect(headlines(card).filter(h => ['Basil', 'Parsley', 'Chives', 'Tarragon'].includes(h))).toHaveLength(3)
  })

  it('states how many plantings a crop covers and when that CROP was last picked', async () => {
    payload(crowded())
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    const [pepper, tomato] = sublines(card)
    // The Pepper row's representative is 20 days unpicked (it is the most OVERDUE member and that is
    // what won the crop its slot), but the crop itself was picked 8 days ago. The row must say 8.
    expect(pepper).toBe('27 plantings · last picked 8 days ago')
    expect(pepper).not.toMatch(/20 days/)
    expect(tomato).toBe('45 plantings · last picked 4 days ago')
  })

  it('a one-planting crop reads exactly as it did before the rollup', async () => {
    payload([cand()])
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    expect(sublines(card)).toEqual(['last picked 7 days ago'])
    expect(card.textContent).not.toMatch(/plantings/)
  })

  it('orders crops by their best-ranked member — never alphabetically', async () => {
    // Alphabetical was measured and rejected: it promotes Blackberry, a deliberately-unmanaged
    // legacy perennial that sits LAST under the ranked order, into a visible slot.
    payload([
      cand({ plant_id: 'b1', name: 'Aster Blackberry', crop_type_slug: 'blackberry', crop_display_name: 'Blackberry', repeat_interval_days: 2, days_since_last_harvest: 2 }),
      cand({ plant_id: 't1', name: 'Cherokee Green', crop_type_slug: 'tomato', crop_display_name: 'Tomato', repeat_interval_days: 3, days_since_last_harvest: 8 }),
      cand({ plant_id: 'p1x', name: 'Armageddon', crop_type_slug: 'pepper', crop_display_name: 'Pepper', repeat_interval_days: 7, days_since_last_harvest: 16 }),
      cand({ plant_id: 'ba1', name: 'Holy Basil', crop_type_slug: 'basil', crop_display_name: 'Basil', harvest_habit: 'cut_and_come_again', repeat_interval_days: 12, days_since_last_harvest: 20 }),
      cand({ plant_id: 'ch1', name: 'Chives', crop_type_slug: 'chives', crop_display_name: 'Chives', harvest_habit: 'cut_and_come_again', repeat_interval_days: 14, days_since_last_harvest: 18 }),
      cand({ plant_id: 'd1', name: 'Bouquet Dill', crop_type_slug: 'dill', crop_display_name: 'Dill', harvest_habit: 'cut_and_come_again', repeat_interval_days: 12, days_since_last_harvest: 15 }),
    ])
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    expect(headlines(card)).toEqual(['Tomato', 'Pepper', 'Basil', 'Chives', 'Dill'])
    expect(headlines(card)).not.toContain('Blackberry')
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 more due for a pick' }))
    expect(headlines(card)).toContain('Blackberry')
  })

  it('the tail counts crops, and one tap still reveals every crop', async () => {
    payload(crowded())
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    // 86 ready plantings collapse to 6 crops: 5 visible, 1 folded — not "Show 81 more".
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 more due for a pick' }))
    expect(card.querySelectorAll('li').length).toBe(6)
    expect(headlines(card)[5]).toBe('Tarragon')
  })

  it('a row with no crop_type_slug stays its own row rather than collapsing', async () => {
    // Non-null by construction in the real payload; a malformed response must degrade to the
    // per-planting rows, never merge unrelated plantings under one arbitrary crop name.
    payload([
      cand({ plant_id: 'n1', name: 'No Slug One', crop_type_slug: undefined, days_since_last_harvest: 8 }),
      cand({ plant_id: 'n2', name: 'No Slug Two', crop_type_slug: undefined, days_since_last_harvest: 7 }),
    ])
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    expect(headlines(card)).toEqual(['No Slug One', 'No Slug Two'])
  })

  it('the row still navigates to a prefilled form — the crop’s most-overdue planting', async () => {
    payload(crowded())
    render(<HarvestReadyBand />)
    const card = await screen.findByRole('region', { name: /Due for a pick/i })
    await userEvent.click(card.querySelectorAll('li button')[0])
    expect(navigateMock.mock.calls[0][0]).toBe('/log?project=proj1&plant=pep0&event_type=harvest')
    const posts = fetchMock.mock.calls.filter(([, opts]) => opts?.method && opts.method !== 'GET')
    expect(posts).toHaveLength(0)
  })
})
