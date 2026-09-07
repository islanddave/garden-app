// V5-SRCDISCLOSE-001 — "Add more details" starts OPEN when the category is seeds.
//
// THE GAP: `source_id` — the controlled vendor picker — lives inside a pane that was collapsed by
// default, so seed packets were being entered with no vendor recorded. Vendor provenance is exactly
// the fact that tells a genuine second packet apart from a duplicate row, which is a live
// data-cleanup problem in this garden.
//
// WHAT "VISIBLE" MEANS HERE, and why these assertions are honest ones. The pane is NOT a native
// <details> and is not CSS-hidden: InventoryAdd renders `{showFull && <div>…</div>}`, so a collapsed
// pane has no nodes in the document at all and DOM presence IS visibility. That equivalence is not
// assumed, it is PINNED by the control case below ('a non-seed category stays collapsed'): if the
// pane were ever refactored to render-always-and-hide — <details>, `hidden`, display:none — the
// picker would be found while collapsed and that test would fail rather than this file going quietly
// vacuous. `offsetParent` is deliberately never consulted; a collapsed <details> still reports as
// laid out, so it proves nothing.
//
// The other half of the feature is that the pane stays the USER'S once it is open, so most of what
// follows is about the auto-open NOT firing: after a hand collapse, no keystroke, re-render, category
// round trip, or draft restore is allowed to spring it back open. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const { navigateSpy, searchParamsRef, createItemSpy, fetchMock } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
  createItemSpy: vi.fn(async () => ({ item: { id: 'inv-new' } })),
  fetchMock: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn(async () => 'tok') }),
  apiFetch: (...args) => fetchMock(...args),
}))
// Stubbed for the reason InventoryAdd.seedDoor.test.jsx records: the real picker drags useCachedFetch,
// the data cache and Clerk in behind it and hangs the render. It doubles here as the discriminator
// for "category is 'seeds' in form STATE" — InventoryAdd renders it on that branch only.
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: () => <div data-testid="variety-picker-stub" />,
}))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({
    items: [], loading: false, error: null, lowStockCount: 0,
    createItem: createItemSpy, updateItem: vi.fn(), adjustQuantity: vi.fn(),
    deleteItem: vi.fn(), reload: vi.fn(), toast: null, dismissToast: vi.fn(),
  }),
}))

import InventoryAdd from '../pages/InventoryAdd.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { writeDraft } from '../lib/draftStash.js'

// Mirrors the module-private DRAFT_KEY in InventoryAdd.jsx. A typo here would leave the draft
// unread, so every draft case below first asserts the restore actually landed.
const DRAFT_KEY = 'inventoryadd'

const SOURCES = [
  { id: 'src-fedco', name: 'Fedco Seeds', kind: 'seed_company', locality: 'Clinton, ME', address: null, website_url: null, notes: null },
]

beforeEach(() => {
  try { sessionStorage.clear() } catch { /* noop */ }
  navigateSpy.mockReset()
  createItemSpy.mockClear()
  searchParamsRef.current = new URLSearchParams()
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) => {
    if (path === '/api/varieties/sources') return Promise.resolve(SOURCES)
    if (path === '/api/varieties/source-kinds') return Promise.resolve([])
    return Promise.resolve([])
  })
})

const renderAdd = async (qs = '') => {
  searchParamsRef.current = new URLSearchParams(qs)
  const out = await act(async () => render(<ToastProvider><InventoryAdd /></ToastProvider>))
  await act(async () => { await Promise.resolve() })
  return out
}

// The pane's own toggle, as the user taps it.
const toggle = async () => {
  await act(async () => { fireEvent.click(screen.getByText('Add more details')) })
}

const paneOpen = () => screen.queryByTestId('inv-add-origin') !== null

// Fill the required group as a consumable and land on a category. Category is disabled until a type
// is chosen, so the type click is not optional scaffolding.
const pickConsumableCategory = async (value) => {
  fireEvent.click(screen.getByRole('radio', { name: /Consumable/i }))
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Category'), { target: { value } })
  })
}

describe('V5-SRCDISCLOSE-001 — the vendor picker is on screen for seeds without being asked for', () => {
  it('opens the pane at mount when the seed door seeds the category', async () => {
    await renderAdd('type=consumable&category=seeds')
    // Two facts, not one: the category reached form STATE (the seeds-only variety field rendered),
    // and the provenance control inside the pane is a real combobox rather than a bare node.
    expect(screen.getByTestId('variety-picker-stub')).toBeTruthy()
    const origin = screen.getByTestId('inv-add-origin')
    expect(origin.getAttribute('role')).toBe('combobox')
    expect(origin.getAttribute('aria-label')).toBe('Origin')
  })

  it('opens the pane when seeds is picked mid-entry, after mount', async () => {
    await renderAdd('')
    expect(paneOpen()).toBe(false)
    await pickConsumableCategory('seeds')
    expect(paneOpen()).toBe(true)
  })

  it('a non-seed category stays collapsed — the control that keeps this file non-vacuous', async () => {
    // Also the tripwire for a render-always-and-hide refactor: if the pane stopped being conditional,
    // the picker would be findable here and this fails.
    await renderAdd('')
    await pickConsumableCategory('fertilizer')
    expect(paneOpen()).toBe(false)
    expect(screen.queryByTestId('variety-picker-stub')).toBeNull()
  })
})

describe('V5-SRCDISCLOSE-001 — opening by default does not take the pane away from the user', () => {
  it('a hand collapse survives later keystrokes, and the toggle still re-opens', async () => {
    await renderAdd('type=consumable&category=seeds')
    expect(paneOpen()).toBe(true)

    await toggle()
    expect(paneOpen()).toBe(false)

    // A keystroke re-renders the whole form. An auto-open written as an unlatched effect on `form`
    // would spring the pane open here, mid-word.
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('e.g. Black Krim tomato seeds'),
        { target: { value: 'Black Krim' } })
    })
    expect(paneOpen()).toBe(false)

    // Control is not one-way: he can still get it back.
    await toggle()
    expect(paneOpen()).toBe(true)
  })

  it('a hand collapse survives a seeds → other → seeds round trip (the latch is per mount)', async () => {
    await renderAdd('')
    await pickConsumableCategory('seeds')
    expect(paneOpen()).toBe(true)

    await toggle()
    expect(paneOpen()).toBe(false)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'fertilizer' } })
    })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'seeds' } })
    })
    // Back in seeds, and still shut: the auto-open is spent for this mount, so returning to the
    // category cannot overrule the collapse he just performed.
    expect(screen.getByTestId('variety-picker-stub')).toBeTruthy()
    expect(paneOpen()).toBe(false)
  })

  it('switching away from seeds never auto-CLOSES the pane', async () => {
    // Closing it would hide fields he may already have filled — the same failure the draft restore
    // guards against. The rule is open-only, in both directions.
    await renderAdd('type=consumable&category=seeds')
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'fertilizer' } })
    })
    expect(screen.queryByTestId('variety-picker-stub')).toBeNull()
    expect(paneOpen()).toBe(true)
  })
})

describe('V5-SRCDISCLOSE-001 — the draft restore still behaves (V4-DIRTYGUARDSWEEP-001)', () => {
  it('still re-opens the pane for a restored NON-seed draft that was left open', async () => {
    // The pre-existing guarantee, pinned on a category the new auto-open cannot reach: a draft whose
    // only content sits inside the pane must not come back invisible.
    writeDraft(DRAFT_KEY, { form: { type: 'durable', category: 'tools', location_text: 'Stable rack' }, showFull: true })
    await renderAdd('')
    // Proves the restore ran at all — otherwise the assertion below would pass for the wrong reason.
    expect(screen.getByPlaceholderText('e.g. Stable rack, shelf 2').value).toBe('Stable rack')
    expect(paneOpen()).toBe(true)
  })

  it('does not spring open a restored seeds draft the user had collapsed by hand', async () => {
    // Being interrupted and coming back is not a new decision about the pane. `showFull: false` on a
    // draft already in seeds can only be a hand collapse, because the auto-open would otherwise have
    // opened it — so the latch is spent during the restore.
    writeDraft(DRAFT_KEY, { form: { type: 'consumable', category: 'seeds', name: 'Black Krim' }, showFull: false })
    await renderAdd('')
    expect(screen.getByPlaceholderText('e.g. Black Krim tomato seeds').value).toBe('Black Krim')
    expect(screen.getByTestId('variety-picker-stub')).toBeTruthy()  // the draft's category landed
    expect(paneOpen()).toBe(false)
  })

  it('opens for a restored seeds draft that had never been collapsed', async () => {
    writeDraft(DRAFT_KEY, { form: { type: 'consumable', category: 'seeds', name: 'Black Krim' }, showFull: true })
    await renderAdd('')
    expect(screen.getByTestId('variety-picker-stub')).toBeTruthy()
    expect(paneOpen()).toBe(true)
  })
})
