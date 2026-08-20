// BUG-SESSIONDRAFTRESTORE-001 — a parked draft must not restore into a weigh-in session.
//
// THE DEFECT. `/log?session=harvest` carries no ?project=/?event_type=/?plant=/?resolve=/fromquick=,
// so it misses every term of the draft-restore `hasSeed` predicate (EventNew.jsx §4 draft stash) and
// the restore fires. A parked NON-harvest draft then writes its own event_type over the harvest the
// session pinned at mount — while `inHarvestSession` is derived from the URL param, not from
// form.event_type. The two halves disagree: the lock strip keeps asserting "every save logs a
// harvest", the harvest panel (gated on form.event_type === 'harvest') stops rendering, the type
// picker is hidden so there is no way back, and Save POSTs the draft's type. resetForNext keeps
// event_type on every shipped call site (keepMode 'type'), so ONE bad restore mis-types the WHOLE
// burst, and `sessionRow` is gated on isHarvest so none of it reaches the ledger either.
//
// THE FIX is the seed predicate, not the lock strip: ?session=harvest IS an explicit fresh intent,
// exactly like the ?event_type=harvest it replaced on the PWA shortcut (which suppressed the restore
// via preselectedEventType — PwaHarvestShortcut.test.jsx:99 names that as the one behavior the
// repoint dropped). Coercing the draft to harvest instead would carry a watering's notes and
// plant_id onto a harvest row — the silent-misattribution class BUG-LOGTARGETREQ-001 exists to stop.
//
// Entry-point URLs are READ FROM THE PRODUCERS (manifest bytes, TopChrome's rendered href, the
// Harvests CTA's rendered href), never retyped: all three land on the same predicate, and a retyped
// string keeps passing after the file it guards is edited.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { apiFetchSpy, postCalls, dataRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], plants: [] },
}))

// TopChrome reads useAuth to decide what the header renders. Spread the original so the rest of the
// module graph (AuthProvider) survives, per PwaHarvestShortcut.test.jsx.
vi.mock('../context/AuthContext.jsx', async (importOriginal) => ({
  ...(await importOriginal()),
  useAuth: () => ({ user: { id: 'u1' } }),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))
// Mirrors EventNew.harvestSession.test.jsx: the gate under test is the draft/seed gate, and dragging
// PlantingSelect into every mount tests something else.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
}))

import EventNew from '../pages/EventNew.jsx'
import Harvests from '../pages/Harvests.jsx'
import TopChrome from '../components/TopChrome.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlaySurfaceProvider } from '../context/OverlayContext.jsx'
import { writeDraft, readDraft } from '../lib/draftStash.js'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const EVENTNEW_DRAFT_KEY = 'logone'

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return Promise.resolve({ id: `evt-${postCalls.length}`, updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] })
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (String(path).startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    if (String(path).startsWith('/api/harvests')) {
      return Promise.resolve({ entries: [], aggregates: { crops: [], other: [], first_pick: [], crop_list: [] }, cursor: null })
    }
    return Promise.resolve(null)
  })
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  postCalls.length = 0
  dataRef.projects = [PROJECT]
  dataRef.plants = []
  try { localStorage.clear() } catch { /* noop */ }
  try { sessionStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

// ── The three entry points, read off the shipped producers ───────────────
// Harvests.jsx (the Harvests-root primary CTA), TopChrome.jsx (the header Basket) and
// manifest.webmanifest (the installed-PWA home-screen shortcut). Extracted once, at module scope,
// so every case below drives the same bytes the app ships.
const MANIFEST = JSON.parse(readFileSync(join(process.cwd(), 'public/manifest.webmanifest'), 'utf8'))
const MANIFEST_URL = MANIFEST.shortcuts.find(s => s.short_name === 'Harvest')?.url

function hrefOf(tree, testid) {
  const utils = render(<MemoryRouter initialEntries={['/harvests']}>{tree}</MemoryRouter>)
  const href = screen.getByTestId(testid).getAttribute('href')
  utils.unmount()
  return href
}

function entryPoints() {
  wireApiFetch()
  const points = [
    ['Harvests CTA', hrefOf(<Harvests />, 'weigh-in-session-link')],
    ['TopChrome Basket', hrefOf(<TopChrome />, 'topchrome-harvest')],
    ['PWA shortcut', MANIFEST_URL],
  ]
  cleanup()
  return points
}

const ENTRY_POINTS = entryPoints()

describe('BUG-SESSIONDRAFTRESTORE-001 entry points — all three reach the same predicate', () => {
  it.each(ENTRY_POINTS)('%s carries ?session=harvest and NO other seed param', (_name, url) => {
    const parsed = new URL(url, 'https://garden.futureishere.net')
    expect(parsed.pathname).toBe('/log')
    expect(parsed.searchParams.get('session')).toBe('harvest')
    // Every one of these is a hasSeed term. That all three are absent is WHY the restore fires here
    // and not on ?event_type=harvest — the property that makes this one fix cover all three.
    for (const seed of ['project', 'event_type', 'plant', 'resolve', 'fromquick']) {
      expect(parsed.searchParams.get(seed), `${_name} carries ?${seed}=`).toBeNull()
    }
  })
})

// ── Harness ─────────────────────────────────────────────────────────────
const WATERING_DRAFT = {
  form: {
    event_type: 'watering',
    notes: 'half a can on the peppers',
    private_notes: '',
    quantity: '',
    event_date: '2026-08-19T18:30',
    is_public: true,
    plant_id: 'pl-parked',
  },
  showPrivate: false,
  showAddDetails: false,
  showHarvestMore: false,
}

const HARVEST_DRAFT = {
  form: {
    event_type: 'harvest',
    notes: '',
    private_notes: '',
    quantity: '',
    event_date: '2026-08-19T18:30',
    is_public: true,
    plant_id: '',
  },
  showPrivate: false,
  showAddDetails: false,
  showHarvestMore: false,
  harvest: { quantity: '7', weight: '', quality_rating: null, disposition: null, unit: 'cup', weight_unit: 'g', unitTouched: true },
}

async function mountAt(url, { overlaySurface = false } = {}) {
  const tree = <ToastProvider><EventNew /></ToastProvider>
  const utils = render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/log" element={overlaySurface ? <OverlaySurfaceProvider>{tree}</OverlaySurfaceProvider> : tree} />
      </Routes>
    </MemoryRouter>
  )
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  return utils
}

async function saveWith({ qty } = {}) {
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
  if (qty != null) fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: qty } })
  await act(async () => { fireEvent.click(screen.getByText('Save')) })
}

// ── The defect, per entry point ─────────────────────────────────────────
describe.each(ENTRY_POINTS)('BUG-SESSIONDRAFTRESTORE-001 — parked NON-harvest draft, via %s', (_name, url) => {
  it('the lock strip and the harvest panel agree: both render', async () => {
    writeDraft(EVENTNEW_DRAFT_KEY, WATERING_DRAFT)
    await mountAt(url)
    // Pre-fix the strip renders alone and the panel is gone — the two halves of the same claim.
    expect(screen.getByTestId('harvest-session-lock')).toBeTruthy()
    expect(screen.getByLabelText('Harvest quantity')).toBeTruthy()
  })

  it('the save the strip promised is a harvest, not the parked type', async () => {
    writeDraft(EVENTNEW_DRAFT_KEY, WATERING_DRAFT)
    await mountAt(url)
    await saveWith({ qty: '4' })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].event_type).toBe('harvest')
  })

  it('carries none of the parked draft onto that harvest — no borrowed notes, no borrowed planting', async () => {
    writeDraft(EVENTNEW_DRAFT_KEY, WATERING_DRAFT)
    await mountAt(url)
    await saveWith({ qty: '4' })
    // A coerce-to-harvest fix would satisfy the two assertions above and fail these: the watering's
    // note and its planting would ride onto a harvest row the user never attributed.
    expect(postCalls[0].notes ?? '').toBe('')
    expect(postCalls[0].plant_id ?? '').not.toBe('pl-parked')
  })

  it('the save reaches the session ledger (sessionRow is gated on isHarvest)', async () => {
    writeDraft(EVENTNEW_DRAFT_KEY, WATERING_DRAFT)
    await mountAt(url)
    await saveWith({ qty: '4' })
    expect(screen.getByTestId('harvest-session-strip').textContent).toContain('This session: 1 harvest')
  })
})

describe.each(ENTRY_POINTS)('BUG-SESSIONDRAFTRESTORE-001 — parked HARVEST draft, via %s', (_name, url) => {
  // Refused too, and deliberately: ?session=harvest and ?event_type=harvest are two spellings of one
  // intent, and ?event_type=harvest has always refused a parked harvest draft. Restoring only the
  // compatible ones would make the two spellings disagree, and would still re-attach the draft's
  // plant_id — the same misattribution the non-harvest cases above reject.
  it('starts the weigh-in clean rather than resuming the parked weight', async () => {
    writeDraft(EVENTNEW_DRAFT_KEY, HARVEST_DRAFT)
    await mountAt(url)
    expect(screen.getByTestId('harvest-session-lock')).toBeTruthy()
    expect(screen.getByLabelText('Harvest quantity').value).toBe('')
  })

  it('and still saves as a harvest', async () => {
    writeDraft(EVENTNEW_DRAFT_KEY, HARVEST_DRAFT)
    await mountAt(url)
    await saveWith({ qty: '4' })
    expect(postCalls[0].event_type).toBe('harvest')
    expect(postCalls[0].harvest?.quantity).toBe(4)
  })
})

// ── Non-vacuity: the restore still works everywhere it always did ───────
// Without these, deleting the whole restore effect would turn this file green.
describe('BUG-SESSIONDRAFTRESTORE-001 controls — the draft stash is untouched off the session', () => {
  it('a bare /log still restores the parked non-harvest draft', async () => {
    writeDraft(EVENTNEW_DRAFT_KEY, WATERING_DRAFT)
    await mountAt('/log')
    expect(screen.queryByTestId('harvest-session-lock')).toBeNull()
    await saveWith()
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].event_type).toBe('watering')
    expect(postCalls[0].notes).toBe('half a can on the peppers')
  })

  it('a bare /log still restores the parked harvest weight', async () => {
    writeDraft(EVENTNEW_DRAFT_KEY, HARVEST_DRAFT)
    await mountAt('/log')
    expect(screen.getByLabelText('Harvest quantity').value).toBe('7')
  })

  it('?session=harvest leaves the parked draft in storage — the refusal is a skip, not a delete', async () => {
    writeDraft(EVENTNEW_DRAFT_KEY, WATERING_DRAFT)
    await mountAt(ENTRY_POINTS[0][1])
    // Read before anything is typed: the persist effect rewrites this key on the first dirty
    // keystroke (single-key stash, same as every other seeded arrival). Arrival itself must not.
    expect(readDraft(EVENTNEW_DRAFT_KEY)?.form?.notes).toBe('half a can on the peppers')
  })

  // Pins the TERM, not just the behavior. `inHarvestSession` (= param && !inOverlay) would satisfy
  // every case above and read the wrong way here: the event_type pin at mount is param-level and
  // overlay-agnostic, so an overlay arrival carrying ?session=harvest is ALSO pinned to harvest and
  // must not have that pin overwritten by a stale draft. The lock-strip assertion is the posture
  // control — a red here means "the restore fired", never "the session engaged".
  it('an OVERLAY arrival carrying ?session=harvest refuses the restore too', async () => {
    writeDraft(EVENTNEW_DRAFT_KEY, WATERING_DRAFT)
    await mountAt(ENTRY_POINTS[0][1], { overlaySurface: true })
    expect(screen.queryByTestId('harvest-session-lock')).toBeNull()
    expect(screen.getByLabelText('Harvest quantity')).toBeTruthy()
  })

  it('an unrelated ?session= value is not a seed — the restore still fires', async () => {
    writeDraft(EVENTNEW_DRAFT_KEY, WATERING_DRAFT)
    await mountAt('/log?session=watering')
    expect(screen.queryByTestId('harvest-session-lock')).toBeNull()
    await saveWith()
    expect(postCalls[0].notes).toBe('half a can on the peppers')
  })
})
