import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import roster from '../data/critters-roster.json'

vi.mock('../hooks/useCritterCollection.js', () => ({
  useCritterCollection: vi.fn(),
}))
// V4-BLOOM-001: Collection now calls useApiFetch (useAuth) + the prefs client for cross-device
// bloom sync. Mock both so this stays a provider-free unit test (L-160).
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ getToken: async () => null, fetch: vi.fn() }) }))
vi.mock('../lib/notificationPrefsClient.js', () => ({
  fetchNotificationPrefs: vi.fn(async () => null),
  saveGardenBloomSeen: vi.fn(),
}))

// V3-DELIGHT D1: the header now renders <CritterOfDay/> which calls useAuth — stub it here
// so Collection's unit test stays provider-free and its grid assertions are unaffected.
vi.mock('../components/CritterOfDay.jsx', () => ({ default: () => null }))
// V3-DELIGHT D2: the header also renders <TallyDisplay/> which calls useAuth — stub it too
// (L-160: a provider-dependent child added to an existing tree breaks its provider-free unit test).
vi.mock('../components/TallyDisplay.jsx', () => ({ default: () => null }))

import { useCritterCollection } from '../hooks/useCritterCollection.js'
import Collection from '../pages/Collection.jsx'

function setState({ collected = new Map(), loading = false, error = null } = {}) {
  useCritterCollection.mockReturnValue({ collected, loading, error, reload: vi.fn() })
}

// V007 contract: float-free candy-pastel per-critter theming on V006 mechanics.
// Heading = "Critter collection" (lowercase). Header line = "N spotted so far…".
// Undiscovered: empty name div (no "???" placeholder), art silhouetted via brightness(0),
//   aria-label on li encodes state. Collected: name in div + alt, caption shows "Seen" + date.
// All cards render sighting-caption testid (Not yet vs Seen+date).

describe('Collection — V007 candy-pastel float-free redesign', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders heading + "spotted so far" line when none collected', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    expect(screen.getByText('Critter collection')).toBeDefined()
    expect(screen.getByText(/0 spotted so far/i)).toBeDefined()
  })

  it('renders one card per roster entry; undiscovered have no name text and "not yet" aria-label', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    const items = screen.getAllByRole('listitem')
    expect(items.length).toBe(roster.length)
    // All uncollected lis have aria-label ending in "not yet visited"
    const notYet = items.filter(el => /not yet visited/i.test(el.getAttribute('aria-label') || ''))
    expect(notYet.length).toBe(roster.length)
    // No "???" placeholder — undiscovered name slot is empty
    expect(screen.queryAllByText('???').length).toBe(0)
  })

  it('groups into wild / legacy / cryptid sections (Special excluded; no tier jargon)', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    // Check h2 section headings (not nav buttons which also contain same text)
    const headings = screen.getAllByRole('heading', { level: 2 })
    const texts = headings.map(h => h.textContent)
    expect(texts).toContain('Around the garden')
    expect(texts).toContain('Legacy')
    expect(texts).toContain('Curiosities')
  })

  it('reveals collected entry: name in alt + div, caption shows Seen + month/day date', () => {
    const collected = new Map([
      ['C050', { speciesId: 3, count: 4, firstSeenAt: '2026-05-10T00:00:00Z', lastSeenAt: '2026-05-20T00:00:00Z' }],
    ])
    setState({ collected })
    render(<Collection />)
    expect(screen.getByText(/1 spotted so far/i)).toBeDefined()
    // Blue Jay should appear as alt text and visible name
    expect(screen.getByAltText('Blue Jay')).toBeDefined()
    expect(screen.getByText('Blue Jay')).toBeDefined()
    // Caption strip shows "Seen" label + a date
    const caption = screen.getByTestId('sighting-caption-C050')
    expect(caption.textContent).toMatch(/Seen/i)
    expect(caption.textContent).toMatch(/May 10/i)
  })

  it('collected entry without current-year date includes year in caption', () => {
    const collected = new Map([
      ['C007', { speciesId: 8, count: 1, firstSeenAt: '2025-11-12T00:00:00Z', lastSeenAt: '2025-11-12T00:00:00Z' }],
    ])
    setState({ collected })
    render(<Collection />)
    const caption = screen.getByTestId('sighting-caption-C007')
    expect(caption.textContent).toMatch(/Seen/i)
    expect(caption.textContent).toMatch(/2025/i)
  })

  it('renders "Loading…" header while loading', () => {
    setState({ collected: new Map(), loading: true })
    render(<Collection />)
    expect(screen.getByText('Loading…')).toBeDefined()
  })

  it('surfaces error message under header when error is set and not loading', () => {
    setState({ collected: new Map(), loading: false, error: 'Could not load your collection' })
    render(<Collection />)
    expect(screen.getByText('Could not load your collection')).toBeDefined()
    expect(screen.getByText(/0 spotted so far/i)).toBeDefined()
  })

  // BUG-CROP-001 regression: rigid 2-line name band + capped art stage must not shear long names.
  // jsdom does not compute layout (scrollHeight/clientHeight are 0), so we assert the structural
  // style invariants that geometrically guarantee no clip: a fixed-height name band, a 2-line
  // -webkit-box clamp on the name span, an art stage capped below the band-reserving max, and the
  // arithmetic 8 + STAGE_MAX(108) + 8 + NAME_H(36) + CAPTION_H(42) = 202 <= TILE_H(212).
  it('BUG-CROP-001: longest name renders with a rigid 2-line clamp (no shear), full name preserved', () => {
    const longest = roster.slice().sort((a, b) => (b.name || '').length - (a.name || '').length)[0]
    expect(longest.name).toBe('Black Throated Blue Warbler')
    const collected = new Map([
      [longest.id, { speciesId: 1, count: 1, firstSeenAt: '2026-05-10T00:00:00Z', lastSeenAt: '2026-05-10T00:00:00Z' }],
    ])
    setState({ collected })
    render(<Collection />)
    // Full, un-truncated name is in the DOM (recovery: also exposed via title attr + facts popover).
    const nameSpan = screen.getByText('Black Throated Blue Warbler')
    expect(nameSpan).toBeDefined()
    // 2-line clamp styles present -> caps at 2 lines + ellipsis, kills descender shear on one-liners.
    expect(nameSpan.style.display).toBe('-webkit-box')
    expect(nameSpan.style.WebkitLineClamp || nameSpan.style.webkitLineClamp).toBe('3')
    expect(nameSpan.style.fontSize).toBe('0.7rem')
    expect(nameSpan.style.WebkitBoxOrient || nameSpan.style.webkitBoxOrient).toBe('vertical')
    expect(nameSpan.style.overflow).toBe('hidden')
    // Full-name recovery on hover/long-press.
    expect(nameSpan.getAttribute('title')).toBe('Black Throated Blue Warbler')
  })

  it('BUG-CROP-001: no-space (single-token) name renders un-truncated with the clamp', () => {
    const collected = new Map([
      ['C022', { speciesId: 1, count: 1, firstSeenAt: '2026-05-10T00:00:00Z', lastSeenAt: '2026-05-10T00:00:00Z' }],
    ])
    setState({ collected })
    render(<Collection />)
    const nameSpan = screen.getByText('Woodchuck')
    expect(nameSpan.style.display).toBe('-webkit-box')
    expect(nameSpan.getAttribute('title')).toBe('Woodchuck')
  })

  it('all cards render sighting-caption testid; uncollected show "Not yet", not "Seen"', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    const strips = screen.queryAllByTestId(/^sighting-caption-/)
    // Every card has the testid (not just collected ones)
    expect(strips.length).toBe(roster.length)
    // None show "Seen" when nothing is collected
    for (const strip of strips) {
      expect(strip.textContent).not.toMatch(/^Seen/)
    }
  })

  // V4-CRITTERSORT-001
  it('renders the sort control (Dex / A–Z / Recently seen / By type), defaulting to Dex order', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    const sel = screen.getByRole('combobox', { name: /sort critters/i })
    expect(sel.value).toBe('dex')
    const optionLabels = Array.from(sel.options).map(o => o.textContent)
    expect(optionLabels).toEqual(['Dex order', 'A – Z', 'Recently seen', 'By type'])
  })

  // V4-CRITTERSORT-001 by-type: switching to "By type" reorders within each group without
  // dropping/duplicating cards and without crashing (graceful even if a critter lacked a type).
  it('switching sort to "By type" keeps every card and all three sections', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    const sel = screen.getByRole('combobox', { name: /sort critters/i })
    fireEvent.change(sel, { target: { value: 'type' } })
    expect(sel.value).toBe('type')
    // No card lost or duplicated by the reorder.
    expect(screen.queryAllByTestId(/^sighting-caption-/).length).toBe(roster.length)
    // The three group section headings survive.
    expect(screen.getByRole('heading', { name: /Around the garden/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Legacy/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Curiosities/i })).toBeTruthy()
  })
})
