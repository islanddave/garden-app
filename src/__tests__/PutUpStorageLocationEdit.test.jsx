// OPS-STORAGELOCNODOOR-001 — the storage-location rename/delete door that was missing.
//
// THE DEFECT THESE LOCK IN. lambda/storage-location/index.js has shipped PUT /:id (:88-104) and
// DELETE /:id (:106-121) since V4-HARVESTCENTER-001, and a repo-wide grep found NO frontend caller
// for either — the client only ever GET and POST. A mistyped or obsolete freezer label was therefore
// permanent. Every assertion below is about THE WIRE (which verb, which path, which body) plus the
// two-step confirm, because a door that renders and calls the wrong route is the same defect wearing
// a UI.
//
// FIXTURES ARE THE REAL DISTRIBUTION, and it is degenerate: live prod carries exactly THREE rows,
// all kind='deep_freezer', all owned by Dave and NONE by Jen — while chk_storage_location_kind
// already permits fridge / pantry / cold_storage. That gap is what the kind control exists to close,
// so the prod three are reproduced verbatim and the two rows prod lacks (a household peer's, and one
// with an off-list kind) are added because a fixture that only contains the happy path cannot fail.
//
// CI LANE: `npm test` (vitest run --coverage). Nothing here is date-sensitive, so the blocking TZ
// re-run is a no-op over this file — stated rather than assumed.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({ cropTypes: [{ slug: 'tomato', display_name: 'Tomato', category: 'vegetable' }], loading: false }),
}))

import PutUp from '../pages/PutUp.jsx'

// The prod three, verbatim: three rows, all deep_freezer, all Dave's.
const PROD_THREE = [
  { id: 'loc-1', user_id: 'user_dave', label: 'Chest Freezer 1', kind: 'deep_freezer' },
  { id: 'loc-2', user_id: 'user_dave', label: 'Chest Freezer 2', kind: 'deep_freezer' },
  { id: 'loc-3', user_id: 'user_dave', label: 'Garage freezr', kind: 'deep_freezer' },  // the typo this door exists for
]
// The two rows prod does not have. JEN is the ownership pair — a single-owner fixture cannot fail an
// ownership bug, and household scoping is the SERVER's job, so the client must not hide her row.
const JEN = { id: 'loc-4', user_id: 'user_jen', label: "Jen's fridge", kind: 'fridge' }
const OFF_LIST = { id: 'loc-5', user_id: 'user_dave', label: 'Old crock shelf', kind: 'root_cellar_v0' }

function wire({ locations = PROD_THREE, onPut, onDelete } = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path.startsWith('/api/kitchen-batches')) return Promise.reject(new Error('no such table'))
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve(locations)
    if (path.startsWith('/api/storage-locations/') && method === 'PUT') {
      return onPut ? onPut(path, options) : Promise.resolve({ ...JSON.parse(options.body), id: path.split('/').pop() })
    }
    if (path.startsWith('/api/storage-locations/') && method === 'DELETE') {
      return onDelete ? onDelete(path, options) : Promise.resolve({ ok: true })
    }
    if (path.startsWith('/api/plants?')) return Promise.resolve([])
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ group_by: 'storage', groups: [] })
    return Promise.resolve(null)
  })
}

// A prefill lands straight on the log form, where the manage door lives.
function renderForm() {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/put-up', state: { prefill: { crop_type_slug: 'tomato' } } }]}>
      <PutUp />
    </MemoryRouter>,
  )
}

async function openEditor() {
  renderForm()
  fireEvent.click(await screen.findByTestId('pu-manage-locations'))
  return screen.getByTestId('pu-location-editor')
}

const rowFor = (id) => screen.getAllByTestId('pu-location-row').find(r => r.getAttribute('data-loc-id') === id)
const writeCalls = (m) => fetchMock.mock.calls.filter(([, o]) => o?.method === m)

beforeEach(() => { fetchMock.mockReset(); wire(); localStorage.clear(); sessionStorage.clear() })

describe('the manage door', () => {
  it('is absent when there is nothing to edit — a door onto an empty list is furniture', async () => {
    wire({ locations: [] })
    renderForm()
    await screen.findByRole('button', { name: /New location/i })
    expect(screen.queryByTestId('pu-manage-locations')).toBeNull()
  })

  it('appears beside the creator once locations exist, and toggles closed again', async () => {
    renderForm()
    const door = await screen.findByTestId('pu-manage-locations')
    expect(door.textContent).toBe('Edit locations')
    fireEvent.click(door)
    expect(screen.getByTestId('pu-manage-locations').textContent).toBe('Done editing')
    expect(screen.getAllByTestId('pu-location-row')).toHaveLength(3)
    fireEvent.click(screen.getByTestId('pu-manage-locations'))
    expect(screen.queryByTestId('pu-location-editor')).toBeNull()
  })

  it('lists every location with its label and its kind spelled out', async () => {
    await openEditor()
    const row = rowFor('loc-3')
    expect(within(row).getByText('Garage freezr')).toBeTruthy()
    expect(within(row).getByText('Deep freezer')).toBeTruthy()
  })
})

describe('rename — PUT /api/storage-locations/:id', () => {
  it('sends the corrected label to the right route with the right verb', async () => {
    await openEditor()
    fireEvent.click(within(rowFor('loc-3')).getByTestId('pu-location-rename'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Location name' }), { target: { value: 'Garage freezer' } })
    fireEvent.click(screen.getByTestId('pu-location-save'))
    await waitFor(() => expect(writeCalls('PUT')).toHaveLength(1))
    const [path, opts] = writeCalls('PUT')[0]
    expect(path).toBe('/api/storage-locations/loc-3')
    expect(opts.method).toBe('PUT')
    expect(JSON.parse(opts.body)).toEqual({ label: 'Garage freezer', kind: 'deep_freezer' })
  })

  it('reflects the new label back into the picker without a refetch', async () => {
    await openEditor()
    fireEvent.click(within(rowFor('loc-3')).getByTestId('pu-location-rename'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Location name' }), { target: { value: 'Garage freezer' } })
    fireEvent.click(screen.getByTestId('pu-location-save'))
    await waitFor(() => expect(screen.queryByTestId('pu-location-save')).toBeNull())
    const options = [...screen.getByRole('combobox', { name: 'Storage location' }).options].map(o => o.textContent)
    expect(options).toEqual(['— Unassigned —', 'Chest Freezer 1', 'Chest Freezer 2', 'Garage freezer'])
  })

  it('trims the label rather than storing the whitespace', async () => {
    await openEditor()
    fireEvent.click(within(rowFor('loc-1')).getByTestId('pu-location-rename'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Location name' }), { target: { value: '  Deep freeze  ' } })
    fireEvent.click(screen.getByTestId('pu-location-save'))
    await waitFor(() => expect(writeCalls('PUT')).toHaveLength(1))
    expect(JSON.parse(writeCalls('PUT')[0][1].body).label).toBe('Deep freeze')
  })

  it('refuses a blank name and sends NOTHING — btrim(label) <> \'\' is a DB CHECK, not a suggestion', async () => {
    await openEditor()
    fireEvent.click(within(rowFor('loc-1')).getByTestId('pu-location-rename'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Location name' }), { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('pu-location-save'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Give the location a name.'))
    expect(writeCalls('PUT')).toHaveLength(0)
  })

  it('names the failure class when the write fails and keeps the row on screen', async () => {
    const err = new Error('nope'); err.status = 500
    wire({ onPut: () => Promise.reject(err) })
    await openEditor()
    fireEvent.click(within(rowFor('loc-1')).getByTestId('pu-location-rename'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Location name' }), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByTestId('pu-location-save'))
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toBe("Couldn't save that change — try again. (SRV)"))
    expect(screen.getByRole('textbox', { name: 'Location name' }).value).toBe('Renamed')
  })
})

describe('kind is settable — the data gap, not a schema gap', () => {
  it('offers every kind chk_storage_location_kind already permits', async () => {
    await openEditor()
    fireEvent.click(within(rowFor('loc-1')).getByTestId('pu-location-rename'))
    const kinds = [...screen.getByRole('combobox', { name: 'Location kind' }).options].map(o => o.value)
    // The handler's VALID_KINDS, exactly. fridge / pantry / cold_storage are the three prod has
    // never used and are the whole reason a ferment cannot yet be tracked counter → fridge → pantry.
    expect(kinds).toEqual(['deep_freezer', 'fridge_freezer', 'fridge', 'pantry', 'cold_storage', 'other'])
  })

  it('moves a deep_freezer to a pantry on the wire', async () => {
    await openEditor()
    fireEvent.click(within(rowFor('loc-1')).getByTestId('pu-location-rename'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Location kind' }), { target: { value: 'pantry' } })
    fireEvent.click(screen.getByTestId('pu-location-save'))
    await waitFor(() => expect(writeCalls('PUT')).toHaveLength(1))
    expect(JSON.parse(writeCalls('PUT')[0][1].body)).toEqual({ label: 'Chest Freezer 1', kind: 'pantry' })
  })

  it('keeps an unrecognised kind as the initial selection instead of rewriting it to deep_freezer', async () => {
    // A form opened to fix a typo must not silently re-file the row. VALID_KINDS and STORAGE_KINDS
    // agree today; this is what stops a future drift in either list from mutating data through it.
    wire({ locations: [OFF_LIST] })
    await openEditor()
    fireEvent.click(within(rowFor('loc-5')).getByTestId('pu-location-rename'))
    expect(screen.getByRole('combobox', { name: 'Location kind' }).value).toBe('root_cellar_v0')
    fireEvent.click(screen.getByTestId('pu-location-save'))
    await waitFor(() => expect(writeCalls('PUT')).toHaveLength(1))
    expect(JSON.parse(writeCalls('PUT')[0][1].body).kind).toBe('root_cellar_v0')
  })
})

describe('delete — two taps, and the second one says what it does', () => {
  it('does NOT delete on the first tap', async () => {
    await openEditor()
    fireEvent.click(within(rowFor('loc-2')).getByTestId('pu-location-delete'))
    expect(screen.getByTestId('pu-location-confirm-delete')).toBeTruthy()
    expect(writeCalls('DELETE')).toHaveLength(0)
  })

  it('states the consequence exactly, with no invented count', async () => {
    // The handler soft-deletes (SET deleted_at = NOW()), and the four read surfaces LEFT JOIN
    // storage_location with NO deleted_at predicate — so referencing preservation_log rows keep
    // rendering this label and there is no FK violation to guard against. The confirm says that and
    // nothing more; a "3 items are stored here" line would be a number this component never fetched.
    await openEditor()
    fireEvent.click(within(rowFor('loc-2')).getByTestId('pu-location-delete'))
    expect(screen.getByTestId('pu-location-delete-consequence').textContent.replace(/\s+/g, ' ').trim())
      .toBe('Delete “Chest Freezer 2”? Anything already stored there keeps this label — '
        + 'it just stops being offered for new put-ups.')
    expect(screen.getByRole('button', { name: 'Yes, delete' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeTruthy()
  })

  it('sends DELETE to the right route and drops the row from the picker', async () => {
    await openEditor()
    fireEvent.click(within(rowFor('loc-2')).getByTestId('pu-location-delete'))
    fireEvent.click(screen.getByTestId('pu-location-delete-confirm'))
    await waitFor(() => expect(writeCalls('DELETE')).toHaveLength(1))
    expect(writeCalls('DELETE')[0][0]).toBe('/api/storage-locations/loc-2')
    const options = [...screen.getByRole('combobox', { name: 'Storage location' }).options].map(o => o.textContent)
    expect(options).toEqual(['— Unassigned —', 'Chest Freezer 1', 'Garage freezr'])
  })

  it('drops the deleted id from the SAVED ROW when it was the one selected', async () => {
    // ASSERTED ON THE WIRE, not on the Select. The DOM version of this test was VACUOUS and a
    // mutation run proved it: removing the onClearSelected call entirely left it green, because a
    // <select> whose value matches no remaining <option> reports '' all by itself. React state still
    // held 'loc-2', so the next save would have written a deleted location id — invisible in the
    // DOM, visible in the request body. Only the POST can tell the two apart.
    await openEditor()
    const picker = screen.getByRole('combobox', { name: 'Storage location' })
    fireEvent.change(picker, { target: { value: 'loc-2' } })
    expect(picker.value).toBe('loc-2')
    fireEvent.click(within(rowFor('loc-2')).getByTestId('pu-location-delete'))
    fireEvent.click(screen.getByTestId('pu-location-delete-confirm'))
    await waitFor(() => expect(writeCalls('DELETE')).toHaveLength(1))

    fireEvent.click(screen.getByTestId('pu-manage-locations'))       // close the editor
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: /Save put-up/i }))
    await waitFor(() => expect(writeCalls('POST')).toHaveLength(1))
    expect(JSON.parse(writeCalls('POST')[0][1].body).storage_location_id).toBeUndefined()
  })

  it('"Keep it" backs out and sends nothing', async () => {
    await openEditor()
    fireEvent.click(within(rowFor('loc-2')).getByTestId('pu-location-delete'))
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByTestId('pu-location-confirm-delete')).toBeNull()
    expect(writeCalls('DELETE')).toHaveLength(0)
  })

  it('names the failure class and keeps the row when the delete fails', async () => {
    const err = new Error('gone'); err.status = 404
    wire({ onDelete: () => Promise.reject(err) })
    await openEditor()
    fireEvent.click(within(rowFor('loc-2')).getByTestId('pu-location-delete'))
    fireEvent.click(screen.getByTestId('pu-location-delete-confirm'))
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toBe("Couldn't delete that location — try again. (HTTP404)"))
    expect(rowFor('loc-2')).toBeTruthy()
  })
})

describe('a two-user household', () => {
  it('lists and can rename a household peer\'s location — scoping is the server\'s job', async () => {
    wire({ locations: [...PROD_THREE, JEN] })
    await openEditor()
    expect(screen.getAllByTestId('pu-location-row')).toHaveLength(4)
    const row = rowFor('loc-4')
    expect(within(row).getByText("Jen's fridge")).toBeTruthy()
    expect(within(row).getByText('Fridge')).toBeTruthy()
    fireEvent.click(within(row).getByTestId('pu-location-rename'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Location name' }), { target: { value: 'Kitchen fridge' } })
    fireEvent.click(screen.getByTestId('pu-location-save'))
    await waitFor(() => expect(writeCalls('PUT')).toHaveLength(1))
    expect(writeCalls('PUT')[0][0]).toBe('/api/storage-locations/loc-4')
  })
})

describe('the freezer walk keeps the creator and does NOT get the manage door', () => {
  it('offers "＋ New location" under "Somewhere else" with no editing affordance', async () => {
    render(<MemoryRouter initialEntries={['/put-up?session=putup']}><PutUp /></MemoryRouter>)
    // Renaming vocabulary is a deliberate, desk-posture act. The walk is a hands-wet sitting whose
    // job is one item at a time, and a Delete button beside a freezer chip there is a hazard.
    fireEvent.click(await screen.findByRole('button', { name: '＋ Somewhere else' }))
    expect(await screen.findByRole('button', { name: /New location/i })).toBeTruthy()
    expect(screen.queryByTestId('pu-manage-locations')).toBeNull()
    expect(screen.queryByTestId('pu-location-editor')).toBeNull()
  })
})
