// EventNewHarvestFab.test.jsx — V4-HARVFAB-001, the EventNew half (design
// harvest-logging-ux-design-V100-20260812 §1c, test list §6-S3).
//
// The FAB's new "Log harvest" row rides the already-shipped `?event_type=harvest` deep-link, so
// the routing half is BottomNav's problem. What lands HERE is the thing that makes the five-tap
// claim honest: on that arrival the planting picker OPENS ITSELF, because choosing a planting is
// the first REQUIRED action and waiting to be discovered is a tap.
//
// Auto-open is deliberately narrow, and each guard is pinned below: an explicit `?plant=` already
// answered the question (HarvestReadyBand seeds it), a stashed draft means resuming rather than
// starting, and every non-harvest arrival is untouched.
//
// Flags are REAL here — prod config, PROJECTS_HIDDEN and PLANTING_REQUIRED_ENABLED both on. This is
// the arm the FAB actually ships into, and it is also the arm where the planting field is required,
// which is what makes auto-opening the picker the right default rather than a nag.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, within } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { projects: [], locations: [], plants: [] },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (<a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>),
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { writeDraft } from '../lib/draftStash.js'

const PROJECT = { id: 'proj-B', name: 'Bravo', status: 'growing' }
const SUNGOLD = { id: 'plant-1', name: 'Sungold', project_id: 'proj-B' }
const CHEROKEE = { id: 'plant-2', name: 'Cherokee', project_id: 'proj-B' }

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') return Promise.resolve({ id: 'evt-1' })
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
}

function renderEventNew(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

// NOTE: no fireEvent.focus anywhere in this file. That is the point — the listbox has to be
// present without the user (or the test) touching the input.
const listbox = () => screen.queryByRole('listbox')

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = [SUNGOLD, CHEROKEE]
  // BOTH stores: logone.* memory is localStorage, but the draft stash is sessionStorage
  // (draftStash.js — session-scoped by design). Clearing only one let the draft case's stash leak
  // forward and silently suppress auto-open in a later test.
  try { localStorage.clear() } catch { /* noop */ }
  try { sessionStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('V4-HARVFAB-001 — the harvest arrival opens the picker itself', () => {
  it('preseeds the harvest type AND renders the planting picker already open', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    await waitFor(() => expect(listbox()).not.toBeNull())
    // The type is genuinely seeded, not merely defaulted — the harvest panel is what proves it.
    expect(screen.getByText('Harvest *')).toBeTruthy()
    expect(within(listbox()).getAllByRole('option').length).toBe(2)
  })

  it('leaves the picker closed when ?plant= already answered the question', async () => {
    // HarvestReadyBand's shipped producer seeds &plant=. Opening a picker over a planting the user
    // already chose is a step backwards, not a shortcut.
    renderEventNew('event_type=harvest&plant=plant-1')
    await flushLoad()
    expect(listbox()).toBeNull()
    expect(screen.getByTestId('evtnew-planting-chip')).toBeTruthy()
  })

  it('leaves the picker closed when a draft is stashed — resuming is not starting', async () => {
    // 'logone' is EVENTNEW_DRAFT_KEY (module-private in EventNew.jsx).
    writeDraft('logone', { form: { event_type: 'harvest', notes: 'half a sentence' } })
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(listbox()).toBeNull()
  })

  it('leaves every other arrival exactly as it was', async () => {
    renderEventNew('')
    await flushLoad()
    expect(listbox()).toBeNull()
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(listbox()).toBeNull()
  })
})

// Pre-promote regression pass I-2. "ONLY there" is a scope claim about ARRIVALS, and two shipped
// producers also arrive with event_type=harvest: HarvestReadyTile (`?project=…&event_type=harvest`)
// and the installed-PWA manifest shortcut (`?event_type=harvest&fromquick=1`). Neither was in design
// §1c's scope, and neither was reviewed for an auto-opening picker. The FAB row carries no params but
// event_type, so the ?project= guard separates them exactly.
describe('V4-HARVFAB-001 — auto-open is scoped to the FAB arrival, not every harvest deep link', () => {
  it('does NOT auto-open for the Harvest-ready tile arrival (?project= present)', async () => {
    renderEventNew('project=proj-B&event_type=harvest')
    await flushLoad()
    expect(listbox()).toBeNull()
  })

  it('still DOES auto-open for the bare FAB arrival', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    await waitFor(() => expect(listbox()).not.toBeNull())
  })
})

// The two slices meet here, and the meeting is the whole point of sequencing S1 before S3: a
// one-tap harvest that still silently pre-targets the last planting is BD-006 made CHEAPER, which
// is worse than the seven-tap version. This is the only test that observes both at once.
describe('V4-HARVFAB-001 × BUG-LOGTARGETREQ-001 — fast, and still not pre-targeted', () => {
  it('opens the picker with the remembered planting RANKED first, and nothing pre-selected', async () => {
    localStorage.setItem('logone.lastProject', 'proj-B')
    localStorage.setItem('logone.lastPlant', 'plant-1')       // Sungold — 2nd alphabetically
    renderEventNew('event_type=harvest')
    await flushLoad()
    await waitFor(() => expect(listbox()).not.toBeNull())

    // Not pre-targeted: no chip, empty combobox. The required-field gate is unsatisfied, which is
    // the honest state — the user has not chosen anything yet.
    expect(screen.queryByTestId('evtnew-planting-chip')).toBeNull()
    expect(screen.getByLabelText('Plant or group').value).toBe('')

    // But ranked: name sort would lead with Cherokee. The remembered row leads instead, marked.
    const rows = within(listbox()).getAllByRole('option')
    expect(rows[0].textContent).toContain('Sungold')
    expect(within(rows[0]).getByText('recent')).toBeTruthy()
    expect(rows[1].textContent).toContain('Cherokee')
  })
})
