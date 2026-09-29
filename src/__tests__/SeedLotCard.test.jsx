/**
 * SeedLotCard — a saved seed lot on Season stats. Only filled contact fields become chips, the card
 * carries no F1 / OP / "?" badge (Dave, round 2), and a lot with a source links to its edit screen.
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import SeedLotCard, { seedCountText } from '../components/stats/SeedLotCard.jsx'

const fixture = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/season-stats.v1.json'), 'utf8'))
const LOTS = fixture.sections.seed_lots.series.rows

const SRC = {
  id: 'src-1', name: 'Skawski Farms', kind: 'nursery', locality: 'Sunderland, MA', address: null,
  website_url: null, instagram_url: null, facebook_url: null, via: null,
}
const lot = (over = {}) => ({
  lot_id: 'lot-1', cultivar: 'Sugar Baby', crop_slug: 'watermelon', count: 175, count_estimated: false,
  stage: 'stored', saved_on: '2026-09-02',
  parent: { planting_id: 'p-1', name: 'Sugar Baby', lb: 13.2 },
  source: SRC, ...over,
})
const draw = (l) => render(<MemoryRouter><SeedLotCard lot={l} /></MemoryRouter>)
const chipKinds = (container) => [...container.querySelectorAll('[data-testid^="seed-lot-chip-"]')].map(a => a.getAttribute('data-testid').replace('seed-lot-chip-', ''))

describe('SeedLotCard', () => {
  it('reads cultivar, count, crop, saved date, stage, parent and origin', () => {
    const { container } = draw(lot())
    const card = within(container.querySelector('[data-testid="seed-lot-card"]'))
    expect(card.getByText('Sugar Baby', { selector: 'b' })).toBeTruthy()
    expect(card.getByTestId('seed-lot-count').textContent).toBe('175 seeds')
    expect(container.textContent).toContain('Watermelon · saved Sep 2 · stored')
    expect(container.textContent).toContain('From your Sugar Baby planting · 13.2 lb picked')
    expect(container.textContent).toContain('Originally: Skawski Farms · nursery · Sunderland, MA')
  })

  it('an estimated count carries ~; a lot with no count shows its stage', () => {
    expect(seedCountText({ count: 110, count_estimated: true })).toBe('~110 seeds')
    expect(seedCountText({ count: 1200, count_estimated: false })).toBe('1,200 seeds')
    expect(seedCountText({ count: null, stage: 'drying' })).toBe('Drying')
  })

  // KILLING MUTATION: render every chip whether filled or not (the round-2 mock's dashed chips). RESULT: RED.
  it('chips appear only for filled fields, in a fixed order', () => {
    const { container, unmount } = draw(lot())
    expect(chipKinds(container)).toEqual([])
    unmount()
    const r2 = draw(lot({ source: { ...SRC, website_url: 'https://www.skawskifarms.com' } }))
    expect(chipKinds(r2.container)).toEqual(['website'])
    expect(r2.container.querySelector('[data-testid="seed-lot-chip-website"]').getAttribute('href')).toBe('https://www.skawskifarms.com')
    r2.unmount()
    const r3 = draw(lot({ source: { ...SRC, website_url: 'https://a.example', instagram_url: 'https://www.instagram.com/skawski', facebook_url: 'https://www.facebook.com/skawski', address: '1 Main St, Sunderland MA' } }))
    expect(chipKinds(r3.container)).toEqual(['website', 'instagram', 'facebook', 'address'])
    for (const a of r3.container.querySelectorAll('[data-testid^="seed-lot-chip-"]')) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toContain('noopener')
    }
  })

  it('a blank or non-http field is not a chip', () => {
    const { container } = draw(lot({ source: { ...SRC, website_url: '   ', instagram_url: 'javascript:alert(1)', address: '  ' } }))
    expect(chipKinds(container)).toEqual([])
  })

  // KILLING MUTATION: add an F1/OP/? badge. RESULT: RED.
  it('no F1, OP or ? badge on any fixture lot', () => {
    for (const l of LOTS) {
      const { container, unmount } = draw(l)
      const text = container.textContent
      expect(text, l.cultivar).not.toMatch(/\bF1\b|\bOP\b|\?/)
      unmount()
    }
  })

  it('Edit source links to /sources/:id when a source exists, and not otherwise', () => {
    const { unmount } = draw(lot())
    const link = screen.getByTestId('seed-lot-edit-source')
    expect(link.getAttribute('href')).toBe('/sources/src-1')
    expect(link.textContent).toBe('Edit source')
    unmount()
    const r2 = draw(lot({ source: null }))
    expect(r2.container.querySelector('[data-testid="seed-lot-edit-source"]')).toBeNull()
    expect(r2.container.textContent).toContain('Source not recorded')
  })

  it('a lot with no parent planting reads "From <source>", with the via place', () => {
    const { container } = draw(lot({ parent: null, source: { ...SRC, via: 'Home Depot' } }))
    expect(container.textContent).not.toContain('From your')
    expect(container.textContent).toContain('From Skawski Farms · nursery · Sunderland, MA · via Home Depot')
  })

  it('every fixture lot renders its card', () => {
    for (const l of LOTS) {
      const { container, unmount } = draw(l)
      expect(container.querySelector('[data-testid="seed-lot-card"]'), l.lot_id).not.toBeNull()
      expect(container.textContent).not.toMatch(/undefined|null|NaN/)
      unmount()
    }
  })
})
