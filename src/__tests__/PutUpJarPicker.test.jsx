// V5-KBCLOSE-001 — the jar picker on the batch close-out.
//
// ⚠ THE TWO RULINGS THIS FILE GUARDS:
//   1. use_by_status / use_by_target are SUPPRESSED here. Each half ships elsewhere and was
//      adjudicated acceptable there; composed beside an outcome choice on one 390px surface the pair
//      becomes a shelf-stability endorsement, which the app does not make. The fixtures below carry
//      BOTH fields with warn-worthy values on purpose — a suppression test over rows that never had
//      the data would pass for the wrong reason.
//   2. Ineligible jars are DISABLED WITH THE REASON INLINE, never omitted. Absence is
//      unattributable: no shipped surface can relink a harvest-linked jar, so a cook who cannot find
//      their jar has to be told why rather than shown a shorter list.
//
// TEST-SHAPE RULES: full literals, and every absence assertion paired with a green control over the
// SAME query on the SAME render.
//
// CI LANE: `npm test` plus the blocking TZ=America/New_York re-run. `preserved_at` is a DATE column
// and is parsed as TEXT, never through `new Date(ymd)` — the TZ lane has a real assertion to bite on
// here (the "Aug 12" case below renders Aug 11 under any zone west of Greenwich if that rule breaks).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import JarPicker, { preservedOn, jarIdentity, flattenJars } from '../components/putup/JarPicker.jsx'

// projectRow's shape, including the two fields this surface refuses to render.
const jar = (over) => ({
  id: 'jar-1', user_id: 'user_dave', crop_type_slug: 'pepper', variety_id: null, plant_id: null,
  harvest_log_id: null, batch_id: null, preserved_at: '2026-08-12', preserved_at_approx: null,
  method: 'hot_sauce', method_other_text: null, quantity_value: '3', quantity_unit: 'pint',
  package_count: 3, storage_location_id: null, remaining_count: 3, consumed_at: null, notes: null,
  photo_id: null, source_kind: 'own_garden', source_label: null,
  // Present and warn-worthy in the DATA. The assertion is that the SURFACE drops them.
  use_by_target: '2026-11-12', use_by_status: 'use_soon',
  ...over,
})

const CLEAN = jar({ id: 'jar-clean' })
const HARVEST_LINKED = jar({ id: 'jar-harvest', harvest_log_id: 'hl-77', quantity_value: '2', quantity_unit: 'qt' })
const OTHER_BATCH = jar({ id: 'jar-other', batch_id: 'kb-other', quantity_value: '1', quantity_unit: 'qt' })
// The two-user pair: Jen's jar is in the household response and is linkable like any other.
const JEN_JAR = jar({ id: 'jar-jen', user_id: 'user_jen', quantity_value: '6', quantity_unit: 'cup' })

const payload = (records) => ({
  group_by: 'crop',
  groups: [{ group_key: 'pepper', label: 'Peppers', total_packages: 9, units: ['pint'], use_soon_count: 1, records }],
})

function renderPicker(records, extra = {}) {
  fetchMock.mockResolvedValue(payload(records))
  return render(
    <JarPicker batchId="kb-mine" selected={new Set()} onToggle={vi.fn()} {...extra} />,
  )
}

beforeEach(() => { fetchMock.mockReset() })

describe('JarPicker — the wire', () => {
  it('reads whats-put-up once, grouped by crop, and nothing else', async () => {
    renderPicker([CLEAN])
    await screen.findByTestId('jar-picker-list')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/preservation/whats-put-up?group=crop')
  })

  it('shows a loading line first, then the rows', async () => {
    let resolve
    fetchMock.mockReturnValue(new Promise(r => { resolve = r }))
    render(<JarPicker batchId="kb-mine" selected={new Set()} onToggle={vi.fn()} />)
    expect(screen.getByTestId('jar-picker-loading').textContent).toBe('Looking up your put-ups…')
    resolve(payload([CLEAN]))
    await screen.findByTestId('jar-picker-list')
    expect(screen.queryByTestId('jar-picker-loading')).toBeNull()
  })

  it('surfaces a load failure with a retry that re-issues the same request', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    render(<JarPicker batchId="kb-mine" selected={new Set()} onToggle={vi.fn()} />)
    const alert = await screen.findByTestId('jar-picker-error')
    expect(alert.textContent).toBe('Couldn’t load your put-ups. Try again')
    fetchMock.mockResolvedValueOnce(payload([CLEAN]))
    fireEvent.click(screen.getByTestId('jar-picker-retry'))
    await screen.findByTestId('jar-picker-list')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('says so plainly when there is nothing to link', async () => {
    renderPicker([])
    await screen.findByTestId('jar-picker-empty')
    expect(screen.getByTestId('jar-picker-empty').textContent)
      .toBe('Nothing logged in your put-ups yet — you can link jars to this batch later.')
    expect(screen.queryByTestId('jar-picker-list')).toBeNull()
  })
})

describe('JarPicker — identity only, and the use-by chip is not part of identity', () => {
  it('renders crop, amount and the date it was put up, as one full literal', async () => {
    renderPicker([CLEAN])
    await screen.findByTestId('jar-picker-list')
    expect(screen.getByTestId('jar-picker-identity').textContent).toBe('Peppers · 3 pint · Aug 12')
  })

  it('renders none of "Use soon" / "Past use-by" / "use by", over rows that carry both fields', async () => {
    renderPicker([CLEAN, HARVEST_LINKED, OTHER_BATCH, JEN_JAR])
    await screen.findByTestId('jar-picker-list')
    const html = screen.getByTestId('jar-picker').innerHTML
    expect(html).not.toMatch(/Use soon|Past use-by|use by/i)
    expect(html).not.toContain('2026-11-12')
    expect(html).not.toContain('use_soon')
    // GREEN CONTROLS over the same render. (a) the fixtures really do carry the suppressed data, so
    // the arms above are a suppression and not an accident of the fixture; (b) other fields from the
    // very same rows DO reach the DOM, so the surface is rendering rows at all.
    expect(CLEAN.use_by_status).toBe('use_soon')
    expect(CLEAN.use_by_target).toBe('2026-11-12')
    expect(html).toContain('Peppers · 3 pint · Aug 12')
  })

  it('parses the put-up date as TEXT, so the two CI zones agree by construction', () => {
    expect(preservedOn('2026-08-12')).toBe('Aug 12')
    expect(preservedOn('2026-01-01')).toBe('Jan 1')
    expect(preservedOn('2026-12-31')).toBe('Dec 31')
    expect(preservedOn(null)).toBeNull()
    expect(preservedOn('not a date')).toBeNull()
    expect(preservedOn('2026-13-01')).toBeNull()
  })

  it('drops a segment it has no value for rather than rendering a blank or a zero', () => {
    expect(jarIdentity({ crop_label: 'Peppers', quantity_value: null, quantity_unit: 'pint', preserved_at: null }))
      .toBe('Peppers')
    expect(jarIdentity({ crop_label: null, quantity_value: '2', quantity_unit: 'qt', preserved_at: '2026-08-12' }))
      .toBe('2 qt · Aug 12')
  })

  it('reads a shape it does not recognise as an empty list, never a crash', () => {
    expect(flattenJars(null)).toEqual([])
    expect(flattenJars({ groups: 'nope' })).toEqual([])
    expect(flattenJars({ groups: [{ label: 'Peppers', records: null }] })).toEqual([])
    expect(flattenJars({ groups: [{ label: 'Peppers', records: [{ no_id: true }] }] })).toEqual([])
    // Green control: the real shape does produce rows, and the group label is stamped onto each.
    expect(flattenJars(payload([CLEAN]))).toEqual([{ ...CLEAN, crop_label: 'Peppers' }])
  })
})

describe('JarPicker — ineligible jars are offered and disabled, never omitted', () => {
  it('renders every jar, disables the two that cannot take a batch link, and states why', async () => {
    renderPicker([CLEAN, HARVEST_LINKED, OTHER_BATCH])
    await screen.findByTestId('jar-picker-list')
    expect(screen.getAllByTestId('jar-picker-row')).toHaveLength(3)

    expect(screen.getByTestId('jar-picker-toggle-jar-clean').disabled).toBe(false)
    expect(screen.getByTestId('jar-picker-toggle-jar-harvest').disabled).toBe(true)
    expect(screen.getByTestId('jar-picker-toggle-jar-other').disabled).toBe(true)

    const reasons = screen.getAllByTestId('jar-picker-reason').map(n => n.textContent)
    expect(reasons).toEqual(['already linked to one harvest', 'already linked to another batch'])
    // The enabled row carries NO reason line — and the green control is the two above, on the same
    // render, proving the query finds reasons when there are any.
    const cleanRow = screen.getByTestId('jar-picker-toggle-jar-clean').closest('li')
    expect(within(cleanRow).queryByTestId('jar-picker-reason')).toBeNull()
  })

  it('names this batch when the jar is already ours', async () => {
    renderPicker([jar({ id: 'jar-mine', batch_id: 'kb-mine' })])
    await screen.findByTestId('jar-picker-list')
    expect(screen.getByTestId('jar-picker-reason').textContent).toBe('already linked to this batch')
  })

  it('lets the caller override the reason resolver', async () => {
    renderPicker([HARVEST_LINKED], { disabledReasonFor: () => 'nope' })
    await screen.findByTestId('jar-picker-list')
    expect(screen.getByTestId('jar-picker-reason').textContent).toBe('nope')
  })
})

describe('JarPicker — selection is derived from the RESOLVED rows', () => {
  it('toggles a linkable jar and hands back its id and its row', async () => {
    const onToggle = vi.fn()
    renderPicker([CLEAN], { onToggle })
    await screen.findByTestId('jar-picker-list')
    fireEvent.click(screen.getByTestId('jar-picker-toggle-jar-clean'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle.mock.calls[0][0]).toBe('jar-clean')
    expect(onToggle.mock.calls[0][1].id).toBe('jar-clean')
  })

  it('shows the chosen state on the row the caller says is chosen', async () => {
    renderPicker([CLEAN, JEN_JAR], { selected: new Set(['jar-jen']) })
    await screen.findByTestId('jar-picker-list')
    expect(screen.getByTestId('jar-picker-toggle-jar-jen').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('jar-picker-toggle-jar-clean').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('jar-picker-count').textContent).toBe('1 put-up chosen')
  })

  it('counts RESOLVED rows, not the id Set — BUG-PHOTOSELSTALE-001', async () => {
    // Two ids in the Set, only one of which the server actually returned. `selected.size` would say
    // 2; the button posts what the rows resolve to, so the line must say 1.
    renderPicker([CLEAN], { selected: new Set(['jar-clean', 'jar-that-was-deleted']) })
    await screen.findByTestId('jar-picker-list')
    expect(screen.getByTestId('jar-picker-count').textContent).toBe('1 put-up chosen')
  })

  it('reads zero when none of the held ids resolve', async () => {
    renderPicker([CLEAN], { selected: new Set(['jar-that-was-deleted']) })
    await screen.findByTestId('jar-picker-list')
    expect(screen.getByTestId('jar-picker-count').textContent).toBe('0 put-ups chosen')
  })
})

describe('JarPicker — the rulings the shipped sweeps would not see here', () => {
  it('says nothing about acidification, safety, shelf stability or readiness', async () => {
    renderPicker([CLEAN, HARVEST_LINKED, OTHER_BATCH, JEN_JAR])
    await waitFor(() => expect(screen.getByTestId('jar-picker-list')).toBeTruthy())
    const html = screen.getByTestId('jar-picker').innerHTML
    expect(html).not.toMatch(/acidif|shelf.stab|\bsafe\b|\bsafety\b|botul/i)
    expect(html).not.toMatch(/\bdue\b|\bremaining\b|\boverdue\b|\bready\b|\bdays left\b|\blate\b/i)
    expect(html).not.toMatch(/role="progressbar"/)
    // GREEN CONTROL: the surface really did render its rows, so the four arms above swept something.
    expect(html).toContain('Peppers · 3 pint · Aug 12')
  })

  it('never puts a raw provenance value in the DOM as a machine token', async () => {
    renderPicker([HARVEST_LINKED, OTHER_BATCH])
    await screen.findByTestId('jar-picker-list')
    const html = screen.getByTestId('jar-picker').innerHTML
    expect(html).not.toContain('hl-77')
    expect(html).not.toContain('kb-other')
    // Green control: the row ids ARE in the DOM (they key the toggles), so the arms above are about
    // the provenance columns and not about the picker rendering nothing.
    expect(html).toContain('jar-harvest')
  })
})
