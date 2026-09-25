// BUG-SEEDLOTOPENSATFORM-001 — a seed lot's page opens at the TOP when a door opens it, and a Back onto
// an entry it was already opened on (an edit round trip: the variety editor leaves with navigate(-1))
// leaves the position the browser restored alone. Dave: the top "is desired behavior when not going
// directly from an edit option of some sort" — so the one edit door into this page, Saved seeds' "Set
// parent plant →", lands on the "Saved from" card instead.
//
// Why spies and not a scroll position: jsdom has no layout and no scroll anchoring, so the symptom itself
// (Chrome re-applying the previous page's offset, clamped to the bottom of this page, once the lot lands)
// cannot happen here. This pins the page's half of the contract; the symptom was measured in real Chrome
// at 426x836 (Saved seeds deep tap: 1742, the page's bottom, before; 0 after).
// Harness shape from InventoryDetail.seedExits.test.jsx. No jest-dom (L-182).
//
// BUG-DETAILPAGESCARRYSCROLL-001 — RE-HOMED, deliberately (rimpact-scrollmanager IMPORTANT-9). With the
// app-level page-scroll manager on, the top is the app shell's (a push or replace onto a different page),
// and so is the return (a POP restores the offset filed for its entry). So the page's own reset is pinned
// here ONLY for the manager-off bundle, which must bring it back exactly (the rollback path), and the
// manager-on page is pinned to never reset itself. The manager's half — a push lands at 0, a Back lands on
// the entry's own offset, the first entry of a document (mutant M7) now restores a reload's record rather
// than opening at the top — lives in usePageScrollManager.test.jsx, pageScroll.test.js and gate:page-scroll.
// The edit door's arrival hint stays the page's, under both bundles.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup, fireEvent } from '@testing-library/react'

const { fetchSpy, navigateSpy, flags } = vi.hoisted(() => ({ fetchSpy: vi.fn(), navigateSpy: vi.fn(), flags: { manager: true } }))

// The real flags, with SCROLL_MANAGER_ENABLED read live so one file can pin both bundles.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get SCROLL_MANAGER_ENABLED() { return flags.manager },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state: _s, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useParams: () => ({ id: 'lot-ristra' }),
  useNavigate: () => navigateSpy,
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
// `finish` stands in for a completed packet-photo upload, whose re-read of the row is the one later
// change to the loaded lot (InventoryDetail.packetCard.test.jsx drives it the same way).
vi.mock('../components/PhotoUpload.jsx', () => ({
  default: (props) => (
    <button type="button" data-testid="photo-upload-finish"
      onClick={() => props.onUploadComplete?.({ id: 'ph-uploaded' })}>finish</button>
  ),
}))
vi.mock('../components/forms/PlantingSelect.jsx', () => ({ default: () => <span data-testid="planting-select" /> }))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({ updateItem: vi.fn(), deleteItem: vi.fn() }),
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { PageScrollProvider } from '../hooks/usePageScrollManager.js'
import { seedsReturnState, LOT_SECTION_KEY, LOT_SECTION_SOURCE_PLANT } from '../lib/seedsRoutes.js'

// The saved lot Dave opened: stored, 175 seeds, saved off his F1 plant (so F2).
const LOT = {
  id: 'lot-ristra', name: 'Ristra Cayenne II Saved seed 2026', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: 1, unit: 'packet', reorder_threshold: null, reorder_quantity: null,
  notes: null, source: null, source_url: null, purchase_date: null, unit_cost: null, quantity_purchased: null,
  location_text: null, brand: null, model: null, variety_id: 'var-ristra', variety_name: null,
  source_plant_id: 'pl-ristra', source_kind: 'own_garden', seed_stage: 'stored', seed_process: 'wet',
  seed_count: 175, seed_count_estimated: false, breeding_system: 'f1', year_harvested: 2026, metadata: null,
  germination: { rate: null, seeds_sown: 0, seeds_germinated: 0, sowings: [] }, sown_from: [],
}
// The lot Saved seeds offers "Set parent plant →" on: no parent yet, and an origin that admits one.
const UNPARENTED = { ...LOT, source_plant_id: null, source_kind: null, breeding_system: null }

const SAVED = '/seeds?view=saved'

// The history entry as BrowserRouter leaves it: react-router's per-entry key under `key`, the pushing
// view's location.state under `usr` (the Saved seeds card passes seedsReturnState(SAVED_VIEW_HREF)).
let n = 0
const freshKey = () => `k-${Date.now().toString(36)}-${++n}`
const arriveOn = (key, usr = seedsReturnState(SAVED)) => window.history.replaceState({ usr, key, idx: 4 }, '')
const SET_PARENT = { ...seedsReturnState(SAVED), [LOT_SECTION_KEY]: LOT_SECTION_SOURCE_PLANT }

// Every scroll the page asks for, in order: window.scrollTo(x, y) and element.scrollIntoView(opts).
let scrolls = []
let row = LOT
beforeEach(() => {
  fetchSpy.mockReset(); navigateSpy.mockReset()
  row = LOT
  fetchSpy.mockImplementation((path, opts) => (String(path) === '/api/inventory-items/lot-ristra' && !opts
    ? Promise.resolve({ ...row }) : Promise.resolve([])))
  scrolls = []
  window.scrollTo = vi.fn((x, y) => { scrolls.push(['top', x, y]) })
  // jsdom implements no scrollIntoView at all; the page guards for its absence, this records it.
  Element.prototype.scrollIntoView = function (opts) { scrolls.push(['into', this.getAttribute('data-testid'), opts]) }
})
afterEach(() => {
  cleanup(); window.history.replaceState(null, '')
  delete Element.prototype.scrollIntoView
})

// `popped`: the page tree arrived by POP, as the manager's provider reports it (a Back, a reload, a tab
// restore). Outside the provider — every other render here — it is false, as with the manager off.
const renderPage = async ({ popped = false } = {}) => {
  const page = <ToastProvider><InventoryDetail /></ToastProvider>
  await act(async () => { render(popped ? <PageScrollProvider value={{ api: null, isReturn: true }}>{page}</PageScrollProvider> : page) })
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(row.name))
}

describe('manager ON: the page never scrolls itself to the top — the app shell does', () => {
  beforeEach(() => { flags.manager = true })

  it('a door that pushes the page: no reset from the page (the shell\'s row 2 lands it at 0)', async () => {
    arriveOn(freshKey()); await renderPage()
    expect(window.scrollTo).not.toHaveBeenCalled()
    expect(scrolls).toEqual([])
  })

  it('the first entry of the document: no reset from the page (the shell restores a reload\'s record, else a new document is at 0)', async () => {
    window.history.replaceState(null, '')
    await renderPage()
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('a Back onto an entry the page was already opened on: nothing from the page, so the shell\'s restore stands', async () => {
    const key = freshKey()
    arriveOn(key); await renderPage()
    cleanup(); window.scrollTo = vi.fn()
    arriveOn(key); await renderPage({ popped: true })
    expect(window.scrollTo).not.toHaveBeenCalled()
  })
})

describe('manager OFF (the rollback bundle): the lot page opens at the top by itself, as before', () => {
  beforeEach(() => { flags.manager = false })
  it('a door that pushes the page (Saved seeds card, My seeds "Open details") scrolls to the top', async () => {
    arriveOn(freshKey()); await renderPage()
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
    expect(scrolls.filter(s => s[0] === 'into')).toEqual([])
  })

  it('a door with no Seeds state (Search, Favorites, a planting\'s lot link, the lot Save seed just made) opens at the top too', async () => {
    arriveOn(freshKey(), null); await renderPage()
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
  })

  // The document's first entry carries no router key: the PWA opened straight onto this lot, a bookmark, a
  // reload of that entry. Nothing says it is a return, so it is a door (qa-v4148 MINOR, mutant M7: a null key
  // treated as a return left the page wherever the browser put it).
  it('an entry with no history key (the first entry of the document) opens at the top', async () => {
    window.history.replaceState(null, '')
    await renderPage()
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('a Back onto an entry the page was already opened on (an edit round trip) keeps the restored position', async () => {
    const key = freshKey()
    arriveOn(key); await renderPage()                    // the first visit: a fresh entry, so the top
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
    cleanup(); window.scrollTo = vi.fn()                  // pushed away to the variety editor ...
    arriveOn(key); await renderPage()                    // ... and navigate(-1) brings the SAME entry back
    expect(window.scrollTo).not.toHaveBeenCalledWith(0, 0)
  })
})

describe.each([['manager ON', true], ['manager OFF', false]])('the edit door lands on what it edits (%s)', (_label, on) => {
  beforeEach(() => { flags.manager = on })

  it('Saved seeds "Set parent plant →" lands on the Saved from card, not the top', async () => {
    row = UNPARENTED
    arriveOn(freshKey(), SET_PARENT); await renderPage()
    // The card is brought into sight once the lot has rendered, and nothing scrolls after it: the page
    // may pass through the top on the way (it holds 0 through the spinner), but it ends on the card.
    await waitFor(() => expect(scrolls.at(-1)).toEqual(['into', 'seed-source-plant', { block: 'center' }]))
    expect(scrolls.filter(s => s[0] === 'into')).toHaveLength(1)
  })

  it('once per arrival: a later re-read of the lot (a packet photo upload) does not scroll again', async () => {
    row = UNPARENTED
    arriveOn(freshKey(), SET_PARENT); await renderPage()
    await waitFor(() => expect(scrolls.at(-1)?.[1]).toBe('seed-source-plant'))
    const before = scrolls.length
    // The re-read adopts a new packet photo, so `item` really changes (adoptPacketPhoto).
    row = { ...UNPARENTED, featured_photo_id: 'ph-new', hero_photo_id: 'ph-new',
      featured_photo_view_url: 'https://photos.example.test/inventory/lot-ristra/ph-new.jpg?sig=1' }
    await act(async () => { fireEvent.click(screen.getByTestId('photo-upload-finish')) })
    await waitFor(() => expect(screen.getByTestId('packet-photo-open')).toBeTruthy())
    expect(scrolls.slice(before)).toEqual([])
  })

  it('a Back onto the edit door\'s entry leaves the restored position alone too', async () => {
    row = UNPARENTED
    const key = freshKey()
    arriveOn(key, SET_PARENT); await renderPage()
    await waitFor(() => expect(scrolls.at(-1)?.[1]).toBe('seed-source-plant'))
    cleanup(); scrolls = []
    arriveOn(key, SET_PARENT); await renderPage()        // the entry still carries the hint on the way back
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(scrolls).toEqual([])
  })
})

describe('manager ON: a POP arrival never takes the edit door\'s hint', () => {
  beforeEach(() => { flags.manager = true })

  // A reload or an Android tab restore empties `openedEntries` (module state), so a Back onto the edit
  // door's entry afterwards reads to the page as a first open. The shell is restoring that entry's offset;
  // a centred scrollIntoView on top of it would fight the restore (design-scrollmanager-pwa §2.7).
  it('the edit door\'s entry reached by POP in a fresh document: no scrollIntoView, no reset', async () => {
    row = UNPARENTED
    arriveOn(freshKey(), SET_PARENT); await renderPage({ popped: true })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(scrolls).toEqual([])
  })

  it('control: the same entry reached by a push takes the hint', async () => {
    row = UNPARENTED
    arriveOn(freshKey(), SET_PARENT); await renderPage()
    await waitFor(() => expect(scrolls).toEqual([['into', 'seed-source-plant', { block: 'center' }]]))
  })
})
