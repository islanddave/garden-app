// V4-EVENTSEL-005 — ONE note for the whole Log Many batch.
//
// The parity gap: Log Event had Notes, Log Many did not. The reason it could not be closed
// client-side is what most of this file is about — POST /api/events/batch neither validated nor
// inserted `notes`, so a note typed here would have been discarded across the entire batch behind
// a green success screen. The Lambda half of this change is tested in
// lambda/events/batch-notes.test.js; these are the client-side assertions.
//
// Harness note (LogManyHarvestHint.test.jsx documents a 4GB OOM from a fourth full LogMany render
// in one file): the render count here is kept low, and the cross-file constant check at the bottom
// is a SOURCE test rather than a render, because the property it pins — that the client cap equals
// the server cap — spans two files and no single render can express it.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { draftKey } from '../lib/draftStash.js'

const HERE = dirname(fileURLToPath(import.meta.url))

installStoragePolyfill()

const navigate = vi.fn()
const location = { pathname: '/log/many', search: '', state: {} }
const searchParams = new URLSearchParams()
const setSearchParams = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, setSearchParams],
  useLocation: () => location,
  Link: ({ children }) => children,
}))

const apiFetch = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch }) }))

import LogMany, { MAX_BATCH_NOTE_LEN } from '../pages/LogMany.jsx'

const PLANTINGS = [{ id: 'pl-1', name: 'Aji Dulce' }, { id: 'pl-2', name: 'Basil Row' }]
const batchPosts = []

beforeEach(() => {
  navigate.mockClear()
  batchPosts.length = 0
  try { sessionStorage.clear(); localStorage.clear() } catch { /* noop */ }
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path === '/api/projects') return Promise.resolve([])
    if (path === '/api/locations') return Promise.resolve({ locations: [] })
    if (path === '/api/events/batch' && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      if (body.dry_run) return Promise.resolve({ count: PLANTINGS.length, plantings: PLANTINGS })
      batchPosts.push(body)
      return Promise.resolve({ batch_id: 'b-1', count: PLANTINGS.length })
    }
    return Promise.resolve(null)
  })
})
afterEach(() => cleanup())

async function renderReady() {
  render(<LogMany />)
  await screen.findByText(/^Log watered on 2$/)
}

const openNotes = () => fireEvent.click(screen.getByTestId('logmany-notes-disclosure'))
const noteField = () => screen.getByLabelText('Notes for this batch')
const type = (v) => fireEvent.change(noteField(), { target: { value: v } })

async function confirm() {
  fireEvent.click(await screen.findByText(/^Log watered on 2$/))
  await waitFor(() => expect(batchPosts.length).toBe(1))
}

describe('LogMany notes — the field exists and says what it does', () => {
  it('offers a Notes disclosure, collapsed, whose LABEL states the batch scope before any tap', async () => {
    // The label is load-bearing, not decoration: a note field that silently lands on 30 events when
    // the user meant one is a data-quality defect. The scope has to be legible BEFORE the tap, so
    // it lives in the collapsed header as well as under the field.
    await renderReady()
    const toggle = screen.getByTestId('logmany-notes-disclosure')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toMatch(/one for the whole batch/i)
    expect(screen.queryByLabelText('Notes for this batch')).toBeNull()
  })

  it('opens to a textarea whose helper text names the fan-out, and describes the field with it', async () => {
    await renderReady()
    openNotes()
    const field = noteField()
    expect(field).toBeTruthy()
    const hint = screen.getByTestId('logmany-notes-scope')
    expect(hint.textContent).toMatch(/every planting in this batch/i)
    expect(hint.textContent).toMatch(/same note is saved on each one/i)
    // Not merely nearby — wired, so a screen reader hears the scope when it reaches the field.
    expect(field.getAttribute('aria-describedby')).toBe(hint.getAttribute('id'))
  })

  it('caps the field at the server cap so the client cannot produce a rejectable value', async () => {
    await renderReady()
    openNotes()
    expect(Number(noteField().getAttribute('maxlength'))).toBe(MAX_BATCH_NOTE_LEN)
  })
})

describe('LogMany notes — what reaches the batch POST', () => {
  it('sends the trimmed note ONCE, as a batch-level field', async () => {
    await renderReady()
    openNotes()
    type('  side-dressed the whole bed with blood meal  ')
    await confirm()
    expect(batchPosts[0].notes).toBe('side-dressed the whole bed with blood meal')
    // Per-row notes are explicitly out of scope (Dave's ruling) — nothing per-plant is emitted.
    expect(batchPosts[0].plant_metadata).toBeUndefined()
  })

  it('omits `notes` entirely when the field is untouched — the old contract is byte-unchanged', async () => {
    await renderReady()
    await confirm()
    expect('notes' in batchPosts[0]).toBe(false)
  })

  it('omits `notes` for a whitespace-only note rather than sending an empty string', async () => {
    // A '' would become 500 rows that every read surface reports as "has a note" and renders blank.
    // Prod holds zero such rows today.
    await renderReady()
    openNotes()
    type('   \n  ')
    await confirm()
    expect('notes' in batchPosts[0]).toBe(false)
  })

  it('confirms the stored note, and on how many rows, on the result screen', async () => {
    // Operational confirmation of a task the user explicitly started (Reward-UX V101 exempt), in
    // the same register as the water-depth "Recorded as …" line beside it. It is what makes
    // "did my note go through?" answerable without opening an event.
    await renderReady()
    openNotes()
    type('frost cloth on overnight')
    await confirm()
    const recorded = await screen.findByTestId('logmany-note-recorded')
    expect(recorded.textContent).toMatch(/Note saved on all 2/)
    expect(recorded.textContent).toMatch(/frost cloth on overnight/)
  })
})

describe('LogMany notes — persistence and reset', () => {
  it('a typed note survives a dismiss via the draft stash, and comes back VISIBLE', async () => {
    // The note is the only free text on this form and the most expensive thing here to lose. The
    // open state is derived (`showNotes || !!notes`), so a restored draft does not hide it behind a
    // collapsed disclosure.
    await renderReady()
    openNotes()
    type('pinched suckers on the whole row')
    await waitFor(() => {
      const raw = sessionStorage.getItem(draftKey('logmany'))
      expect(raw).toBeTruthy()
      expect(JSON.parse(raw).data.notes).toBe('pinched suckers on the whole row')
    })

    cleanup()
    render(<LogMany />)
    const restored = await screen.findByLabelText('Notes for this batch')
    expect(restored.value).toBe('pinched suckers on the whole row')
    expect(screen.getByTestId('logmany-notes-disclosure').getAttribute('aria-expanded')).toBe('true')
  })

  it('"Log more" clears the note — a new batch must not silently inherit the last one\'s prose', async () => {
    await renderReady()
    openNotes()
    type('side-dressed the whole bed')
    await confirm()
    fireEvent.click(await screen.findByText('Log more'))
    await screen.findByText(/^Log watered on 2$/)
    // Back to collapsed-and-empty: the disclosure is shut, which is only possible when notes === ''.
    expect(screen.getByTestId('logmany-notes-disclosure').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Notes for this batch')).toBeNull()
  })
})

describe('LogMany notes — cross-file invariants (source)', () => {
  const read = (p) => readFileSync(resolve(HERE, p), 'utf8')

  it('the client cap equals the server cap', () => {
    // Looser than the server and a valid-looking note 400s with no client explanation; tighter and
    // the client silently truncates. Two files, one number — which is exactly the class of property
    // no single-file render test can express.
    const serverSrc = read('../../lambda/events/validators.js')
    const m = serverSrc.match(/export const MAX_NOTES_LEN = (\d+);/)
    expect(m, 'MAX_NOTES_LEN not found in lambda/events/validators.js').toBeTruthy()
    expect(Number(m[1])).toBe(MAX_BATCH_NOTE_LEN)
  })

  it('the server still validates and inserts notes on the batch route', () => {
    // The tripwire for the deploy-order hazard: if this ever goes red while the client field is
    // still present, Log Many is silently discarding notes again. Exhaustive coverage lives in
    // lambda/events/batch-notes.test.js; this is the cross-referencing guard so the dependency the
    // client surface relies on cannot vanish without a failure on the client side too.
    expect(read('../../lambda/events/validators.js')).toMatch(/const notesErr = validateNotes\(body\.notes\);/)
    expect(read('../../lambda/events/index.js')).toMatch(/metadata, source, notes\)/)
    expect(read('../../lambda/events/index.js')).toMatch(/\$\{batchNotes\}::text/)
  })
})
