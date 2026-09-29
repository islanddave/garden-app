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
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import SeasonStats from '../pages/SeasonStats.jsx'
import { STATS_SECTION_ORDER } from '../lib/stats-kit/registry.js'
import { currentGrowYear } from '../lib/growYear.js'

const fixture = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/season-stats.v1.json'), 'utf8'))
const draw = () => render(<MemoryRouter><SeasonStats /></MemoryRouter>)
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

  it('an envelope with no drawable sections shows the empty state', async () => {
    fetchSpy.mockResolvedValue({ ...fixture, sections: {} })
    draw()
    expect(await screen.findByText('Nothing to show yet.')).toBeTruthy()
  })

  it('the source report folds sources under 2 lb behind "N more sources"', async () => {
    fetchSpy.mockResolvedValue(fixture)
    draw()
    const report = await screen.findByTestId('source-report')
    const shown = within(report).getAllByTestId('source-row').length
    const more = screen.getByTestId('source-more')
    expect(more.textContent).toMatch(/^\d+ more sources · /)
    expect(within(report).getByText('No source recorded')).toBeTruthy()
    expect(within(report).getByText('96 plantings · seed saved from 3')).toBeTruthy()
    fireEvent.click(more)
    expect(within(report).getAllByTestId('source-row').length).toBeGreaterThan(shown)
    expect(more.getAttribute('aria-expanded')).toBe('true')
  })
})
