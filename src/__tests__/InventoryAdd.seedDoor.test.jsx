// V4-SEEDNOPLANTING-001 — arriving at Add-item FROM the seed flow.
//
// THE GAP, reported by Dave hours after the create-a-lot flow shipped: "i don't see where to go
// right now to add seeds into this flow when not from a planting - is that just adding a seed item
// to inventory?" It was, and the path worked end to end — add a seeds item, track it on
// /seeds/saved, set "Or where did it come from?" on the lot. Nothing was broken. Nothing pointed at
// it either: "Track a saved-seed lot" only offers packets that already exist, and the empty state
// taught provenance rather than the first step.
//
// So /seeds/saved now links here with the two facts the general form would otherwise make him
// re-derive, plus a return leg. This file covers the receiving end: the params seed the form, an
// invalid one is ignored rather than trusted, and the return path cannot leave the origin.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const { navigateSpy, searchParamsRef, createItemSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
  createItemSpy: vi.fn(async () => ({ item: { id: 'inv-new' } })),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))
// VarietyPicker (rendered only on the seeds branch — which is exactly the branch under test) fetches
// /api/varieties on mount and reaches Clerk through useApiFetch. Without this the seeds cases fail
// on "useAuth can only be used within <ClerkProvider>", which would look like the param seeding not
// working when it is the auth layer, not the form.
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: vi.fn(async () => []), getToken: vi.fn(async () => 'tok') }),
  apiFetch: vi.fn(async () => []),
}))
// VarietyPicker is STUBBED, not exercised. It is rendered only on the seeds branch — which is the
// branch under test — and it drags useCachedFetch, the data cache and Clerk in behind it, which
// hangs the render at 20s. The unit here is InventoryAdd's param seeding; the picker's own behaviour
// is covered by its own tests. The stub carries a testid so the assertions key on a STRUCTURAL fact
// (the seeds-only field rendered) rather than on copy.
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

import InventoryAdd, { safeReturnTo } from '../pages/InventoryAdd.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const renderAdd = async (qs = '') => {
  searchParamsRef.current = new URLSearchParams(qs)
  const out = await act(async () => render(<ToastProvider><InventoryAdd /></ToastProvider>))
  await act(async () => { await Promise.resolve() })
  return out
}

beforeEach(() => {
  try { sessionStorage.clear() } catch { /* noop */ }
  navigateSpy.mockReset()
  createItemSpy.mockClear()
  searchParamsRef.current = new URLSearchParams()
})

describe('safeReturnTo — the return leg cannot leave the origin', () => {
  it('accepts an ordinary internal path', () => {
    expect(safeReturnTo('/seeds/saved')).toBe('/seeds/saved')
    expect(safeReturnTo('/inventory/abc')).toBe('/inventory/abc')
  })

  it('REFUSES a protocol-relative URL — the case a startsWith("/") check would admit', () => {
    // `//evil.example.com` begins with a slash and is resolved by browsers as another ORIGIN. This
    // is the whole reason the guard is a regex and not a prefix test.
    expect(safeReturnTo('//evil.example.com')).toBe('/inventory')
    expect(safeReturnTo('//evil.example.com/path')).toBe('/inventory')
  })

  it('refuses absolute URLs, backslash tricks, and anything not starting with a slash', () => {
    for (const bad of ['https://evil.example.com', 'http://x.test', '/\\evil.example.com',
                       'seeds/saved', '', null, undefined, 'javascript:alert(1)']) {
      expect(safeReturnTo(bad), String(bad)).toBe('/inventory')
    }
  })

  it('honours a caller-supplied fallback', () => {
    expect(safeReturnTo('//evil.example.com', '/seeds/saved')).toBe('/seeds/saved')
  })
})

describe('the seed door seeds the form', () => {
  it('arrives as a consumable in category seeds', async () => {
    await renderAdd('type=consumable&category=seeds&return=%2Fseeds%2Fsaved')
    // The variety FIELD is the discriminator: InventoryAdd renders it ONLY when form.category is
    // 'seeds' (it is the DB CHECK chk_inventory_seed_requires_variety made visible), so its presence
    // proves the category landed in form STATE rather than merely sitting in the URL.
    expect(screen.getByTestId('variety-picker-stub')).toBeTruthy()
  })

  it('ignores an invalid category rather than seeding it', async () => {
    // A URL is user-editable input. Seeding an out-of-enum value would fail at submit with a message
    // about a field the user never touched.
    await renderAdd('type=consumable&category=nonsense')
    expect(screen.queryByTestId('variety-picker-stub')).toBeNull()
    expect(document.body.textContent).not.toMatch(/nonsense/)
  })

  it('ignores an invalid type', async () => {
    await renderAdd('type=nonsense&category=seeds')
    // The two params are validated INDEPENDENTLY, which is the property under test: a bad type must
    // not take the good category down with it, and the bad value must not reach the page.
    expect(screen.getByTestId('variety-picker-stub')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/nonsense/)
  })

  it('no params at all still renders a blank form — the ordinary Add-item route', async () => {
    await renderAdd('')
    expect(screen.queryByTestId('variety-picker-stub')).toBeNull()
  })
})
