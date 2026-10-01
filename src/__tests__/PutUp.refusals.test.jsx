// Put-Up release 1a — refused writes are explained by the server's `code` (design V4 §6.5 "409
// handling", §5.4, §11 first risk). The codes mostly arrive from release 1b/2 servers; this bundle is
// the one that will be stale when they do, so it has to read them already.
//
// Three things are pinned here, each with a control that proves the assertion can fail:
//   1. THE WORDS: describeRefusal's sentence per known code, the server's own text for an unknown
//      one, and the caller's old copy for anything uncoded (nothing that renders today changes).
//   2. THE EDIT STAYS: a refused save leaves the editor open with what was typed. Before this, put()
//      swallowed the throw and the editor closed anyway, so the edit was lost with the refusal.
//   3. THE TAP: "Refresh now" exists only for client_stale and calls useAppUpdate().apply() on the
//      tap — never on render, never on the refusal arriving (apply() reloads without consulting the
//      reload gate, so an automatic one would discard any other surface still holding it).
//
// Every refusal fixture is produced by the REAL api.js (global fetch stubbed to answer 409), never by
// hand: a hand-built Error would certify whatever shape this file invented — the class of mistake
// BUG-GOINGNOWENVELOPE-001 shipped, where both sides were green and disagreed about the wire.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({
    cropTypes: [
      { slug: 'tomato', display_name: 'Tomato', category: 'vegetable' },
      { slug: 'blueberry', display_name: 'Blueberries', category: 'fruit' },
    ],
    loading: false,
  }),
}))
const { applySpy } = vi.hoisted(() => ({ applySpy: vi.fn() }))
vi.mock('../hooks/useAppUpdate.js', () => ({ useAppUpdate: () => ({ update: null, apply: applySpy }) }))

import PutUp from '../pages/PutUp.jsx'
import { rowFromRecord } from './helpers/pantryFake.js'
import {
  describeRefusal, existingPlaceId, REFUSAL_CODES, REFRESH_NOW_LABEL, CLIENT_STALE_TEXT, BATCH_CLOSED_TEXT,
  COUNT_BELOW_USED_TEXT, ONLY_SOME_LEFT_TEXT, onlyNLeftText,
} from '../lib/putUpErrors.js'

// ── the wire ─────────────────────────────────────────────────────────────────────────────────────
// A refusal exactly as api.js throws it for a non-2xx answer carrying `body`.
async function serverSays(body, { status = 409, path = '/api/preservation/rec-1', method = 'PUT' } = {}) {
  const { apiFetch } = await vi.importActual('../lib/api.js')
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, statusText: 'Conflict', json: async () => body })))
  try {
    await apiFetch(path, { method }, 'token')
  } catch (e) {
    return e
  } finally {
    vi.unstubAllGlobals()
  }
  throw new Error('apiFetch resolved; the fixture expected a refusal')
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
const REC = {
  id: 'rec-1', crop_type_slug: 'tomato', variety_id: null, plant_id: null, harvest_log_id: null,
  preserved_at: '2026-07-01', method: 'whole_freeze', method_other_text: null,
  quantity_value: 14, quantity_unit: 'bags', package_count: 3, storage_location_id: 'loc-1',
  use_by_target: null, remaining_count: 3, consumed_at: null, notes: null, photo_id: null, use_by_status: null,
  source_kind: 'own_garden', source_label: null,
}
const STORES = {
  group_by: 'storage',
  groups: [{ group_key: 'loc-1', label: 'Garage freezer', total_packages: 3, units: ['bags'], use_soon_count: 0, records: [REC] }],
}

// `writes` answers the non-GET calls: a function of (path, options) returning a promise, or absent
// for a plain success.
function wire({ writes } = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (method !== 'GET' && writes) return writes(path, options)
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/plants') && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/harvests')) return Promise.resolve({ aggregates: { crops: [] } })
    // B′ release 2: the list is the Pantry (GET /api/pantry); a jar's sheet reads it by id.
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows: [rowFromRecord(REC, { id: 'loc-1', label: 'Garage freezer', kind: 'deep_freezer' })] })
    if (path === '/api/preservation/rec-1' && method === 'GET') return Promise.resolve(REC)
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve(STORES)
    if (path === '/api/preservation' && method === 'POST') return Promise.resolve({ id: 'new-1', source_kind: 'own_garden' })
    if (path.startsWith('/api/preservation/') && method === 'PUT') return Promise.resolve({ id: 'rec-1' })
    return Promise.resolve(null)
  })
}
const refuseWritesWith = (err) => wire({ writes: () => Promise.reject(err) })

function renderPage(entry = '/put-up') {
  return render(<MemoryRouter initialEntries={[entry]}><PutUp /></MemoryRouter>)
}
const writeCalls = (method) => fetchMock.mock.calls.filter(([, o]) => o?.method === method)

beforeEach(() => {
  fetchMock.mockReset(); applySpy.mockReset(); wire()
  sessionStorage.clear(); localStorage.clear()
})
afterEach(() => { vi.unstubAllGlobals() })

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('describeRefusal — the code decides the words', () => {
  const err = (body) => Object.assign(new Error(body?.error ?? 'HTTP 409'), { status: 409, body })

  it('client_stale: the client’s own sentence and the only refusal with a refresh, whatever the server said', () => {
    expect(describeRefusal(err({ error: 'stale bundle', code: 'client_stale' })))
      .toEqual({ code: 'client_stale', text: CLIENT_STALE_TEXT, refresh: true })
  })

  it('only_n_left: the number is the SERVER’s, read off the body', () => {
    expect(describeRefusal(err({ error: 'x', code: 'only_n_left', n: 2 })).text).toBe('Only 2 left — nothing was changed.')
    expect(describeRefusal(err({ error: 'x', code: 'only_n_left', n: 0 })).text).toBe('None are left — nothing was changed.')
    // The other spellings a future server might pick, including a numeric string off the driver.
    expect(describeRefusal(err({ code: 'only_n_left', left: 1 })).text).toBe('Only 1 left — nothing was changed.')
    expect(describeRefusal(err({ code: 'only_n_left', remaining: '4' })).text).toBe('Only 4 left — nothing was changed.')
    expect(describeRefusal(err({ code: 'only_n_left', remaining_count: 5 })).text).toBe('Only 5 left — nothing was changed.')
    // Not a count: a negative, a fraction, a boolean or an empty string is never shown as one.
    for (const bad of [-1, 1.5, true, '', 'two']) {
      expect(describeRefusal(err({ code: 'only_n_left', n: bad })).text).toBe(ONLY_SOME_LEFT_TEXT)
    }
    // No number: the server's own sentence, then the client's number-free one.
    expect(describeRefusal(err({ error: 'Only a couple left', code: 'only_n_left' })).text).toBe('Only a couple left')
    expect(describeRefusal(err({ code: 'only_n_left' })).text).toBe(ONLY_SOME_LEFT_TEXT)
  })

  it('batch_closed and count_below_used: the client’s sentence', () => {
    expect(describeRefusal(err({ error: 'closed', code: 'batch_closed' }))).toEqual({ code: 'batch_closed', text: BATCH_CLOSED_TEXT, refresh: false })
    expect(describeRefusal(err({ error: 'below', code: 'count_below_used' }))).toEqual({ code: 'count_below_used', text: COUNT_BELOW_USED_TEXT, refresh: false })
  })

  it('an unknown code: the server’s own text — `message` first, then `error` — never a generic failure', () => {
    expect(describeRefusal(err({ message: 'Mark the rest Went bad first', error: 'has uses', code: 'has_uses' })))
      .toEqual({ code: 'has_uses', text: 'Mark the rest Went bad first', refresh: false })
    expect(describeRefusal(err({ error: '1 was used — undo that use first', code: 'has_uses' })).text)
      .toBe('1 was used — undo that use first')
    // A code with no words at all: null, so the caller's own copy renders.
    expect(describeRefusal(err({ code: 'has_uses' }))).toBeNull()
    expect(describeRefusal(err({ code: 'has_uses', error: '   ' }))).toBeNull()
  })

  it('anything uncoded is null, so every existing message renders exactly as before', () => {
    expect(describeRefusal(err({ error: 'Internal server error' }))).toBeNull()
    expect(describeRefusal(err({ error: 'x', code: '' }))).toBeNull()
    expect(describeRefusal(err({ error: 'x', code: 409 }))).toBeNull()
    expect(describeRefusal(Object.assign(new Error('Request timed out'), { status: 0, timeout: true }))).toBeNull()
    // Clerk's offline error and the storage field's retry classifier put THEIR codes on err.code.
    expect(describeRefusal(Object.assign(new Error('offline'), { code: 'clerk_offline' }))).toBeNull()
    expect(describeRefusal(null)).toBeNull()
    expect(describeRefusal('boom')).toBeNull()
  })

  it('place_exists: the server’s words (it writes them to be shown as-is), and the existing id for a create', () => {
    expect(describeRefusal(err({ message: 'You already have a place called Chest Freezer 1.', error: 'dup', code: 'place_exists', id: 'loc-1' })))
      .toEqual({ code: 'place_exists', text: 'You already have a place called Chest Freezer 1.', refresh: false })
    expect(existingPlaceId(err({ code: 'place_exists', id: 'loc-1' }))).toBe('loc-1')
    expect(existingPlaceId(err({ code: 'place_exists', existing_id: ' loc-2 ' }))).toBe('loc-2')
    expect(existingPlaceId(err({ code: 'place_exists', place_id: 'loc-3' }))).toBe('loc-3')
    expect(existingPlaceId(err({ code: 'place_exists', existing: { id: 'loc-4' } }))).toBe('loc-4')
    expect(existingPlaceId(err({ code: 'place_exists', place: { id: 'loc-5' } }))).toBe('loc-5')
    // Only place_exists names a place: an id on any other refusal is not an invitation to select it.
    expect(existingPlaceId(err({ code: 'client_stale', id: 'loc-1' }))).toBeNull()
    expect(existingPlaceId(err({ error: 'dup', id: 'loc-1' }))).toBeNull()
    expect(existingPlaceId(err({ code: 'place_exists', id: '  ' }))).toBeNull()
    expect(existingPlaceId(err({ code: 'place_exists' }))).toBeNull()
    expect(existingPlaceId(null)).toBeNull()
  })

  it('refresh is offered for client_stale and for nothing else', () => {
    const offered = [...Object.values(REFUSAL_CODES), 'has_uses']
      .filter(code => describeRefusal(err({ error: 'x', code, n: 1 }))?.refresh)
    expect(offered).toEqual(['client_stale'])
  })
})

describe('the wire — api.js hands over the body the Lambda sent', () => {
  it('a coded 409 reaches describeRefusal with its code', async () => {
    const e = await serverSays({ error: 'This app is out of date', code: 'client_stale' })
    expect(e.status).toBe(409)
    expect(describeRefusal(e)?.code).toBe('client_stale')
  })

  it('a 409 whose body is not JSON carries no code, and falls back to the caller’s copy', async () => {
    const { apiFetch } = await vi.importActual('../lib/api.js')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, statusText: 'Conflict', json: async () => { throw new SyntaxError('html') } })))
    const e = await apiFetch('/api/preservation/rec-1', { method: 'PUT' }, 'token').catch(x => x)
    expect(e.status).toBe(409)
    expect(describeRefusal(e)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// AMENDED for B′ release 2: the retired RecordRow's writes live on the Pantry row (Used one / Used it up)
// and its sheet (Edit, with Remove inside, two-step). Same routes, same refusal words, same Refresh now.
describe('the Pantry row and its sheet — a refused write says why, and the edit stays', () => {
  const USED_ONE = /^Used one — /
  const openSheet = async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId('pantry-row-open-put_up:rec-1'))
    return screen.findByTestId('row-sheet')
  }
  async function openEditor() {
    await openSheet()
    fireEvent.click(screen.getByTestId('row-edit'))
    return screen.findByRole('button', { name: 'Save' })
  }
  async function removeTwoStep() {
    await openSheet()
    fireEvent.click(screen.getByTestId('row-edit'))
    fireEvent.click(await screen.findByTestId('jar-edit-remove'))
    fireEvent.click(screen.getByTestId('jar-edit-remove-confirm'))
  }

  it('Used one → client_stale: the reason, and a Refresh now that has not run', async () => {
    refuseWritesWith(await serverSays({ error: 'stale', code: 'client_stale' }))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: USED_ONE }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(CLIENT_STALE_TEXT))
    expect(screen.getByRole('button', { name: REFRESH_NOW_LABEL })).toBeTruthy()
    expect(applySpy).not.toHaveBeenCalled()
    // The row's own action is usable again: the refusal is not a lock.
    expect(screen.getByRole('button', { name: USED_ONE }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: REFRESH_NOW_LABEL }))
    expect(applySpy).toHaveBeenCalledTimes(1)
  })

  it('a refused Edit keeps the editor open with everything typed (count_below_used)', async () => {
    refuseWritesWith(await serverSays({ error: 'below used', code: 'count_below_used' }))
    await openEditor()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Number of containers' }), { target: { value: '1' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'two went to Jen' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(COUNT_BELOW_USED_TEXT))
    // Release F: the Edit is ONE PATCH (the count rides it with the same delta rule), no PUT.
    expect(writeCalls('PATCH').length).toBe(1)
    expect(writeCalls('PUT').length).toBe(0)
    // Still the editor, still his values.
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.getByRole('spinbutton', { name: 'Number of containers' }).value).toBe('1')
    expect(screen.getByRole('textbox', { name: 'Notes' }).value).toBe('two went to Jen')
    expect(screen.queryByRole('button', { name: REFRESH_NOW_LABEL })).toBeNull()
  })

  it('a refused Edit on a stale bundle keeps the edit AND offers Refresh now, which runs only on the tap', async () => {
    refuseWritesWith(await serverSays({ error: 'stale', code: 'client_stale' }))
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'moved to the chest freezer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const refresh = await screen.findByRole('button', { name: REFRESH_NOW_LABEL })
    expect(screen.getByRole('textbox', { name: 'Notes' }).value).toBe('moved to the chest freezer')
    expect(applySpy).not.toHaveBeenCalled()
    fireEvent.click(refresh)
    expect(applySpy).toHaveBeenCalledTimes(1)
  })

  it('CONTROL: a save that lands still closes the editor', async () => {
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'fine' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('only_n_left shows the number the SERVER sent, not the one on the row', async () => {
    // The row reads 3 left. The server knows the other person used two since this page loaded.
    refuseWritesWith(await serverSays({ error: 'x', code: 'only_n_left', n: 1 }))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: USED_ONE }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(onlyNLeftText(1)))
    expect(screen.getByRole('alert').textContent).not.toMatch(/\b3\b/)
  })

  it('batch_closed says so', async () => {
    refuseWritesWith(await serverSays({ error: 'x', code: 'batch_closed' }))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: USED_ONE }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(BATCH_CLOSED_TEXT))
  })

  it('Remove refused with a code this bundle does not know: the server’s own words', async () => {
    refuseWritesWith(await serverSays({ error: '1 was used — mark the rest Went bad, or undo that use', code: 'jar_has_uses' }, { method: 'DELETE' }))
    await removeTwoStep()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('1 was used — mark the rest Went bad, or undo that use'))
  })

  it('an uncoded failure keeps today’s copy exactly (update and remove)', async () => {
    refuseWritesWith(await serverSays({ error: 'Internal server error' }, { status: 500 }))
    const view = renderPage()
    fireEvent.click(await screen.findByRole('button', { name: USED_ONE }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Couldn't update — try again."))
    view.unmount()
    await removeTwoStep()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Couldn't remove — try again."))
    expect(screen.queryByRole('button', { name: REFRESH_NOW_LABEL })).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('every other write on the page reads the code too', () => {
  it('the log form: client_stale in the banner, Refresh now, and the typed entries kept', async () => {
    refuseWritesWith(await serverSays({ error: 'stale', code: 'client_stale' }, { path: '/api/preservation', method: 'POST' }))
    renderPage({ pathname: '/put-up', state: { prefill: { crop_type_slug: 'tomato' } } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    const refresh = await screen.findByRole('button', { name: REFRESH_NOW_LABEL })
    expect(screen.getByRole('alert').textContent).toContain(CLIENT_STALE_TEXT)
    expect(screen.getByRole('textbox', { name: 'Quantity' }).value).toBe('6')
    expect(applySpy).not.toHaveBeenCalled()
    fireEvent.click(refresh)
    expect(applySpy).toHaveBeenCalledTimes(1)
  })

  it('the log form: an uncoded 400 still reads the way it always has', async () => {
    refuseWritesWith(await serverSays({ error: 'quantity_value must be > 0' }, { status: 400, path: '/api/preservation', method: 'POST' }))
    renderPage({ pathname: '/put-up', state: { prefill: { crop_type_slug: 'tomato' } } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Couldn't save — quantity_value must be > 0"))
  })

  // B′ release 2: the freezer walk is Walk a place — same band, same Undo, same refusal words.
  it('the walk’s Undo: a coded refusal is shown in the band in the server’s words', async () => {
    const undoRefusal = await serverSays({ error: 'That one was already used', code: 'jar_has_uses' }, { method: 'DELETE' })
    wire({
      writes: (_path, options) => (options.method === 'POST'
        ? Promise.resolve({ id: 'new-1', source_kind: 'own_garden', crop_type_slug: 'blueberry' })
        : Promise.reject(undoRefusal)),
    })
    const base = fetchMock.getMockImplementation()
    const locations = [{ id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' }]
    fetchMock.mockImplementation((path, options = {}) => (
      path === '/api/storage-locations' && (options.method || 'GET') === 'GET' ? Promise.resolve(locations) : base(path, options)
    ))
    renderPage('/put-up?session=putup')
    fireEvent.click(await screen.findByRole('radio', { name: 'Chest Freezer 1' }))
    fireEvent.click(screen.getByRole('radio', { name: 'This month' }))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    fireEvent.change(await screen.findByTestId('walk-what-name'), { target: { value: 'Blueberries' } })
    fireEvent.click(screen.getByTestId('walk-method-whole_freeze'))
    fireEvent.click(screen.getByTestId('walk-save'))
    const band = screen.getByTestId('putup-walk-band')
    fireEvent.click(await within(band).findByTestId('putup-walk-undo'))
    await waitFor(() => expect(within(band).getByRole('alert').textContent).toBe('That one was already used'))
  })

  it('adding a storage location: a coded refusal replaces the diagnostic line', async () => {
    refuseWritesWith(await serverSays({ error: 'You already have a place called Garage freezer', code: 'location_label_taken' }, { path: '/api/storage-locations', method: 'POST' }))
    renderPage({ pathname: '/put-up', state: { prefill: { crop_type_slug: 'tomato' } } })
    fireEvent.click(screen.getByRole('button', { name: /New location/i }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New location name' }), { target: { value: 'Garage freezer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('You already have a place called Garage freezer'))
  })
})

// V4 §3.2 — the swept words. Every sentence this lane adds to a surface, checked as a whole word.
describe('words — none of the refusal copy uses a banned word', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
  it.each([
    ['client_stale', CLIENT_STALE_TEXT], ['batch_closed', BATCH_CLOSED_TEXT],
    ['count_below_used', COUNT_BELOW_USED_TEXT], ['only_n_left, no number', ONLY_SOME_LEFT_TEXT],
    ['only_n_left, 0', onlyNLeftText(0)], ['only_n_left, 1', onlyNLeftText(1)], ['only_n_left, 7', onlyNLeftText(7)],
    ['the button', REFRESH_NOW_LABEL],
  ])('%s', (_name, text) => {
    expect(text).not.toMatch(BANNED)
  })
  it('INSTRUMENT: the same pattern does catch a banned word', () => {
    expect('This change is done.').toMatch(BANNED)
    expect('The shelf life is short.').toMatch(BANNED)
  })
})
