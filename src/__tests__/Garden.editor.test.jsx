// Garden PlantingEditor — V3-IA merge coverage. The add/edit/delete machinery that
// lived in the retired Plants page now opens inside Garden via query params:
//   ?add=1 (FAB create sheet) · ?edit=<id> (PlantingDetail V3-EDIT-001) ·
//   ?source_inventory_item_id/&variety_id (InventoryDetail plant-from-packet).
// Wire-contract assertions (dual-write variety, planting-details union, COALESCE PUT)
// ported from the old Plants.test.jsx.
//
// OPS-GARDENROUTERMOCK-001 — this file used to mock `react-router-dom` and hand `useSearchParams`
// a frozen `{ current: new URLSearchParams() }` ref, so `setSearchParams` mutated an object and
// re-rendered nothing. Measured on the pre-fix Garden.jsx (32e9473^, the source that shipped a dead
// ?edit= deep link for four days): all 27 tests here PASSED, including "opens the edit form
// prefilled" — the exact behaviour that was broken 100% of the time in production. Every param
// entry point now arrives as a real URL through MemoryRouter (helpers/routerHarness.jsx), and the
// param-strip assertions read the URL the router actually holds rather than a spy's argument.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'
import { renderWithRouter, currentParams, navigateTo, resetRouterHarness } from './helpers/routerHarness.jsx'

const { fetchSpy, getTokenSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  getTokenSpy: vi.fn(async () => 'tok'),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: getTokenSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value, onChange }) => (
    <div data-testid="variety-picker">
      <span data-testid="vp-value">{value ? value.name : 'EMPTY'}</span>
      <button type="button" data-testid="vp-pick-black-krim"
        onClick={() => onChange({ id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum', genus: 'Solanum' })}>
        Pick Variety
      </button>
    </div>
  ),
}))

import Garden from '../pages/Garden.jsx'

const PROJECTS = [{ id: 'proj-1', name: 'Spring 2026', status: 'active', parent_project_id: null, is_public: true }]
const PLANT = {
  id: 'plant-2', name: 'Krim Plant', project_id: 'proj-1', project_name: 'Spring 2026',
  quantity: 3, status: 'seedling', notes: null,
  variety: 'Black Krim', variety_id: 'var-1',
  variety_ref: { id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum' },
}
const PACKET = { id: 'item-seed-1', name: 'Black Krim seed packet', category: 'seeds', variety_id: 'var-1', quantity_on_hand: 5 }
const VARIETY = { id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum', genus: 'Solanum' }

// Resolves on a MACROTASK — strictly later than the synchronous flush the ?edit= param strip
// schedules. A by-id GET that resolves synchronously cannot distinguish the fixed code from the
// broken code, so `byId` exists to let one test spend the extra tick.
const late = value => new Promise(resolve => { setTimeout(() => resolve(value), 0) })

function primeFetch({ plants = [PLANT], byId = () => Promise.resolve(PLANT) } = {}) {
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (url === '/api/projects') return Promise.resolve(PROJECTS)
    if (url === '/api/plants?view=grid' && !opts.method) return Promise.resolve(plants)
    // V4-PLANTSPAYLOAD-001: the list is the grid projection now, so ?edit= resolves its target with
    // a by-id GET. The wide shape lives HERE, which is the point — the projected list row could not
    // prefill this form.
    if (url === '/api/plants/plant-2' && !opts.method) return byId()
    if (url === '/api/inventory-items/item-seed-1') return Promise.resolve(PACKET)
    if (url === '/api/varieties/var-1') return Promise.resolve(VARIETY)
    if (url === '/api/plants' && opts.method === 'POST') return Promise.resolve({ id: 'plant-new', name: 'X', project_id: 'proj-1' })
    if (url.startsWith('/api/plants/') && opts.method === 'PUT') return Promise.resolve({ ...PLANT, name: 'Renamed' })
    if (url.startsWith('/api/plants/') && opts.method === 'DELETE') return Promise.resolve({})
    if (url.includes('/archive') && opts.method === 'PATCH') return Promise.resolve({ id: 'plant-2', archived_at: '2026-06-12T00:00:00Z' })
    return Promise.resolve([])
  })
}

beforeEach(() => {
  localStorage.clear()
  fetchSpy.mockReset()
  resetRouterHarness()
})

// `query` is the raw query string the deep link arrives with, e.g. 'edit=plant-2'.
async function renderGarden(query = '') {
  const view = await renderWithRouter(<Garden />, { route: '/garden' + (query ? '?' + query : '') })
  await screen.findByText(/Log many/)
  return view
}

describe('Garden — ?add=1 opens the Add Planting editor (FAB entry)', () => {
  it('auto-opens the add form and strips the param', async () => {
    primeFetch()
    await renderGarden('add=1')
    expect(screen.getAllByText('Add planting').length).toBeGreaterThan(0)
    // The URL the router actually holds, not that a setter was called with something.
    expect(currentParams().get('add')).toBeNull()
  })

  it('does NOT open the editor without params', async () => {
    primeFetch()
    await renderGarden()
    expect(screen.queryByText('Add planting')).toBeNull()
  })

  // ★ The BottomNav FAB while ALREADY on /garden — `<Link to="/garden?add=1">` (BottomNav.jsx:89).
  // Same route, so Garden never remounts: the ONLY signal is the query changing underneath a live
  // component. The old frozen-ref mock could not express a URL change it did not itself seed, so
  // this path had no coverage at all; every ?add=1 test above enters on the initial render instead.
  it('opens the add form when ?add=1 arrives mid-session, without a remount', async () => {
    primeFetch()
    await renderGarden()
    expect(screen.queryByText('Add planting')).toBeNull()
    await navigateTo('/garden?add=1')
    expect(screen.getAllByText('Add planting').length).toBeGreaterThan(0)
    expect(currentParams().get('add')).toBeNull()
  })

  it('POST carries dual-write variety + planting-details union + project_id', async () => {
    primeFetch()
    await renderGarden('add=1')
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'New Plant' } })
    fireEvent.click(screen.getByTestId('vp-pick-black-krim'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add planting$/i }))
    })
    const postCall = fetchSpy.mock.calls.find(c => c[0] === '/api/plants' && c[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall[1].body)
    expect(body.name).toBe('New Plant')
    expect(body.variety_id).toBe('var-1')
    expect(body.variety).toBe('Black Krim')
    expect(body.project_id).toBe('proj-1')
    expect(body.sown_at).toBeNull()
    expect(body.source_type).toBeNull()
    expect(screen.queryAllByText('Add planting').length).toBe(0)
  })

  it('create success refetches /api/plants (V3-GARDEN-001)', async () => {
    // The POST /api/plants response lacks the nested variety_ref join, so the optimistic
    // prepend alone leaves the row variety-less until a tab refresh. onPlantCreated must
    // refetch the full hydrated list. Assert a SECOND bare GET /api/plants fires after Add
    // (mirrors Garden.photoUpload.test.jsx onUploadComplete refetch assertion). The extra
    // GET is satisfied by primeFetch's bare-GET branch returning the plants list.
    primeFetch()
    await renderGarden('add=1')
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'New Plant' } })
    fireEvent.click(screen.getByTestId('vp-pick-black-krim'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add planting$/i }))
    })
    await waitFor(() => {
      const plantGets = fetchSpy.mock.calls.filter(([u, o = {}]) => u === '/api/plants?view=grid' && !o.method)
      expect(plantGets.length).toBeGreaterThanOrEqual(2)
    })
  })
})

describe('Garden — plant-from-packet deep link (InventoryDetail entry)', () => {
  it('prefills name + variety from packet params and shows the packet banner', async () => {
    primeFetch()
    await renderGarden('source_inventory_item_id=item-seed-1&variety_id=var-1')
    await waitFor(() => expect(screen.getByText(/Planting from/)).toBeDefined())
    expect(screen.getByText(/Black Krim seed packet/)).toBeDefined()
    await waitFor(() => expect(screen.getByTestId('vp-value').textContent).toBe('Black Krim'))
    expect(screen.getByLabelText(/Name/i).value).toBe('Black Krim seed packet')
  })

  it('POST includes source_inventory_item_id', async () => {
    primeFetch()
    await renderGarden('source_inventory_item_id=item-seed-1&variety_id=var-1')
    await waitFor(() => expect(screen.getByText(/Planting from/)).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add planting$/i }))
    })
    const postCall = fetchSpy.mock.calls.find(c => c[0] === '/api/plants' && c[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall[1].body)
    expect(body.source_inventory_item_id).toBe('item-seed-1')
    expect(body.variety_id).toBe('var-1')
  })
})

describe('Garden — ?edit=<id> opens the edit editor (V3-EDIT-001 target)', () => {
  it('opens the edit form prefilled, strips the param', async () => {
    primeFetch()
    await renderGarden('edit=plant-2')
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    expect(screen.getByLabelText(/Name/i).value).toBe('Krim Plant')
    expect(screen.getByTestId('vp-value').textContent).toBe('Black Krim')
    expect(currentParams().get('edit')).toBeNull()
  })

  it('PUT body includes variety_id + flat variety (dual-write) on save', async () => {
    primeFetch()
    await renderGarden('edit=plant-2')
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Renamed' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))
    })
    const putCall = fetchSpy.mock.calls.find(c => c[0] === '/api/plants/plant-2' && c[1]?.method === 'PUT')
    expect(putCall).toBeDefined()
    const body = JSON.parse(putCall[1].body)
    expect(body.name).toBe('Renamed')
    expect(body.variety_id).toBe('var-1')
    expect(body.variety).toBe('Black Krim')
    expect(screen.queryByText(/Edit Krim Plant/)).toBeNull()
  })

  it('Remove deletes the planting and closes the editor', async () => {
    primeFetch()
    await renderGarden('edit=plant-2')
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Remove$/i }))
    })
    const delCall = fetchSpy.mock.calls.find(c => c[0] === '/api/plants/plant-2' && c[1]?.method === 'DELETE')
    expect(delCall).toBeDefined()
    expect(screen.queryByText(/Edit Krim Plant/)).toBeNull()
  })

  it('unknown edit id strips the param without opening an editor', async () => {
    primeFetch()
    await renderGarden('edit=nope')
    expect(screen.queryByText(/^Edit /)).toBeNull()
    expect(currentParams().get('edit')).toBeNull()
  })

  // ★ BUG-EDITDEEPLINKRACE-001, guarded from INSIDE the file that hid it. The effect strips `edit`
  // before awaiting the by-id GET; the strip changes `location.search`, `useSearchParams`
  // re-memoises on it, both of the effect's params deps change and React runs the cleanup on that
  // same synchronous flush. An effect-local cancel flag was therefore false before any response
  // could land, so the editor never opened — 100% of the time, for four days and nine releases.
  // The cancel flag has to be TEARDOWN-scoped (`editDeepLinkMountedRef`) for this to pass.
  //
  // The sibling cases above resolve the GET synchronously and that is deliberate — they assert the
  // wire contract, not the ordering. This one buys the extra macrotask so the response is
  // unambiguously later than the strip's flush, which is what makes it able to fail.
  it('opens the editor when the by-id GET resolves AFTER the param-strip re-render', async () => {
    primeFetch({ byId: () => late(PLANT) })
    await renderGarden('edit=plant-2')
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    expect(screen.getByLabelText(/Name/i).value).toBe('Krim Plant')
    expect(currentParams().get('edit')).toBeNull()
  })
})

describe('Garden — V3-ARCHIVE-001 archive a planting (edit editor)', () => {
  it('Archive PATCHes archived:true, closes editor, shows ambient Undo', async () => {
    primeFetch()
    await renderGarden('edit=plant-2')
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Archive$/i }))
    })
    const arc = fetchSpy.mock.calls.find(c => c[0] === '/api/plants/plant-2/archive' && c[1]?.method === 'PATCH')
    expect(arc).toBeDefined()
    expect(JSON.parse(arc[1].body).archived).toBe(true)
    expect(screen.queryByText(/Edit Krim Plant/)).toBeNull()
    // Ambient confirmation + Undo affordance (operational confirmation, non-modal).
    await waitFor(() => expect(screen.getByText(/Archived/)).toBeDefined())
    expect(screen.getByRole('button', { name: /^Undo$/i })).toBeDefined()
  })

  it('Undo PATCHes archived:false', async () => {
    primeFetch()
    await renderGarden('edit=plant-2')
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Archive$/i })) })
    await waitFor(() => expect(screen.getByRole('button', { name: /^Undo$/i })).toBeDefined())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Undo$/i })) })
    const calls = fetchSpy.mock.calls.filter(c => c[0] === '/api/plants/plant-2/archive' && c[1]?.method === 'PATCH')
    expect(calls.length).toBe(2)
    expect(JSON.parse(calls[1][1].body).archived).toBe(false)
  })
})

// BUG-COALESCECLEAR-001 — the clear:[] channel on the planting edit form.
//
// The plants PUT binds its optional columns as COALESCE(${body.x ?? null}, x), so `null` and
// `absent` are the same token on the wire. Every field below already sent `form.x.trim() || null`
// for an emptied box, which the handler read as "not supplied" and answered with a 200 and no
// change. The server allowlist has existed since BUG-COALESCECLEAR-001 landed; until this wiring
// the channel was inert from the UI, which is the exact state the server half shipped in.
describe('Garden — the planting editor can actually clear a field', () => {
  // Distinct from PLANT: the channel only fires when the SAVED row held a value, so a fixture with
  // notes: null could never exercise it.
  const PLANT_FILLED = {
    ...PLANT,
    notes: 'started under the south light',
    source_ref: "Johnny's Lot 4421",
    container_size: '4in',
  }

  function primeFilled() {
    fetchSpy.mockImplementation((url, opts = {}) => {
      if (url === '/api/projects') return Promise.resolve(PROJECTS)
      if (url === '/api/plants?view=grid' && !opts.method) return Promise.resolve([PLANT_FILLED])
      if (url === '/api/plants/plant-2' && !opts.method) return Promise.resolve(PLANT_FILLED)
      if (url.startsWith('/api/plants/') && opts.method === 'PUT') return Promise.resolve(PLANT_FILLED)
      return Promise.resolve([])
    })
  }

  async function openEditorAndSave(mutate) {
    primeFilled()
    await renderGarden('edit=plant-2')
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    mutate()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Save$/i })) })
    const put = fetchSpy.mock.calls.find(c => c[0] === '/api/plants/plant-2' && c[1]?.method === 'PUT')
    expect(put).toBeDefined()
    return JSON.parse(put[1].body)
  }

  it('emptying Notes sends clear:["notes"] alongside the null', async () => {
    const body = await openEditorAndSave(() => {
      fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: '' } })
    })
    // Both halves matter: the null is what the old code sent and is now merely inert, and `clear`
    // is the part the handler actually acts on.
    expect(body.notes).toBeNull()
    expect(body.clear).toContain('notes')
  })

  it('clears several emptied fields in one save', async () => {
    const body = await openEditorAndSave(() => {
      fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: '' } })
      fireEvent.change(screen.getByLabelText(/Source reference/i), { target: { value: '' } })
    })
    expect([...body.clear].sort()).toEqual(['notes', 'source_ref'])
  })

  it('a save with nothing emptied sends NO clear key at all', async () => {
    // The byte-identity guarantee that let this ship without re-testing every existing save path.
    const body = await openEditorAndSave(() => {
      fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Renamed' } })
    })
    expect(body.name).toBe('Renamed')
    expect('clear' in body).toBe(false)
  })

  it('does NOT clear a field that was already empty', async () => {
    // saved[k] == null means there is nothing to clear; without this half every save would
    // pointlessly re-clear every blank column.
    const body = await openEditorAndSave(() => {
      fireEvent.change(screen.getByLabelText(/Generation/i), { target: { value: '' } })
    })
    expect('clear' in body).toBe(false)
  })

  it('drops an emptied field the server refuses to clear rather than sending it', async () => {
    // status is rendered and IS emptied here, but it is a tier-2 care-engine input: clearing it
    // resumes calendar watering on a dormant plant and skips the status_change audit row. The
    // client drops it so the user's OTHER edits still save — sending it would make the server 400
    // the whole request and the user would lose the lot.
    const body = await openEditorAndSave(() => {
      // By id, not by label: several labels on this page match /Status/i.
      fireEvent.change(document.getElementById('edit-plant-2-status'), { target: { value: '' } })
      fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: '' } })
    })
    expect(body.clear).toContain('notes')
    expect(body.clear).not.toContain('status')
  })
})

// ── V4-PLANTEDITORWIRE-001 — the dirty contract over the embedded PlantingEditor ─────────────────
//
// /garden carried NO guard at all before this: the one region on the page that holds typed content
// is a child component that owns its field state privately, and until V4-PLANTEDITORDIRTY-001 gave
// it `onDirty` there was nothing for the page to observe. These tests prove the whole chain — a
// keystroke inside PlantingEditor reaching the REAL reloadGate — not just that Garden passes a prop.
//
// Nothing spies on setReloadBlocked. A spy proves a call happened, not that the gate ends up held,
// and that exact blind spot is how the gate primitive shipped with zero callers and a green suite.
//
// The NEGATIVE cases carry the weight. Over-reporting here is not a cosmetic defect: it holds a
// service-worker update (BUG-STALECLIENT-001's shape, deferred rather than cancelled precisely so
// it cannot recur) for a user who only opened a form and typed nothing. Three separate ways to get
// that wrong are pinned below — a merely-opened add form, an edit form seeded from a planting that
// already HAS a name and notes, and a packet deep-link that fills the Name box by machine.
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

describe('Garden — reload gate over the embedded editor (V4-PLANTEDITORWIRE-001)', () => {
  beforeEach(() => { clearReloadBlocks() })

  it('holds nothing while the garden is merely being browsed', async () => {
    primeFetch()
    await renderGarden()
    expect(screen.queryByLabelText(/Name/i)).toBeNull()
    expect(isReloadBlocked()).toBe(false)
  })

  // ★ The nag case. An editor the user opened and has not typed into is not unsaved work, and a
  // guard that fired here would hold a deploy for every FAB tap on the page.
  it('does NOT hold when the add editor is merely opened', async () => {
    primeFetch()
    await renderGarden('add=1')
    expect(screen.getByLabelText(/Name/i)).toBeDefined()
    expect(isReloadBlocked()).toBe(false)
  })

  it('holds the reload on the first keystroke in the add editor', async () => {
    primeFetch()
    await renderGarden('add=1')
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Sungold' } })
    })
    expect(isReloadBlocked()).toBe(true)
  })

  // A pick is not a keystroke and travels a different path into the form (VarietyPicker's onChange,
  // not a DOM change event on an <input>), so it gets its own assertion rather than being assumed.
  it('holds the reload for a VARIETY PICK, not just typed text', async () => {
    primeFetch()
    await renderGarden('add=1')
    expect(isReloadBlocked()).toBe(false)
    await act(async () => { fireEvent.click(screen.getByTestId('vp-pick-black-krim')) })
    expect(screen.getByTestId('vp-value').textContent).toBe('Black Krim')
    expect(isReloadBlocked()).toBe(true)
  })

  // ★ The predicate an "any value is non-empty" version fails. Every box in this form arrives
  // filled — name, variety, quantity, status — because it is seeded FROM the planting being edited.
  it('does NOT hold when the EDIT editor opens prefilled from a real planting', async () => {
    primeFetch()
    await renderGarden('edit=plant-2')
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    // The seed genuinely landed — otherwise this asserts nothing about prefilled fields.
    expect(screen.getByLabelText(/Name/i).value).toBe('Krim Plant')
    expect(isReloadBlocked()).toBe(false)
  })

  it('holds once the prefilled edit form is actually changed', async () => {
    primeFetch()
    await renderGarden('edit=plant-2')
    await waitFor(() => expect(screen.getByText(/Edit Krim Plant/)).toBeDefined())
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: 'potted on' } })
    })
    expect(isReloadBlocked()).toBe(true)
  })

  // ★ Machine-seeded fields are not the user's unsaved work. This is the deep link
  // InventoryDetail's "Plant this" opens: /garden?source_inventory_item_id=…&variety_id=…, which
  // fetches the packet and writes the Name box itself.
  it('does NOT hold for a packet deep-link prefill', async () => {
    primeFetch()
    await renderGarden('source_inventory_item_id=item-seed-1&variety_id=var-1')
    await waitFor(() => expect(screen.getByLabelText(/Name/i).value).toBe('Black Krim seed packet'))
    await waitFor(() => expect(screen.getByTestId('vp-value').textContent).toBe('Black Krim'))
    expect(isReloadBlocked()).toBe(false)
  })

  it('releases when a dirty editor is CANCELLED — a closed form must not wedge updates', async () => {
    primeFetch()
    await renderGarden('add=1')
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Sungold' } })
    })
    expect(isReloadBlocked()).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i })) })
    expect(screen.queryByLabelText(/Name/i)).toBeNull()
    expect(isReloadBlocked()).toBe(false)
  })

  it('releases on a successful save — the save is what makes the typing safe', async () => {
    primeFetch()
    await renderGarden('add=1')
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Sungold' } })
    })
    expect(isReloadBlocked()).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add planting$/i }))
    })
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
  })

  // The other half of BUG-STALECLIENT-001's lesson: a hold that outlives its form can never be
  // resolved by the user, because there is no form left on screen to clean or close.
  it('releases when Garden itself unmounts with a dirty editor open', async () => {
    primeFetch()
    const view = await renderGarden('add=1')
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Sungold' } })
    })
    expect(isReloadBlocked()).toBe(true)
    act(() => { view.unmount() })
    expect(isReloadBlocked()).toBe(false)
  })
})

// ── V4-OVERLAYSLICE3-001 — the Sheet dismissal guard ────────────────────────────────────────────
//
// WHY THIS EXISTS. Moving Add Planting into a <Sheet> ADDED dismissal gestures the inline form
// never had, and Sheet does not guard them: `dirty` gates the BACKDROP TAP only, because
// confirmOnDirty defaults FALSE at both registry call sites (dismissLayers.js:78, backNav.js:75)
// pending the ConfirmSheet primitive. MEASURED in tests/harness on the un-guarded build: typing a
// name and pressing Escape closed the sheet, raised NO confirm, and discarded the typing. Dave is
// Android-only and hardware Back routes through the same decision, so this is the gesture at risk.
//
// The guard lives in Garden (requestCloseEditor), NOT in PlantingEditor: the editor's own Cancel
// and its post-save close must not prompt, and a save that SUCCEEDED must never ask to discard.
describe('Garden — Sheet dismissal guard (V4-OVERLAYSLICE3-001)', () => {
  const typeName = (v) => fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: v } })
  const escape = () => fireEvent.keyDown(document, { key: 'Escape' })
  const editorMounted = () => !!document.getElementById('planting-editor')

  it('a DIRTY form survives Escape when the user declines, and keeps the typing', async () => {
    primeFetch()
    await renderGarden('add=1')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    typeName('Half Typed Plant')
    await act(async () => { escape() })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(editorMounted()).toBe(true)
    // The whole point: the characters are still there, not just the sheet.
    expect(screen.getByLabelText(/Name/i).value).toBe('Half Typed Plant')
    confirmSpy.mockRestore()
  })

  it('Escape DOES discard once the user accepts — the guard must not be a trap', async () => {
    primeFetch()
    await renderGarden('add=1')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    typeName('Half Typed Plant')
    await act(async () => { escape() })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(editorMounted()).toBe(false)
    confirmSpy.mockRestore()
  })

  it('a CLEAN form closes on Escape with NO prompt — no nag on an untouched sheet', async () => {
    primeFetch()
    await renderGarden('add=1')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => { escape() })
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(editorMounted()).toBe(false)
    confirmSpy.mockRestore()
  })
})
