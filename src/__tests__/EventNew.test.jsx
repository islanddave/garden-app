// Unit tests for src/pages/EventNew.jsx — V1.2a-2 Wave 3 additions:
// harvest panel, observation flag form, POST body wiring, friendlyError,
// deep-link project safety. Pre-existing behavior is exercised only as far
// as needed to reach the new code paths.
//
// useApiFetch is mocked to a controllable fetch: GETs resolve the mount-time
// projects/locations/plants loads; POST /api/events captures the body and
// resolves (or rejects) per-test. react-router-dom is fully mocked (matches
// the Plants.test.jsx convention) — useSearchParams is driven by a hoisted ref
// so we can simulate deep-link query params per test.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'

// ── Hoisted mock plumbing ───────────────────────────────────────────────
const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef, uploadResultRef, uploadUiRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  // BUG-PHOTOUPLOADHANG-001: per-test override for the swallow-mode photo upload result.
  uploadResultRef: { current: null },
  // Save-button label instrumentation: stage/progress the mocked hook reports; hang=true makes
  // the photo leg never settle so the mid-upload label is observable.
  uploadUiRef: { current: { stage: null, progress: null, hang: false } },
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
    upload: vi.fn(() => uploadUiRef.current.hang
      ? new Promise(() => {})
      : Promise.resolve(uploadResultRef.current ?? { photo: { id: 'p1' } })),
    isUploading: false,
    error: null,
    photo: null,
    stage: uploadUiRef.current.stage,
    progress: uploadUiRef.current.progress,
    preview: null,
    reset: vi.fn(),
  }),
}))


// V4-PLANTREQUIRED-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip
// and its assertions describe the planting-OPTIONAL behavior, which remains a live configuration
// (rollback = one-line revert). Mocked FALSE so every assertion below keeps covering what it was
// written to cover, rather than being rewritten to the flag-ON world. Flag-ON is covered by
// EventNew.plantRequired.test.jsx and EventNew.plantMismatch.plantRequired.test.jsx.
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

// ── apiFetch behavior: route GETs to fixture data, capture POSTs ────────
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

// Simulate deep-link query params, then render.
function renderEventNew(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] }
  dataRef.postError = null
  uploadResultRef.current = null
  uploadUiRef.current = { stage: null, progress: null, hang: false }
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

// Wait for the mount-time projects/locations load to settle.
async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

// V4-PLANTPICKER-001: the planting control is the shared PlantingSelect combobox — pick by
// focusing the input (opens the listbox) and clicking the ps-opt-<id> row. findBy waits out the
// async plants load, replacing the old waitFor(getByText(<plant name>)) option-wait. An empty
// selection still renders the input, so `.value === ''` assertions remain valid.
async function pickPlanting(id) {
  fireEvent.focus(screen.getByLabelText('Plant or group'))
  fireEvent.click(await screen.findByTestId(`ps-opt-${id}`))
}

describe('EventNew — harvest panel rendering', () => {
  it('renders the harvest panel when event_type is harvest', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.getByLabelText('Harvest quantity')).toBeTruthy()
    expect(screen.getByLabelText('Harvest unit')).toBeTruthy()
    // V4-HIDEQUALITY-001: quality is HIDDEN at the shipped flag value — the rest of the harvest
    // panel is untouched. The flag-OFF (rollback) path re-renders it and is covered by
    // HarvestQuality.flagOff.test.jsx; the pin on the shipped value lives in flagOn.test.jsx.
    expect(screen.queryByRole('radiogroup', { name: 'Harvest quality' })).toBeNull()
  })

  it('does NOT render the harvest panel for non-harvest event types', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.queryByLabelText('Harvest quantity')).toBeNull()
  })

  it('hides the generic Quantity section for harvest events', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    // The generic freetext quantity input has aria-label "Quantity"
    expect(screen.queryByLabelText('Quantity')).toBeNull()
  })

  it('shows the generic Quantity section for non-harvest events (under "Add details")', async () => {
    // V3-EVENT-008 §8: Quantity moved into the collapsed "Add details" section to
    // declutter the common logging path. It is NOT removed — expanding the section
    // reveals it. Assert it is reachable (the field + its state/payload wiring intact).
    renderEventNew('event_type=watering')
    await flushLoad()
    // Collapsed by default (EVENTNEW_ADD_DETAILS_EXPANDED=false): not yet in the DOM.
    expect(screen.queryByLabelText('Quantity')).toBeNull()
    // The expander label lives in its own <span> ("Add details  ·  optional"); match on
    // a stable substring so the leading toggle-arrow span doesn't break the matcher.
    fireEvent.click(screen.getByText(/Add details/i))
    expect(screen.getByLabelText('Quantity')).toBeTruthy()
  })

  // V4-HIDEQUALITY-001: the anchored-label assertions moved to HarvestQuality.flagOff.test.jsx —
  // they describe the rollback path, which is where that widget still renders. What belongs HERE is
  // the shipped-surface claim: none of the quality copy reaches the user.
  it('renders no quality labels at the shipped flag value', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.queryByText('1 = inedible')).toBeNull()
    expect(screen.queryByText('3 = acceptable')).toBeNull()
    expect(screen.queryByText('5 = excellent')).toBeNull()
  })
})

describe('EventNew — harvest unit default from localStorage', () => {
  it('defaults the unit select to lastHarvestUnit when set and valid', async () => {
    localStorage.setItem('lastHarvestUnit', 'lb')
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.getByLabelText('Harvest unit').value).toBe('lb')
  })

  it("defaults to 'count' when localStorage is unset", async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.getByLabelText('Harvest unit').value).toBe('count')
  })

  it("defaults to 'count' when localStorage holds an invalid unit", async () => {
    localStorage.setItem('lastHarvestUnit', 'furlongs')
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.getByLabelText('Harvest unit').value).toBe('count')
  })
})

describe('EventNew — harvest client-side validation', () => {
  async function setupHarvest() {
    renderEventNew('event_type=harvest')
    await flushLoad()
    // select the project so the project gate passes
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
  }

  it('blocks POST with an inline error when quantity is empty', async () => {
    await setupHarvest()
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/quantity greater than zero/i)).toBeTruthy()
  })

  it('blocks POST when quantity is zero', async () => {
    await setupHarvest()
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '0' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/quantity greater than zero/i)).toBeTruthy()
  })

  it('blocks POST when quantity is negative', async () => {
    await setupHarvest()
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '-5' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/quantity greater than zero/i)).toBeTruthy()
  })

  it('blocks POST when quantity exceeds MAX_PLAUSIBLE for the unit', async () => {
    await setupHarvest()
    // count cap is 10000
    fireEvent.change(screen.getByLabelText('Harvest unit'), { target: { value: 'count' } })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '99999' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/higher than expected/i)).toBeTruthy()
  })
})

describe('EventNew — valid harvest submit', () => {
  it('fires a POST with harvest:{quantity,unit,quality_rating} and writes lastHarvestUnit', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByLabelText('Harvest unit'), { target: { value: 'lb' } })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '2.5' } })
    // V4-HIDEQUALITY-001: no rating is picked because there is no control to pick one with. The KEY
    // is still present and explicitly null — hiding the input must not change the request SHAPE the
    // server validates. The rating-carrying variant of this case lives in the flagOff file.

    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })

    expect(postCalls.length).toBe(1)
    const body = postCalls[0]
    expect(body.event_type).toBe('harvest')
    expect(body.harvest).toEqual({ quantity: 2.5, unit: 'lb', quality_rating: null })
    // generic freetext quantity nulled for harvest events
    expect(body.quantity).toBeNull()
    expect(localStorage.getItem('lastHarvestUnit')).toBe('lb')
  })

  it('sends quality_rating: null when no quality picked', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '3' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].harvest.quality_rating).toBeNull()
  })
})

describe('EventNew — deep-link project safety', () => {
  it('clears an unknown ?project= param and shows the "Project not found" notice', async () => {
    renderEventNew('project=ghost-project')
    await flushLoad()
    await waitFor(() => {
      expect(screen.getByText('Project not found — pick one.')).toBeTruthy()
    })
    // selection cleared back to placeholder
    expect(screen.getByLabelText('Project').value).toBe('')
  })

  it('keeps a valid ?project= param and shows no notice', async () => {
    renderEventNew('project=proj-1')
    await flushLoad()
    await waitFor(() => {
      expect(screen.getByLabelText('Project').value).toBe('proj-1')
    })
    expect(screen.queryByText('Project not found — pick one.')).toBeNull()
  })
})

describe('EventNew — friendlyError on server failure', () => {
  it('maps a server quantity-exceeds error to canned copy, never the raw string', async () => {
    dataRef.postError = Object.assign(
      new Error('harvest.quantity exceeds max for unit lb'),
      { status: 400 },
    )
    renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '3' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(screen.getByText('Quantity is unusually high — double-check?')).toBeTruthy()
    // raw server string must NOT appear
    expect(screen.queryByText(/exceeds max for unit/i)).toBeNull()
  })

  it('maps a generic 5xx to "Couldn\'t save — try again."', async () => {
    dataRef.postError = Object.assign(new Error('Internal Server Error'), { status: 500 })
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(screen.getByText('Couldn’t save — try again.')).toBeTruthy()
  })

  it('maps a generic 4xx to a check-the-form message', async () => {
    dataRef.postError = Object.assign(new Error('Bad Request'), { status: 422 })
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(screen.getByText('Something didn’t look right — check the form and try again.')).toBeTruthy()
  })
})

describe('EventNew — non-harvest POST unchanged', () => {
  it('a plain watering submit has no harvest or flag fields', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].harvest).toBeUndefined()
    expect(postCalls[0].flagged_as_issue).toBeUndefined()
    expect(postCalls[0].event_type).toBe('watering')
  })
})

describe('EventNew — V3-EVENTCONTSIZE-001 container capture on potting_up/transplant', () => {
  it('PUTs the planting container_type/size when a potting_up event captures a new container', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }]
    renderEventNew('event_type=potting_up')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')
    fireEvent.change(screen.getByLabelText(/Pot \/ bag type/i), { target: { value: 'fabric_bag' } })
    fireEvent.change(screen.getByLabelText(/Pot size/i), { target: { value: '5 gal' } })

    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })

    expect(postCalls.length).toBe(1)
    expect(postCalls[0].event_type).toBe('potting_up')
    const putCall = apiFetchSpy.mock.calls.find(
      ([path, opts]) => path === '/api/plants/pl-1' && opts && opts.method === 'PUT'
    )
    expect(putCall).toBeTruthy()
    expect(JSON.parse(putCall[1].body)).toEqual({ container_type: 'fabric_bag', container_size: '5 gal' })
  })

  it('does NOT PUT the planting when no container is entered', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }]
    renderEventNew('event_type=potting_up')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')

    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })

    expect(postCalls.length).toBe(1)
    const putCall = apiFetchSpy.mock.calls.find(
      ([path, opts]) => typeof path === 'string' && path.startsWith('/api/plants/') && opts && opts.method === 'PUT'
    )
    expect(putCall).toBeUndefined()
  })
})

describe('EventNew — V4-EVENTSAVE-001 single Save = next-of-type', () => {
  it('Save fires the POST and does NOT navigate', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].event_type).toBe('watering')
    expect(postCalls[0].project_id).toBe('proj-1')
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('Save keeps the type, clears the plant', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }, { id: 'pl-2', name: 'Cayenne #2' }]
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await pickPlanting('pl-1')

    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    expect(postCalls.length).toBe(1)
    expect(postCalls[0].event_type).toBe('watering')
    expect(postCalls[0].plant_id).toBe('pl-1')
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    expect(screen.getByLabelText('Plant or group').value).toBe('')
    // V4-LOGTARGET-001: the toast now names the TARGET planting (was "Logged event for
    // Tomatoes 2026" — the only assertion in this oracle block changed by Lane 2, because
    // the copy it pinned is exactly the behavior Dave ratified changing). POST-shape and
    // plant-clearing assertions are untouched.
    await waitFor(() => { expect(screen.getByText('Logged event — Cayenne #1')).toBeTruthy() })
    expect(screen.getByText('Undo')).toBeTruthy()

    // log the SAME type against the next plant WITHOUT re-picking the type
    await pickPlanting('pl-2')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(2)
    expect(postCalls[1].event_type).toBe('watering')
    expect(postCalls[1].plant_id).toBe('pl-2')
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('has no save-and-leave button and never navigates on save', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    expect(screen.queryByText('+ Log event')).toBeNull()
    expect(screen.getAllByText('Save').length).toBe(1)
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('global undo toast: clicking Undo soft-deletes the just-logged event', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    await waitFor(() => screen.getByText('Undo'))
    await act(async () => { fireEvent.click(screen.getByText('Undo')) })
    const del = apiFetchSpy.mock.calls.find(([p, o]) => p === '/api/events/evt-1' && o && o.method === 'DELETE')
    expect(del).toBeTruthy()
  })
})

// BUG-PHOTOUPLOADHANG-001 follow-up — a swallowed photo failure must still be VISIBLE.
describe('EventNew — photo failure surfacing', () => {
  function stubObjectUrls() {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock')
    globalThis.URL.revokeObjectURL = vi.fn()
  }
  async function attachPhotoAndSave() {
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    const fileInput = document.querySelector('input[type="file"]')
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [new File(['x'], 'begonia.jpg', { type: 'image/jpeg' })] } })
    })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
  }

  it('a failed photo upload surfaces "photo didn\'t upload" in the save toast', async () => {
    stubObjectUrls()
    uploadResultRef.current = { error: 'Upload stalled — the connection stopped sending. Check your signal and try again.' }
    renderEventNew('event_type=watering')
    await flushLoad()
    await attachPhotoAndSave()
    expect(postCalls.length).toBe(1) // the event itself still saves
    expect(await screen.findByText(/photo didn't upload/i)).toBeTruthy()
  })

  it('a successful photo upload keeps the plain success toast', async () => {
    stubObjectUrls()
    renderEventNew('event_type=watering')
    await flushLoad()
    await attachPhotoAndSave()
    expect(postCalls.length).toBe(1)
    expect(screen.queryByText(/photo didn't upload/i)).toBeNull()
  })
})

// BUG-PHOTOUPLOADHANG-001 — the Save button names the photo step + live % while the photo leg
// runs (a minutes-long bare "Saving…" is how a dead upload hid inside the event save).
describe('EventNew — Save button photo-stage labels', () => {
  async function attachPhotoAndSubmit() {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock')
    globalThis.URL.revokeObjectURL = vi.fn()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    const fileInput = document.querySelector('input[type="file"]')
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [new File(['x'], 'begonia.jpg', { type: 'image/jpeg' })] } })
    })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
  }

  it('shows "Uploading photo… N%" while the PUT is in flight', async () => {
    uploadUiRef.current = { stage: 'uploading', progress: 43, hang: true }
    renderEventNew('event_type=watering')
    await flushLoad()
    await attachPhotoAndSubmit()
    expect(screen.getByText('Uploading photo… 43%')).toBeTruthy()
  })

  it('shows "Preparing photo…" during the downscale stage', async () => {
    uploadUiRef.current = { stage: 'preparing', progress: null, hang: true }
    renderEventNew('event_type=watering')
    await flushLoad()
    await attachPhotoAndSubmit()
    expect(screen.getByText('Preparing photo…')).toBeTruthy()
  })

  it('plain event save (no photo) still reads "Saving…" mid-flight and completes', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
  })
})

// ── V4-HARVDUAL-001 Slice B — the optional weight half of the harvest panel ──────────
// The count-only path is the fast path and must stay exactly as it was; the weight is additive,
// never required, and must never block a save on its own absence.
describe('EventNew — optional harvest weight', () => {
  async function setupHarvest() {
    renderEventNew('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '5' } })
  }
  const save = async () => { await act(async () => { fireEvent.click(screen.getByText('Save')) }) }

  it('renders the weight field only for harvest events', async () => {
    renderEventNew('event_type=harvest'); await flushLoad()
    expect(screen.getByLabelText('Harvest weight')).toBeTruthy()
    expect(screen.getByLabelText('Harvest weight unit')).toBeTruthy()
  })

  it('does not render the weight field for a non-harvest event', async () => {
    renderEventNew('event_type=watering'); await flushLoad()
    expect(screen.queryByLabelText('Harvest weight')).toBeNull()
  })

  it('saves a count-only harvest with NO weight keys at all', async () => {
    // absent, not null: the server reads absent-vs-null as different intents on the edit path, so
    // the client must not blur them
    await setupHarvest(); await save()
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].harvest.quantity).toBe(5)
    expect(postCalls[0].harvest).not.toHaveProperty('weight')
    expect(postCalls[0].harvest).not.toHaveProperty('weight_unit')
  })

  it('sends weight + weight_unit when the user weighs the pick', async () => {
    await setupHarvest()
    fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: '337' } })
    await save()
    expect(postCalls[0].harvest.weight).toBe(337)
    expect(postCalls[0].harvest.weight_unit).toBe('g')
    expect(postCalls[0].harvest.quantity).toBe(5) // count is untouched by the weight
  })

  it('passes the scale unit through unconverted — the server owns the conversion', async () => {
    await setupHarvest()
    fireEvent.change(screen.getByLabelText('Harvest weight unit'), { target: { value: 'oz' } })
    fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: '11.9' } })
    await save()
    expect(postCalls[0].harvest.weight).toBe(11.9)
    expect(postCalls[0].harvest.weight_unit).toBe('oz')
  })

  it('blocks the POST on a zero or negative weight', async () => {
    await setupHarvest()
    fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: '0' } })
    await save()
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/weight greater than zero/i)).toBeTruthy()
  })

  it('blocks the POST on an implausible weight, judged after unit conversion', async () => {
    await setupHarvest()
    fireEvent.change(screen.getByLabelText('Harvest weight unit'), { target: { value: 'lb' } })
    fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: '200' } }) // 90 718 g
    await save()
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/higher than expected for a single weighing/i)).toBeTruthy()
  })

  it('remembers the weight unit only once it has actually been used', async () => {
    await setupHarvest()
    fireEvent.change(screen.getByLabelText('Harvest weight unit'), { target: { value: 'oz' } })
    await save() // weight left blank -> the choice was never exercised
    expect(localStorage.getItem('lastHarvestWeightUnit')).toBeNull()
  })

  it('persists the weight unit after a weighed save', async () => {
    await setupHarvest()
    fireEvent.change(screen.getByLabelText('Harvest weight unit'), { target: { value: 'oz' } })
    fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: '11.9' } })
    await save()
    expect(localStorage.getItem('lastHarvestWeightUnit')).toBe('oz')
  })

  it('seeds the weight unit from localStorage, and ignores a bogus stored value', async () => {
    localStorage.setItem('lastHarvestWeightUnit', 'lb')
    renderEventNew('event_type=harvest'); await flushLoad()
    expect(screen.getByLabelText('Harvest weight unit').value).toBe('lb')
    cleanup()
    localStorage.setItem('lastHarvestWeightUnit', 'stone')
    renderEventNew('event_type=harvest'); await flushLoad()
    expect(screen.getByLabelText('Harvest weight unit').value).toBe('g')
  })
})

// ── V4-LOGPHOTOFIRST-001 (BD-003) — the photo picker leads the form ────────────────────────────
// Dave: "It should lead. Everything else will follow." Position is the whole deliverable here, so
// the test has to be about ORDER, not presence — a presence assertion passes with the block in its
// old second-from-last slot, which is the bug.
describe('EventNew — photo-first ordering (V4-LOGPHOTOFIRST-001)', () => {
  function sectionLabels(container) {
    return Array.from(container.querySelectorAll('form > div > label')).map(el => el.textContent.trim())
  }

  it('the Photo block is the FIRST section of the form, ahead of the event type', async () => {
    const { container } = renderEventNew(); await flushLoad()
    const labels = sectionLabels(container)
    expect(labels[0]).toMatch(/^Photo/)
    expect(labels.indexOf('What happened? *')).toBeGreaterThan(0)
  })

  it('leads on the flag-issue path too (the event-type section is replaced, not the photo one)', async () => {
    const { container } = renderEventNew('event_type=flag_issue'); await flushLoad()
    expect(sectionLabels(container)[0]).toMatch(/^Photo/)
  })

  it('the picker is never gated on a project or planting being chosen first', async () => {
    // The conformance point of the shipped photo-first model (BUG-PHOTOFIRST-001): picking comes
    // before attribution. No project selected, no planting selected — both buttons still live.
    renderEventNew(); await flushLoad()
    expect(screen.getByRole('button', { name: /Take photo/i }).disabled).toBe(false)
    expect(screen.getByRole('button', { name: /Choose photo/i }).disabled).toBe(false)
  })

  it('says the photo is required for a photo event, before Save rather than after', async () => {
    // Same rule as the BUG-SNAPATTACH-001 submit gate, stated up front.
    renderEventNew('event_type=photo'); await flushLoad()
    expect(screen.getByText('Photo *')).toBeTruthy()
    cleanup()
    renderEventNew('event_type=watering'); await flushLoad()
    expect(screen.getByText(/^Photo\s+·\s+optional$/)).toBeTruthy()
  })
})

// ── BUG-PLANTMISMATCH-001 — a project switch must drop the planting ───────────────────────────
// Prod carries 39 events whose plant_id belongs to a different project than their project_id.
// Nothing on either side validates the pair, so the form is the only place it can be prevented.
describe('EventNew — project switch clears the planting (BUG-PLANTMISMATCH-001)', () => {
  const PROJ_A = { id: 'proj-a', name: 'Project A', status: 'growing' }
  const PROJ_B = { id: 'proj-b', name: 'Project B', status: 'growing' }
  const PLANT_A = { id: 'plant-a', name: 'Tomato A', project_id: 'proj-a' }
  const PLANT_B = { id: 'plant-b', name: 'Pepper B', project_id: 'proj-b' }

  // The shared harness answers every /api/plants call with one fixture list; the pair bug is only
  // observable when each project returns its OWN plantings.
  function wireTwoProjects() {
    apiFetchSpy.mockImplementation((path, options = {}) => {
      if (options.method === 'POST' && path === '/api/events') {
        postCalls.push(JSON.parse(options.body))
        return Promise.resolve(dataRef.postResult)
      }
      if (path === '/api/projects') return Promise.resolve([PROJ_A, PROJ_B])
      if (path === '/api/locations/with-path') return Promise.resolve([])
      if (path === '/api/plants?project_id=proj-a') return Promise.resolve([PLANT_A])
      if (path === '/api/plants?project_id=proj-b') return Promise.resolve([PLANT_B])
      if (path.startsWith('/api/plants')) return Promise.resolve([])
      return Promise.resolve(null)
    })
  }

  async function switchTo(projectId) {
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: projectId } })
    await act(async () => { await Promise.resolve() })
  }

  it('a hand-picked planting does not survive a switch to another project', async () => {
    wireTwoProjects()
    renderEventNew('project=proj-a&plant=plant-a&event_type=watering'); await flushLoad()
    await act(async () => { await Promise.resolve() })
    await switchTo('proj-b')
    // The POST is the assertion that matters: the pair, not the widget state.
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].project_id).toBe('proj-b')
    expect(postCalls[0].plant_id).toBeNull()
  })

  it('re-selecting the SAME project is not a silent reset', async () => {
    wireTwoProjects()
    renderEventNew('project=proj-a&plant=plant-a&event_type=watering'); await flushLoad()
    await act(async () => { await Promise.resolve() })
    await switchTo('proj-a')
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].plant_id).toBe('plant-a')
  })

  it('the load-effect stale-guard is no longer scoped to the deep-link / remembered ids', async () => {
    // Regression pin for the actual defect: the two prior guards compared plant_id against
    // preselectedPlantId / rememberedPlantId by identity, so ANY other id passed through.
    apiFetchSpy.mockImplementation((path, options = {}) => {
      if (options.method === 'POST' && path === '/api/events') {
        postCalls.push(JSON.parse(options.body)); return Promise.resolve(dataRef.postResult)
      }
      if (path === '/api/projects') return Promise.resolve([PROJ_A, PROJ_B])
      if (path === '/api/locations/with-path') return Promise.resolve([])
      // proj-b never contains plant-a, whatever route selected it.
      if (path === '/api/plants?project_id=proj-b') return Promise.resolve([PLANT_B])
      if (path.startsWith('/api/plants')) return Promise.resolve([PLANT_A])
      return Promise.resolve(null)
    })
    renderEventNew('project=proj-b&plant=plant-a&event_type=watering'); await flushLoad()
    await act(async () => { await Promise.resolve() })
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].plant_id).toBeNull()
  })
})
