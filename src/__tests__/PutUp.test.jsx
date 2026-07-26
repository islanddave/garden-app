// V4-HARVESTCENTER-001 — PutUp page: fast-path validation, method='other' gate, fast-path submit,
// the regroup toggle on the read surface, and the minimal decrement. Real react-router (MemoryRouter)
// so useLocation()/state.prefill work; useApiFetch + useCropTypes are mocked. a11y: query controls by
// role+name (getByRole), not label-on-roleless (L-275).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

function wire({ stores = STORES_FIXTURE, plants = PLANTS_FIXTURE } = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path === '/api/plants' && method === 'GET') return Promise.resolve(plants)
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve(stores)
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
  it('offers a planting picker on the direct entry path, not just off a harvest', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const sel = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/plants'))
    await waitFor(() => expect(sel.querySelectorAll('option').length).toBe(PLANTS_FIXTURE.length + 1))
  })

  it('distinguishes same-named successions by wave and sown date', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const sel = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(sel.querySelectorAll('option').length).toBeGreaterThan(1))
    const labels = [...sel.querySelectorAll('option')].map(o => o.textContent)
    expect(labels.some(l => /Dark Green Zucchini.*wave 1/.test(l))).toBe(true)
    expect(labels.some(l => /Dark Green Zucchini.*wave 2/.test(l))).toBe(true)
    expect(labels.some(l => /Dark Green Zucchini.*wave 3/.test(l))).toBe(true)
    // Name alone is ambiguous — the date is what actually separates them for a human.
    expect(labels.filter(l => /sown/.test(l)).length).toBeGreaterThanOrEqual(3)
  })

  it('scopes the planting list to the chosen crop', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const sel = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(sel.querySelectorAll('option').length).toBe(5))
    fireEvent.change(screen.getByRole('combobox', { name: 'Crop' }), { target: { value: 'tomato' } })
    // Only the tomato planting survives the scope (+ the "not tied" row).
    await waitFor(() => expect(sel.querySelectorAll('option').length).toBe(2))
    expect(sel.textContent).toMatch(/Cherokee Purple/)
  })

  it('submits plant_id and derives the crop from the selected planting', async () => {
    renderPutUp()
    fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
    const sel = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(sel.querySelectorAll('option').length).toBe(5))
    fireEvent.change(sel, { target: { value: 'pl-w2' } })
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
    const sel = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(sel.querySelectorAll('option').length).toBe(5))
    fireEvent.change(sel, { target: { value: 'pl-w1' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await waitFor(() => expect(lastPost()).not.toBeNull())
    expect(lastPost().plant_id).toBe('pl-w1')
  })

  it('keeps a harvest-prefilled planting selected even when it is outside the current scope', async () => {
    // Launched off a harvest for wave 3, but the crop filter says tomato — the link must survive.
    renderPutUp({ crop_type_slug: 'tomato', plant_id: 'pl-w3' })
    const sel = await screen.findByRole('combobox', { name: 'From which planting' })
    await waitFor(() => expect(sel.value).toBe('pl-w3'))
    expect(sel.textContent).toMatch(/wave 3/)
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

describe('PutUp — "what\'s put up" read surface', () => {
  it('defaults to grouping by storage and regroups by crop on one tap', async () => {
    renderPutUp()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/preservation/whats-put-up?group=storage'))
    await screen.findByText('Garage freezer')
    fireEvent.click(screen.getByRole('radio', { name: 'By crop' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/preservation/whats-put-up?group=crop'))
  })

  it('regroups by planting so successions read separately', async () => {
    renderPutUp()
    await screen.findByText('Garage freezer')
    fireEvent.click(screen.getByRole('radio', { name: 'By planting' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/preservation/whats-put-up?group=planting'))
  })

  it('shows which planting a record came from when the link exists', async () => {
    renderPutUp({}) // stores view
    wire({ stores: { group_by: 'planting', groups: [{
      group_key: 'pl-w2', label: 'Dark Green Zucchini — wave 2, sown May 12',
      total_packages: 2, units: ['bags'], use_soon_count: 0,
      records: [{ ...STORES_FIXTURE.groups[0].records[0], id: 'rec-2', plant_id: 'pl-w2',
        planting_name: 'Dark Green Zucchini', planting_succession_order: 2, planting_sown_at: '2026-05-12' }],
    }] } })
    renderPutUp()
    expect(await screen.findByText(/from Dark Green Zucchini/)).toBeTruthy()
  })

  it('numbers-first headline shows package count + the distinct units (never a cross-unit sum)', async () => {
    renderPutUp()
    await screen.findByText('Garage freezer')
    // Headline: "3 containers · bags" (packages counted, units listed — never a cross-unit sum).
    expect(screen.getAllByText(/3 containers/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/bags/).length).toBeGreaterThan(0)
  })

  it('"Mark used" decrements remaining_count via a full-replace PUT', async () => {
    renderPutUp()
    await screen.findByText('Garage freezer')
    fireEvent.click(screen.getByRole('button', { name: 'Mark used' }))
    await waitFor(() => expect(putCalls().length).toBe(1))
    const [path, opts] = putCalls()[0]
    expect(path).toBe('/api/preservation/rec-1')
    const body = JSON.parse(opts.body)
    expect(body.remaining_count).toBe(2) // 3 → 2
    // Full replace carries the row's identity fields forward.
    expect(body.crop_type_slug).toBe('tomato')
    expect(body.quantity_value).toBe(14)
    // V4-PUTUPPROV-001. THE REGRESSION THIS GUARDS: before buildFullPayload carried these, every
    // one-tap "Mark used" rewrote a farm-stand put-up as own-garden with the vendor erased, returned
    // 200, and looked like a render glitch. Worst on exactly the rows the feature exists for, since
    // only non-own_garden rows have anything to lose.
    expect(body.source_kind).toBe('farm_stand')
    expect(body.source_label).toBe('Warner Farms')
    // Assert the NEGATIVE too: catches a client- or server-side re-default even if the positive
    // assertion were somehow satisfied.
    expect(opts.body).not.toMatch(/own_garden/)
  })

  it('renders provenance on a bought row, and nothing at all on a garden row', async () => {
    renderPutUp()
    await screen.findByText('Garage freezer')
    expect(screen.queryByText(/from Warner Farms/)).toBeTruthy()
  })

  it('renders NO provenance line for an own-garden row (existing rows look unchanged)', async () => {
    const gardenFixture = { ...STORES_FIXTURE, groups: [{ ...STORES_FIXTURE.groups[0],
      records: [{ ...STORES_FIXTURE.groups[0].records[0], source_kind: 'own_garden', source_label: null }] }] }
    wire({ stores: gardenFixture })
    renderPutUp()
    await screen.findByText('Garage freezer')
    expect(screen.queryByText(/^from /)).toBeNull()
  })

  it('renders NO provenance line when source_kind is NULL (unrecorded, pre-migration rows)', async () => {
    const legacyFixture = { ...STORES_FIXTURE, groups: [{ ...STORES_FIXTURE.groups[0],
      records: [{ ...STORES_FIXTURE.groups[0].records[0], source_kind: null, source_label: null }] }] }
    wire({ stores: legacyFixture })
    renderPutUp()
    await screen.findByText('Garage freezer')
    expect(screen.queryByText(/^from /)).toBeNull()
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
      if (path === '/api/plants') return Promise.resolve(PLANTS_FIXTURE)
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
      if (path === '/api/plants') return Promise.resolve(PLANTS_FIXTURE)
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
      if (path === '/api/plants') return Promise.resolve(PLANTS_FIXTURE)
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
