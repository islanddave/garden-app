// V4-SEEDGERMRATE-001 (BD-057) — the packet's germination panel.
//
// WHY THE PACKET IS THE UNIT. Dave: "packets of the same variety differ by age, vendor, and lot,
// which is the whole reason a per-packet number is worth having." So the rate belongs here and not
// on the variety or the crop type, and this panel is the surface the whole feature exists to fill.
//
// WHY THE HISTORY IS NOT DECORATION. Dave's Q2 answer was "combine them, keep the history". The
// combined number alone hides the thing worth knowing: 80% in March and 45% in July from one packet
// is a packet going over, and a single averaged 62% says nothing. The per-sowing rows are asserted
// for that reason, not for completeness.
//
// The counts-beside-the-percentage assertion is the same argument at a smaller scale: 7-of-10 and
// 70-of-100 are the same percentage and not the same evidence, and the decision this panel informs
// — re-sow from this packet or bin it — turns on which one it is.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'

const { fetchSpy, itemRef } = vi.hoisted(() => ({ fetchSpy: vi.fn(), itemRef: { current: null } }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }), apiFetch: (...a) => fetchSpy(...a) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'inv-1' }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const BASE = {
  id: 'inv-1', name: "Johnny's Genovese Basil", category: 'seeds', type: 'consumable',
  quantity_on_hand: 3, unit: 'packet', created_by: 'me',
}

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
  await waitFor(() => expect(screen.getByText(BASE.name)).toBeTruthy())
}

describe('InventoryDetail — packet germination (V4-SEEDGERMRATE-001)', () => {
  it('shows the combined rate with the raw counts beside it', async () => {
    itemRef.current = { ...BASE, germination: {
      rate: 70, seeds_sown: 20, seeds_germinated: 14,
      sowings: [{ id: 'p1', name: 'Basil flat A', sown_at: '2026-03-02', seeds_sown: 20, seeds_germinated: 14 }],
    } }
    await renderPage()
    expect(screen.getByTestId('packet-germ-rate').textContent).toContain('70%')
    // The counts, not just the percentage — see the header note.
    expect(screen.getByTestId('packet-germination').textContent).toContain('14 of 20 seeds')
  })

  it('lists every sowing with its own rate once there is more than one', async () => {
    itemRef.current = { ...BASE, germination: {
      rate: 62.5, seeds_sown: 40, seeds_germinated: 25,
      sowings: [
        { id: 'p1', name: 'Basil March', sown_at: '2026-03-02', seeds_sown: 20, seeds_germinated: 16 },
        { id: 'p2', name: 'Basil July',  sown_at: '2026-07-14', seeds_sown: 20, seeds_germinated: 9 },
      ],
    } }
    await renderPage()
    const panel = screen.getByTestId('packet-germination').textContent
    expect(panel).toContain('2 sowings')
    // 80% then 45% — the decline the combined 62.5% hides, which is the reason the rows exist.
    expect(panel).toContain('80%')
    expect(panel).toContain('45%')
    expect(panel).toContain('Basil March')
    expect(panel).toContain('Basil July')
  })

  it('does NOT list a single sowing separately — it would just repeat the headline', async () => {
    itemRef.current = { ...BASE, germination: {
      rate: 70, seeds_sown: 20, seeds_germinated: 14,
      sowings: [{ id: 'p1', name: 'Basil flat A', sown_at: '2026-03-02', seeds_sown: 20, seeds_germinated: 14 }],
    } }
    await renderPage()
    expect(screen.getByTestId('packet-germination').textContent).not.toContain('Basil flat A')
  })

  it('renders nothing at all for a packet nobody has counted from', async () => {
    // Not an empty scaffold and NOT 0% — an unused packet is un-measured, not a total failure, and
    // 0% on every packet in the drawer would make the number meaningless where it IS real.
    itemRef.current = { ...BASE, germination: { rate: null, seeds_sown: 0, seeds_germinated: 0, sowings: [] } }
    await renderPage()
    expect(screen.queryByTestId('packet-germination')).toBeNull()
  })

  it('renders nothing when the API sends no germination block at all', async () => {
    // A non-seed item, or an older Lambda: the page must not throw on a missing key.
    itemRef.current = { ...BASE, category: 'tools', germination: null }
    await renderPage()
    expect(screen.queryByTestId('packet-germination')).toBeNull()
  })
})
