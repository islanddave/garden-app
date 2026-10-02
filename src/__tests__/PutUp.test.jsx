// V4-HARVESTCENTER-001 — PutUp page: fast-path validation, method='other' gate, fast-path submit,
// the regroup toggle on the read surface, and the minimal decrement. Real react-router (MemoryRouter)
// so useLocation()/state.prefill work; useApiFetch + useCropTypes are mocked. a11y: query controls by
// role+name (getByRole), not label-on-roleless (L-275).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const fetchMock = vi.fn()
// `apiFetch` is required because PutUp now imports useUploadPhoto (V4-PUTUPPHOTO-001), which
// re-exports it through its __testing__ seam. Omitting it fails the whole suite at collect time.
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  // Lazy wrapper, NOT a bare `fetchMock` reference: vi.mock is hoisted above the const, so an
  // eager reference throws "Cannot access 'fetchMock' before initialization" at collect time.
  apiFetch: (...args) => fetchMock(...args),
}))

// Photo upload is stubbed at the hook boundary — the 3-step S3 engine has its own coverage in
// useUploadPhoto.test.js. What matters HERE is the ordering contract: upload resolves BEFORE the
// preservation POST, and its id rides along on that single create.
const uploadMock = vi.fn()
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadMock, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({
    cropTypes: [
      { slug: 'tomato', display_name: 'Tomato', category: 'vegetable' },
      { slug: 'bean', display_name: 'Beans', category: 'vegetable' },
    ],
    loading: false,
  }),
}))

import PutUp from '../pages/PutUp.jsx'
import { rowFromRecord } from './helpers/pantryFake.js'

const STORES_FIXTURE = {
  group_by: 'storage',
  groups: [{
    group_key: 'loc-1', label: 'Garage freezer', total_packages: 3, units: ['bags'], use_soon_count: 0,
    records: [{
      id: 'rec-1', crop_type_slug: 'tomato', variety_id: null, plant_id: null, harvest_log_id: null,
      preserved_at: '2026-07-01', method: 'whole_freeze', method_other_text: null,
      quantity_value: 14, quantity_unit: 'bags', package_count: 3, storage_location_id: 'loc-1',
      use_by_target: null, remaining_count: 3, consumed_at: null, notes: null, photo_id: null, use_by_status: null,
      // V4-PUTUPPROV-001 — DELIBERATELY NOT own_garden. If this fixture said own_garden, the
      // decrement test below would pass whether buildFullPayload carries the field through OR drops
      // it and something re-defaults it, because the observable value is identical either way. A
      // non-default value is what makes the assertion able to fail.
      source_kind: 'farm_stand', source_label: 'Warner Farms',
    }],
  }],
}

// Three waves of ONE variety + an unrelated crop. The successions are the whole point: they are
// name-identical, so only the wave ordinal / sown date tells them apart.
const PLANTS_FIXTURE = [
  { id: 'pl-w1', name: 'Dark Green Zucchini', variety_id: 'var-dgz', sown_at: '2026-04-10',
    succession_order: 1, variety_ref: { id: 'var-dgz', name: 'Dark Green Zucchini', crop_type_slug: 'squash' } },
  { id: 'pl-w2', name: 'Dark Green Zucchini', variety_id: 'var-dgz', sown_at: '2026-05-12',
    succession_order: 2, variety_ref: { id: 'var-dgz', name: 'Dark Green Zucchini', crop_type_slug: 'squash' } },
  { id: 'pl-w3', name: 'Dark Green Zucchini', variety_id: 'var-dgz', sown_at: '2026-06-14',
    succession_order: 3, variety_ref: { id: 'var-dgz', name: 'Dark Green Zucchini', crop_type_slug: 'squash' } },
  { id: 'pl-tom', name: 'Cherokee Purple', variety_id: 'var-cp', sown_at: '2026-03-01',
    succession_order: null, variety_ref: { id: 'var-cp', name: 'Cherokee Purple', crop_type_slug: 'tomato' } },
]

// B′ release 2: the list is GET /api/pantry (the pinned contract's rows) and a jar's sheet reads the jar
// by id; `record` is that jar.
function wire({ plants = PLANTS_FIXTURE, record = STORES_FIXTURE.groups[0].records[0] } = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/plants?') && method === 'GET') return Promise.resolve(plants)
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows: [rowFromRecord(record, { id: 'loc-1', label: 'Garage freezer', kind: 'deep_freezer' })] })
    if (path === `/api/preservation/${record.id}` && method === 'GET') return Promise.resolve(record)
    if (path === '/api/preservation' && method === 'POST') return Promise.resolve({ id: 'new-1' })
    if (path.startsWith('/api/preservation/') && method === 'PUT') return Promise.resolve({ id: 'rec-1' })
    return Promise.resolve(null)
  })
}

function renderPutUp(prefill) {
  const entry = prefill ? { pathname: '/put-up', state: { prefill } } : { pathname: '/put-up' }
  return render(<MemoryRouter initialEntries={[entry]}><PutUp /></MemoryRouter>)
}

function lastPost() {
  const call = [...fetchMock.mock.calls].reverse().find(([, o]) => (o?.method === 'POST'))
  return call ? JSON.parse(call[1].body) : null
}
function putCalls() {
  return fetchMock.mock.calls.filter(([, o]) => o?.method === 'PUT')
}

beforeEach(() => {
  fetchMock.mockReset(); uploadMock.mockReset(); wire()
  uploadMock.mockResolvedValue({ photo: { id: 'photo-1' } })
  // jsdom has no object-URL implementation.
  if (!URL.createObjectURL) { URL.createObjectURL = vi.fn(() => 'blob:preview'); URL.revokeObjectURL = vi.fn() }
  // V4-RELOADGATEWIRE-001: PutUpForm now stashes a dirty (unsubmitted) draft to sessionStorage
  // keyed 'gardenApp.draft.put-up' (draftStash.js) and restores it on a fresh, no-prefill mount.
  // Several tests below type into the form without ever reaching a successful submit (the only
  // point that clears the stash), so without this reset a later bare renderPutUp() in the SAME
  // file would restore an earlier test's leftover draft over its own fixture state.
  sessionStorage.clear()
})

function pickPhoto() {
  fireEvent.click(screen.getByRole('button', { name: /More/i }))
  const input = screen.getByLabelText('Photo')
  const file = new File(['x'], 'jars.jpg', { type: 'image/jpeg' })
  fireEvent.change(input, { target: { files: [file] } })
  return file
}

describe('PutUp — log form (progressive disclosure)', () => {
  it('blocks submit when neither a crop nor a variety is attributed', async () => {
    renderPutUp() // no prefill → defaults to the "what's put up" view
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await screen.findByText(/Pick a crop/i)
    expect(lastPost()).toBeNull() // never POSTed
  })

  it("requires method_other_text when method is 'other'", async () => {
    renderPutUp({ crop_type_slug: 'tomato' }) // prefill → lands on the form
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Method' }), { target: { value: 'other' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await screen.findByText(/Describe the method when you choose/i)
    expect(lastPost()).toBeNull()
  })

  it('fast-path submit posts crop + quantity + defaulted method/date/packages', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Crop' }), { target: { value: 'tomato' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '14' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))

    await waitFor(() => expect(lastPost()).not.toBeNull())
    const body = lastPost()
    expect(body.crop_type_slug).toBe('tomato')
    expect(body.quantity_value).toBe(14)
    expect(body.quantity_unit).toBeTruthy()
    expect(body.method).toBe('whole_freeze')
    expect(body.package_count).toBe(1)
    expect(body.preserved_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // use_by_target OMITTED on 'auto' so the server applies the shelf-life default (L6).
    expect('use_by_target' in body).toBe(false)
    // Competence payoff surfaces (L10 cold-start) — no celebration, just the inventory reflection.
    await screen.findByText(/Now in/i)
  })
})

// The seed → planting → harvest → put-up spine. Before this, plant_id was prefill-only and
// immutable, so a put-up logged from More → Put-Up could never be tied to a planting at all.
describe('PutUp — planting attribution (succession spine)', () => {
  // V4-PLANTPICKER-001: the field is now the shared PlantingSelect combobox — options live in a
  // listbox that opens on focus (browse mode preserves the waves-side-by-side read); rows are
  // picked by click on their ps-opt-<id> testid instead of a native select change.
  it('offers a planting picker on the direct entry path, not just off a harvest', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const input = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/plants?view=picker'))
    fireEvent.focus(input)
    const list = await screen.findByRole('listbox', { name: 'Plantings' })
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(PLANTS_FIXTURE.length))
  })

  it('distinguishes same-named successions by wave and sown date', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const input = await screen.findByRole('combobox', { name: 'From which planting' })
    fireEvent.focus(input)
    const list = await screen.findByRole('listbox', { name: 'Plantings' })
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBeGreaterThan(1))
    const labels = within(list).getAllByRole('option').map(o => o.textContent)
    expect(labels.some(l => /Dark Green Zucchini.*wave 1/.test(l))).toBe(true)
    expect(labels.some(l => /Dark Green Zucchini.*wave 2/.test(l))).toBe(true)
    expect(labels.some(l => /Dark Green Zucchini.*wave 3/.test(l))).toBe(true)
    // Name alone is ambiguous — the date is what actually separates them for a human.
    expect(labels.filter(l => /sown/.test(l)).length).toBeGreaterThanOrEqual(3)
  })

  it('scopes the planting list to the chosen crop', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const input = await screen.findByRole('combobox', { name: 'From which planting' })
    fireEvent.focus(input)
    const list = await screen.findByRole('listbox', { name: 'Plantings' })
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(4))
    fireEvent.change(screen.getByRole('combobox', { name: 'Crop' }), { target: { value: 'tomato' } })
    // Only the tomato planting survives the scope.
    fireEvent.focus(input)
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(1))
    expect(within(list).getByRole('option', { name: /Cherokee Purple/ })).toBeTruthy()
  })

  it('submits plant_id and derives the crop from the selected planting', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const input = await screen.findByRole('combobox', { name: 'From which planting' })
    fireEvent.focus(input)
    const list = await screen.findByRole('listbox', { name: 'Plantings' })
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(4))
    fireEvent.click(screen.getByTestId('ps-opt-pl-w2'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))

    await waitFor(() => expect(lastPost()).not.toBeNull())
    const body = lastPost()
    expect(body.plant_id).toBe('pl-w2')           // the specific wave, not just the variety
    expect(body.crop_type_slug).toBe('squash')    // derived from the planting
  })

  it('accepts a planting alone as sufficient attribution (no crop picked)', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const input = await screen.findByRole('combobox', { name: 'From which planting' })
    fireEvent.focus(input)
    const list = await screen.findByRole('listbox', { name: 'Plantings' })
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(4))
    fireEvent.click(screen.getByTestId('ps-opt-pl-w1'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await waitFor(() => expect(lastPost()).not.toBeNull())
    expect(lastPost().plant_id).toBe('pl-w1')
  })

  it('keeps a harvest-prefilled planting selected even when it is outside the current scope', async () => {
    // Launched off a harvest for wave 3, but the crop filter says tomato — the link must survive.
    // V4-PLANTPICKER-001: a made selection renders as the chip; retainOutOfScopeValue keeps it.
    renderPutUp({ crop_type_slug: 'tomato', plant_id: 'pl-w3' })
    const chip = await screen.findByTestId('pu-planting-select-chip')
    expect(chip.textContent).toMatch(/wave 3/)
  })
})

// V4-PUTUPPHOTO-001. The handoff assumed this needed create -> upload -> re-PUT; the 'standalone'
// key prefix takes no parentId, so the photo can exist first and photo_id rides the single create.
describe('PutUp — photo capture', () => {
  it('uploads BEFORE the put-up and sends photo_id on the single create (no re-PUT)', async () => {
    renderPutUp({ crop_type_slug: 'tomato' })
    pickPhoto()
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))

    await waitFor(() => expect(lastPost()).not.toBeNull())
    expect(uploadMock).toHaveBeenCalledTimes(1)
    // standalone => no parentId needed, which is what makes upload-first possible.
    expect(uploadMock.mock.calls[0][1]).toMatchObject({ keyPrefix: 'standalone' })
    expect(lastPost().photo_id).toBe('photo-1')
    expect(putCalls().length).toBe(0)   // the re-PUT the old design would have needed
  })

  it('still saves the put-up when the photo upload fails, and says so', async () => {
    uploadMock.mockResolvedValue({ error: 'S3 upload failed: 500' })
    renderPutUp({ crop_type_slug: 'tomato' })
    pickPhoto()
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))

    await waitFor(() => expect(lastPost()).not.toBeNull())
    expect('photo_id' in lastPost()).toBe(false)   // never sends a bogus id
    expect(await screen.findByText(/photo didn.t upload/i)).toBeTruthy()
  })

  it('sends no photo_id when no photo was picked', async () => {
    renderPutUp({ crop_type_slug: 'tomato' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await waitFor(() => expect(lastPost()).not.toBeNull())
    expect(uploadMock).not.toHaveBeenCalled()
    expect('photo_id' in lastPost()).toBe(false)
  })

  it('a picked photo can be removed before saving', async () => {
    renderPutUp({ crop_type_slug: 'tomato' })
    pickPhoto()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove photo' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await waitFor(() => expect(lastPost()).not.toBeNull())
    expect(uploadMock).not.toHaveBeenCalled()
  })
})

// AMENDED for B′ release 2 (V4 §2.5, §10.1): "What's put up" is the Pantry — ONE list over GET
// /api/pantry, grouped By place (default) or By what it is (By planting is dropped), with ONE inline
// action per row; the jar's words the list used to carry (size, put-up date, provenance, planting) are
// said in its row sheet, which reads the jar once. The editor and the use route are unchanged, so their
// wire literals are too. Retired with the old surface: the per-group "N containers · units" headline.
describe('PutUp — the Pantry read surface', () => {
  const ROW_ID = 'put_up:rec-1'
  const REC = STORES_FIXTURE.groups[0].records[0]
  const openSheet = async () => {
    fireEvent.click(await screen.findByTestId(`pantry-row-open-${ROW_ID}`))
    return screen.findByTestId('row-sheet')
  }

  it('defaults to grouping by place and regroups by what it is on one tap', async () => {
    renderPutUp()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pantry?group=place'))
    await screen.findByRole('heading', { name: 'Garage freezer' })
    fireEvent.click(screen.getByRole('radio', { name: 'By what it is' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pantry?group=kind'))
    expect(screen.queryByRole('radio', { name: 'By planting' })).toBeNull()
  })

  it('the row sheet says which planting a jar came from when the link exists', async () => {
    wire({ record: { ...REC, plant_id: 'pl-w2', planting_name: 'Dark Green Zucchini', planting_succession_order: 2 } })
    renderPutUp()
    await openSheet()
    expect(await screen.findByText(/from Dark Green Zucchini · wave 2/)).toBeTruthy()
  })

  // Amended for release F, and again for B′: the one-tap use is ONE use on POST /api/pantry/uses and no
  // PUT at all. Three left → the row offers "Used one".
  it('"Used one" is one use on the use route, and sends no PUT', async () => {
    renderPutUp()
    fireEvent.click(await screen.findByRole('button', { name: /^Used one — / }))
    const uses = () => fetchMock.mock.calls.filter(([p, o]) => p === '/api/pantry/uses' && o?.method === 'POST')
    await waitFor(() => expect(uses().length).toBe(1))
    const use = JSON.parse(uses()[0][1].body)
    expect(use.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect({ ...use, idempotency_key: 'K' }).toEqual({ idempotency_key: 'K', preservation_log_id: 'rec-1', count_used: 1 })
    expect(putCalls().length).toBe(0)
  })

  // Release F (amended again in the same commit as the change): an Edit is ONE PATCH carrying only what
  // changed — so nothing on the row (provenance, date, place) is echoed at all.
  it('a count edit is one PATCH of the count alone — nothing else on the row is sent', async () => {
    renderPutUp()
    await openSheet()
    fireEvent.click(screen.getByTestId('row-edit'))
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'How many were put up?' }), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const patches = () => fetchMock.mock.calls.filter(([, o]) => o?.method === 'PATCH')
    await waitFor(() => expect(patches().length).toBe(1))
    expect(patches()[0][0]).toBe('/api/preservation/rec-1')
    expect(JSON.parse(patches()[0][1].body)).toEqual({ package_count: 4 })
    expect(putCalls().length).toBe(0)
  })

  it('the row sheet says where a bought jar came from, and nothing for a garden jar', async () => {
    renderPutUp()
    await openSheet()
    expect(await screen.findByText(/from Warner Farms/)).toBeTruthy()
  })

  it('says NO provenance for an own-garden jar (or a NULL, pre-migration one)', async () => {
    for (const source_kind of ['own_garden', null]) {
      wire({ record: { ...REC, source_kind, source_label: null } })
      const view = renderPutUp()
      await openSheet()
      await screen.findByTestId('row-sheet-record')
      expect(screen.getByTestId('row-sheet-record').textContent).not.toMatch(/from /)
      view.unmount()
    }
  })
})

// V4-PUTUPSESSION-001 slice 1. The read half of the slice: a stored estimate has to read back as an
// estimate. B′: said in the jar's row sheet (the Pantry row carries no date).
describe('PutUp — an estimated date does not read as a date you picked', () => {
  const REC = STORES_FIXTURE.groups[0].records[0]
  const sheetWords = async () => {
    fireEvent.click(await screen.findByTestId('pantry-row-open-put_up:rec-1'))
    return (await screen.findByTestId('row-sheet-record')).textContent
  }

  it('marks a TRUE row', async () => {
    wire({ record: { ...REC, preserved_at_approx: true } })
    renderPutUp()
    expect(await sheetWords()).toContain('put up around Jul 1')
  })

  it('leaves a FALSE row plain', async () => {
    wire({ record: { ...REC, preserved_at_approx: false } })
    renderPutUp()
    const w = await sheetWords()
    expect(w).toContain('put up Jul 1')
    expect(w).not.toContain('around')
  })

  it('leaves a NULL row plain — unrecorded is not a claim that the date is approximate', async () => {
    wire({ record: { ...REC, preserved_at_approx: null } })
    renderPutUp()
    const w = await sheetWords()
    expect(w).toContain('put up Jul 1')
    expect(w).not.toContain('around')
  })

  it('the ordinary form records FALSE rather than leaving it unrecorded', async () => {
    // Not an omission: this form always knows where the date came from, and the today-default is a
    // fact, not a guess. Sending nothing would store NULL — "nobody was ever asked" — which is the
    // one thing that is not true here.
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Crop' }), { target: { value: 'tomato' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '14' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await waitFor(() => expect(lastPost()).not.toBeNull())
    expect(lastPost().preserved_at_approx).toBe(false)
  })

  it('an Edit of a row with an estimated date does not send the date or the flag', async () => {
    wire({ record: { ...REC, preserved_at_approx: true } })
    renderPutUp()
    await sheetWords()
    fireEvent.click(screen.getByTestId('row-edit'))
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'How many were put up?' }), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const patches = () => fetchMock.mock.calls.filter(([, o]) => o?.method === 'PATCH')
    await waitFor(() => expect(patches().length).toBe(1))
    const body = JSON.parse(patches()[0][1].body)
    expect('preserved_at_approx' in body).toBe(false)
    expect('preserved_at' in body).toBe(false)
  })
})

// BUG-PUTUPLOC-001 — the add-location failure that succeeded on retry and left no evidence.
// These lock in the self-heal (one automatic retry for transient classes) and the self-report
// (a diagnostic code in the message), so a recurrence arrives already classified.
describe('PutUp — add storage location resilience (BUG-PUTUPLOC-001)', () => {
  function openNewLocation() {
    fireEvent.click(screen.getByRole('button', { name: /New location/i }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New location name' }), { target: { value: 'Garage freezer' } })
  }

  it('auto-retries once when the request never reached the server, and succeeds silently', async () => {
    let calls = 0
    fetchMock.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET'
      if (path === '/api/storage-locations' && method === 'POST') {
        calls += 1
        if (calls === 1) return Promise.reject(new Error('Failed to fetch'))  // no .status => NET
        return Promise.resolve({ id: 'loc-9', label: 'Garage freezer', kind: 'deep_freezer' })
      }
      if (path === '/api/storage-locations') return Promise.resolve([])
      if (path.startsWith('/api/plants?')) return Promise.resolve(PLANTS_FIXTURE)
      if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve(STORES_FIXTURE)
      return Promise.resolve(null)
    })
    renderPutUp({ crop_type_slug: 'tomato' })
    openNewLocation()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    // Recovered: the location lands in the select and NO error is shown.
    await waitFor(() => expect(calls).toBe(2))
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Storage location' }).textContent).toMatch(/Garage freezer/))
    expect(screen.queryByText(/Couldn't add that location/)).toBeNull()
  })

  it('surfaces a diagnostic code when both attempts fail', async () => {
    fetchMock.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET'
      if (path === '/api/storage-locations' && method === 'POST') return Promise.reject(new Error('Failed to fetch'))
      if (path === '/api/storage-locations') return Promise.resolve([])
      if (path.startsWith('/api/plants?')) return Promise.resolve(PLANTS_FIXTURE)
      if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve(STORES_FIXTURE)
      return Promise.resolve(null)
    })
    renderPutUp({ crop_type_slug: 'tomato' })
    openNewLocation()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    // (NET) = threw before reaching the server — the class BUG-PUTUPLOC-001 lives in.
    expect(await screen.findByText(/Couldn't add that location.*\(NET\)/)).toBeTruthy()
  })

  it('does NOT retry a client error — a 400 is not transient', async () => {
    let calls = 0
    fetchMock.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET'
      if (path === '/api/storage-locations' && method === 'POST') {
        calls += 1
        const err = new Error('bad request'); err.status = 400
        return Promise.reject(err)
      }
      if (path === '/api/storage-locations') return Promise.resolve([])
      if (path.startsWith('/api/plants?')) return Promise.resolve(PLANTS_FIXTURE)
      if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve(STORES_FIXTURE)
      return Promise.resolve(null)
    })
    renderPutUp({ crop_type_slug: 'tomato' })
    openNewLocation()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText(/\(HTTP400\)/)).toBeTruthy()
    expect(calls).toBe(1)   // retrying a 400 would just duplicate a guaranteed failure
  })

  it('still blocks an empty name before any request goes out', async () => {
    renderPutUp({ crop_type_slug: 'tomato' })
    fireEvent.click(screen.getByRole('button', { name: /New location/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Give the location a name.')).toBeTruthy()
    expect(fetchMock.mock.calls.filter(([p, o]) => p === '/api/storage-locations' && o?.method === 'POST')).toHaveLength(0)
  })
})
