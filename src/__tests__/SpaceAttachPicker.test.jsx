// SpaceAttachPicker.test.jsx — V4-SPACECLIENTGAP-001 Stage 2.
//
// The batch-attach sheet is the ONLY client caller of PUT /api/photos/:id/space, so these are the
// only tests standing between that route and a client that can silently mis-file photos. No
// jest-dom (L-182): assert via roles + text + attributes + toBe/toBeTruthy/toBeNull.
//
// The load-bearing assertions are the ones covering states a happy-path click-through never
// reaches: already-attached rows must be EXCLUDED (not shown twice with different affordances), a
// PARTIAL failure must keep the sheet open with only the failures selected, and a failed batch must
// not report success to the page.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }),
  apiFetch: (...a) => fetchSpy(...a),
}))
// PhotoImg owns presign/retry behavior irrelevant here; stub to a bare img so tile assertions are
// about SELECTION, not image loading.
vi.mock('../components/PhotoImg.jsx', () => ({
  default: ({ alt }) => <img alt={alt} data-testid="tile-img" />,
}))

import SpaceAttachPicker from '../components/SpaceAttachPicker.jsx'

const SPACE = 'space-1'

// Three attachable rows plus one already on this space.
const LIST = [
  { id: 'p1', caption: 'wide shot', thumb_url: 'https://x/1.jpg', space_id: null },
  { id: 'p2', caption: 'drive', thumb_url: 'https://x/2.jpg', space_id: null },
  { id: 'p3', caption: 'pasture', thumb_url: 'https://x/3.jpg', space_id: null },
  { id: 'p4', caption: 'already here', thumb_url: 'https://x/4.jpg', space_id: SPACE },
]

function mount(props = {}) {
  return render(
    <SpaceAttachPicker spaceId={SPACE} spaceName="Gardens at Mathews Ridge"
      onClose={props.onClose ?? vi.fn()} onAttached={props.onAttached ?? vi.fn()} />,
  )
}

// Route the list read and the attach PUTs independently so a test can fail a SUBSET of the PUTs.
function wireFetch({ list = LIST, failIds = new Set(), listError = null } = {}) {
  fetchSpy.mockImplementation((path, opts) => {
    if (path.startsWith('/api/photos?')) {
      return listError ? Promise.reject(listError) : Promise.resolve(list)
    }
    const m = path.match(/^\/api\/photos\/([^/]+)\/space$/)
    if (m && opts?.method === 'PUT') {
      return failIds.has(m[1])
        ? Promise.reject(new Error('nope'))
        : Promise.resolve({ id: m[1], space_id: SPACE })
    }
    return Promise.resolve(null)
  })
}

// V4-A11YGATE-001: the tile is a BUTTON inside a listitem wrapper, not a listitem pretending to be
// a button. Selecting it by its button role is what keeps this helper honest — under the old markup
// `getByRole('listitem', { name })` matched a role that cannot be named, and the mirror assertion
// `queryByRole('listitem', { name: /already here/ })` below would have passed vacuously.
const tile = (caption) => screen.getByRole('button', { name: new RegExp(caption) })

beforeEach(() => { fetchSpy.mockReset(); document.body.innerHTML = '' })

describe('candidate set', () => {
  it('EXCLUDES photos already attached to this space', async () => {
    // They are visible one scroll down in the gallery this sheet sits over; listing them again is
    // the same photo twice on one screen with different affordances.
    wireFetch()
    mount()
    await screen.findByRole('list', { name: 'Photos you can add' })
    expect(screen.queryByRole('button', { name: /already here/ })).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    // The tiles are real toggles again: button role + a valid aria-pressed (V4-A11YGATE-001).
    expect(screen.getAllByRole('button', { name: /^Select / })).toHaveLength(3)
    expect(tile('wide shot').getAttribute('aria-pressed')).toBe('false')
  })

  it('distinguishes "you have no photos" from "they are all already here"', async () => {
    // Saying "no photos" to someone whose whole library is already on the space would be a lie.
    wireFetch({ list: [{ id: 'p4', caption: 'already here', space_id: SPACE }] })
    mount()
    const empty = await screen.findByTestId('space-attach-empty')
    expect(empty.textContent).toContain('already on this space')
  })

  it('surfaces a load failure as an error with a Retry, not as an empty picker', async () => {
    wireFetch({ listError: new Error('boom') })
    mount()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load your photos')
    expect(screen.queryByTestId('space-attach-empty')).toBeNull()
  })
})

describe('the 200-row cap', () => {
  it('says so when the list comes back full — silent truncation reads as "my photo is gone"', async () => {
    // GET /api/photos caps at 200 with no offset/cursor, and prod carries ~981 photos. Presenting
    // a partial library as the whole thing is the failure mode this notice exists to prevent.
    const full = Array.from({ length: 200 }, (_, i) => ({
      id: `f${i}`, caption: `photo ${i}`, thumb_url: 'https://x/f.jpg', space_id: null,
    }))
    wireFetch({ list: full })
    mount()
    const note = await screen.findByTestId('space-attach-truncated')
    expect(note.textContent).toContain('200 most recent')
  })

  it('stays quiet on a short list, where nothing is being hidden', async () => {
    wireFetch()
    mount()
    await screen.findByRole('list', { name: 'Photos you can add' })
    expect(screen.queryByTestId('space-attach-truncated')).toBeNull()
  })

  it('requests the full page size', async () => {
    wireFetch()
    mount()
    await screen.findByRole('list', { name: 'Photos you can add' })
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/photos?limit=200')
  })
})

describe('attaching', () => {
  it('PUTs the space sub-resource once per selected photo and reports the count', async () => {
    // The route is single-photo by design, so a batch is N requests. Asserting the exact path and
    // body is what pins the client to the ATTACH sub-resource rather than the general re-tag PUT
    // (which cannot carry space_id at all).
    wireFetch()
    const onAttached = vi.fn()
    mount({ onAttached })
    await screen.findByRole('list', { name: 'Photos you can add' })

    fireEvent.click(tile('wide shot'))
    fireEvent.click(tile('pasture'))
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 to Space' }))

    await waitFor(() => expect(onAttached).toHaveBeenCalled())
    const puts = fetchSpy.mock.calls.filter(([, o]) => o?.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(puts.map(([p]) => p).sort()).toEqual(['/api/photos/p1/space', '/api/photos/p3/space'])
    for (const [, o] of puts) expect(JSON.parse(o.body)).toEqual({ space_id: SPACE })
    expect(onAttached).toHaveBeenCalledWith({ attached: 2, failed: 0, done: true })
  })

  it('deselects on a second tap', async () => {
    wireFetch()
    mount()
    await screen.findByRole('list', { name: 'Photos you can add' })
    fireEvent.click(tile('wide shot'))
    expect(tile('wide shot').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(tile('wide shot'))
    expect(screen.queryByRole('button', { name: /Add \d+ to Space/ })).toBeNull()
  })

  it('never issues a PUT with nothing selected — the action bar is not rendered at all', async () => {
    wireFetch()
    mount()
    await screen.findByRole('list', { name: 'Photos you can add' })
    expect(screen.queryByRole('button', { name: /Add \d+ to Space/ })).toBeNull()
    expect(fetchSpy.mock.calls.filter(([, o]) => o?.method === 'PUT')).toHaveLength(0)
  })
})

describe('partial failure', () => {
  it('keeps the sheet open with ONLY the failures still selected, and does not report done', async () => {
    // N independent requests means "some worked" is the COMMON failure. Closing here would hide
    // which ones, and re-selecting everything would re-attach the ones that already landed.
    wireFetch({ failIds: new Set(['p2']) })
    const onClose = vi.fn()
    const onAttached = vi.fn()
    mount({ onClose, onAttached })
    await screen.findByRole('list', { name: 'Photos you can add' })

    fireEvent.click(tile('wide shot'))
    fireEvent.click(tile('drive'))
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 to Space' }))

    await waitFor(() => expect(onAttached).toHaveBeenCalled())
    expect(onAttached).toHaveBeenCalledWith({ attached: 1, failed: 1, done: false })
    expect(onClose).not.toHaveBeenCalled()
    // Only the failure survives the selection, so the retry cannot double-attach the success.
    expect(tile('drive').getAttribute('aria-pressed')).toBe('true')
    expect(tile('wide shot').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('announces the failure count in a live region — a red border is invisible to a screen reader', async () => {
    wireFetch({ failIds: new Set(['p1']) })
    mount()
    await screen.findByRole('list', { name: 'Photos you can add' })
    fireEvent.click(tile('wide shot'))
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 to Space' }))
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('1 couldn’t be added')
    expect(status.getAttribute('aria-live')).toBe('polite')
  })

  it('a fully-failed batch reports zero attached, so the page does not refresh or claim success', async () => {
    wireFetch({ failIds: new Set(['p1', 'p2']) })
    const onAttached = vi.fn()
    mount({ onAttached })
    await screen.findByRole('list', { name: 'Photos you can add' })
    fireEvent.click(tile('wide shot'))
    fireEvent.click(tile('drive'))
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 to Space' }))
    await waitFor(() => expect(onAttached).toHaveBeenCalled())
    expect(onAttached).toHaveBeenCalledWith({ attached: 0, failed: 2, done: false })
  })
})

describe('dialog affordances', () => {
  it('is a labelled modal dialog', async () => {
    wireFetch()
    mount()
    const dlg = await screen.findByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('aria-label')).toContain('Gardens at Mathews Ridge')
  })

  it('closes on Escape', async () => {
    wireFetch()
    const onClose = vi.fn()
    mount({ onClose })
    await screen.findByRole('list', { name: 'Photos you can add' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('every tap target clears the 44px floor', async () => {
    // The frozen token is T.buttonMinHeight: 48 (formStyles.js:28). Tiles are a 3-up grid of square
    // thumbs, comfortably over; the CONTROLS are the ones that were at risk.
    wireFetch()
    mount()
    await screen.findByRole('list', { name: 'Photos you can add' })
    fireEvent.click(tile('wide shot'))
    for (const name of ['Cancel', 'Add 1 to Space']) {
      const btn = screen.getByRole('button', { name })
      expect(parseInt(btn.style.minHeight, 10), `${name} minHeight`).toBeGreaterThanOrEqual(44)
    }
  })
})
