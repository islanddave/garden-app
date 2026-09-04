// V5-SEEDSTAGEONEPLACE-001 — /inventory/:id has NO seed_stage control, and must not grow one back.
//
// THIS FILE WAS AMENDED, NOT SUPPLEMENTED, and that is the whole point of it. Until 2026-09-04 it
// was a characterization test for a stage <select> on this page, and its final case was titled
// "does not append a history entry — corrections move the pointer, they do not rewrite it". That
// SPECIFIED the behaviour: this page moved inventory_items.seed_stage and wrote no
// seed_lot_stage_log row, deliberately, so that a correction could not stamp stage_entered_at with
// the moment the mistake was noticed. BUG-SEEDSTAGEHEADSHIP-001's design pass ruled that the defect
// could not be closed by adding a test — the authoritative surface had to be decided first, and
// then this file amended to match. It was decided (Dave, 2026-09-04): "only change stages on Saved
// seeds". So the specification below is the new one, and the old assertions about PUT bodies are
// gone with the writer that produced them.
//
// WHAT THE DECISION BOUGHT. seed_stage had three writers and only one of them appended to the log —
// the /seed-stage CTE logged, the wide PUT and the create INSERT did not — and the one this page
// used was a non-logging one. On all three live staged lots the pointer and the log disagreed, so
// the LATERAL that derives stage_entered_at matched nothing and /seeds/saved rendered no elapsed
// time on any of them. Removing the client's only non-logging stage writer is what makes "every
// change to a lot's stage is recorded, and dated to when it actually happened" true rather than
// aspirational.
//
// WHAT REPLACED THE CAPABILITY, because deleting it outright would have been worse than keeping it:
// seed_lot_stage_log has no DELETE route, so a mis-tapped stage with no repair anywhere would be
// permanent. /seeds/saved can now set ANY stage, not just the next one right, and dates the entry
// itself — the repair MOVED, it was not dropped. This page points at it (`seed-stage-change-link`)
// rather than silently losing a control the user had learned.
//
// ALSO RETIRED HERE: src/__tests__/InventoryDetail.storedCount.test.jsx, deleted in the same commit.
// It specified the count prompt that hung off this control's `stored` transition, which existed
// because this select was the WIDER path to `stored` — it could jump there from any stage,
// including on a lot that was never tracked. With the select gone, /seeds/saved is the only path to
// `stored` and its own count arm (SavedSeeds.storedCount.test.jsx) carries the guarantee alone.
//
// EVERY NEGATIVE HERE IS PAIRED WITH A POSITIVE. "The control is absent" is satisfied by a page that
// failed to render at all, and "no PUT was issued" is satisfied by a spy nothing ever called — so
// each case asserts something that must be PRESENT in the same breath.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, updateItemSpy, deleteItemSpy, itemRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  updateItemSpy: vi.fn(),
  deleteItemSpy: vi.fn(),
  itemRef: { current: null },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useParams: () => ({ id: 'inv-1' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span data-testid="photo-upload" /> }))
vi.mock('../components/forms/PlantingSelect.jsx', () => ({ default: () => <span data-testid="planting-select" /> }))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({ updateItem: updateItemSpy, deleteItem: deleteItemSpy }),
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// As GET /api/inventory-items/:id returns it: the raw columns, plus the three keys that route adds
// and that are NOT columns on the row. Kept whole — `metadata`, the derived hero and the germination
// summary included — because the assertions below are about what this page does NOT put on the
// wire, and a thin fixture would make several of them pass for the wrong reason.
const LOT = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: 1, unit: 'packet', reorder_threshold: null,
  reorder_quantity: null, notes: 'Saved from the 2026 melon', source: 'Self-saved',
  source_url: null, purchase_date: null, unit_cost: null, quantity_purchased: null,
  location_text: 'Seed tin', brand: null, model: null, tags: ['melon'],
  variety_id: 'v-melon', variety_name: 'Green Flesh', source_plant_id: 'pl-melon',
  seed_stage: 'drying', seed_process: 'wet', metadata: { sku: 'GF-2026' },
  featured_photo_id: 'ph-derived', featured_photo_view_url: 'https://example.invalid/x.jpg',
  featured_is_explicit: false, germination: { rate: null, seeds_sown: 0, seeds_germinated: 0, sowings: [] },
}

const ITEM_PATH = '/api/inventory-items/inv-1'
const HISTORY_PATH = '/api/inventory-items/inv-1/seed-stage'

// Every call this page made to the item's own path with a method on it — a PUT, a PATCH, anything
// that is not the load GET.
const itemWrites = () => fetchSpy.mock.calls.filter(([p, o]) => String(p) === ITEM_PATH && o?.method)
const stagePosts = () => fetchSpy.mock.calls.filter(
  ([p, o]) => String(p) === HISTORY_PATH && o?.method === 'POST')
const historyGets = () => fetchSpy.mock.calls.filter(
  ([p, o]) => String(p) === HISTORY_PATH && !o?.method)

beforeEach(() => {
  fetchSpy.mockReset(); updateItemSpy.mockReset(); deleteItemSpy.mockReset()
  itemRef.current = { ...LOT }
  updateItemSpy.mockResolvedValue({ item: { ...LOT } })
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (p === HISTORY_PATH) return Promise.resolve([])
    if (p === ITEM_PATH && !opts) return Promise.resolve(itemRef.current)
    return Promise.resolve([])
  })
})

const renderPage = async () => {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText(itemRef.current.name)).toBeTruthy())
}

describe('InventoryDetail — the seed_stage control is gone (V5-SEEDSTAGEONEPLACE-001)', () => {
  it('renders the seed-processing card and NO stage control in it', async () => {
    await renderPage()
    // The positive half, and it is what stops the three negatives below from passing on a page that
    // never rendered: the card itself is still here, because the history it holds is the reason the
    // card exists.
    expect(screen.getByTestId('seed-stage-panel')).toBeTruthy()
    expect(screen.getByTestId('seed-stage-history')).toBeTruthy()
    // The select, its status line, and the count prompt that hung off its `stored` transition.
    expect(screen.queryByTestId('seed-stage-select')).toBeNull()
    expect(screen.queryByTestId('seed-stage-help')).toBeNull()
    expect(screen.queryByTestId('seed-count-ask')).toBeNull()
  })

  it('names where the stage is changed instead, and links there', async () => {
    // Removing the control WITHOUT this is the version of the change that leaves a user who has
    // spotted a wrong stage with nothing to do about it. Asserted as the full href, not a substring:
    // '/seeds' and '/seeds/saved' are different pages and only one of them has the control.
    await renderPage()
    const link = screen.getByTestId('seed-stage-change-link')
    expect(link.getAttribute('href')).toBe('/seeds/saved')
    expect(link.textContent).toBe("Change this lot's stage on Saved seeds →")
  })

  it('issues NO stage write of either kind for a seeds lot', async () => {
    // THE AMENDED CHARACTERIZATION. The case this replaces asserted only that no POST /seed-stage
    // went out, because a PUT that moved the pointer off-log was the intended behaviour. Both halves
    // are now refusals: this page neither logs a stage nor moves the pointer, by any route.
    await renderPage()
    expect(itemWrites()).toEqual([])
    expect(stagePosts()).toEqual([])
    // The green control. The history GET IS issued on the same render, so a spy that recorded
    // nothing — the way both assertions above would pass vacuously — is ruled out by measurement
    // rather than by assumption.
    expect(historyGets()).toHaveLength(1)
  })

  it('saves the form through updateItem, carrying no seed column at all', async () => {
    // The buildChanges() separation, kept from the file this replaces and now load-bearing in the
    // other direction. The wide PUT reads seed_stage / seed_process by PRESENCE, so the edit form
    // must not so much as MENTION them: a key in the body is an assignment, and this form has no
    // idea what the lot's stage is. Omission is the only spelling of "leave it alone".
    await renderPage()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Green Flesh Honeydew (2026)' } })
    await act(async () => { fireEvent.click(screen.getByText('Save changes')) })
    await waitFor(() => expect(updateItemSpy).toHaveBeenCalled())

    const [, changes] = updateItemSpy.mock.calls[0]
    // Positive: the edit really did travel, so the three negatives below are about a body that
    // exists rather than about a save that never happened.
    expect(changes.name).toBe('Green Flesh Honeydew (2026)')
    expect(changes.category).toBe('seeds')
    expect(Object.prototype.hasOwnProperty.call(changes, 'seed_stage')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(changes, 'seed_process')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(changes, 'variety_id')).toBe(false)
    // …and it goes through useInventory, not through a direct fetch to the item path.
    expect(itemWrites()).toEqual([])
  })

  it('does NOT render the card for a non-seed item', async () => {
    // Gated exactly like the "Saved from" card and the Plant-from-packet CTA. A hori-hori has no
    // processing chain, and a card offering a link to Saved seeds on every tool in the shed implies
    // the concept applies there.
    itemRef.current = {
      ...LOT, name: 'Hori hori knife', category: 'tools', type: 'durable',
      variety_id: null, seed_stage: null, seed_process: null, quantity: 1,
    }
    await renderPage()
    expect(screen.getByText('Hori hori knife')).toBeTruthy()
    expect(screen.queryByTestId('seed-stage-panel')).toBeNull()
    expect(screen.queryByTestId('seed-stage-change-link')).toBeNull()
    // …and the history endpoint is not called at all for it.
    expect(historyGets()).toHaveLength(0)
  })
})
