// V5-SEEDSTAB-001 slice 3 (design §9) — "Sown from this packet" on the seed's detail page.
//
// GET /api/inventory-items/:id carries `sown_from` on a seed row: every live planting whose
// source_inventory_item_id is this packet, archived ones already filtered out by the route
// (Archive-Hiding Rule — lambda/inventory-items/sown-from.test.js holds the WHERE). This page renders
// one 44px link per planting, to /plantings/:id, next to Sow this and the germination record — and
// nothing at all when the list is empty, absent (an older Lambda) or the item is not a seed.
//
// Prod, 2026-09-23: 39 seed packets carry exactly one live planting each (29 unarchived: vegetative,
// harvesting, fruiting). The fixture's two plantings exercise the list form and the order the route
// sends (newest sowing first); the page never re-sorts.
//
// No jest-dom (L-182). jsdom has no layout, so the 44px floor is asserted as the style that makes it.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, within } from '@testing-library/react'

const { fetchSpy, itemRef } = vi.hoisted(() => ({ fetchSpy: vi.fn(), itemRef: { current: null } }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }), apiFetch: (...a) => fetchSpy(...a) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'inv-1' }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { T } from '../components/forms/formStyles.js'

const BASE = {
  id: 'inv-1', name: 'Gong Bao (Kung Pao) seeds', category: 'seeds', type: 'consumable',
  quantity_on_hand: 1, unit: 'packet', variety_id: 'v-gongbao', variety_name: 'Gong Bao (Kung Pao)',
  crop_slug: 'pepper', created_by: 'me', germination: { sowings: [], seeds_sown: 0, seeds_germinated: 0, rate: null },
}
const SOWN_FROM = [
  { id: 'pl-2', name: 'Gong Bao — back bed', sown_at: '2026-06-03', status: 'harvested' },
  { id: 'pl-1', name: 'Gong Bao — pot 4', sown_at: '2026-04-20T00:00:00.000Z', status: 'vegetative' },
]

beforeEach(() => {
  fetchSpy.mockReset()
  itemRef.current = { ...BASE }
  fetchSpy.mockImplementation((path) => {
    const p = String(path)
    if (p.startsWith('/api/inventory-items/inv-1')) return Promise.resolve(itemRef.current)
    return Promise.resolve([])
  })
})

const renderPage = async () => {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(itemRef.current.name))
}
const section = () => screen.queryByTestId('packet-sown-from')
const links = () => within(section()).getAllByTestId('sown-from-link')

describe('InventoryDetail — Sown from this packet (V5-SEEDSTAB-001 slice 3)', () => {
  it('links every planting the route sent, in its order, each to /plantings/:id', async () => {
    itemRef.current = { ...BASE, sown_from: SOWN_FROM }
    await renderPage()
    expect(section(), 'no "Sown from this packet" section').toBeTruthy()
    expect(section().textContent).toContain('Sown from this packet')
    expect(links().map((a) => a.getAttribute('href'))).toEqual(['/plantings/pl-2', '/plantings/pl-1'])
  })

  it('each link names the planting, when it was sown and where it stands — in the app\'s status words', async () => {
    itemRef.current = { ...BASE, sown_from: SOWN_FROM }
    await renderPage()
    const [first, second] = links()
    expect(first.textContent).toContain('Gong Bao — back bed')
    expect(first.textContent).toContain('Sown Jun 3, 2026')
    // 'harvested' is shown as the app says it everywhere else (PLANT_STATUS_MAP): "Harvesting".
    expect(first.textContent).toContain('Harvesting')
    // A date the driver serialised as a full timestamp reads as the same calendar date, not a day off.
    expect(second.textContent).toContain('Sown Apr 20, 2026')
    expect(second.textContent).toContain('Vegetative')
  })

  it('every link is a whole-row target on the 44px floor', async () => {
    itemRef.current = { ...BASE, sown_from: SOWN_FROM }
    await renderPage()
    for (const a of links()) {
      expect(a.style.minHeight).toBe(`${T.tapMinHeight}px`)
      expect(T.tapMinHeight).toBeGreaterThanOrEqual(44)
      expect(a.style.display).toBe('flex')
    }
  })

  it('an undated or status-less planting still links, and says only what it knows', async () => {
    itemRef.current = { ...BASE, sown_from: [{ id: 'pl-9', name: 'Gong Bao — tray', sown_at: null, status: null }] }
    await renderPage()
    const [a] = links()
    expect(a.getAttribute('href')).toBe('/plantings/pl-9')
    expect(a.textContent).toContain('Gong Bao — tray')
    expect(a.textContent).not.toMatch(/Sown|null|undefined/)
  })

  it('sits under the Sow this group and above the germination record — slice 2a\'s pieces unmoved', async () => {
    itemRef.current = {
      ...BASE, sown_from: SOWN_FROM,
      germination: {
        rate: 70, seeds_sown: 20, seeds_germinated: 14,
        sowings: [{ id: 'pl-2', name: 'Gong Bao — back bed', sown_at: '2026-06-03', seeds_sown: 20, seeds_germinated: 14 }],
      },
    }
    await renderPage()
    const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    const card = screen.getByTestId('packet-card')
    const sow = screen.getByTestId('sow-actions')
    const germ = screen.getByTestId('packet-germination')
    // Slice 2a's order is kept: the packet card, then the Sow this group directly after it.
    expect(card.nextElementSibling).toBe(sow)
    expect(follows(sow, section())).toBe(true)
    expect(follows(section(), germ)).toBe(true)
  })

  it('renders NOTHING — no heading, no scaffold — for an empty list, an older Lambda\'s missing key, or a non-seed', async () => {
    for (const current of [
      { ...BASE, sown_from: [] },
      { ...BASE },
      { ...BASE, sown_from: null },
      { ...BASE, category: 'tools', type: 'durable', quantity: 1, sown_from: SOWN_FROM },
    ]) {
      itemRef.current = current
      const { unmount } = await (async () => {
        let out
        await act(async () => { out = render(<ToastProvider><InventoryDetail /></ToastProvider>) })
        await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(current.name))
        return out
      })()
      expect(section(), JSON.stringify(Object.keys(current))).toBeNull()
      expect(screen.queryByText('Sown from this packet')).toBeNull()
      unmount()
    }
  })
})
