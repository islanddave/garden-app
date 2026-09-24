// V5-SEEDSTAB-001 slice 3 (design §2 rule 8, §5.4) — a Saved seeds card for a lot saved off an F1
// plant says "F2 — won’t come true".
//
// WHY BOTH DATA PATHS. Saved seeds renders the same rows two ways: embedded in the Seeds page, where
// the shell's useSeedItems() store hands them in, and standalone, where the page fetches its own. The
// label reads `breeding_system` off the row, so it is only as good as the path that delivered the row.
// Both paths are the same GET — `/api/inventory-items?category=seeds`, whose two list statements
// project `pv.breeding_system` (lambda/inventory-items/cultivar-columns.test.js pins that) — and this
// file mounts each one with the same row and asserts the card says F2 on both.
//
// Prod, 2026-09-23: four saved lots have an F1 parent — Big Boy and Thai Dragon drying, Gong Bao
// (Kung Pao) and Ristra Cayenne II stored. The stored shape is the fixture: no ferment badge, the
// least on the card.
//
// No jest-dom (L-182). Content only: jsdom has no layout, and whether the chip fits the card at 360 px
// is gate:seeds-page's question, not this file's.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, within } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useNavigate: () => () => {},
}))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { F2_LABEL } from '../components/seed/seedLots.js'
import { SEED_ITEMS_PATH } from '../hooks/useSeedItems.js'
import { P } from '../lib/constants.js'

const LOT = {
  id: 'inv-gongbao', name: 'Gong Bao (Kung Pao) — saved 2026', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: '1.000', unit: 'packet', notes: null, source: null, purchase_date: null,
  seed_count: 85, seed_weight_g: null, seed_count_estimated: true,
  variety_id: 'v-gongbao', source_plant_id: 'pl-gongbao', source_kind: null,
  seed_stage: 'stored', seed_process: null, featured_photo_id: null,
  variety_name: 'Gong Bao (Kung Pao)', stage_entered_at: '2026-09-10T12:00:00Z', crop_slug: 'pepper',
  breeding_system: 'f1', updated_at: '2026-09-10T12:00:00Z',
}
const OP_LOT = {
  ...LOT, id: 'inv-brandy', name: 'Brandywine — saved 2026', variety_id: 'v-brandy', variety_name: 'Brandywine',
  crop_slug: 'tomato', breeding_system: 'open_pollinated',
}

let inventoryGets
beforeEach(() => {
  fetchSpy.mockReset()
  inventoryGets = []
})

const serve = (items) => fetchSpy.mockImplementation((path, opts) => {
  const p = String(path)
  if (opts?.method) return Promise.resolve({ ok: true })
  if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([])
  if (p.startsWith('/api/inventory-items')) { inventoryGets.push(p); return Promise.resolve(items) }
  return Promise.resolve([])
})

const mountStandalone = async (items) => {
  serve(items)
  await act(async () => { render(<ToastProvider><SavedSeeds /></ToastProvider>) })
  await waitFor(() => expect(screen.getAllByTestId('seed-lot-card').length).toBe(items.length))
}
const mountEmbedded = async (items) => {
  serve([])
  const store = { items, error: null, reload: vi.fn(), patch: vi.fn() }
  await act(async () => { render(<ToastProvider><SavedSeeds embedded store={store} /></ToastProvider>) })
  await waitFor(() => expect(screen.getAllByTestId('seed-lot-card').length).toBe(items.length))
}
const cardFor = (id) => screen.getAllByTestId('seed-lot-card').find((c) => c.getAttribute('data-lot-id') === id)
const f2Of = (id) => within(cardFor(id)).queryByTestId('lot-f2')

describe('Saved seeds — a lot saved off an F1 plant says it is F2 (V5-SEEDSTAB-001 slice 3)', () => {
  it('STANDALONE: the page\'s own fetch is the seed list GET, and the F1-parent card says F2; the OP card does not', async () => {
    await mountStandalone([LOT, OP_LOT])
    // The self-fetch path is the same GET the shell's store makes — the one that projects breeding_system.
    expect(inventoryGets).toEqual([SEED_ITEMS_PATH])
    const badge = f2Of(LOT.id)
    expect(badge, 'the F1-parent lot shows no F2 label').toBeTruthy()
    expect(badge.textContent).toBe(F2_LABEL)
    expect(f2Of(OP_LOT.id)).toBeNull()
  })

  it('EMBEDDED: the shell\'s store rows carry the same answer, and the page issues no fetch of its own', async () => {
    await mountEmbedded([LOT, OP_LOT])
    expect(inventoryGets).toEqual([])
    expect(f2Of(LOT.id)?.textContent).toBe(F2_LABEL)
    expect(f2Of(OP_LOT.id)).toBeNull()
  })

  it('a fact, not an alarm: the neutral chip in the card\'s text column, never a warning tone', async () => {
    await mountStandalone([LOT])
    const badge = f2Of(LOT.id)
    // Badge paints its tone and exposes nothing else of it: neutral is the cream chip, warn the gold one.
    const paint = (c) => { const s = document.createElement('span'); s.style.backgroundColor = c; return s.style.backgroundColor }
    expect(badge.style.backgroundColor).toBe(paint(P.cream))
    expect(badge.style.backgroundColor).not.toBe(paint(P.warn))
    expect(badge.textContent).not.toMatch(/mistake|wrong/i)
    // In the text column with the stage line and the count — not beside the advance button.
    expect(badge.parentElement.parentElement).toBe(cardFor(LOT.id).firstElementChild)
  })

  it('only F1 speaks: a NULL, "unknown" or landrace parent card carries nothing', async () => {
    const rows = [null, 'unknown', 'landrace'].map((b, n) => ({ ...OP_LOT, id: `inv-${n}`, breeding_system: b }))
    await mountStandalone(rows)
    for (const r of rows) expect(f2Of(r.id), String(r.breeding_system)).toBeNull()
  })
})
