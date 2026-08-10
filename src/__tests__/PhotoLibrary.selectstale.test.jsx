/**
 * src/__tests__/PhotoLibrary.selectstale.test.jsx
 * BUG-PHOTOSELSTALE-001 — the multi-select bar described a list that no longer existed.
 *
 * THE DEFECT: changing a filter refetches and REPLACES `photos`, but nothing cleared `selected`
 * (only exitSelectMode did). `selectedPhotos = photos.filter(p => selected.has(p.id))` therefore
 * silently dropped every id missing from the new list — while the bar's count label and its Max-10
 * guard both still read the stale `selected.size`. Two user-visible faces of one bug:
 *   under-post — the bar says "12 selected" and the button posts 5.
 *   false block — the bar says "Max 10" and refuses, when only 4 photos would actually be posted.
 * This is the sole entry point for the V4-FBSHARE-001 Facebook Page share (shipped but dormant), so
 * the first face is a wrong-photos-posted-PUBLICLY bug the moment the feature is switched on.
 *
 * WHAT THESE TESTS PIN. Not "the Set is cleared" — that is one implementation of the fix and a test
 * that only asserted it would pass a future refactor that reintroduced the divergence somewhere new.
 * The invariant is: EVERY affordance on the bar (that it exists, its count, its max guard, what the
 * button posts) resolves to the SAME set of photos. So the share sheet is stubbed to expose exactly
 * what it was handed, and the count on the bar is checked against it rather than against a literal.
 *
 * The last describe is the regression check on the OTHER consumer of select-mode: the tag modal is
 * reached by tapping a photo while NOT in select mode, so anything that changes selection lifecycle
 * can strand the only photo-tagging entry point in the app.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

// V4-PROJHIDE-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip and
// its assertions describe the projects-VISIBLE UI (project chooser, project tree, "By project" scope),
// which remains a live configuration — rollback is a one-line revert. Pinned FALSE so every assertion
// below keeps covering what it was written to cover, rather than being rewritten to the flag-ON world
// and silently weakened. Flag-ON is covered by the *.projhide.test.jsx suites.
// importActual spread so every other flag keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null,
    preview: null, stage: null, progress: null, reset: vi.fn(),
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

// The share sheet is stubbed to REPORT its cargo rather than render it. `photos` here is the literal
// array openShare() was called with, which is the ground truth the bar's label is judged against —
// the real sheet would only show them, and "showed 5 while the bar said 12" is the bug itself.
vi.mock('../components/FacebookShareSheet.jsx', () => ({
  default: ({ open, photos }) => (open
    ? <div data-testid="fb-sheet" data-ids={photos.map(p => p.id).join(',')}>{photos.length} posting</div>
    : null),
}))

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import PhotoLibrary from '../pages/PhotoLibrary.jsx'

const PROJECT  = { id: 'proj-1', name: 'Spring 2026' }
const LOCATION = { id: 'loc-1', full_path: 'Garden › Bed A', is_active: true }
const PLANT    = { id: 'plant-1', name: 'Sungold', project_id: 'proj-1', project_name: 'Spring 2026' }

// thumb_url only, never view_url — same reason as PhotoLibrary.pickerclip.test.jsx: it gives the grid
// card its accessible name without pulling the presign-on-mount path into a test about state.
// The caption doubles as that accessible name, so photos are addressable individually.
const photo = n => ({
  id: `ph-${n}`, project_id: 'proj-1', project_name: 'Spring 2026',
  caption: `Photo ${n}`, thumb_url: `blob:thumb-${n}`,
})
// Twelve, because the max guard only has anything to say above ten.
const ALL = Array.from({ length: 12 }, (_, i) => photo(i + 1))

beforeEach(() => {
  fetchSpy.mockReset()
  if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = vi.fn(() => 'blob:stub')
  if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = vi.fn()
})

afterEach(() => { vi.unstubAllEnvs() })

async function mount({ photos = ALL, share = true } = {}) {
  // The Select button — and so the whole bar — is dormant until the share endpoint is configured.
  if (share) vi.stubEnv('VITE_API_FACEBOOK_SHARE', 'https://example.invalid/share')
  fetchSpy.mockResolvedValueOnce([PROJECT])    // /api/projects
  fetchSpy.mockResolvedValueOnce([LOCATION])   // /api/locations/with-path
  fetchSpy.mockResolvedValueOnce(photos)       // /api/photos
  render(<PhotoLibrary />)
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
  await screen.findByRole('button', { name: cardName(1) })
}

// The card's accessible name is the caption PLUS the "standalone" chip and the project strip, so it
// is matched by prefix. \b keeps "Photo 1" from also matching "Photo 12".
const cardName = n => new RegExp(`^Photo ${n}\\b`)
const card = n => screen.getByRole('button', { name: cardName(n) })
const bar  = () => screen.queryByTestId('pl-select-bar')

function pick(...ns) { for (const n of ns) fireEvent.click(card(n)) }

// The number the user reads off the bar. null when there is no bar to read.
function labelCount() {
  const b = bar()
  if (!b) return null
  return Number(within(b).getByText(/\d+ selected/).textContent.match(/\d+/)[0])
}

// Zone is the SERVER-side filter, so the post-filter list is whatever the mock returns — which lets
// each case state its own "these survived the filter" set. (The mode chips filter client-side, so
// they could not express a partial overlap.)
async function filterToZone(surviving) {
  fetchSpy.mockResolvedValueOnce(surviving)
  await act(async () => {
    fireEvent.change(screen.getByDisplayValue(/Filter by zone/i), { target: { value: 'loc-1' } })
  })
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos?location_id=loc-1'))
}

describe('BUG-PHOTOSELSTALE-001 — the count label must describe the CURRENT list', () => {
  it('shows the selection while the list it was made against is still on screen', async () => {
    await mount()
    fireEvent.click(screen.getByText('Select'))
    pick(1, 2, 3)
    expect(labelCount()).toBe(3)
  })

  it('does not keep reading a pre-filter count after the list is replaced', async () => {
    await mount()
    fireEvent.click(screen.getByText('Select'))
    pick(...ALL.map((_, i) => i + 1))
    expect(labelCount()).toBe(12)

    // Four of the twelve survive the filter. THE BUG: the label kept saying 12.
    await filterToZone(ALL.slice(0, 4))

    // Cleared, not intersected — so there is no selection left to describe, and critically the label
    // is not asserting 12 (or any number) about photos that are no longer listed.
    expect(labelCount()).not.toBe(12)
    expect(bar()).toBeNull()
  })

  it('tracks a fresh selection made after the filter change', async () => {
    await mount()
    fireEvent.click(screen.getByText('Select'))
    pick(1, 2, 3)
    await filterToZone(ALL.slice(0, 4))
    // Select mode itself survives the filter change — only the selection resets.
    pick(1, 2)
    expect(labelCount()).toBe(2)
  })
})

describe('BUG-PHOTOSELSTALE-001 — the Max guard must gate the CURRENT selection', () => {
  const maxWarning = () => screen.queryByText(/^Max \d+$/)
  const postBtn    = () => screen.getByRole('button', { name: /Post to Facebook/i })

  it('blocks a genuinely over-cap selection', async () => {
    await mount()
    fireEvent.click(screen.getByText('Select'))
    pick(...ALL.map((_, i) => i + 1))
    expect(maxWarning()).not.toBeNull()
    expect(postBtn().disabled).toBe(true)
  })

  it('does not block a post that is under the cap just because the pre-filter set was over it', async () => {
    await mount()
    fireEvent.click(screen.getByText('Select'))
    pick(...ALL.map((_, i) => i + 1))
    expect(postBtn().disabled).toBe(true)

    await filterToZone(ALL.slice(0, 4))
    pick(1, 2, 3, 4)

    // THE SECOND FACE OF THE BUG: four photos would be posted, and the user was told "Max 10".
    // (With the stale Set live, these four taps would have DESELECTED the ids already in it —
    // leaving the label on 8 and the post empty, which this also catches.)
    expect(labelCount()).toBe(4)
    expect(maxWarning()).toBeNull()
    expect(postBtn().disabled).toBe(false)
  })
})

describe('BUG-PHOTOSELSTALE-001 — the invariant: label, guard and payload are one set', () => {
  async function postAndReadSheet() {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Post to Facebook/i })) })
    const sheet = await screen.findByTestId('fb-sheet')
    return sheet.dataset.ids ? sheet.dataset.ids.split(',') : []
  }

  it('posts exactly as many photos as the bar claims, on a plain selection', async () => {
    await mount()
    fireEvent.click(screen.getByText('Select'))
    pick(2, 5, 9)
    const claimed = labelCount()
    expect(await postAndReadSheet()).toEqual(['ph-2', 'ph-5', 'ph-9'])
    expect((await postAndReadSheet()).length).toBe(claimed)
  })

  it('posts exactly as many photos as the bar claims, after a filter change', async () => {
    await mount()
    fireEvent.click(screen.getByText('Select'))
    pick(7, 8, 11, 12)          // none of these survive the filter below
    await filterToZone(ALL.slice(0, 4))
    pick(1, 3)

    const claimed = labelCount()
    const posted = await postAndReadSheet()
    // The invariant, stated as the equality the ticket is about — and the ids, so a coincidental
    // match of counts over the wrong photos cannot pass it.
    expect(posted.length).toBe(claimed)
    expect(posted).toEqual(['ph-1', 'ph-3'])
  })

  it('never shows a bar that would post nothing', async () => {
    await mount()
    fireEvent.click(screen.getByText('Select'))
    pick(1, 2, 3)
    // Every selected id filtered away: under the bug this rendered "3 selected" over a button that
    // posted an empty array.
    await filterToZone([photo(99)])
    expect(bar()).toBeNull()
  })
})

describe('BUG-PHOTOSELSTALE-001 — photo tagging via the same select-mode must be unaffected', () => {
  async function openTagModal(n) {
    fetchSpy.mockResolvedValueOnce([PLANT])   // /api/plants?project_id=proj-1 (modal effect)
    await act(async () => { fireEvent.click(card(n)) })
    return screen.findByTestId('pl-modal-card')
  }

  it('routes a tap to selection — not the tag modal — while in select mode', async () => {
    await mount()
    fireEvent.click(screen.getByText('Select'))
    await act(async () => { fireEvent.click(card(1)) })
    expect(screen.queryByTestId('pl-modal-card')).toBeNull()
    expect(labelCount()).toBe(1)
  })

  it('still opens the tag modal once select mode is left', async () => {
    await mount()
    fireEvent.click(screen.getByText('Select'))
    pick(1, 2)
    fireEvent.click(within(bar()).getByText('Cancel'))
    expect(bar()).toBeNull()

    const modal = await openTagModal(1)
    expect(within(modal).getByText('Tags')).toBeTruthy()
    expect(document.getElementById('pl-modal-plant')).toBeTruthy()
  })

  it('still opens the tag modal after a filter change cleared a selection', async () => {
    await mount()
    fireEvent.click(screen.getByText('Select'))
    pick(1, 2, 3)
    await filterToZone(ALL.slice(0, 4))
    fireEvent.click(screen.getByText('Cancel'))   // the header toggle leaves select mode

    const modal = await openTagModal(2)
    expect(within(modal).getByText('Tags')).toBeTruthy()
  })

  it('leaves tagging reachable with the share feature dormant (no Select button at all)', async () => {
    await mount({ share: false })
    expect(screen.queryByText('Select')).toBeNull()
    const modal = await openTagModal(1)
    expect(within(modal).getByText('Tags')).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DERIVATION, PINNED STRUCTURALLY — and why this block is not redundant with the ones above.
//
// The fix has two independent halves: (1) clearing `selected` when a filter change replaces the
// list, and (2) deriving the count label and the Max guard from `selectedPhotos` rather than from
// the `selected` Set. Every behavioural test above exercises a FILTER change, so half (1) alone
// satisfies them: with the Set cleared, `selected.size` and `selectedPhotos.length` agree, and
// reverting half (2) leaves the whole suite green. Verified by mutation — that is the gap this
// block closes.
//
// Half (2) earns its place on a path the tests cannot reach: `loadPhotos()` also runs from
// handleUploadComplete(), which replaces `photos` WITHOUT the filter-keyed effect firing, so
// `selected` legitimately survives holding ids that are absent from the new list. Driving that path
// needs the real upload flow, and useUploadPhoto is mocked to a no-op here — so this is asserted
// structurally rather than behaviourally, deliberately, and this comment is the record of why.
//
// MUTATION: change either derivation back to `selected.size` -> RED here and nowhere else.
describe('BUG-PHOTOSELSTALE-001 — the count and the guard derive from the CURRENT list', () => {
  const SRC = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../pages/PhotoLibrary.jsx'), 'utf8')
  const src = SRC.replace(/\/\/[^\n]*/g, '')   // strip comments: this file's own rationale mentions
                                               // selected.size, and a bare substring test would
                                               // match the prose and pass on a broken component.

  it('selectionCount is derived from selectedPhotos, not from the Set', () => {
    expect(src).toMatch(/const\s+selectionCount\s*=\s*selectedPhotos\.length/)
  })

  it('the Max guard is derived from selectionCount, not from the Set', () => {
    expect(src).toMatch(/const\s+selectionOverMax\s*=\s*selectionCount\s*>/)
  })

  it('no live code path reads selected.size', () => {
    expect(src).not.toMatch(/selected\.size/)
  })
})
