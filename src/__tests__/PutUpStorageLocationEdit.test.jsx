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

function wire({ locations = PROD_THREE, onPut, onDelete, onPost } = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path.startsWith('/api/kitchen-batches')) return Promise.reject(new Error('no such table'))
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve(locations)
    if (path === '/api/storage-locations' && method === 'POST' && onPost) return onPost(path, options)
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

// Put-Up release 1a (V4 §6.5) — every write on the page reads the server's `code`. The storage
// Lambda sends none today, so these pin the other half too: an uncoded failure above keeps its
// diagnostic line, a coded one says what the server said. The error is shaped the way api.js throws
// it (message = body.error, .status, .body) — PutUp.refusals.test.jsx proves that shape against the
// real api.js.
describe('a coded refusal is shown in the server’s words (rename and delete)', () => {
  const refusal = (body) => Object.assign(new Error(body.error), { status: 409, body })

  it('rename', async () => {
    wire({ onPut: () => Promise.reject(refusal({ error: 'You already have a place called Chest Freezer 2', code: 'location_label_taken' })) })
    await openEditor()
    fireEvent.click(within(rowFor('loc-1')).getByTestId('pu-location-rename'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Location name' }), { target: { value: 'Chest Freezer 2' } })
    fireEvent.click(screen.getByTestId('pu-location-save'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('You already have a place called Chest Freezer 2'))
    expect(screen.getByRole('textbox', { name: 'Location name' }).value).toBe('Chest Freezer 2')
  })

  it('delete', async () => {
    wire({ onDelete: () => Promise.reject(refusal({ error: 'Something is still stored there', code: 'location_in_use' })) })
    await openEditor()
    fireEvent.click(within(rowFor('loc-2')).getByTestId('pu-location-delete'))
    fireEvent.click(screen.getByTestId('pu-location-delete-confirm'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Something is still stored there'))
    expect(rowFor('loc-2')).toBeTruthy()
  })
})

// Put-Up release 1a (brief addendum 6) — from 1b a duplicate place name is refused by the database, and
// the storage Lambda answers a duplicate CREATE with the existing place (200, `existing: true`) and a
// duplicate RENAME/RE-KIND with a coded 409 place_exists carrying a plain message and the existing id.
// The creator selects the place either way (a create-409, if one ever arrives, is "select that place");
// the rename shows the message and keeps the edit. The 409s are shaped the way api.js throws them.
describe('a place that already exists (create selects it; rename says so and keeps the edit)', () => {
  const placeExists = (body) => Object.assign(new Error(body.error ?? 'HTTP 409'), { status: 409, body: { code: 'place_exists', ...body } })
  const storageSelect = () => screen.getByRole('combobox', { name: 'Storage location' })
  const optionsLabelled = (text) => [...storageSelect().options].filter(o => o.textContent === text)
  function create(name, kindValue) {
    fireEvent.click(screen.getByRole('button', { name: /New location/i }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New location name' }), { target: { value: name } })
    if (kindValue) fireEvent.change(screen.getByRole('combobox', { name: 'Location kind' }), { target: { value: kindValue } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  }

  it('a create answered with a place already in the list (200, existing: true) selects it and lists it once', async () => {
    wire({ onPost: () => Promise.resolve({ ...PROD_THREE[0], existing: true }) })
    renderForm()
    await screen.findByTestId('pu-manage-locations')
    create('chest freezer 1')
    await waitFor(() => expect(storageSelect().value).toBe('loc-1'))
    expect(optionsLabelled('Chest Freezer 1')).toHaveLength(1)
    expect(screen.queryByRole('textbox', { name: 'New location name' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('an existing place the list had not loaded is added once and selected', async () => {
    wire({ onPost: () => Promise.resolve({ id: 'loc-9', user_id: 'user_jen', label: 'Porch fridge', kind: 'fridge', existing: true }) })
    renderForm()
    await screen.findByTestId('pu-manage-locations')
    create('Porch fridge', 'fridge')
    await waitFor(() => expect(storageSelect().value).toBe('loc-9'))
    expect(optionsLabelled('Porch fridge')).toHaveLength(1)
  })

  it('a create refused 409 place_exists selects the named place instead of failing, keeping the stored label', async () => {
    wire({ onPost: () => Promise.reject(placeExists({ message: 'You already have a place called Chest Freezer 2.', id: 'loc-2' })) })
    renderForm()
    await screen.findByTestId('pu-manage-locations')
    create('chest freezer 2')
    await waitFor(() => expect(storageSelect().value).toBe('loc-2'))
    expect(optionsLabelled('Chest Freezer 2')).toHaveLength(1)
    expect(optionsLabelled('chest freezer 2')).toHaveLength(0)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'New location name' })).toBeNull()
  })

  it('the id is read in the other spellings too, and a 409 with no id says what the server said', async () => {
    wire({ onPost: () => Promise.reject(placeExists({ message: 'Already there', existing_id: 'loc-3' })) })
    const first = renderForm()
    await screen.findByTestId('pu-manage-locations')
    create('garage freezr')
    await waitFor(() => expect(storageSelect().value).toBe('loc-3'))
    first.unmount()

    wire({ onPost: () => Promise.reject(placeExists({ message: 'That place is already there.' })) })
    renderForm()
    await screen.findByTestId('pu-manage-locations')
    create('chest freezer 1')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That place is already there.'))
    expect(screen.getByRole('textbox', { name: 'New location name' }).value).toBe('chest freezer 1')
  })

  it('a rename onto an existing name shows the server’s message and keeps the edit', async () => {
    wire({ onPut: () => Promise.reject(placeExists({ message: 'You already have a place called Chest Freezer 1.', error: 'duplicate key', id: 'loc-1' })) })
    await openEditor()
    fireEvent.click(within(rowFor('loc-3')).getByTestId('pu-location-rename'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Location name' }), { target: { value: 'Chest Freezer 1' } })
    fireEvent.click(screen.getByTestId('pu-location-save'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('You already have a place called Chest Freezer 1.'))
    expect(screen.getByRole('textbox', { name: 'Location name' }).value).toBe('Chest Freezer 1')
    expect(screen.getByTestId('pu-location-save')).toBeTruthy()
    // A rename refusal is never read as "select that place": the editor is still on loc-3.
    expect(within(rowFor('loc-3')).getByRole('textbox', { name: 'Location name' })).toBeTruthy()
  })
})

// B′ release 2 (V4 §2.2, Appendix B): the freezer walk is Walk a place. Its "＋ Somewhere else" is the
// Appendix B creator (a name + a kind), made by find-or-create when the walk starts — so an answer that
// names a place already there must select THAT place and list it once.
describe('a place that already exists — the walk lists it once', () => {
  it('a walk create answered with an existing place selects its chip and adds no second chip', async () => {
    wire({ onPost: () => Promise.resolve({ ...PROD_THREE[1], existing: true }) })
    render(<MemoryRouter initialEntries={['/put-up?session=putup']}><PutUp /></MemoryRouter>)
    fireEvent.click(await screen.findByTestId('putup-walk-place-new'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name of the place' }), { target: { value: 'Chest Freezer 2' } })
    fireEvent.click(screen.getByTestId('putup-walk-place-new-kind-deep_freezer'))
    fireEvent.click(screen.getByTestId('putup-walk-place-new-use'))
    fireEvent.click(screen.getByTestId('putup-walk-when-this_month'))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByTestId('putup-walk-band')
    expect(writeCalls('POST').filter(([p]) => p === '/api/storage-locations')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('putup-walk-change'))
    const chips = within(await screen.findByRole('radiogroup', { name: 'Which place are you at?' })).getAllByRole('radio')
    expect(chips.filter(c => c.textContent === 'Chest Freezer 2')).toHaveLength(1)
    expect(chips.find(c => c.getAttribute('aria-checked') === 'true')?.textContent).toBe('Chest Freezer 2')
    expect(chips.map(c => c.textContent)).toEqual(['Chest Freezer 1', 'Chest Freezer 2', 'Garage freezr', 'Fridge', 'Fridge freezer', 'Pantry shelf', 'Counter'])
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

describe('the walk keeps the creator and does NOT get the manage door', () => {
  it('offers "＋ Somewhere else" (a name + a kind) with no editing affordance', async () => {
    render(<MemoryRouter initialEntries={['/put-up?session=putup']}><PutUp /></MemoryRouter>)
    // Renaming vocabulary is a deliberate, desk-posture act. The walk is a hands-wet sitting whose
    // job is one item at a time, and a Delete button beside a freezer chip there is a hazard.
    fireEvent.click(await screen.findByRole('button', { name: '＋ Somewhere else' }))
    expect(await screen.findByRole('textbox', { name: 'Name of the place' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'What kind of place?' })).toBeTruthy()
    expect(screen.queryByTestId('pu-manage-locations')).toBeNull()
    expect(screen.queryByTestId('pu-location-editor')).toBeNull()
  })
})
