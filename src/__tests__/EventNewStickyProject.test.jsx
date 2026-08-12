// V4-LOGTARGET-001 → BUG-LOGTARGETREQ-001 — Log One (EventNew) sticky memory, REWRITTEN per the
// harvest-logging-ux-design-V100-20260812 §1a disposition table. The planting VALUE seed is
// REMOVED: a cold mount with NO draft and NO deep-link never pre-targets a planting. The
// logone.lastPlant key survives as a stale-bundle compatibility contract — written on every save,
// consumed only as a RANKING signal (PlantingSelect recentPlantId: position-1 pin + visible
// "recent" marker, read at picker-OPEN). Project stickiness (logone.lastProject) is UNCHANGED.
//
// Every pre-rewrite case is accounted for below with its disposition (survives verbatim /
// rewrite-invert / mechanics rewrite / repurposed / kept-near-vacuous) — nothing deleted silently.
//
// Flag arm: both flags mocked FALSE — the ROLLBACK configuration (one-line revert). The seed
// executed in both arms, so the never-pre-targets + ranked-first pins are DUPLICATED in the
// flag-ON arm (EventNew.projhide.test.jsx); prod runs flag-ON.
//
// Harness mirrors EventNew.test.jsx: useApiFetch → controllable fetch, and
// react-router-dom fully mocked with a hoisted searchParams ref.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: {
    projects: [],
    locations: [],
    plants: [],
    postResult: { id: 'evt-1', updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] },
    postError: null,
  },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy }),
}))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn().mockResolvedValue({ photo: { id: 'p1' } }),
    isUploading: false,
    error: null,
    photo: null,
    preview: null,
    reset: vi.fn(),
  }),
}))

// V4-PLANTREQUIRED-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip
// and its assertions describe the planting-OPTIONAL behavior, which remains a live configuration
// (rollback = one-line revert). Mocked FALSE so every assertion below keeps covering what it was
// written to cover, rather than being rewritten to the flag-ON world. Flag-ON is covered by
// EventNew.plantRequired.test.jsx, EventNew.plantMismatch.plantRequired.test.jsx and the
// BUG-LOGTARGETREQ-001 duplicates in EventNew.projhide.test.jsx.
// importActual spread so every other flag (OVERLAY_ROUTES_ENABLED etc.) keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
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
import { writeDraft } from '../lib/draftStash.js'

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      if (dataRef.postError) return Promise.reject(dataRef.postError)
      return Promise.resolve(dataRef.postResult)
    }
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

const PROJECT_A = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PROJECT_B = { id: 'proj-2', name: 'Peppers 2026', status: 'growing' }
const PLANT_A = { id: 'pl-A', name: 'Sungold #1' }
const PLANT_B = { id: 'pl-B', name: 'Sungold #2' }

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

// V4-PLANTPICKER-001: the planting control is the shared PlantingSelect combobox. Picking = focus
// (opens the listbox) + click the ps-opt-<id> row; a made selection renders as the chip
// (evtnew-planting-chip) showing the plant NAME — the raw select .value is gone. An EMPTY
// selection still renders the combobox input, so `.value === ''` assertions remain valid.
async function pickPlanting(id) {
  fireEvent.focus(screen.getByLabelText('Plant or group'))
  fireEvent.click(await screen.findByTestId(`ps-opt-${id}`))
}
const plantingChip = () => screen.getByTestId('evtnew-planting-chip')

// BUG-LOGTARGETREQ-001: open the picker (the ranking reads logone.lastPlant at OPEN) and return
// the option rows once rendered. Scoped to the LISTBOX: in this flag-OFF arm the Project
// <select>'s native <option>s also match role=option, so a bare getAllByRole would count them.
const listboxOptions = () => within(screen.getByRole('listbox')).getAllByRole('option')
async function openPicker() {
  fireEvent.focus(screen.getByLabelText('Plant or group'))
  await act(async () => { await Promise.resolve() })
  return waitFor(() => {
    const opts = listboxOptions()
    expect(opts.length).toBeGreaterThan(0)
    return opts
  })
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT_A, PROJECT_B]
  dataRef.locations = []
  dataRef.plants = [PLANT_A, PLANT_B]
  dataRef.postResult = { id: 'evt-1', updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] }
  dataRef.postError = null
  try { localStorage.clear() } catch { /* noop */ }
  try { sessionStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('EventNew — sticky planting demoted to ranking (BUG-LOGTARGETREQ-001, supersedes the V4-LOGTARGET-001 value seed)', () => {
  // Disposition: SURVIVES VERBATIM. The write-on-save is a stale-bundle compatibility contract.
  it('writes the chosen planting (and its project) to localStorage on save', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-2' } })
    await pickPlanting('pl-B')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    expect(postCalls.length).toBe(1)
    expect(postCalls[0].project_id).toBe('proj-2')
    expect(postCalls[0].plant_id).toBe('pl-B')
    expect(localStorage.getItem('logone.lastPlant')).toBe('pl-B')
    expect(localStorage.getItem('logone.lastProject')).toBe('proj-2')
  })

  // Disposition: REWRITE/INVERT (was "pre-fills the planting ... on cold remount"). The project
  // still pre-fills; the PLANTING must NOT — remembered state is now a ranking signal only:
  // opening the picker lists the remembered planting FIRST with a visible "recent" marker.
  it('cold remount: project pre-fills, planting does NOT — remembered ranks first with a visible marker instead', async () => {
    // First session: pick proj-2 + a planting and save (persists both keys).
    const first = renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-2' } })
    await pickPlanting('pl-B')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(localStorage.getItem('logone.lastPlant')).toBe('pl-B')
    first.unmount()

    // Cold remount, no deep link: project pre-fills; planting stays UNSET.
    renderEventNew('event_type=watering')
    await flushLoad()
    await waitFor(() => expect(screen.getByLabelText('Project').value).toBe('proj-2'))
    expect(screen.queryByTestId('evtnew-planting-chip')).toBeNull()
    expect(screen.getByLabelText('Plant or group').value).toBe('')

    // Ranking, not value: the remembered planting leads the opened picker, visibly marked.
    await openPicker()
    await waitFor(() => {
      const rows = listboxOptions()
      expect(rows[0].textContent).toContain('Sungold #2')
      expect(within(rows[0]).getByText('recent')).toBeTruthy()
      expect(rows.length).toBe(2)
    })
  })

  // Disposition: REWRITE/INVERT, same shape as the remount case (was "pre-fills ... directly").
  it('direct localStorage pre-fill seeds the project only; the planting is ranked, never chipped', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    expect(screen.queryByTestId('evtnew-planting-chip')).toBeNull()
    expect(screen.getByLabelText('Plant or group').value).toBe('')
    await openPicker()
    await waitFor(() => {
      const rows = listboxOptions()
      expect(rows[0].textContent).toContain('Sungold #1')
      expect(within(rows[0]).getByText('recent')).toBeTruthy()
    })
  })

  // Disposition: SURVIVES VERBATIM.
  it('KEY MIGRATION: the old logone.lastProject key alone still pre-fills the project (project-level fallback, no planting)', async () => {
    // Pre-migration device: only the old key exists. The project pre-fills exactly as
    // V4-STICKY-001 did; the planting stays unset (neutral placeholder, no invention).
    localStorage.setItem('logone.lastProject', 'proj-1')
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    await waitFor(() => {
      expect(screen.getByLabelText('Plant or group').value).toBe('')
    })
  })

  // Disposition: behavior survives, MECHANICS REWRITE — the chip no longer self-establishes from
  // localStorage, so the planting is picked EXPLICITLY before being cleared.
  it('a save without a planting clears logone.lastPlant — remembered is always the LAST save', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering')
    await flushLoad()
    await pickPlanting('pl-A')
    await waitFor(() => expect(plantingChip().textContent).toContain('Sungold #1'))
    // Deliberately clear the planting, then save at project level.
    fireEvent.click(screen.getByRole('button', { name: 'Clear planting selection' }))
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].plant_id).toBeNull()
    expect(localStorage.getItem('logone.lastPlant')).toBeNull()
    expect(localStorage.getItem('logone.lastProject')).toBe('proj-1')
  })

  // Disposition: KEPT, near-vacuous post-removal (nothing seeds the planting anymore). The real
  // deep-link guard moved to the NEW ?plant= over-removal pin below.
  it('deep-linked ?project= wins over the remembered project and never carries a planting', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering&project=proj-2')
    await flushLoad()
    await waitFor(() => {
      expect(screen.getByLabelText('Project').value).toBe('proj-2')
    })
    expect(screen.getByLabelText('Plant or group').value).toBe('')
  })

  // Disposition: project half SURVIVES; planting half vacuous post-removal (kept as a cheap
  // regression guard — it can only fail if the seed returns).
  it('falls back to no selection (silently) — project AND planting — when the remembered project no longer exists', async () => {
    localStorage.setItem('logone.lastProject', 'ghost-project')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering')
    await flushLoad()
    await waitFor(() => {
      expect(screen.getByLabelText('Project').value).toBe('')
    })
    expect(screen.getByLabelText('Plant or group').value).toBe('')
    // Stale-remembered is NOT the deep-link case — no "Project not found" notice.
    expect(screen.queryByText('Project not found — pick one.')).toBeNull()
  })

  // Disposition: REPURPOSED FOR RANKING (was "archived remembered planting is cleared"). An
  // archived/missing remembered id is simply absent from the live list: no "recent" marker,
  // no crash, fallback ordering.
  it('an archived/missing remembered planting ranks nothing: no marker, no crash, fallback order', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-old')
    dataRef.plants = [{ id: 'pl-old', name: 'Old Sungold', archived_at: '2026-01-01' }, PLANT_A, PLANT_B]
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    const opts = await openPicker()
    // Archived rows are filtered from the live list; the remembered id matches nothing.
    expect(opts.map(o => o.textContent).join('|')).not.toContain('Old Sungold')
    expect(screen.queryByText('recent')).toBeNull()
    // Fallback (name) ordering, no hoist.
    expect(opts[0].textContent).toContain('Sungold #1')
    expect(opts[1].textContent).toContain('Sungold #2')
  })

  // Disposition: SURVIVES VERBATIM.
  it('does not override an explicit in-session project change', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    // User switches project this session; the load effect must not clobber it.
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-2' } })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByLabelText('Project').value).toBe('proj-2')
  })

  // ── INVARIANT: plant_id present ⇒ project_id present (server exactly_one_parent) ──

  // Disposition: REWRITE VIA EXPLICIT PICK PATH (the old setup seeded localStorage then waited
  // for the chip — that hangs post-removal). The invariant re-pins through pick→save.
  it('INVARIANT: an explicitly picked planting always POSTs with its parent project — BOTH ids present', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    renderEventNew('event_type=watering')
    await flushLoad()
    await waitFor(() => expect(screen.getByLabelText('Project').value).toBe('proj-1'))
    await pickPlanting('pl-A')
    await waitFor(() => expect(plantingChip().textContent).toContain('Sungold #1'))
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    // The submit must NEVER be {project_id:'', plant_id:X} — that 500s server-side.
    expect(postCalls[0].plant_id).toBe('pl-A')
    expect(postCalls[0].project_id).toBe('proj-1')
    expect(postCalls[0].project_id).toBeTruthy()
  })

  // Disposition: KEPT as a cheap regression guard — post-removal it can no longer fail unless
  // the seed returns, which is exactly what it should catch.
  it('INVARIANT: a remembered planting with no remembered project is never seeded — no POST can carry a plant without a project', async () => {
    // Corrupt/partial storage state: plant key present, project key absent.
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByLabelText('Plant or group').value).toBe('')
    // And the submit gate blocks a project-less POST outright.
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText('Select a project.')).toBeTruthy()
  })

  // ── NEW pins (design §1a / §6-S1) ──────────────────────────────────────────

  // ANTI-RETURN PIN — the S1 invariant verbatim: a cold mount with NO draft and NO deep-link
  // never pre-targets a planting. MUTATION TARGET: reintroducing `|| rememberedPlantId` at the
  // form seed makes this fail (the chip self-establishes).
  it('ANTI-RETURN: both keys set → bare cold mount (no draft, no deep-link) → combobox empty, no chip, remembered ranked first with marker', async () => {
    localStorage.setItem('logone.lastProject', 'proj-2')
    localStorage.setItem('logone.lastPlant', 'pl-B')
    renderEventNew('')
    await flushLoad()
    await waitFor(() => expect(screen.getByLabelText('Project').value).toBe('proj-2'))
    expect(screen.getByLabelText('Plant or group').value).toBe('')
    expect(screen.queryByTestId('evtnew-planting-chip')).toBeNull()
    await openPicker()
    await waitFor(() => {
      const rows = listboxOptions()
      expect(rows[0].textContent).toContain('Sungold #2')
      expect(within(rows[0]).getByText('recent')).toBeTruthy()
    })
  })

  // DRAFT PIN — adjudicated semantics: draft-restored plant_id is USER CONTEXT (the user
  // explicitly chose that planting in this draft moments ago), not misattribution. Restore KEEPS it.
  it('DRAFT: a stashed draft with typed text + plant_id restores the planting on a bare cold mount', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    writeDraft('logone', {
      form: { event_type: 'watering', notes: 'half-typed note', plant_id: 'pl-A' },
    })
    renderEventNew('')
    await flushLoad()
    await waitFor(() => expect(plantingChip().textContent).toContain('Sungold #1'))
    expect(screen.getByLabelText('Notes').value).toBe('half-typed note')
  })

  // ?plant= OVER-REMOVAL GUARD — protects HarvestReadyBand's shipped &plant= producer.
  // MUTATION TARGET: deleting the `plant_id: preselectedPlantId` seed entirely makes this fail.
  it('?plant= deep-link still seeds the chip and POSTs both ids (explicit intent wins)', async () => {
    renderEventNew('event_type=watering&project=proj-1&plant=pl-A')
    await flushLoad()
    await waitFor(() => expect(plantingChip().textContent).toContain('Sungold #1'))
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].plant_id).toBe('pl-A')
    expect(postCalls[0].project_id).toBe('proj-1')
  })

  // RANKING FRESHNESS — the ranking source reads logone.lastPlant at picker-OPEN, not mount:
  // after an in-burst save rewrites it, the still-mounted form ranks fresh for harvest #2.
  it('ranking reads at picker-open: an in-burst save re-ranks without a remount', async () => {
    // Mount-time remembered planting is pl-A…
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering')
    await flushLoad()
    // …but the user picks pl-B and saves (write-on-save flips the key, resetForNext clears the pick).
    await pickPlanting('pl-B')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(localStorage.getItem('logone.lastPlant')).toBe('pl-B')
    // Re-open WITHOUT remounting: pl-B must lead — a mount-time read would still rank pl-A.
    await openPicker()
    await waitFor(() => {
      const rows = listboxOptions()
      expect(rows[0].textContent).toContain('Sungold #2')
      expect(within(rows[0]).getByText('recent')).toBeTruthy()
    })
  })

  // PER-CROP UNIT DEFAULT (§5.2): crop A's unit never leaks to crop B. The global key survives
  // only as fallback for crops with no memory of their own.
  it('per-crop unit default: picking a crop re-seeds the unit from lastHarvestUnit:<slug>, never from another crop', async () => {
    dataRef.plants = [
      { id: 'pl-blue', name: 'Blueberry Row', variety_ref: { id: 'v-b', name: 'Bluecrop', crop_type_slug: 'blueberry' } },
      { id: 'pl-tom', name: 'Sungold', variety_ref: { id: 'v-t', name: 'Sungold', crop_type_slug: 'tomato' } },
    ]
    localStorage.setItem('lastHarvestUnit', 'cup')            // global: last save was blueberry cup
    localStorage.setItem('lastHarvestUnit:blueberry', 'cup')
    localStorage.setItem('lastHarvestUnit:tomato', 'count')
    renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    // Pre-pick the unit shows the global fallback (cup).
    await waitFor(() => expect(screen.getByLabelText('Harvest unit').value).toBe('cup'))
    // Picking the tomato planting re-seeds from ITS crop memory — the blueberry unit never leaks.
    await pickPlanting('pl-tom')
    await waitFor(() => expect(screen.getByLabelText('Harvest unit').value).toBe('count'))
    // And a save writes the per-crop key alongside the global one.
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '3' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    expect(localStorage.getItem('lastHarvestUnit:tomato')).toBe('count')
    expect(localStorage.getItem('lastHarvestUnit')).toBe('count')
  })

  // PER-CROP UNIT — an explicit in-entry unit pick is never overridden by a later planting pick.
  it('per-crop unit default never overrides an explicit in-entry unit choice', async () => {
    dataRef.plants = [
      { id: 'pl-tom', name: 'Sungold', variety_ref: { id: 'v-t', name: 'Sungold', crop_type_slug: 'tomato' } },
    ]
    localStorage.setItem('lastHarvestUnit:tomato', 'count')
    renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByLabelText('Harvest unit'), { target: { value: 'lb' } })
    await pickPlanting('pl-tom')
    await act(async () => { await Promise.resolve() })
    expect(screen.getByLabelText('Harvest unit').value).toBe('lb')
  })
})
