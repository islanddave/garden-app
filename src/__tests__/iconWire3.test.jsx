// iconWire3.test.jsx — V4-ICON-001, third wiring slice: pages/Favorites.jsx + pages/Locations.jsx.
//
// WHAT THIS FILE PINS, and why each arm is separate:
//
//   1. THE EMOJI ARE GONE FROM THE TWO WIRED PAGES. eslint.config.js does not scope
//      designsys/no-raw-design-tokens to either of them, and even where it applies it visits
//      JSXText and literal JSX attributes only — Favorites' glyphs lived in a plain `icon:` object
//      field and Locations' in a `label="…"` string built in the parent. Neither was reachable.
//
//   2. EVERY KEY RESOLVES. getIcon() returns NEUTRAL_ICON instead of throwing (§15), so a typo
//      renders a small grey dot and ships looking fine. The static scan matches BOTH quote styles:
//      the iconWire2 lane shipped a single-quote-only version that let a double-quoted JSX
//      attribute typo through, and every key on these two pages is a double-quoted attribute.
//
//   3. THE HAND-OFF IS TRACKED, NOT FORGOTTEN. Six files in this lane's set still hold emoji, each
//      for a stated reason (consumer outside the lane, or no glyph drawn yet). Pinning the exact
//      counts stops a NEW emoji drifting in while the hand-off is open, and makes routing one of
//      them trip a visible reminder to update this table rather than silently diverge.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { GLYPHS, NEUTRAL_ICON, getIcon } from '../lib/iconRegistry.js'

// cwd-relative, not import.meta.url: under vitest the module URL is an http: one and
// fileURLToPath rejects it. Same convention as iconWire2.test.jsx.
const src = (rel) => readFileSync(resolve(process.cwd(), 'src', rel), 'utf8')

const WIRED = ['pages/Favorites.jsx', 'pages/Locations.jsx']

const PICTOGRAPHIC = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}]/gu
const ESCAPED_PICTOGRAPHIC = /\\u\{1F[0-9A-Fa-f]{3}\}|\\u2[6-7][0-9A-Fa-f]{2}/g

// The lane's OPEN hand-offs, by exact remaining occurrence count. Every one is deliberate:
//   waterDepth / lifeStory / overwinterRegimes / inventoryEnums — data maps whose ONLY render
//     consumer (WaterDepthChips, LifeStoryTimeline, ChoiceGrid via OverwinterPrompt+InventoryAdd)
//     sits outside this lane's file set. Dropping the field without moving the consumer in the
//     same commit renders nothing at all, so the pair has to travel together.
//   inventoryEnums / NotifyButton — additionally BLOCKED ON A DRAW: the 133-key registry has no
//     consumable, durable, or bell mark, and a near-miss key is worse than the emoji.
//   harvestTracked — check/cross marks inside a COMMENT documenting a gating asymmetry. Prose in
//     a comment is not an icon slot; there is nothing here to route.
// Counts are by codepoint so this file itself contains no raw emoji.
const OPEN_HANDOFFS = {
  'lib/waterDepth.js': 6,
  'lib/lifeStory.js': 5,
  'lib/overwinterRegimes.js': 4,
  'lib/inventoryEnums.js': 2,
  'lib/harvestTracked.js': 3,
  'components/NotifyButton.jsx': 4,
}

describe('V4-ICON-001 slice 3 — the wired pages carry no pictographic characters', () => {
  it.each(WIRED)('%s has no emoji left', (rel) => {
    expect(src(rel).match(PICTOGRAPHIC) ?? []).toEqual([])
  })

  it.each(WIRED)('%s has no escaped emoji either', (rel) => {
    expect(src(rel).match(ESCAPED_PICTOGRAPHIC) ?? []).toEqual([])
  })

  it('the scanner actually matches emoji (this file is not passing on a dead regex)', () => {
    expect('\u{1F4A7}'.match(PICTOGRAPHIC)).toHaveLength(1)
    expect('\u2713'.match(PICTOGRAPHIC)).toHaveLength(1) // check mark, the U+2600-27BF arm
    expect("emoji: '\\u{1F440}'".match(ESCAPED_PICTOGRAPHIC)).toHaveLength(1)
    expect('plain text'.match(PICTOGRAPHIC)).toBeNull()
  })

  it('the old field shapes are gone by name, not just by character', () => {
    const fav = src('pages/Favorites.jsx')
    // TYPE_META carried `icon:` holding a literal; every row is `iconName:` now.
    expect(fav).not.toMatch(/\bicon:\s*['"]/)
    expect(fav).toContain("iconName: 'lifecycle.sprout'")
    expect(fav).toContain("iconName: 'facet.location'")
    // MenuBtn took a label string with the glyph baked into it; the glyph is a prop now.
    expect(src('pages/Locations.jsx')).toMatch(/<MenuBtn\s+iconName=/)
  })

  it.each(Object.entries(OPEN_HANDOFFS))(
    '%s still holds exactly its documented emoji count (tracked hand-off)',
    (rel, expected) => {
      const n = (src(rel).match(PICTOGRAPHIC) ?? []).length
      expect(n, `${rel}: routing this file is EXPECTED — when you do, update OPEN_HANDOFFS here`)
        .toBe(expected)
    },
  )
})

describe('V4-ICON-001 slice 3 — every registry key named in the wired pages resolves', () => {
  // Registry-key-shaped literals in BOTH quote styles. The double-quote arm is the load-bearing
  // one here: every key on these two pages is a JSX attribute (name="…", iconName="…").
  const KEY_RE = /['"]((?:action|care|event|facet|lifecycle|media|mode|nav|severity|status)\.[A-Za-z][A-Za-z0-9_]*)['"]/g
  const keysIn = (rel) => [...new Set([...src(rel).matchAll(KEY_RE)].map(m => m[1]))]

  it('the scan found keys at all (guards the whole describe from going vacuous)', () => {
    expect(WIRED.flatMap(keysIn).length).toBeGreaterThanOrEqual(10)
  })

  it('the scan sees a double-quoted attribute, not just single-quoted object fields', () => {
    // The exact hole that shipped in the first iconWire2 draft. Asserted on a literal sample so it
    // holds even if a future edit converts every attribute on these pages to single quotes.
    expect([...'<Icon name="facet.location" />'.matchAll(KEY_RE)].map(m => m[1]))
      .toEqual(['facet.location'])
    expect(keysIn('pages/Locations.jsx')).toContain('action.edit')
  })

  it.each(WIRED)('%s names only real registry entries', (rel) => {
    const missing = keysIn(rel).filter(k => getIcon(k) === NEUTRAL_ICON)
    expect(missing, `${rel} would render the silent neutral dot for these`).toEqual([])
  })

  it('the keys this slice introduced are present by name', () => {
    for (const k of ['lifecycle.sprout', 'facet.group', 'facet.location', 'nav.inventory',
      'action.heart', 'action.edit', 'nav.plus', 'status.dormant', 'status.active',
      'action.remove']) {
      expect(GLYPHS[k], `${k} missing from the registry`).toBeTruthy()
    }
  })
})

// ── Render harness ───────────────────────────────────────────────────────────────────────────
const { apiFetchSpy, dataRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  dataRef: { favorites: [], plants: [], locations: [], inventory: [] },
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }),
}))

import Favorites from '../pages/Favorites.jsx'
import Locations from '../pages/Locations.jsx'

// The registry authors self-closing markup; the DOM serializes open/close pairs. Round-tripping
// the registry string through the parser makes both sides comparable.
const parsed = (markup) => {
  const host = document.createElement('div')
  host.innerHTML = `<svg>${markup}</svg>`
  return host.firstChild.innerHTML
}
const isNeutral = (svg) =>
  svg.innerHTML === parsed(NEUTRAL_ICON.svg24) || svg.innerHTML === parsed(NEUTRAL_ICON.svg18)

// lifecycle.sprout is a color-candidate, so on the cream surface Icon rewrites each [data-region]
// currentColor to a resolved hex (V4-ICONCOLOR-001). Comparing raw markup would fail on that
// alone. These assertions are about SHAPE — which is the point, since colour is additive and never
// the sole channel — so normalize hue out of both sides rather than re-deriving the colorFills map
// here, which would just restate production logic back at itself.
const shape = (html) => html.replace(/(fill|stroke)="#[0-9a-fA-F]{3,8}"/g, '$1="currentColor"')

describe('V4-ICON-001 slice 3 — Favorites draws real glyphs', () => {
  beforeEach(() => {
    apiFetchSpy.mockReset()
    dataRef.favorites = [
      { entity_type: 'plant', entity_id: 'p1' },
      { entity_type: 'location', entity_id: 'l1' },
      { entity_type: 'inventory_item', entity_id: 'i1' },
    ]
    dataRef.plants = [{ id: 'p1', name: 'Basil' }]
    dataRef.locations = { locations: [{ id: 'l1', name: 'Stable' }] }
    dataRef.inventory = [{ id: 'i1', name: 'Trowel' }]
    apiFetchSpy.mockImplementation((path) => {
      if (path === '/api/favorites') return Promise.resolve(dataRef.favorites)
      if (path === '/api/plants') return Promise.resolve(dataRef.plants)
      if (path === '/api/locations') return Promise.resolve(dataRef.locations)
      if (path === '/api/inventory-items') return Promise.resolve(dataRef.inventory)
      if (path === '/api/projects') return Promise.resolve([])
      return Promise.resolve([])
    })
  })
  afterEach(cleanup)

  const renderFavorites = async () => {
    const view = render(<MemoryRouter><Favorites /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Favorites')).toBeTruthy())
    return view
  }

  it('each section heading draws its own authored shape, never the neutral dot', async () => {
    await renderFavorites()
    const headingSvg = (label) => screen.getByText(label).closest('h2').querySelector('svg')
    for (const label of ['Plantings', 'Locations', 'Inventory']) {
      expect(isNeutral(headingSvg(label)), `${label} fell back to the neutral dot`).toBe(false)
    }
    expect(shape(headingSvg('Plantings').innerHTML)).toBe(parsed(GLYPHS['lifecycle.sprout'].svg18))
    expect(shape(headingSvg('Locations').innerHTML)).toBe(parsed(GLYPHS['facet.location'].svg18))
    expect(shape(headingSvg('Inventory').innerHTML)).toBe(parsed(GLYPHS['nav.inventory'].svg18))
    // Three sections, three distinguishable marks — not one glyph reused down the page.
    const shapes = ['Plantings', 'Locations', 'Inventory'].map(l => shape(headingSvg(l).innerHTML))
    expect(new Set(shapes).size).toBe(3)
  })

  it('every section heading keeps its text label beside the glyph (never icon-alone)', async () => {
    await renderFavorites()
    for (const label of ['Plantings', 'Locations', 'Inventory']) {
      const h2 = screen.getByText(label).closest('h2')
      expect(h2.textContent.trim()).toBe(label)
      expect(h2.querySelectorAll('svg')).toHaveLength(1)
    }
  })

  it('the page title draws the FILLED heart, proving the variant is actually applied', async () => {
    await renderFavorites()
    const svg = screen.getByText('Favorites').closest('h1').querySelector('svg')
    expect(isNeutral(svg)).toBe(false)
    expect(svg.innerHTML).toBe(parsed(GLYPHS['action.heart'].variants.filled.svg18))
    // Without `variant`, Icon would draw the outline master — assert they really differ, or the
    // line above would pass on a base-shape render.
    expect(svg.innerHTML).not.toBe(parsed(GLYPHS['action.heart'].svg18))
  })

  it('renders no pictographic character anywhere', async () => {
    const { container } = await renderFavorites()
    expect(container.textContent.match(PICTOGRAPHIC)).toBeNull()
    // Non-vacuity: the page really did render its icons.
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(4)
  })

  it('the empty-state heart is the OUTLINE and is announced, not hidden', async () => {
    dataRef.favorites = []
    const { container } = render(<MemoryRouter><Favorites /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/No favorites yet/)).toBeTruthy())
    // It is a control reference inside a sentence, so it has to carry a name: action.heart's
    // accessibleName is the {outline, filled} object and Icon only auto-labels from a STRING,
    // so an explicit title is the only thing keeping this out of aria-hidden.
    const svg = screen.getByRole('img', { name: 'Add to favorites' })
    expect(isNeutral(svg)).toBe(false)
    expect(svg.innerHTML).toBe(parsed(GLYPHS['action.heart'].svg18))
    expect(container.textContent.match(PICTOGRAPHIC)).toBeNull()
  })
})

describe('V4-ICON-001 slice 3 — the Locations action menu draws real glyphs', () => {
  const LOC = {
    id: 'loc1', name: 'Stable', slug: 'stable', level: 0, type_label: null,
    parent_id: null, sort_order: 0, description: null, is_active: true,
  }
  const locRef = { current: [LOC] }

  beforeEach(() => {
    locRef.current = [LOC]
    apiFetchSpy.mockReset()
    apiFetchSpy.mockImplementation((path) => {
      if (path === '/api/locations') return Promise.resolve(locRef.current)
      if (path === '/api/locations/with-path') return Promise.resolve([])
      return Promise.resolve({})
    })
  })
  afterEach(cleanup)

  async function openMenu() {
    const view = render(<MemoryRouter><Locations /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Stable')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Actions'))
    return view
  }

  const rowSvg = (label) => screen.getByText(label).closest('button').querySelector('svg')

  it('all four rows draw an authored shape, and none is the neutral fallback', async () => {
    await openMenu()
    for (const label of ['Edit', 'Add child', 'Deactivate', 'Delete']) {
      const svg = rowSvg(label)
      expect(svg, `"${label}" renders no icon`).toBeTruthy()
      expect(isNeutral(svg), `"${label}" fell back to the neutral dot`).toBe(false)
    }
    expect(rowSvg('Edit').innerHTML).toBe(parsed(GLYPHS['action.edit'].svg18))
    expect(rowSvg('Add child').innerHTML).toBe(parsed(GLYPHS['nav.plus'].svg18))
    expect(rowSvg('Deactivate').innerHTML).toBe(parsed(GLYPHS['status.dormant'].svg18))
    expect(rowSvg('Delete').innerHTML).toBe(parsed(GLYPHS['action.remove'].svg18))
  })

  it('the four rows are four different marks', async () => {
    await openMenu()
    const shapes = ['Edit', 'Add child', 'Deactivate', 'Delete'].map(l => rowSvg(l).innerHTML)
    expect(new Set(shapes).size).toBe(4)
  })

  it('an inactive zone swaps the toggle glyph with its label, not just the label', async () => {
    locRef.current = [{ ...LOC, is_active: false }]
    await openMenu()
    expect(rowSvg('Activate').innerHTML).toBe(parsed(GLYPHS['status.active'].svg18))
    expect(rowSvg('Activate').innerHTML).not.toBe(parsed(GLYPHS['status.dormant'].svg18))
  })

  it('every row keeps its text label, so the menu never reads by glyph or hue alone', async () => {
    await openMenu()
    for (const label of ['Edit', 'Add child', 'Deactivate', 'Delete']) {
      // Also the selector contract LocationsToggleActive.test.jsx relies on: getByText must still
      // land on the button now that the glyph is a sibling element rather than part of the string.
      expect(screen.getByText(label).tagName).toBe('BUTTON')
    }
  })

  it('the open menu renders no pictographic character', async () => {
    await openMenu()
    const menu = screen.getByText('Edit').closest('div')
    expect(within(menu).getByText('Delete')).toBeTruthy()
    expect(menu.textContent.match(PICTOGRAPHIC)).toBeNull()
  })
})
