// V5-SEEDSTAB-001 slice 2a — ONE Sow sheet, two hosts: Sow now's cards and the seed's detail page
// ("Sow this"). design-seedshome-V102 §6: "Sow this opens the same Sow sheet as Sow now — a SowSheet
// extracted from SowNow (per-host draft key, its own projects fetch, registry icon)".
//
// What this file pins, and what would red it:
//   · THE GOLDEN COMPARISON (crucible QA S2-02): for the same packet on the same day, the POST
//     /api/plants body from the detail page EQUALS the one from Sow now — whole-object equality, so a
//     host that drifts on any default (status, sown date, source type, place, the packet link) reds.
//     Run for a bought packet and for a saved lot, so the source-type decision is in both.
//   · PER-HOST STASH KEYS (seat-regression-impact #13): a sow interrupted on a packet's page reopens
//     there and NOWHERE else; Sow now's stash never opens a packet's page.
//   · THE EDITOR WAITS FOR THE PLACES: a tap that beats GET /api/projects must not mount an editor
//     whose default place is '' (PlantingEditor reads projects[0] once, at mount, and with
//     PROJECTS_HIDDEN there is no picker to fix it from).
//   · The detail page's live provenance decides the source type, its sown line, and Edit sow details.
//
// Real sowEngine, real Sheet, real PlantingEditor, real draftStash and reloadGate; only the network,
// the router and a few leaf widgets are stubbed. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, act, waitFor, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy, navigateSpy, paramsRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  paramsRef: { current: { id: 'pkt-1' } },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useParams: () => paramsRef.current,
}))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({ updateItem: vi.fn().mockResolvedValue({ item: {} }), deleteItem: vi.fn().mockResolvedValue({ ok: true }) }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => null }))

import SowNow from '../pages/SowNow.jsx'
import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlayDirtyProvider } from '../context/OverlayContext.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { todayLocalISO } from '../lib/dateLocal.js'
import { sowPacketFromCandidate, sowPacketFromItem, sowSourceType } from '../components/seed/SowSheet.jsx'

// One packet, in both shapes. start_method indoors_only is sowable inside on ANY date (sowEngine's
// indoor-only overlay → sow_inside_anytime, an actionable bucket), so Sow now offers "Sow" whatever
// day this runs — and both hosts then stamp the real local today, which is what makes the two POST
// bodies comparable without faking the clock.
const ITEM = {
  id: 'pkt-1', name: 'Sungold Tomato Seeds', type: 'consumable', category: 'seeds', status: 'active',
  quantity_on_hand: 1, unit: 'packet', variety_id: 'var-sungold', variety_name: 'Sungold',
  source: "Order 1234; rec'd by Jen", purchase_date: '2026-03-01', metadata: { vendor: "Johnny's" },
  brand: null, source_plant_id: null, source_kind: null, seed_stage: null, source_id: null,
  acquired_from_source_id: null, source_url: null, year_harvested: null, germination: null,
}
const CANDIDATE = {
  inventory_item_id: 'pkt-1', item_name: ITEM.name, variety_name: 'Sungold', variety_id: 'var-sungold',
  quantity_on_hand: '1', unit: 'packet', created_by: 'user_x', purchase_date: ITEM.purchase_date,
  source: ITEM.source, metadata: {}, crop_type_slug: 'tomato', lifecycle: 'annual', grown_as: null,
  sun_requirements: 'full_sun', start_method: 'indoors_only', seed_stage: null, source_plant_id: null,
  source_kind: null,
}
// The same packet as a lot Dave saved off his own plant and finished drying.
const SAVED_ITEM = { ...ITEM, source_plant_id: 'pl-sungold', seed_stage: 'stored' }
const SAVED_CANDIDATE = { ...CANDIDATE, source_plant_id: 'pl-sungold', seed_stage: 'stored' }

const PROJECTS = [{ id: 'proj-beds', name: 'Raised beds' }]

let item
let candidates
let projectsResponse   // optional override: () => Promise for GET /api/projects
function routeFetch() {
  fetchSpy.mockImplementation((path, opts = {}) => {
    const p = String(path)
    if (opts.method === 'POST' && p === '/api/plants') return Promise.resolve({ id: 'plant-1' })
    if (opts.method === 'PATCH') return Promise.resolve({ ok: true })
    if (p === '/api/inventory-items/sow-candidates') return Promise.resolve({ items: candidates })
    if (p === `/api/inventory-items/${item.id}`) return Promise.resolve(item)
    if (p === '/api/projects') return projectsResponse ? projectsResponse() : Promise.resolve(PROJECTS)
    if (p === '/api/varieties/var-sungold') return Promise.resolve({ id: 'var-sungold', name: 'Sungold' })
    return Promise.resolve([])
  })
}

beforeEach(() => {
  fetchSpy.mockReset()
  navigateSpy.mockReset()
  paramsRef.current = { id: 'pkt-1' }
  sessionStorage.clear()
  clearReloadBlocks()
  item = ITEM
  candidates = [CANDIDATE]
  projectsResponse = null
  routeFetch()
})
afterEach(() => cleanup())

const stash = (key) => {
  const raw = sessionStorage.getItem(`gardenApp.draft.${key}`)
  return raw ? JSON.parse(raw).data : null
}
const seedStash = (key, data) => sessionStorage.setItem(`gardenApp.draft.${key}`, JSON.stringify({ v: 1, data }))
const postBody = () => {
  const call = fetchSpy.mock.calls.find(([u, o]) => u === '/api/plants' && o?.method === 'POST')
  return call ? JSON.parse(call[1].body) : null
}
const sowDialog = () => screen.queryByRole('dialog', { name: /^Sow / })

async function renderDetail(wrap = (n) => n) {
  let out
  await act(async () => { out = render(wrap(<ToastProvider><InventoryDetail /></ToastProvider>)) })
  await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
  return out
}
async function renderSowNow() {
  let out
  await act(async () => { out = render(<ToastProvider><SowNow /></ToastProvider>) })
  await screen.findByRole('button', { name: 'Sow Sungold' })
  return out
}

// Fill-then-submit through the REAL editor, from an open sheet. Waits for the packet prefill (its name
// fills the required Name field) so both hosts submit the same, fully seeded form.
async function submitSheet() {
  const sheet = sowDialog()
  await waitFor(() => expect(within(sheet).getByLabelText(/Name/i).value).toBe(ITEM.name))
  await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: /Add planting/i })) })
  await waitFor(() => expect(postBody()).toBeTruthy())
  return postBody()
}
async function sowFromDetail() {
  await renderDetail()
  await act(async () => { fireEvent.click(screen.getByTestId('sow-this')) })
  return submitSheet()
}
async function sowFromSowNow() {
  await renderSowNow()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sow Sungold' })) })
  return submitSheet()
}

describe('the packet shape and the source type (pure)', () => {
  it('both hosts\' rows become the same packet', () => {
    expect(sowPacketFromItem(ITEM)).toEqual(sowPacketFromCandidate(CANDIDATE))
    expect(sowPacketFromItem(ITEM)).toEqual({ id: 'pkt-1', varietyId: 'var-sungold', title: 'Sungold', saved: false })
  })

  it('saved seed is any of the three saved-lot facts; a bought packet is none of them', () => {
    expect(sowSourceType(sowPacketFromItem(ITEM))).toBe('seed_packet')
    expect(sowSourceType(sowPacketFromItem({ ...ITEM, source_plant_id: 'pl-1' }))).toBe('saved_seed')
    expect(sowSourceType(sowPacketFromItem({ ...ITEM, source_kind: 'u_pick' }))).toBe('saved_seed')
    expect(sowSourceType(sowPacketFromItem({ ...ITEM, seed_stage: 'stored' }))).toBe('saved_seed')
    expect(sowSourceType(null)).toBe('seed_packet')
  })
})

describe('GOLDEN: "Sow this" and Sow now send the same planting', () => {
  it('a bought packet — every field of the two POST bodies agrees', async () => {
    const fromSowNow = await sowFromSowNow()
    cleanup()
    fetchSpy.mockClear()
    const fromDetail = await sowFromDetail()

    expect(fromDetail).toEqual(fromSowNow)
    // And the agreed body is the Sow flow's, not merely two copies of the same wrong thing.
    expect(fromDetail).toMatchObject({
      project_id: 'proj-beds', name: ITEM.name, variety_id: 'var-sungold', status: 'seed',
      sown_at: todayLocalISO(), source_type: 'seed_packet', source_inventory_item_id: 'pkt-1',
      source_ref: "Johnny's",
    })
  })

  it('a saved lot — both hosts record saved seed', async () => {
    item = SAVED_ITEM
    candidates = [SAVED_CANDIDATE]
    const fromSowNow = await sowFromSowNow()
    cleanup()
    fetchSpy.mockClear()
    const fromDetail = await sowFromDetail()

    expect(fromDetail).toEqual(fromSowNow)
    expect(fromDetail.source_type).toBe('saved_seed')
    expect(fromDetail.source_inventory_item_id).toBe('pkt-1')
  })
})

describe('the Sow sheet on a packet\'s page', () => {
  it('opens on this packet, in place, with the page\'s LIVE provenance deciding the source type', async () => {
    await renderDetail()
    // Recorded on this page a moment ago — the loaded row still says "bought".
    await act(async () => {
      fireEvent.change(screen.getByTestId('source-kind-select'), { target: { value: 'farm_stand' } })
    })
    await waitFor(() => expect(fetchSpy.mock.calls.some(([u, o]) => String(u).endsWith('/source-kind') && o?.method === 'PATCH')).toBe(true))
    await act(async () => { fireEvent.click(screen.getByTestId('sow-this')) })
    expect(sowDialog().getAttribute('aria-label')).toBe('Sow Sungold')
    expect(navigateSpy).not.toHaveBeenCalled()

    const body = await submitSheet()
    expect(body.source_type).toBe('saved_seed')
  })

  it('after a sow the page says so and offers the planting — and still offers Sow this', async () => {
    await sowFromDetail()
    await waitFor(() => expect(screen.getByTestId('sow-this-sown')).toBeTruthy())
    expect(sowDialog()).toBeNull()
    expect(screen.getByTestId('sow-this-sown').textContent).toContain('Sown ✓')
    expect(screen.getByTestId('sow-this-see-planting').getAttribute('href')).toBe('/plantings/plant-1')
    // On the 44px tap floor (QA T03: dropping it survived; gate:seed-detail measures it in Chrome too).
    expect(screen.getByTestId('sow-this-see-planting').style.minHeight).toBe('44px')
    // Sowing does not consume a packet (SowNow.jsx header), so the packet's own page keeps the action.
    expect(screen.getByTestId('sow-this')).toBeTruthy()
    expect(screen.getByText('Planted!')).toBeTruthy()
  })

  it('holds the service-worker reload while open, and releases it on Close', async () => {
    await renderDetail()
    expect(isReloadBlocked()).toBe(false)
    await act(async () => { fireEvent.click(screen.getByTestId('sow-this')) })
    expect(isReloadBlocked()).toBe(true)
    await act(async () => { fireEvent.click(within(sowDialog()).getByRole('button', { name: 'Close' })) })
    expect(sowDialog()).toBeNull()
    expect(isReloadBlocked()).toBe(false)
  })

  // Forward-compat, like SowNow.formGuard's dirtySpy half: /inventory/:id is not overlayable, so this
  // pins the page's single report, not a live guard. It must carry the sheet AND stay one reporter.
  it('reports an open sheet through the page\'s one overlay-dirty channel', async () => {
    const dirtySpy = vi.fn()
    await renderDetail((n) => <OverlayDirtyProvider onDirtyChange={dirtySpy}>{n}</OverlayDirtyProvider>)
    expect(dirtySpy).not.toHaveBeenCalledWith(true)
    await act(async () => { fireEvent.click(screen.getByTestId('sow-this')) })
    expect(dirtySpy).toHaveBeenLastCalledWith(true)
    await act(async () => { fireEvent.click(within(sowDialog()).getByRole('button', { name: 'Close' })) })
    expect(dirtySpy).toHaveBeenLastCalledWith(false)
  })
})

describe('per-host stash keys — an interrupted sow reopens where it was, and nowhere else', () => {
  it('the packet page writes ITS key while open, and an abnormal exit leaves it for this page to restore', async () => {
    const { unmount } = await renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('sow-this')) })
    expect(stash('sow-packet')).toEqual({ inventoryItemId: 'pkt-1' })
    expect(stash('sow-now')).toBeNull()
    unmount()   // the SW reload / hard refresh the guards could not defer
    expect(stash('sow-packet')).toEqual({ inventoryItemId: 'pkt-1' })

    await renderDetail()
    await waitFor(() => expect(sowDialog()).toBeTruthy())
    expect(sowDialog().getAttribute('aria-label')).toBe('Sow Sungold')
    await waitFor(() => expect(within(sowDialog()).getByLabelText(/Name/i).value).toBe(ITEM.name))
  })

  it('a stash written on the packet page does NOT reopen on Sow now', async () => {
    const { unmount } = await renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('sow-this')) })
    unmount()

    await renderSowNow()
    expect(sowDialog()).toBeNull()
    expect(screen.getByRole('button', { name: 'Sow Sungold' })).toBeTruthy()
  })

  it('Sow now\'s stash does NOT reopen on the packet\'s page', async () => {
    seedStash('sow-now', { inventoryItemId: 'pkt-1' })
    await renderDetail()
    expect(screen.getByTestId('sow-this')).toBeTruthy()
    expect(sowDialog()).toBeNull()
  })

  it('a stash naming ANOTHER packet does not open this one', async () => {
    seedStash('sow-packet', { inventoryItemId: 'pkt-other' })
    await renderDetail()
    expect(sowDialog()).toBeNull()
  })

  it('a packet that is no longer sowable (used up since) does not reopen, and offers no Sow this', async () => {
    seedStash('sow-packet', { inventoryItemId: 'pkt-1' })
    item = { ...ITEM, quantity_on_hand: 0 }
    await renderDetail()
    expect(sowDialog()).toBeNull()
    expect(screen.queryByTestId('sow-this')).toBeNull()
  })

  // The restore guard (`if (!canSowFrom(item)) return`) cannot be seen through the sheet: SowSheet is
  // not mounted for an unsowable packet, so a restore past the guard opens nothing (QA Q05: deleting the
  // guard left the test above green). It is still a defect — the page would hold a sow open in its state,
  // report itself dirty, and reopen the stale sheet if the packet became sowable later in the tab. The
  // overlay-dirty report is the channel the mount gate does not hide.
  it.each([
    ['used up', { ...ITEM, quantity_on_hand: 0 }],
    ['still drying', { ...SAVED_ITEM, seed_stage: 'drying' }],
    ['still fermenting', { ...SAVED_ITEM, seed_stage: 'fermenting' }],
  ])('a stash naming a %s packet never reports the page dirty', async (_label, unsowable) => {
    seedStash('sow-packet', { inventoryItemId: 'pkt-1' })
    item = unsowable
    const dirtySpy = vi.fn()
    await renderDetail((n) => <OverlayDirtyProvider onDirtyChange={dirtySpy}>{n}</OverlayDirtyProvider>)
    await act(async () => {})
    // Positive evidence the page reported at all — a spy never called passes "never true" vacuously.
    expect(dirtySpy).toHaveBeenCalledWith(false)
    expect(dirtySpy).not.toHaveBeenCalledWith(true)
    expect(sowDialog()).toBeNull()
  })

  it('a deliberate Close clears the stash, so the next visit does not reopen it', async () => {
    const { unmount } = await renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('sow-this')) })
    await act(async () => { fireEvent.click(within(sowDialog()).getByRole('button', { name: 'Close' })) })
    expect(stash('sow-packet')).toBeNull()
    unmount()

    await renderDetail()
    expect(sowDialog()).toBeNull()
  })

  it('a successful sow clears the stash too', async () => {
    await sowFromDetail()
    await waitFor(() => expect(sowDialog()).toBeNull())
    expect(stash('sow-packet')).toBeNull()
  })
})

describe('the editor waits for the places', () => {
  // The race a packet's page makes possible: the sheet mounts with the page, so a tap can land before
  // GET /api/projects answers. PlantingEditor seeds its place from projects[0] ONCE, at mount — an
  // editor mounted on an empty list would POST project_id '' with no picker (PROJECTS_HIDDEN) to fix it.
  it('a tap that beats the projects fetch shows a loading state, then an editor defaulted to a real place', async () => {
    let release
    projectsResponse = () => new Promise((r) => { release = () => r(PROJECTS) })
    await renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('sow-this')) })

    expect(within(sowDialog()).getByText('Loading places…')).toBeTruthy()
    expect(within(sowDialog()).queryByRole('button', { name: /Add planting/i })).toBeNull()

    await act(async () => { release() })
    const body = await submitSheet()
    expect(body.project_id).toBe('proj-beds')
  })

  it('a failed projects fetch still opens the editor (it says why a create fails), never an endless spinner', async () => {
    projectsResponse = () => Promise.reject(new Error('offline'))
    await renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('sow-this')) })
    await waitFor(() => expect(within(sowDialog()).getByRole('button', { name: /Add planting/i })).toBeTruthy())
    expect(within(sowDialog()).queryByText('Loading places…')).toBeNull()
  })
})

describe('Edit sow details — the variety editor, from the packet\'s page', () => {
  it('links a seed row to its cultivar\'s editor, on the 44px floor', async () => {
    await renderDetail()
    const link = screen.getByTestId('edit-sow-details')
    expect(link.getAttribute('href')).toBe('/varieties/var-sungold/edit')
    expect(link.textContent).toBe('Edit sow details →')
    expect(link.style.minHeight).toBe('44px')
  })

  it('stays when the packet is used up — the profile is the cultivar\'s, not the stock\'s', async () => {
    item = { ...ITEM, quantity_on_hand: 0 }
    await renderDetail()
    expect(screen.queryByTestId('sow-this')).toBeNull()
    expect(screen.getByTestId('edit-sow-details').getAttribute('href')).toBe('/varieties/var-sungold/edit')
  })

  it('is absent on a row with no cultivar, and on every non-seed row', async () => {
    item = { ...ITEM, variety_id: null }
    await renderDetail()
    expect(screen.queryByTestId('edit-sow-details')).toBeNull()
    cleanup()

    item = { ...ITEM, id: 'inv-tool', category: 'tools', type: 'durable', quantity: 1, quantity_on_hand: null }
    paramsRef.current = { id: 'inv-tool' }
    routeFetch()
    await renderDetail()
    expect(screen.queryByTestId('edit-sow-details')).toBeNull()
    expect(screen.queryByTestId('sow-this')).toBeNull()
    expect(screen.queryByTestId('sow-actions')).toBeNull()
  })
})
