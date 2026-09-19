// V5-SEEDSTAB-001 — the add form in SEED MODE (form.category === 'seeds'): what it calls itself and
// how it leaves.
//
// Seed left the Inventory list for its own Seeds page, so a seed packet saved here can no longer go
// "back to Inventory" — the list it would land on no longer shows it. Four behaviours follow, and
// each has a wrong version that looks fine on screen:
//   • THE LEAVE RULE. Back (navigate(-1)) when the page underneath IS where the form is going —
//     window.history.state.usr.seedsReturn, the state a Seeds door attaches when it pushes this form,
//     equals the effective target; otherwise a REPLACE to that target. A push instead would leave the
//     form in the stack behind the page it returned to, so N packets added from My seeds and then one
//     Back walks through N copies of the form and the page.
//   • IMMEDIATE. The old 2.5 s toast window before the navigate only bought a double-tap duplicate.
//     The non-seed timer is unchanged and still pinned by InventoryAdd.navTimer.test.jsx.
//   • THE NOTE. navigate(-1) carries nothing back, so the created id rides in sessionStorage
//     ('seeds.justAdded.v1') for the Seeds page to outline once.
//   • DONE. The submit stays disabled after a successful save, in every category.
// Cancel in seed mode follows the same leave rule; every other category keeps its /inventory link.
// Harness shape follows InventoryAdd.seedDoor.test.jsx (same router, api and hook doubles, same
// reasons). No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const { navigateSpy, searchParamsRef, createItemSpy, apiFetchMock } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
  createItemSpy: vi.fn(),
  apiFetchMock: vi.fn(async () => []),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))
// HOISTED fetch, for the reason InventoryAdd.seedDoor.test.jsx gives: seed mode opens "Add more
// details" on mount, which mounts SourcePicker -> useSources, whose effect keys on the fetch's
// identity. A fresh function per render re-fires it forever.
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchMock, getToken: vi.fn(async () => 'tok') }),
  apiFetch: (...args) => apiFetchMock(...args),
}))
// Stubbed for seedDoor's reason (it drags the data cache and Clerk in behind it), but with a way to
// PICK one: a seeds row cannot be saved without a variety (chk_inventory_seed_requires_variety,
// enforced in validate()), so a stub that cannot answer would leave every save below refused.
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ onChange }) => (
    <button type="button" data-testid="variety-pick" onClick={() => onChange({ id: 'v-krim', name: 'Black Krim' })}>
      pick variety
    </button>
  ),
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
import { addPacketHref, seedsReturnState, peekSeedAdded } from '../lib/seedsRoutes.js'

const MINE = '/seeds?view=mine'
const SAVED = '/seeds?view=saved'
const NOTE_KEY = 'seeds.justAdded.v1'

// The query string a Seeds door actually builds, so the `return` under test is spelled (and encoded)
// exactly as the app spells it rather than by hand here.
const doorQuery = (returnTo) => addPacketHref(returnTo).split('?')[1]
// Seed mode with NO return leg — a hand-typed or older link.
const BARE_SEEDS = 'type=consumable&category=seeds'

// The history entry as BrowserRouter leaves it after a Seeds door pushed this form with
// state={seedsReturnState(url)}: location.state lives under `usr`.
const arriveFrom = (seedsUrl) => window.history.replaceState({ usr: seedsReturnState(seedsUrl), key: 'k1', idx: 1 }, '')

const renderAdd = async (qs = '') => {
  searchParamsRef.current = new URLSearchParams(qs)
  const out = await act(async () => render(<ToastProvider><InventoryAdd /></ToastProvider>))
  await act(async () => { await Promise.resolve() })
  return out
}

const h1 = () => screen.getByRole('heading', { level: 1 })
const submitBtn = (name) => screen.getByRole('button', { name })
const seedCancel = () => screen.getByTestId('inventory-add-cancel')

function fillSeedPacket() {
  fireEvent.change(screen.getByLabelText("What's the item?"), { target: { value: 'Black Krim tomato seeds' } })
  fireEvent.click(screen.getByTestId('variety-pick'))
  fireEvent.change(screen.getByLabelText('Qty on hand'), { target: { value: '1' } })
  fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'packet' } })
}

async function saveSeedPacket() {
  fillSeedPacket()
  await act(async () => { fireEvent.click(submitBtn('Add seeds')) })
}

// Same minimal durable path as InventoryAdd.navTimer.test.jsx.
async function saveDurable() {
  fireEvent.change(screen.getByLabelText("What's the item?"), { target: { value: 'Hori hori' } })
  fireEvent.click(screen.getByText('Durable'))
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'tools' } })
  fireEvent.change(screen.getByLabelText('Quantity (how many?)'), { target: { value: '1' } })
  await act(async () => { fireEvent.click(submitBtn('Add item')) })
}

beforeEach(() => {
  try { sessionStorage.clear() } catch { /* noop */ }
  navigateSpy.mockReset()
  createItemSpy.mockReset().mockResolvedValue({ item: { id: 'inv-new' } })
  searchParamsRef.current = new URLSearchParams()
  window.history.replaceState(null, '')
})

afterEach(() => {
  vi.useRealTimers()
  window.history.replaceState(null, '')
})

describe('seed mode names itself — heading, breadcrumb, submit', () => {
  it('reads "Add seeds", and its breadcrumb goes to Seeds › My seeds', async () => {
    await renderAdd(doorQuery())
    expect(h1().textContent).toBe('Add seeds')
    const crumb = screen.getByRole('link', { name: 'Seeds' })
    expect(crumb.getAttribute('href')).toBe(MINE)
    expect(crumb.parentElement.textContent).toBe('Seeds › Add seeds')
    // The Inventory list no longer shows seed, so a crumb back to it would be a dead end.
    expect(screen.queryByRole('link', { name: 'Inventory' })).toBeNull()
    expect(submitBtn('Add seeds').getAttribute('type')).toBe('submit')
    expect(screen.queryByRole('button', { name: 'Add item' })).toBeNull()
  })

  it('every other category keeps "Add item" and the Inventory breadcrumb', async () => {
    await renderAdd('')
    expect(h1().textContent).toBe('Add item')
    const crumb = screen.getByRole('link', { name: 'Inventory' })
    expect(crumb.getAttribute('href')).toBe('/inventory')
    expect(crumb.parentElement.textContent).toBe('Inventory › Add item')
    expect(screen.queryByRole('link', { name: 'Seeds' })).toBeNull()
    expect(submitBtn('Add item')).toBeTruthy()
  })

  it('the CATEGORY decides, not the door: picking Seeds in the select flips it, and picking away flips it back', async () => {
    await renderAdd('type=consumable')
    expect(h1().textContent).toBe('Add item')
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'seeds' } })
    expect(h1().textContent).toBe('Add seeds')
    expect(screen.getByRole('link', { name: 'Seeds' }).getAttribute('href')).toBe(MINE)
    expect(screen.getByTestId('inventory-add-cancel')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'fertilizer' } })
    expect(h1().textContent).toBe('Add item')
    expect(screen.getByRole('link', { name: 'Inventory' }).getAttribute('href')).toBe('/inventory')
    expect(screen.queryByTestId('inventory-add-cancel')).toBeNull()
  })
})

describe('a saved seed packet leaves at once, by the leave rule', () => {
  it('pushed by the Seeds view it returns to: goes BACK, exactly once', async () => {
    arriveFrom(MINE)
    await renderAdd(doorQuery(MINE))
    await saveSeedPacket()
    expect(createItemSpy).toHaveBeenCalledTimes(1)
    expect(createItemSpy.mock.calls[0][0].category).toBe('seeds')
    expect(navigateSpy.mock.calls).toEqual([[-1]])
  })

  it('the page underneath is a DIFFERENT Seeds view than the target: replaces to the target', async () => {
    // Back would land on My seeds when the door asked to come home to Saved seeds.
    arriveFrom(MINE)
    await renderAdd(doorQuery(SAVED))
    await saveSeedPacket()
    expect(navigateSpy.mock.calls).toEqual([[SAVED, { replace: true }]])
  })

  it('not pushed by a Seeds door (a bookmark, a reload that dropped state): replaces to the return target', async () => {
    // Nothing to go Back TO — navigate(-1) here would leave the app or land somewhere unrelated.
    await renderAdd(doorQuery(SAVED))
    await saveSeedPacket()
    expect(navigateSpy.mock.calls).toEqual([[SAVED, { replace: true }]])
  })

  it('no return param and no Seeds entry underneath: replaces to My seeds, not to /inventory', async () => {
    await renderAdd(BARE_SEEDS)
    await saveSeedPacket()
    expect(navigateSpy.mock.calls).toEqual([[MINE, { replace: true }]])
  })

  it('no return param but My seeds IS underneath: goes Back — the rule compares against where the form is GOING', async () => {
    // The effective target without a `return` is My seeds, and that is the page underneath, so a
    // replace would stack a second copy of it. Pinned because a comparison against the raw `return`
    // param instead of the effective target reads the same in review and differs exactly here.
    arriveFrom(MINE)
    await renderAdd(BARE_SEEDS)
    await saveSeedPacket()
    expect(navigateSpy.mock.calls).toEqual([[-1]])
  })

  it('a hostile return param lands on My seeds — never off-origin, and never on the Inventory list', async () => {
    await renderAdd(`${BARE_SEEDS}&return=${encodeURIComponent('//evil.example.com')}`)
    await saveSeedPacket()
    expect(navigateSpy.mock.calls).toEqual([[MINE, { replace: true }]])
  })

  it('navigates immediately — no toast window, and no second navigate after it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    arriveFrom(MINE)
    await renderAdd(doorQuery(MINE))
    await saveSeedPacket()
    // Before any time has passed: the old seed path waited 2.5 s here.
    expect(navigateSpy).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(5000) })
    // And nothing else fires later — the non-seed timer must not ALSO run for a seed save.
    expect(navigateSpy.mock.calls).toEqual([[-1]])
  })

  it('notes the created id for the Seeds page to outline', async () => {
    arriveFrom(MINE)
    await renderAdd(doorQuery(MINE))
    expect(sessionStorage.getItem(NOTE_KEY)).toBeNull()
    await saveSeedPacket()
    expect(sessionStorage.getItem(NOTE_KEY)).toBe('inv-new')
    expect(peekSeedAdded()).toBe('inv-new')
  })

  it('a non-seed save leaves no note — the outline is a Seeds-page affordance', async () => {
    await renderAdd('')
    await saveDurable()
    expect(createItemSpy).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(NOTE_KEY)).toBeNull()
  })

  it('a FAILED seed save stays put: no navigate, no note, and the submit stays live for the retry', async () => {
    createItemSpy.mockResolvedValue({ error: 'Server said no' })
    arriveFrom(MINE)
    await renderAdd(doorQuery(MINE))
    await saveSeedPacket()
    expect(createItemSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toContain('Server said no')
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(NOTE_KEY)).toBeNull()
    expect(submitBtn('Add seeds').disabled).toBe(false)
  })
})

describe('the submit stays disabled once a save has landed — every category', () => {
  it('seed mode: live before the save, disabled after it', async () => {
    await renderAdd(doorQuery())
    fillSeedPacket()
    expect(submitBtn('Add seeds').disabled).toBe(false)
    await act(async () => { fireEvent.click(submitBtn('Add seeds')) })
    expect(createItemSpy).toHaveBeenCalledTimes(1)
    expect(submitBtn('Add seeds').disabled).toBe(true)
  })

  it('a non-seed save: disabled through the toast window, before its navigate', async () => {
    // The window where the old form let a second tap create a duplicate row.
    await renderAdd('')
    expect(submitBtn('Add item').disabled).toBe(false)
    await saveDurable()
    expect(createItemSpy).toHaveBeenCalledTimes(1)
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(submitBtn('Add item').disabled).toBe(true)
  })
})

describe('Cancel in seed mode follows the leave rule', () => {
  it('is a real button that does not submit, not the /inventory link', async () => {
    await renderAdd(doorQuery())
    const c = seedCancel()
    expect(c.tagName).toBe('BUTTON')
    expect(c.getAttribute('type')).toBe('button')
    expect(c.textContent).toBe('Cancel')
    expect(screen.queryByRole('link', { name: 'Cancel' })).toBeNull()
  })

  it('pushed by the Seeds view it returns to: goes Back', async () => {
    arriveFrom(MINE)
    await renderAdd(doorQuery(MINE))
    await act(async () => { fireEvent.click(seedCancel()) })
    expect(navigateSpy.mock.calls).toEqual([[-1]])
  })

  it('otherwise: replaces to the return target', async () => {
    await renderAdd(doorQuery(SAVED))
    await act(async () => { fireEvent.click(seedCancel()) })
    expect(navigateSpy.mock.calls).toEqual([[SAVED, { replace: true }]])
  })

  it('no return and nothing underneath: replaces to My seeds', async () => {
    await renderAdd(BARE_SEEDS)
    await act(async () => { fireEvent.click(seedCancel()) })
    expect(navigateSpy.mock.calls).toEqual([[MINE, { replace: true }]])
  })

  it('on a FILLED form it creates nothing and notes nothing', async () => {
    // The form is valid, so a Cancel that also submitted would save the packet the user abandoned.
    arriveFrom(MINE)
    await renderAdd(doorQuery(MINE))
    fillSeedPacket()
    await act(async () => { fireEvent.click(seedCancel()) })
    expect(navigateSpy.mock.calls).toEqual([[-1]])
    expect(createItemSpy).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(NOTE_KEY)).toBeNull()
  })
})

describe('every other category keeps its Cancel link', () => {
  it('Cancel is the /inventory link, and there is no seed-mode button', async () => {
    await renderAdd('')
    const c = screen.getByRole('link', { name: 'Cancel' })
    expect(c.getAttribute('href')).toBe('/inventory')
    expect(screen.queryByTestId('inventory-add-cancel')).toBeNull()
  })
})
