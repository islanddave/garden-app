// BUG-PUTUPSTASHHARVLINK-001 — a prefilled PutUp mount stashes `harvestLogId`, and the restore gate
// asked whether a prefill EXISTS (`if (hasPrefill) return`) rather than whether it is the SAME one.
// Two consequences, one root cause:
//   - a later BARE mount ("More → Put-Up") rehydrated that link and silently attributed a fresh
//     put-up to an old harvest. Invisible: harvest_log_id has no control on this form, so nothing on
//     screen ever said so and only the wire knew;
//   - the legitimate case — resuming the SAME harvest-triggered form after a dismiss or an SW reload,
//     both of which preserve location.state — could not resume at all.
// Every assertion here reads the POST BODY rather than component state: the link is a data defect,
// and it is only a defect once it reaches the wire.
//
// Harness ported from PutUp.formGuard.test.jsx (mock shape for useApiFetch/useUploadPhoto/
// useCropTypes, entryFor/renderFullPage, readStash/lastPost).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
const uploadMock = vi.fn()
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadMock, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({
    cropTypes: [
      { slug: 'tomato', display_name: 'Tomato', category: 'vegetable' },
      { slug: 'pepper', display_name: 'Peppers', category: 'vegetable' },
    ],
    loading: false,
  }),
}))

import PutUp from '../pages/PutUp.jsx'

const STASH_KEY = 'gardenApp.draft.put-up'
function readStash() {
  const raw = sessionStorage.getItem(STASH_KEY)
  return raw ? JSON.parse(raw).data : null
}
function seedStash(data) {
  sessionStorage.setItem(STASH_KEY, JSON.stringify({ v: 1, data }))
}

function wire() {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/plants') && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ groups: [] })
    if (path === '/api/preservation' && method === 'POST') return Promise.resolve({ id: 'new-1', source_kind: 'own_garden' })
    return Promise.resolve(null)
  })
}
function lastPost() {
  const call = [...fetchMock.mock.calls].reverse().find(([, o]) => o?.method === 'POST')
  return call ? JSON.parse(call[1].body) : null
}

function entryFor(prefill) {
  return prefill ? { pathname: '/put-up', state: { prefill } } : { pathname: '/put-up' }
}
function renderFullPage(prefill) {
  return render(<MemoryRouter initialEntries={[entryFor(prefill)]}><PutUp /></MemoryRouter>)
}
const openLogForm = () => fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
const qtyField = () => screen.getByRole('textbox', { name: 'Quantity' })
const typeQty = (v) => fireEvent.change(qtyField(), { target: { value: v } })
async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
  await waitFor(() => expect(lastPost()).not.toBeNull())
}

// The shape the harvest-log "preserve this?" trigger actually navigates with.
const HARVEST_PREFILL = { crop_type_slug: 'tomato', plant_id: 'p-1', harvest_log_id: 'h-1' }
// Same trigger, no planting attached — the source control is only rendered when the live plantId is
// empty (prefillLocksSource), so this is the shape that can exercise a user-cleared link.
const HARVEST_PREFILL_NO_PLANT = { crop_type_slug: 'tomato', harvest_log_id: 'h-1' }

beforeEach(() => {
  fetchMock.mockReset(); uploadMock.mockReset(); wire()
  sessionStorage.clear()
})

describe('PutUp harvest link — a bare mount never inherits it (BUG-PUTUPSTASHHARVLINK-001)', () => {
  it('a BARE mount resumes the draft but NOT the harvest link', async () => {
    const first = renderFullPage(HARVEST_PREFILL)   // hasPrefill -> lands straight on the log form
    typeQty('4')
    // Non-vacuity: the link really is in the snapshot. The fix is not "stop stashing it".
    await waitFor(() => expect(readStash()?.harvestLogId).toBe('h-1'))
    expect(readStash().qtyValue).toBe('4')
    first.unmount()

    renderFullPage()                                // a bare "More -> Put-Up" tap, days later
    openLogForm()
    await screen.findByRole('combobox', { name: 'Crop' })
    // The draft still resumes — dropping the whole restore would be a regression dressed as a fix.
    await waitFor(() => expect(qtyField().value).toBe('4'))
    await save()
    expect(lastPost().quantity_value).toBe(4)
    // THE DEFECT: this used to be 'h-1' — a fresh put-up filed against an old harvest, with nothing
    // on screen that could have shown it.
    expect(lastPost().harvest_log_id).toBeUndefined()
  })

  // The migration case: drafts written before this fix carry no context stamp. An unknown context is
  // never "the same context", so they restore on a bare mount (no orphaning) minus the link.
  it('a pre-stamp draft still restores on a bare mount, minus the harvest link', async () => {
    seedStash({ cropSlug: 'tomato', qtyValue: '4', plantId: 'p-1', harvestLogId: 'h-1' })
    renderFullPage()
    openLogForm()
    await screen.findByRole('combobox', { name: 'Crop' })
    await waitFor(() => expect(qtyField().value).toBe('4'))
    await save()
    expect(lastPost().plant_id).toBe('p-1')
    expect(lastPost().harvest_log_id).toBeUndefined()
  })
})

describe('PutUp harvest link — the prefilled resume still works (BUG-PUTUPSTASHHARVLINK-001)', () => {
  // The half that proves the fix is not just a deletion. location.state survives BOTH a dismiss/
  // re-open and an SW reload, so this is the same "preserve this?" form coming back to itself.
  it('the SAME prefilled context resumes its draft, harvest link included', async () => {
    const first = renderFullPage(HARVEST_PREFILL)
    typeQty('4')
    await waitFor(() => expect(readStash()?.qtyValue).toBe('4'))
    first.unmount()

    renderFullPage(HARVEST_PREFILL)
    await waitFor(() => expect(qtyField().value).toBe('4'))
    await save()
    expect(lastPost().harvest_log_id).toBe('h-1')
    expect(lastPost().plant_id).toBe('p-1')
  })

  // A resume must honour what the user TOOK BACK, not just what they typed: flipping the source to a
  // vendor clears both spine links (applySourceKind), and re-seeding them from the prefill would
  // resume the form re-asserting a garden harvest — the "half-applied" pair V4-PUTUPPROV-001 (D2-c)
  // exists to prevent, and one the server rejects.
  it('a resume honours a link the user CLEARED rather than re-seeding it from the prefill', async () => {
    const first = renderFullPage(HARVEST_PREFILL_NO_PLANT)
    typeQty('4')
    fireEvent.click(screen.getByRole('radio', { name: 'Somewhere else' }))
    await waitFor(() => expect(readStash()?.sourceKind).toBe('farm_stand'))
    expect(readStash().harvestLogId).toBeNull()
    first.unmount()

    renderFullPage(HARVEST_PREFILL_NO_PLANT)
    await waitFor(() => expect(qtyField().value).toBe('4'))
    await save()
    expect(lastPost().source_kind).toBe('farm_stand')
    expect(lastPost().harvest_log_id).toBeUndefined()
  })

  // Precedence control (passes before the fix too, by early-return): a DIFFERENT harvest is a
  // different explicit intent and must beat the stale draft outright — never silently swap which
  // harvest a put-up is attributed to.
  it('a DIFFERENT harvest is not resumed from another harvest draft', async () => {
    const first = renderFullPage(HARVEST_PREFILL)
    typeQty('4')
    await waitFor(() => expect(readStash()?.qtyValue).toBe('4'))
    first.unmount()

    renderFullPage({ crop_type_slug: 'tomato', plant_id: 'p-2', harvest_log_id: 'h-2' })
    const qty = await screen.findByRole('textbox', { name: 'Quantity' })
    expect(qty.value).toBe('')
    typeQty('9')
    await save()
    expect(lastPost().harvest_log_id).toBe('h-2')
    expect(lastPost().plant_id).toBe('p-2')
  })

  // Same rule for an unstamped draft arriving at a prefilled mount: unknown context, so the explicit
  // navigation wins. (Also a control on the stamp itself — if `prefillKey` ever stopped being
  // written, every draft would look pre-stamp and this is one of the two places that would notice.)
  it('a pre-stamp draft does not resume a prefilled mount', async () => {
    seedStash({ cropSlug: 'pepper', qtyValue: '99', harvestLogId: 'h-9' })
    renderFullPage(HARVEST_PREFILL)
    const cropSelect = await screen.findByRole('combobox', { name: 'Crop' })
    expect(cropSelect.value).toBe('tomato')
    expect(qtyField().value).toBe('')
    typeQty('2')
    await save()
    expect(lastPost().harvest_log_id).toBe('h-1')
  })
})
