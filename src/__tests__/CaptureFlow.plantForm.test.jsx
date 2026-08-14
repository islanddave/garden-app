// CaptureFlow.plantForm.test.jsx — V4-PLANTFORMUNIFY-001 (BD-014) ⊇ V4-SNAPVARIETY-001 (BD-015).
//
// Own file, deliberately. CaptureFlow.test.jsx is shared fleet surface and pins the V3-CAPTURE-001
// flow contract (project-less POST, photo linkage, Undo, Save & Next); this file pins the thing the
// two merged ledger rows are actually about, and pins it END TO END rather than by unit:
//
//   • Snap renders the SHARED <PlantForm/> — the same widget PlantingEditor and ProjectDetail render
//     — instead of the two hand-rolled fields it had. Snap was the last outlier of six add/edit
//     planting surfaces.
//   • Because PlantForm hosts VarietyPicker, Snap can now CREATE a variety, and create the crop type
//     it belongs to, without leaving the capture flow. That is BD-015's premise verbatim: Dave
//     photographed hydrangeas, no hydrangea crop type existed, and Snap could only pick from a
//     pre-fetched list, so the planting landed with cultivar_id NULL and grouped nowhere.
//   • BOTH LEGS ARE ASSERTED SEPARATELY, because recon corrected a prior lane on exactly this: a
//     crop-type POST writes ONLY crop_types. The derived tag facets are materialized by applyDerive
//     on the VARIETY write, against entity_type='cultivar'. Creating the type alone therefore
//     produces no facet and the new plant still groups nowhere — the variety leg must follow it and
//     must carry the new slug. A test that stopped at "crop type created" would pass while the
//     user-visible defect survived.
//   • VarietyPicker is rendered FOR REAL here (not mocked, unlike plantForm.test.jsx) — mocking it
//     would leave the create capability, i.e. the entire point of BD-015, unexercised.
//
// FAST-CAPTURE is treated as a contract, not a hope: Snap's whole justification is being quicker
// than /garden?add=1, and adopting a richer form is the obvious way to wreck that. The guarantees
// pinned below are that the provenance disclosure stays COLLAPSED, that name is the only thing the
// user must supply, and that the preview yields its hero height once the photo is settled.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { fetchSpy, uploadSpy, navigateSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), uploadSpy: vi.fn(), navigateSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadSpy, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
  Link: ({ children, to }) => <a href={typeof to === 'string' ? to : '#'}>{children}</a>,
}))

import CaptureFlow from '../pages/CaptureFlow.jsx'

const PLANTS = [{ id: 'pl-1', name: 'Basil', project_id: 'proj-9', featured_photo_id: null }]
const LOCATIONS = [
  { id: 'loc-1', full_path: 'Greenhouse / Bench 2', is_active: true },
  { id: 'loc-dead', full_path: 'Old bed', is_active: false },
]
// The crop-type form derives its Category options from the LIVE vocabulary rather than hardcoding
// them, so an 'ornamental' row has to exist here for "Hydrangea" to be mintable as one.
const CROPS = [
  { slug: 'pepper', display_name: 'Pepper', default_lifecycle: 'tender_perennial', category: 'vegetable', sort_order: 0 },
  { slug: 'tomato', display_name: 'Tomato', default_lifecycle: 'tender_perennial', category: 'vegetable', sort_order: 0 },
  { slug: 'hosta', display_name: 'Hosta', default_lifecycle: 'perennial', category: 'ornamental', sort_order: 1 },
]
const EXISTING_VARIETY = { id: 'var-1', name: 'Charentais', crop_type_slug: 'melon' }

beforeEach(() => {
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1' } })
})

// `varieties` defaults to a list containing EXISTING_VARIETY so search finds it; pass [] to force
// the not-found -> create path.
function wire({ varieties = [EXISTING_VARIETY], crops = CROPS, onPost } = {}) {
  fetchSpy.mockImplementation((path, options = {}) => {
    const m = options.method ?? 'GET'
    const custom = onPost?.(path, options, m)
    if (custom) return custom
    if (m === 'GET' && path === '/api/plants') return Promise.resolve(PLANTS)
    if (m === 'GET' && path === '/api/locations/with-path') return Promise.resolve(LOCATIONS)
    if (m === 'GET' && path === '/api/varieties/crop-types') return Promise.resolve(crops)
    if (m === 'GET' && path.startsWith('/api/varieties')) return Promise.resolve(varieties)
    if (m === 'POST' && path === '/api/plants') return Promise.resolve({ id: 'plant-new', name: 'Charentais' })
    return Promise.resolve({ ok: true })
  })
}

async function snapToPlanting() {
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByTestId('mode-planting')) })
}

const nameInput   = () => document.getElementById('cap-plant-name')
const saveBtn     = () => screen.getByRole('button', { name: 'Save' })
const varietyBox  = () => screen.getByPlaceholderText('Search or create a variety…')
const plantsPost  = () => fetchSpy.mock.calls.find(c => c[0] === '/api/plants' && c[1]?.method === 'POST')
const bodyOf      = (call) => JSON.parse(call[1].body)

// ── Adoption: it really is the shared widget, not a look-alike ────────────────────────────────
describe('V4-PLANTFORMUNIFY-001 — Snap renders the shared PlantForm', () => {
  it('renders PlantForm’s full field set off idPrefix="cap-plant"', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    // These four ids can only exist if PlantForm rendered — they are built from its idPrefix, and
    // nothing in CaptureFlow constructs them.
    expect(document.getElementById('cap-plant-name')).toBeTruthy()
    expect(document.getElementById('cap-plant-qty')).toBeTruthy()
    expect(document.getElementById('cap-plant-status')).toBeTruthy()
    expect(document.getElementById('cap-plant-notes')).toBeTruthy()
    expect(screen.getByTestId('planting-details')).toBeDefined()
  })

  it('drops the old hand-rolled name/variety controls entirely', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    // The bespoke Input is GONE, not hidden.
    expect(screen.queryByTestId('cap-pname')).toBeNull()
    // …and the variety control is no longer a read-only <select> over a prefetched list. It is
    // VarietyPicker's searchable combobox, which is the whole capability BD-015 asked for.
    const variety = document.getElementById('cap-plant-variety')
    expect(variety.tagName).toBe('INPUT')
    expect(variety.getAttribute('role')).toBe('combobox')
  })

  it('no longer prefetches /api/varieties on mount — VarietyPicker owns that list', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    // Mount fetches plants + locations only. The old eager varieties GET fired on EVERY Snap mount
    // for a list only one of four destinations read.
    const paths = fetchSpy.mock.calls.map(c => c[0])
    expect(paths).toContain('/api/plants')
    expect(paths).toContain('/api/locations/with-path')
    expect(paths.some(p => String(p).startsWith('/api/varieties'))).toBe(false)
  })

  it('hides the project chooser and still POSTs project_id null', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    expect(document.getElementById('cap-plant-project')).toBeNull()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Charentais' } }) })
    await act(async () => { fireEvent.click(saveBtn()) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    // The regression recon named: PlantingEditor seeds project_id = projects[0]?.id. Inheriting that
    // through the shared form would silently start filing every field capture under an arbitrary
    // first project. Snap keeps null.
    expect(bodyOf(plantsPost()).project_id).toBeNull()
  })
})

// ── Fast capture: the reason Snap exists ──────────────────────────────────────────────────────
describe('V4-PLANTFORMUNIFY-001 — adopting the richer form does not slow capture', () => {
  it('keeps the twelve provenance fields COLLAPSED (unlike PlantingEditor, which opens them)', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    // detailsDefaultOpen defaults false and Snap must not pass true. PlantingEditor passes
    // detailsDefaultOpen={!isEdit} because it is a desk form; Snap is one-handed and outdoors.
    expect(screen.getByTestId('planting-details').open).toBe(false)
  })

  it('captures with a name ALONE — every added field is prefilled or optional', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    // Nothing is touched except the name: no variety, no quantity, no status, no notes.
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Charentais' } }) })
    await act(async () => { fireEvent.click(saveBtn()) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    const body = bodyOf(plantsPost())
    expect(body.name).toBe('Charentais')
    expect(body.quantity).toBe(1)          // prefilled '1', same as the old hardcoded quantity
    expect(body.status).toBe('seedling')   // prefilled, same as the old hardcoded status
    expect(body.variety_id).toBeNull()
    expect(body.variety).toBeNull()
    expect(uploadSpy).toHaveBeenCalled()
  })

  it('shrinks the preview once a destination is chosen so Save stays reachable', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
    const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
    await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
    // Step 'mode': the photo is still being judged (Retake is overlaid on it) — full hero.
    expect(screen.getByAltText('capture preview').style.maxHeight).toBe('280px')
    await act(async () => { fireEvent.click(screen.getByTestId('mode-planting')) })
    // Step 'form': settled, so it yields 160px back to the taller shared form. jsdom has no layout,
    // so the fold cannot be asserted directly; the style that buys it back can be.
    expect(screen.getByAltText('capture preview').style.maxHeight).toBe('120px')
  })

  it('keeps a Back escape to the destination list with the photo intact', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    // PlantForm's built-in onCancel renders the word "Cancel"; on a capture flow that reads as
    // discarding the shot. Snap keeps "Back", and it must still preserve the photo.
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('cap-back')) })
    expect(screen.getByTestId('mode-planting')).toBeDefined()
    expect(screen.getByAltText('capture preview')).toBeDefined()
  })
})

// ── BD-015 leg A: pick an existing variety; send the same wire shape as every other create path ──
describe('V4-SNAPVARIETY-001 — variety selection sends the canonical FK, in the shared wire shape', () => {
  it('sends variety_id (which lands) and variety (wire parity only) when an existing variety is picked', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Charentais melon' } }) })
    await act(async () => { fireEvent.focus(varietyBox()) })
    await act(async () => { fireEvent.change(varietyBox(), { target: { value: 'Charentais' } }) })
    await act(async () => { fireEvent.click(await screen.findByRole('option', { name: /^Charentais/ })) })
    await act(async () => { fireEvent.click(saveBtn()) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    const body = bodyOf(plantsPost())
    // `variety_id` is the assertion that MATTERS — it is the canonical FK and the only one of the
    // two that the server persists.
    expect(body.variety_id).toBe('var-1')
    // `variety` (flat text) is asserted for WIRE PARITY, not because it lands: `garden_node` has no
    // `variety` column and the POST handler never reads `body.variety`, so this key is discarded
    // server-side. An earlier version of this test called the pair a "dual-write ... separate real
    // columns", which was false and would have taught the next reader that the text is stored —
    // corrected 2026-08-14 after review. It is pinned only so Snap keeps the identical wire shape to
    // PlantingEditor and ProjectDetail; the day those two drop the key, this should drop with them.
    // Nothing is lost today because the id carries the meaning.
    expect(body.variety).toBe('Charentais')
  })
})

// ── BD-015 leg B: the genuinely-new plant — crop type AND variety, in order ────────────────────
describe('V4-SNAPVARIETY-001 — Snap can mint a crop type and a variety mid-capture', () => {
  // Drives the picker to the crop chooser for a name that matches nothing.
  async function toCropChooser(varietyName) {
    await act(async () => { fireEvent.focus(varietyBox()) })
    await act(async () => { fireEvent.change(varietyBox(), { target: { value: varietyName } }) })
    const create = await screen.findByText(/Create/)
    await act(async () => { fireEvent.click(create.closest('li')) })
    await waitFor(() => expect(screen.getByText('Pepper')).toBeDefined())
  }

  it('POSTs the crop type, THEN the variety carrying its new slug, then the planting', async () => {
    wire({
      varieties: [],
      onPost: (path, options, m) => {
        if (m === 'POST' && path === '/api/varieties/crop-types') {
          return Promise.resolve({ slug: 'hydrangea', display_name: 'Hydrangea', default_lifecycle: 'perennial', category: 'ornamental', sort_order: 0 })
        }
        if (m === 'POST' && path === '/api/varieties') {
          return Promise.resolve({ id: 'var-new', name: 'Endless Summer', crop_type_slug: 'hydrangea' })
        }
        return null
      },
    })
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Hydrangeas' } }) })

    await toCropChooser('Endless Summer')
    await act(async () => { fireEvent.click(screen.getByText(/New crop type/).closest('li')) })

    // Two controls are labelled "Name" on screen now — PlantForm's (id cap-plant-name) and the
    // crop-type form's. Disambiguate by id rather than by order, which styling churn could flip.
    const cropName = screen.getAllByLabelText(/^Name/).find(el => el.id !== 'cap-plant-name')
    expect(cropName).toBeTruthy()
    fireEvent.change(cropName, { target: { value: 'Hydrangea' } })
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'ornamental' } })
    fireEvent.change(screen.getByLabelText('Lifecycle'), { target: { value: 'perennial' } })
    await act(async () => { fireEvent.click(screen.getByText('Create crop type')) })

    // LEG 1 — the crop type. This write touches crop_types ONLY.
    const cropPost = fetchSpy.mock.calls.find(c => c[0] === '/api/varieties/crop-types' && c[1]?.method === 'POST')
    expect(cropPost).toBeDefined()
    expect(bodyOf(cropPost)).toMatchObject({ display_name: 'Hydrangea', category: 'ornamental', default_lifecycle: 'perennial' })
    // The slug is derived server-side and must never be sent by the client.
    expect(bodyOf(cropPost).slug).toBeUndefined()

    // LEG 2 — the variety, carrying the brand-new slug. This is the write that runs applyDerive and
    // materializes the type:<slug> tag on entity_type='cultivar'. Stopping at leg 1 would create the
    // vocabulary entry and still leave the plant ungrouped, which is BD-015's exact complaint.
    await waitFor(() => {
      const vp = fetchSpy.mock.calls.find(c => c[0] === '/api/varieties' && c[1]?.method === 'POST')
      expect(vp).toBeDefined()
      expect(bodyOf(vp)).toMatchObject({ name: 'Endless Summer', crop_type_slug: 'hydrangea' })
    })

    // …and the planting the whole flow was for links to it, by id and by text.
    await act(async () => { fireEvent.click(saveBtn()) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    const body = bodyOf(plantsPost())
    expect(body.variety_id).toBe('var-new')
    expect(body.variety).toBe('Endless Summer')
    expect(body.name).toBe('Hydrangeas')
  })

  it('can also create a variety under an EXISTING crop type without minting a new one', async () => {
    wire({
      varieties: [],
      onPost: (path, options, m) => {
        if (m === 'POST' && path === '/api/varieties') return Promise.resolve({ id: 'var-2', name: 'Jimmy Nardello', crop_type_slug: 'pepper' })
        return null
      },
    })
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Sweet frying pepper' } }) })
    await toCropChooser('Jimmy Nardello')
    await act(async () => { fireEvent.click(screen.getByText('Pepper').closest('li')) })
    await waitFor(() => {
      const vp = fetchSpy.mock.calls.find(c => c[0] === '/api/varieties' && c[1]?.method === 'POST')
      expect(vp).toBeDefined()
      expect(bodyOf(vp)).toMatchObject({ name: 'Jimmy Nardello', crop_type_slug: 'pepper' })
    })
    // No crop type was minted — the existing vocabulary was reused, which is the behaviour that
    // keeps the type list from fragmenting into one type per variety.
    expect(fetchSpy.mock.calls.find(c => c[0] === '/api/varieties/crop-types' && c[1]?.method === 'POST')).toBeUndefined()
  })
})

// ── The rest of the unified field set actually reaches the wire ────────────────────────────────
describe('V4-PLANTFORMUNIFY-001 — the added fields are wired, not decorative', () => {
  it('offers the active locations only, and sends the chosen one as location_id', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    const loc = document.getElementById('cap-plant-loc')
    expect(loc).toBeTruthy()
    // is_active filtering mirrors PlantingEditor, so the two surfaces offer the same set.
    expect(screen.queryByText('Old bed')).toBeNull()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Charentais' } }) })
    await act(async () => { fireEvent.change(loc, { target: { value: 'loc-1' } }) })
    await act(async () => { fireEvent.click(saveBtn()) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    expect(bodyOf(plantsPost()).location_id).toBe('loc-1')
  })

  it('coerces empty optional fields to null rather than empty strings', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Charentais' } }) })
    await act(async () => { fireEvent.click(saveBtn()) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    const body = bodyOf(plantsPost())
    // source_type '' 400s on the plants Lambda; the others would be written as empty strings.
    for (const k of ['notes', 'source_type', 'source_ref', 'source_generation', 'lineage_note', 'parent_plant_id', 'container_type', 'container_size', 'location_id', 'qty_initial']) {
      expect(body[k]).toBeNull()
    }
    expect(body.sown_at).toBeNull()
    expect(body.sown_at_approx).toBe(false)
  })

  it('carries the provenance fields when the user does open the disclosure', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Charentais' } }) })
    await act(async () => { fireEvent.change(document.getElementById('cap-plant-qty'), { target: { value: '6' } }) })
    await act(async () => { fireEvent.change(document.getElementById('cap-plant-sown'), { target: { value: '2026-05-02' } }) })
    await act(async () => { fireEvent.change(document.getElementById('cap-plant-source'), { target: { value: 'seed_packet' } }) })
    await act(async () => { fireEvent.change(document.getElementById('cap-plant-notes'), { target: { value: 'south bed' } }) })
    await act(async () => { fireEvent.click(saveBtn()) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    const body = bodyOf(plantsPost())
    expect(body.quantity).toBe(6)
    expect(body.sown_at).toBe('2026-05-02')
    expect(body.source_type).toBe('seed_packet')
    expect(body.notes).toBe('south bed')
  })

  it('surfaces a save failure through PlantForm’s own error banner', async () => {
    wire({
      onPost: (path, options, m) => (m === 'POST' && path === '/api/plants')
        ? Promise.reject(new Error('Server said no')) : null,
    })
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Charentais' } }) })
    await act(async () => { fireEvent.click(saveBtn()) })
    await waitFor(() => expect(screen.getByText(/Server said no/)).toBeDefined())
    // Operational error, not a reward surface: it renders inline in the form, no toast or modal.
    expect(screen.queryByTestId('cap-result')).toBeNull()
  })

  it('resets the shared form on Save & Next so the next snap starts clean', async () => {
    wire()
    await act(async () => { render(<CaptureFlow />) })
    await snapToPlanting()
    await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Charentais' } }) })
    await act(async () => { fireEvent.change(document.getElementById('cap-plant-notes'), { target: { value: 'south bed' } }) })
    await act(async () => { fireEvent.click(saveBtn()) })
    await waitFor(() => expect(screen.getByTestId('cap-next')).toBeDefined())
    await act(async () => { fireEvent.click(screen.getByTestId('cap-next')) })
    await waitFor(() => expect(screen.getByTestId('cap-take')).toBeDefined())
    const file = new File(['x'], 'again.jpg', { type: 'image/jpeg' })
    await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('mode-planting')) })
    // A stale name or note carried into the next capture is the classic rapid-entry bug; the old
    // two-scalar reset covered two fields, the object reset has to cover all seventeen.
    expect(nameInput().value).toBe('')
    expect(document.getElementById('cap-plant-notes').value).toBe('')
  })
})
