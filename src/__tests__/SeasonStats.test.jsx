/**
 * src/__tests__/SeasonStats.test.jsx — the Season stats page against the v1 contract fixture.
 *
 * The page draws what the server sends: all eight cards from the fixture, in registry order; a
 * missing section is skipped (not an error); an unknown one is ignored; a cold failure is an error
 * card with Try again; a payload that is not a v1 envelope is an error, not a blank page.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useParams } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import SeasonStats from '../pages/SeasonStats.jsx'
import { STATS_SECTION_ORDER } from '../lib/stats-kit/registry.js'
import { currentGrowYear } from '../lib/growYear.js'
import { buildEnvelope, SECTION_IDS } from '../../lambda/harvests/season-stats-sections.js'

const fixture = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/season-stats.v1.json'), 'utf8'))
const draw = () => render(<MemoryRouter><SeasonStats /></MemoryRouter>)
const EditTarget = () => <p data-testid="edit-target">{useParams().id}</p>
const cardIds = () => screen.queryAllByTestId('stat-card').map(c => c.getAttribute('data-section'))

beforeEach(() => { fetchSpy.mockReset() })

describe('SeasonStats', () => {
  it('asks for the current grow-year from the season-stats route', async () => {
    fetchSpy.mockResolvedValue(fixture)
    draw()
    await screen.findAllByTestId('stat-card')
    expect(fetchSpy).toHaveBeenCalledWith(`/api/harvests/season-stats?season=${currentGrowYear(new Date())}`)
  })

  it('renders all 8 cards from the fixture, in page order, each with a verdict and a Limits line', async () => {
    fetchSpy.mockResolvedValue(fixture)
    draw()
    await screen.findAllByTestId('stat-card')
    expect(cardIds()).toEqual(STATS_SECTION_ORDER)
    expect(cardIds()).toHaveLength(8)
    for (const card of screen.getAllByTestId('stat-card')) {
      const c = within(card)
      expect(card.querySelector('h2').textContent.length).toBeGreaterThan(3)
      expect(c.getByTestId('stat-card-verdict').textContent.length).toBeGreaterThan(20)
      expect(c.getByTestId('stat-card-limits').textContent).toMatch(/^Limits /)
      expect(c.getByTestId('stat-card-numbers').tagName).toBe('DETAILS')
      expect(card.textContent).not.toMatch(/NaN|undefined/)
    }
    expect(screen.getByText('2026 season · Nov 1 to Oct 31')).toBeTruthy()
    expect(screen.getAllByTestId('seed-lot-card')).toHaveLength(fixture.sections.seed_lots.series.rows.length)
  })

  it('a missing section is skipped and an unknown one is ignored', async () => {
    const { heat_ladder, ...rest } = fixture.sections
    void heat_ladder
    fetchSpy.mockResolvedValue({ ...fixture, sections: { ...rest, frost_race: { section: 'frost_race', version: 1, meta: { limits: [] }, series: {} } } })
    draw()
    await screen.findAllByTestId('stat-card')
    expect(cardIds()).toEqual(STATS_SECTION_ORDER.filter(id => id !== 'heat_ladder'))
    expect(screen.queryByTestId('season-stats-list').textContent).not.toContain('frost_race')
  })

  it('shows the loading skeleton while the first fetch is out', () => {
    fetchSpy.mockReturnValue(new Promise(() => {}))
    draw()
    expect(screen.getByTestId('season-stats-loading').getAttribute('role')).toBe('status')
    expect(screen.queryAllByTestId('stat-card')).toHaveLength(0)
  })

  it('a failed load shows the error card, and Try again fetches again', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(fixture)
    draw()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load your season stats.')
    expect(screen.queryAllByTestId('stat-card')).toHaveLength(0)
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(cardIds()).toHaveLength(8))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('a payload that is not a v1 envelope is an error, not a blank page', async () => {
    fetchSpy.mockResolvedValue({ version: 2, sections: fixture.sections })
    draw()
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load your season stats.')
  })

  // The REAL server output for a season with no rows: all eight sections, every series empty.
  const emptySeason = (year) => buildEnvelope({ year, sections: SECTION_IDS, results: {}, generatedAt: '2026-11-02T12:00:00Z' })
  const BROKEN = [/\b0 days\b/, /start ,/, / , /, /0\.0 lb came from/, /0 pods · 0\.0 lb/, /NaN|undefined|null/]

  it('an empty season (real server shape) shows the empty state and none of the broken sentences', async () => {
    const cur = currentGrowYear(new Date())
    fetchSpy.mockImplementation((path) => Promise.resolve(emptySeason(Number(path.split('season=')[1]))))
    draw()
    expect(await screen.findByText('Nothing to show yet.')).toBeTruthy()
    expect(cardIds()).toEqual([])
    const text = screen.getByTestId('season-stats').textContent
    for (const re of BROKEN) expect(text).not.toMatch(re)
    // Looked back SEASON_FALLBACK_YEARS for a season with picks, found none, and shows the current one.
    const asked = fetchSpy.mock.calls.map(c => c[0])
    expect(asked).toEqual(expect.arrayContaining([0, 1, 2].map(b => `/api/harvests/season-stats?season=${cur - b}`)))
    expect(screen.getByText(`${cur} season · Nov 1 to Oct 31`)).toBeTruthy()
    expect(screen.queryByTestId('season-stats-earlier')).toBeNull()
  })

  it('no picks in the current season: the page shows the last season with picks and says so', async () => {
    const cur = currentGrowYear(new Date())
    const prev = { ...fixture, season: { year: cur - 1, start: `${cur - 2}-11-01`, end: `${cur - 1}-10-31` } }
    fetchSpy.mockImplementation((path) => Promise.resolve(path.endsWith(`season=${cur}`) ? emptySeason(cur) : prev))
    draw()
    await screen.findAllByTestId('stat-card')
    expect(cardIds()).toEqual(STATS_SECTION_ORDER)
    expect(screen.getByText(`${cur - 1} season · Nov 1 to Oct 31`)).toBeTruthy()
    expect(screen.getByTestId('season-stats-earlier').textContent)
      .toBe(`Nothing has been picked in the ${cur} season yet, so this shows ${cur - 1}, your last season with picks.`)
  })

  it('a section whose series is empty is skipped, the rest still draw', async () => {
    const empty = emptySeason(2026).sections
    fetchSpy.mockResolvedValue({ ...fixture, sections: { ...fixture.sections, heat_ladder: empty.heat_ladder, seed_lots: empty.seed_lots } })
    draw()
    await screen.findAllByTestId('stat-card')
    expect(cardIds()).toEqual(STATS_SECTION_ORDER.filter(id => id !== 'heat_ladder' && id !== 'seed_lots'))
  })

  // QA 2026-09-29: one card showed "Not recorded 70" and "No source recorded · 96 plantings" with nothing
  // saying they count different things. Each label now names its question.
  it('the two "not recorded" counts on the Sources card say what each one means', async () => {
    fetchSpy.mockResolvedValue(fixture)
    draw()
    const card = (await screen.findAllByTestId('stat-card')).find(c => c.getAttribute('data-section') === 'sources')
    const keyRow = within(card).getByText('How it started: not recorded').closest('li')
    expect(keyRow.textContent).toBe('How it started: not recorded70213')
    const sellerRow = within(within(card).getByTestId('source-report')).getByText('Seller not recorded').closest('li')
    expect(sellerRow.textContent).toContain('96 plantings')
    expect(card.textContent).not.toMatch(/No source recorded|(^|[^:] )Not recorded/)
  })

  // QA 2026-09-29: the only way to /sources/:id was a saved-seed card, so a source with no saved lot
  // (High Mowing) could never gain its Instagram. Every named row in the report now has "Edit".
  it('each named source row has an Edit link to /sources/:id; the seller-not-recorded row has none', async () => {
    fetchSpy.mockResolvedValue(fixture)
    render(
      <MemoryRouter initialEntries={['/season-stats']}>
        <Routes>
          <Route path="/season-stats" element={<SeasonStats />} />
          <Route path="/sources/:id" element={<EditTarget />} />
        </Routes>
      </MemoryRouter>,
    )
    const report = await screen.findByTestId('source-report')
    const rows = within(report).getAllByTestId('source-row')
    const named = fixture.sections.sources.series.cards.filter(c => c.source_id != null)
    const edits = within(report).getAllByTestId('source-row-edit')
    expect(edits).toHaveLength(rows.length - 1)
    for (const a of edits) {
      expect(a.textContent).toBe('Edit')
      expect(a.style.minHeight).toBe('44px')
      expect(a.style.minWidth).toBe('44px')
    }
    expect(within(rows[rows.length - 1]).queryByTestId('source-row-edit')).toBeNull()
    const hm = named.find(c => c.name === 'High Mowing Organic Seeds')
    fireEvent.click(within(report).getByRole('link', { name: 'Edit High Mowing Organic Seeds' }))
    expect((await screen.findByTestId('edit-target')).textContent).toBe(hm.source_id)
  })

  it('the source report folds sources under 2 lb behind "N more sources"', async () => {
    fetchSpy.mockResolvedValue(fixture)
    draw()
    const report = await screen.findByTestId('source-report')
    const shown = within(report).getAllByTestId('source-row').length
    const more = screen.getByTestId('source-more')
    expect(more.textContent).toMatch(/^\d+ more sources · /)
    expect(within(report).getByText('Seller not recorded')).toBeTruthy()
    expect(within(report).getByText('96 plantings · seed saved from 3')).toBeTruthy()
    fireEvent.click(more)
    expect(within(report).getAllByTestId('source-row').length).toBeGreaterThan(shown)
    expect(more.getAttribute('aria-expanded')).toBe('true')
  })
})
