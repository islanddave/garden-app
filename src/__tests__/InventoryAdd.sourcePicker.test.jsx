// V4-SOURCEREG-001 — the source registry on /inventory/add (wiring surface 2 of 3).
//
// THIS is the field that produced 73 spellings of 35 places: `inventory_items.source`, a free-text
// "Source (store / vendor)". It is not removed — 567 rows carry text with no other column in this
// design (order numbers, "(HOMESTEAD discount)", received-on dates) — it is RELABELLED to the
// order/lot reference it holds, and the vendor name moves to a controlled `source_id`.
//
// The assertions are on the SUBMITTED PAYLOAD, not on what rendered: a test that only checked the
// picker was on screen would pass while buildPayload silently dropped the id. The free text is
// asserted in the same payload, carrying its OWN different value, so "the picker replaced it" is a
// failing state rather than an invisible one.
//
// EVERY NEEDLE IS UNIQUE — 'Fedco', 'Greenfield' and 'Botanical' appear nowhere else in the tree,
// and rows resolve through `sp-opt-<id>` scoped to ONE picker's root, so each assertion names WHICH
// row of WHICH instance satisfied it. No jest-dom (L-182): plain DOM reads.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

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
// Stubbed for the reason InventoryAdd.seedDoor.test.jsx records: the real one drags useCachedFetch,
// the data cache and Clerk in and hangs the render. Not the unit under test here.
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

const SOURCES = [
  { id: 'src-botanical', name: 'Botanical Interests', kind: 'seed_company', locality: 'Broomfield, CO', address: null, website_url: null, notes: null },
  { id: 'src-fedco', name: 'Fedco Seeds', kind: 'seed_company', locality: 'Clinton, ME', address: null, website_url: null, notes: null },
  { id: 'src-coop', name: 'Greenfield Farmers Co-op', kind: 'garden_center', locality: 'Greenfield, MA', address: null, website_url: null, notes: null },
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

// Fill the required group as a durable (name + type + category + quantity), then open the
// "Add more details" pane where the provenance fields live.
async function renderAdd() {
  const utils = await act(async () => render(<ToastProvider><InventoryAdd /></ToastProvider>))
  await act(async () => { await Promise.resolve() })

  fireEvent.change(screen.getByPlaceholderText('e.g. Black Krim tomato seeds'), { target: { value: 'Hori hori knife' } })
  fireEvent.click(screen.getByRole('radio', { name: /Durable/i }))
  const category = document.querySelector('select')
  fireEvent.change(category, { target: { value: 'tools' } })
  fireEvent.change(screen.getByPlaceholderText('1'), { target: { value: '2' } })

  await act(async () => { fireEvent.click(screen.getByText('Add more details')) })
  await screen.findByTestId('inv-add-origin')
  return utils
}

async function openPicker(testid) {
  const input = screen.getByTestId(testid)
  const root = input.parentElement
  fireEvent.focus(input)
  await waitFor(() => expect(root.querySelector('[data-testid="sp-panel"]')).not.toBe(null))
  return { input, root, opt: (id) => root.querySelector(`[data-testid="sp-opt-${id}"]`) }
}

const submit = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add item' })) })
}

describe('/inventory/add — the three provenance fields', () => {
  it('renders the picker inline, and KEEPS the free text relabelled as the order/lot reference', async () => {
    await renderAdd()
    const origin = screen.getByTestId('inv-add-origin')
    expect(origin.getAttribute('role')).toBe('combobox')
    expect(origin.getAttribute('aria-label')).toBe('Origin')

    // The old label read "Source (store / vendor)" and invited the vendor name the picker now owns.
    const labels = Array.from(document.querySelectorAll('label')).map(l => l.textContent)
    expect(labels.some(t => t.includes('Source (store / vendor)'))).toBe(false)
    expect(labels.filter(t => t.includes('Order / lot reference')).length).toBe(1)

    const ref = screen.getByPlaceholderText('e.g. order no. 350019, item 233')
    expect(ref.tagName).toBe('INPUT')
    expect(ref.value).toBe('')
  })

  it('choosing an origin puts source_id in the SUBMITTED PAYLOAD, and the free text still submits its own value', async () => {
    await renderAdd()
    fireEvent.change(screen.getByPlaceholderText('e.g. order no. 350019, item 233'),
      { target: { value: 'order no. 350019 (HOMESTEAD discount)' } })

    const origin = await openPicker('inv-add-origin')
    fireEvent.click(origin.opt('src-fedco'))
    await screen.findByTestId('inv-add-origin-chip')

    await submit()
    expect(createItemSpy).toHaveBeenCalledTimes(1)
    const payload = createItemSpy.mock.calls[0][0]
    expect(payload.source_id).toBe('src-fedco')
    expect(payload.acquired_from_source_id).toBe(null)
    // Two separate facts in one payload: the controlled id AND the free text nobody can model.
    expect(payload.source).toBe('order no. 350019 (HOMESTEAD discount)')
  })

  it('choosing a venue too puts BOTH ids in the payload', async () => {
    await renderAdd()
    const origin = await openPicker('inv-add-origin')
    fireEvent.click(origin.opt('src-fedco'))
    await screen.findByTestId('inv-add-acquired-from')

    const acq = await openPicker('inv-add-acquired-from')
    fireEvent.click(acq.opt('src-coop'))
    await screen.findByTestId('inv-add-acquired-from-chip')

    await submit()
    const payload = createItemSpy.mock.calls[0][0]
    expect(payload.source_id).toBe('src-fedco')
    expect(payload.acquired_from_source_id).toBe('src-coop')
  })

  it('an untouched form still submits both keys as null — never absent', async () => {
    await renderAdd()
    await submit()
    const payload = createItemSpy.mock.calls[0][0]
    expect(Object.prototype.hasOwnProperty.call(payload, 'source_id')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(payload, 'acquired_from_source_id')).toBe(true)
    expect(payload.source_id).toBe(null)
    expect(payload.acquired_from_source_id).toBe(null)
  })
})

describe('/inventory/add — the venue picker appears only when it can change the answer', () => {
  it('is ABSENT before an origin is chosen and PRESENT after', async () => {
    await renderAdd()
    expect(screen.queryByTestId('inv-add-acquired-from')).toBe(null)

    const origin = await openPicker('inv-add-origin')
    fireEvent.click(origin.opt('src-botanical'))

    const acq = await screen.findByTestId('inv-add-acquired-from')
    expect(acq.getAttribute('aria-label')).toBe('Acquired from')
  })

  it('clearing the origin removes the venue AND its stored id — no orphan reaches the payload', async () => {
    await renderAdd()
    const origin = await openPicker('inv-add-origin')
    fireEvent.click(origin.opt('src-fedco'))
    await screen.findByTestId('inv-add-acquired-from')

    const acq = await openPicker('inv-add-acquired-from')
    fireEvent.click(acq.opt('src-coop'))
    await screen.findByTestId('inv-add-acquired-from-chip')

    fireEvent.click(screen.getByRole('button', { name: 'Clear origin' }))
    await waitFor(() => expect(screen.queryByTestId('inv-add-acquired-from')).toBe(null))

    await submit()
    const payload = createItemSpy.mock.calls[0][0]
    expect(payload.source_id).toBe(null)
    expect(payload.acquired_from_source_id).toBe(null)
  })
})

describe('/inventory/add — the guards around the new fields', () => {
  it('blocks the save when both name the SAME source (chk_inventory_source_distinct)', async () => {
    await renderAdd()
    const origin = await openPicker('inv-add-origin')
    fireEvent.click(origin.opt('src-coop'))
    await screen.findByTestId('inv-add-acquired-from')

    const acq = await openPicker('inv-add-acquired-from')
    fireEvent.click(acq.opt('src-coop'))
    await screen.findByTestId('inv-add-acquired-from-chip')

    await submit()
    expect(createItemSpy).not.toHaveBeenCalled()
    // Exactly ONE alert says it, and it sits inside the VENUE Field — not the page-level _form
    // banner, which is also role="alert" and would also satisfy a bare `.includes` search.
    const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
      .filter(n => n.textContent.includes('Same as the origin'))
    expect(alerts.length).toBe(1)
    const venueField = Array.from(document.querySelectorAll('label'))
      .find(l => l.textContent.includes('Acquired from')).parentElement
    expect(venueField.contains(alerts[0])).toBe(true)
    expect(venueField.contains(screen.getByTestId('inv-add-acquired-from-chip'))).toBe(true)
  })

  it('a blank form issues exactly ONE GET /api/varieties/sources', async () => {
    // `useSources` fetches on mount and `useApiFetch` is uncached, so each mounted SourcePicker
    // costs one request for the same 54-row list. Gating the venue picker on `source_id` is what
    // keeps the common case — a form nobody has touched — at one. The two-instance case (an edit
    // form for a row that already has an origin) still costs two; the only fix for THAT is inside
    // useSources.js, which this lane does not own. Reported, not silently absorbed.
    await renderAdd()
    const gets = fetchMock.mock.calls.filter(c => !c[1] && c[0] === '/api/varieties/sources')
    expect(gets.length).toBe(1)
  })

  it('a chosen source alone arms the dirty guard — it is not in TEXT_FIELDS and would be missed', async () => {
    // The reload gate is the observable end of hasUnsavedInput. Nothing is typed here: the ONLY
    // content on the form is the picked source, which is exactly the case a `.trim()` over
    // TEXT_FIELDS cannot see.
    const { setReloadBlocked } = await import('../lib/reloadGate.js')
    expect(typeof setReloadBlocked).toBe('function')

    await act(async () => render(<ToastProvider><InventoryAdd /></ToastProvider>))
    await act(async () => { await Promise.resolve() })
    await act(async () => { fireEvent.click(screen.getByText('Add more details')) })
    const { isReloadBlocked } = await import('../lib/reloadGate.js')
    expect(isReloadBlocked()).toBe(false)

    const origin = await openPicker('inv-add-origin')
    await act(async () => { fireEvent.click(origin.opt('src-botanical')) })
    expect(isReloadBlocked()).toBe(true)
  })
})
