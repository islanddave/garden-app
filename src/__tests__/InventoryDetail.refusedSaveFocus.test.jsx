// A refused Save on /inventory/:id brings the first refused field into view and focuses it.
//
// Save sits at the bottom of the form; every refusal renders beside its own field, far above it. The
// seed-count review round measured it in real Chrome (gate:seed-detail (l)): the Seed count refusal sat
// 455-680px ABOVE the visible band after the Save tap at 360x640, 390x844 and 426x836, so a refused Save
// looked like a Save that did nothing. The page now scrolls the FIRST refused field (page order) to the
// middle of the screen — scrollIntoView({ block: 'center' }) — and then focuses it with
// focus({ preventScroll: true }). This file pins which field, in which order, and that a valid Save does
// neither. The geometry itself (is the refusal inside the band?) is gate:seed-detail (l)'s; jsdom has no
// layout and no scrollIntoView, so the page guards for it and this file installs a spy in its place.
//
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, navigateSpy, updateItemSpy, deleteItemSpy, paramsRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  updateItemSpy: vi.fn(),
  deleteItemSpy: vi.fn(),
  paramsRef: { current: { id: 'inv-lot-1' } },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useParams: () => paramsRef.current,
  useNavigate: () => navigateSpy,
}))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({ updateItem: updateItemSpy, deleteItem: deleteItemSpy }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({
  default: (props) => <input id={props.inputId} type="file" hidden />,
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const SOURCES = [
  { id: 'src-sandia', name: 'Sandia Seed Company', kind: 'seed_company', locality: null, address: null, website_url: null, notes: null },
]

// A saved lot, put away, 175 counted — as GET /:id returns it.
const SAVED = {
  id: 'inv-lot-1', name: 'Thai Dragon — saved 2026', type: 'consumable', category: 'seeds', status: 'active',
  quantity_on_hand: '1.000', unit: 'packet', reorder_threshold: null, reorder_quantity: null,
  unit_cost: null, quantity_purchased: null, purchase_date: null, location_text: null,
  brand: null, model: null, condition: null, notes: null, source: null, source_url: null,
  source_id: null, acquired_from_source_id: null, year_harvested: 2026,
  variety_id: 'var-thai', variety_name: 'Thai Dragon', crop_slug: 'pepper',
  seed_stage: 'stored', seed_process: 'fresh', source_plant_id: 'pl-thai', source_kind: null,
  seed_count: 175, seed_count_estimated: false, seed_weight_g: null,
  featured_photo_id: null, hero_photo_id: null, featured_photo_view_url: null,
  germination: null, sown_from: [],
}

let rows
let scrollSpy
let focusSpy
beforeEach(() => {
  fetchSpy.mockReset(); navigateSpy.mockReset(); updateItemSpy.mockReset(); deleteItemSpy.mockReset()
  updateItemSpy.mockResolvedValue({ item: {} })
  rows = {}
  fetchSpy.mockImplementation((path) => {
    const m = /^\/api\/inventory-items\/([^/?]+)$/.exec(String(path))
    if (m) return rows[m[1]] ? Promise.resolve({ ...rows[m[1]] }) : Promise.reject(Object.assign(new Error('nf'), { status: 404 }))
    if (path === '/api/varieties/sources') return Promise.resolve(SOURCES)
    return Promise.resolve([])
  })
  clearReloadBlocks()
  // jsdom has no scrollIntoView; the page guards for that, so a spy installed here is the only caller.
  scrollSpy = vi.fn()
  Element.prototype.scrollIntoView = scrollSpy
  // Calls through, so document.activeElement moves exactly as it would.
  focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
})
afterEach(() => {
  delete Element.prototype.scrollIntoView
  focusSpy.mockRestore()
})

async function renderPage(row) {
  rows[row.id] = { ...row }
  paramsRef.current = { id: row.id }
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
}

const type = (el, value) => fireEvent.change(el, { target: { value } })
const save = async () => { await act(async () => { fireEvent.click(screen.getByText('Save changes')) }) }
const scrolled = () => scrollSpy.mock.contexts
const focusedWithPreventScroll = (el) => focusSpy.mock.calls
  .some((args, i) => focusSpy.mock.contexts[i] === el && args[0]?.preventScroll === true)
// Scroll FIRST, then focus without a second scroll: the order the effect promises.
const scrollBeforeFocus = (el) => {
  const s = scrollSpy.mock.contexts.indexOf(el)
  const f = focusSpy.mock.contexts.indexOf(el)
  return s !== -1 && f !== -1 && scrollSpy.mock.invocationCallOrder[s] < focusSpy.mock.invocationCallOrder[f]
}

describe('a refused Save brings the first refused field into view and focuses it', () => {
  it('two refusals: the FIRST in page order (Name, above the Seed count) is scrolled to the middle and focused', async () => {
    await renderPage(SAVED)
    const name = screen.getByLabelText('Name')
    type(name, '   ')
    type(screen.getByTestId('inv-seed-count'), '175-')
    scrollSpy.mockClear(); focusSpy.mockClear()
    await save()
    expect(updateItemSpy).not.toHaveBeenCalled()
    expect(scrolled()).toEqual([name])
    expect(scrollSpy.mock.calls[0]).toEqual([{ block: 'center' }])
    expect(document.activeElement).toBe(name)
    expect(focusedWithPreventScroll(name)).toBe(true)
    expect(scrollBeforeFocus(name)).toBe(true)
  })

  it('the Seed count alone: its box is scrolled to and focused, the typed "175-" still in it', async () => {
    await renderPage(SAVED)
    const count = screen.getByTestId('inv-seed-count')
    type(count, '175-')
    scrollSpy.mockClear(); focusSpy.mockClear()
    await save()
    expect(scrolled()).toEqual([count])
    expect(document.activeElement).toBe(count)
    expect(count.value).toBe('175-')
    expect(focusedWithPreventScroll(count)).toBe(true)
  })

  it('page-wide: a refused harvest year, down in the Details card, is brought up the same way', async () => {
    await renderPage(SAVED)
    const year = screen.getByTestId('inv-year-harvested')
    type(year, '19 86')
    scrollSpy.mockClear(); focusSpy.mockClear()
    await save()
    expect(scrolled()).toEqual([year])
    expect(document.activeElement).toBe(year)
  })

  it('a picker showing a chosen value: its Change button takes focus — never the ✕ that clears it', async () => {
    await renderPage({ ...SAVED, source_plant_id: null, seed_stage: null, source_kind: 'store', source_id: 'src-sandia', acquired_from_source_id: 'src-sandia' })
    // Both pickers resolve their chip from the registry before anything is saved.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear acquired from' })).toBeTruthy())
    const venue = Array.from(document.querySelectorAll('label'))
      .find((l) => l.textContent.startsWith('Acquired from')).parentElement
    scrollSpy.mockClear(); focusSpy.mockClear()
    await save()
    expect(updateItemSpy).not.toHaveBeenCalled()
    const target = scrolled()[0]
    expect(scrolled()).toHaveLength(1)
    expect(venue.contains(target)).toBe(true)
    expect(target.tagName).toBe('BUTTON')
    expect(target.textContent.trim()).toBe('Change')
    expect(document.activeElement).toBe(target)
    expect(document.activeElement.getAttribute('aria-label') ?? '').not.toMatch(/^Clear/)
  })

  it('a second refused Save of the same field moves again — every refusal, not the first only', async () => {
    await renderPage(SAVED)
    const count = screen.getByTestId('inv-seed-count')
    type(count, '175-')
    scrollSpy.mockClear()
    await save()
    await save()
    expect(scrolled()).toEqual([count, count])
  })

  it('a valid Save neither scrolls nor moves focus', async () => {
    await renderPage(SAVED)
    type(screen.getByLabelText('Name'), 'Thai Dragon — tin 2')
    type(screen.getByTestId('inv-seed-count'), '180')
    scrollSpy.mockClear(); focusSpy.mockClear()
    await save()
    expect(updateItemSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy).not.toHaveBeenCalled()
    expect(focusSpy).not.toHaveBeenCalled()
  })
})
