// V4-WEIGHFRAME-001 — the flag-OFF no-op proof for the fixed weigh-in frame.
//
// The frame (WEIGH_IN_FRAME_ENABLED) restructures the whole weigh-in surface: a 100dvh
// non-scrolling 3-track grid, a one-line ledger, no BottomNav, no scroll anchors. That is a big
// enough diff that "the tests still pass" is not evidence the OFF arm is untouched — the OFF arm
// IS the rollback lever, and a lever that has quietly drifted is worth nothing.
//
// So this pins BYTES, not behaviour: the fixture beside this file is the literal
// `container.innerHTML` of a four-save weigh-in session, captured and committed BEFORE EventNew was
// edited (see git history for this path — that is the provenance, deliberately, rather than a
// claim in a comment). With the flag false the render must reproduce it exactly.
//
// Why innerHTML and not a testid census: a census cannot see a leaked wrapper `<div>`, an added
// style property, or a changed `align-content` — all of which are precisely what a grid refactor
// leaks. The mutation proof for this assertion is recorded in the lane report.
//
// Regenerate deliberately (never to "fix" a red run): UPDATE_WEIGHIN_FIXTURE=1 npx vitest run
// src/__tests__/WeighInFrame.flagOff.test.jsx
//
// REGENERATED 2026-08-26 (V4-ICON-001, the EventNew emoji-wiring pass). The diff was read before
// the write and is the same four tokens as its sibling weighInSessionBaseBytes: the session-lock's
// `<span>` basket emoji became the registry's event.harvest `<svg>`. No wrapper, no style property
// and no id changed, so the grid-refactor leak this file exists to catch is still fully pinned.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// cwd-relative, not import.meta.url: under vitest the module URL is an http: one and
// fileURLToPath rejects it. Matches bootPaint.test.jsx's `resolve(process.cwd(), …)`.
const FIXTURE = resolve(process.cwd(), 'src/__tests__/__fixtures__/weighInSession.flagOff.html')

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [] },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null,
    reset: vi.fn(),
  }),
}))

// PROJECTS_HIDDEN false + PLANTING_REQUIRED_ENABLED false mirrors EventNew.harvestSession.test.jsx:
// it lets a save go through on the Project select alone, so the fixture exercises the ledger
// without dragging PlantingSelect's async plant list into a byte comparison.
// WEIGH_IN_FRAME_ENABLED is stated explicitly rather than left to the module default so this file
// keeps testing the OFF arm on the day the default flips.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
  WEIGH_IN_FRAME_ENABLED: false,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>
  ),
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return Promise.resolve({ id: `evt-${postCalls.length}`, updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] })
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
}

async function saveHarvest({ qty, weight }) {
  fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: qty } })
  if (weight != null) fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: weight } })
  await act(async () => { fireEvent.click(screen.getByText('Save')) })
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = []
  localStorage.clear()
  wireApiFetch()
})

// Four saves, not one: the fourth is what renders the `+N earlier` line and takes the band to its
// real cap, so the fixture covers the tallest state the shipped band ever reaches.
async function renderFourSaveSession() {
  searchParamsRef.current = new URLSearchParams('session=harvest')
  const { container } = render(<ToastProvider><EventNew /></ToastProvider>)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
  await saveHarvest({ qty: '12', weight: '340' })
  await saveHarvest({ qty: '5', weight: '860' })
  await saveHarvest({ qty: '3', weight: '120' })
  await saveHarvest({ qty: '7', weight: '210' })
  return container
}

describe('weigh-in session — WEIGH_IN_FRAME_ENABLED=false is a byte-level no-op', () => {
  it('renders the pre-frame markup exactly, to the byte', async () => {
    const container = await renderFourSaveSession()
    const html = container.innerHTML

    // Sanity on the fixture itself before it is used as an oracle: a fixture that captured an
    // empty or error render would pass a byte comparison against an equally empty render forever.
    expect(html).toContain('data-testid="harvest-session-strip"')
    expect(html).toContain('+1 earlier')
    expect(html).toContain('This session: 4 harvests')
    expect(html).toContain('data-testid="save-sticky"')

    if (process.env.UPDATE_WEIGHIN_FIXTURE) {
      writeFileSync(FIXTURE, html)
      return
    }
    expect(html).toBe(readFileSync(FIXTURE, 'utf8'))
  })
})
