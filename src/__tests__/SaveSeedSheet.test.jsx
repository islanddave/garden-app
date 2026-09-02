// V4-SAVESEEDBTN-001 — "Save seed" on planting detail, and the create-a-seed-lot write behind it.
//
// WHAT IS ACTUALLY WORTH PINNING HERE is the payload, not the pixels. Before this change no route
// in the app could create a seed lot at all, and the two fields that make one worth creating are
// the two that were historically dropped or refused:
//   • source_plant_id — BUG-SEEDPOSTDROPSPARENT-001. The POST named it in neither the INSERT column
//     list nor its VALUES, so a client that sent one got 201 back with the provenance gone. A test
//     that only asserted "the request was made" would have passed throughout that bug's life, so
//     the assertions below read the KEY out of the body.
//   • variety_id — chk_inventory_seed_requires_variety refuses a category='seeds' row without one,
//     and validateCreate 400s first. So there are two tests: the value is sent on the happy path,
//     and a planting that HAS no variety produces no request at all rather than a doomed one.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { navigateSpy, apiFetchSpy, toastSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(), apiFetchSpy: vi.fn(), toastSpy: vi.fn(),
}))
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig()
  return { ...actual, useNavigate: () => navigateSpy }
})
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
// V4-SEEDEVENT-001 — the toast is now an ASSERTION SURFACE, not scenery: an event failure must
// leave it byte-identical to a clean save, where a stage failure retones it. useOptionalToast
// returns a no-op outside a provider, so without this mock "the toast did not change" is
// unfalsifiable. Only the two hooks this tree uses are stubbed; ToastProvider is never mounted here.
vi.mock('../context/ToastContext.jsx', () => ({
  useOptionalToast: () => ({ show: toastSpy }),
  useToast: () => ({ show: toastSpy }),
}))
vi.mock('../lib/pendingCapture.js', () => ({ setPendingCapture: vi.fn(), takePendingCapture: vi.fn() }))

// VarietyPicker is stubbed for ONE reason and it is not convenience: its useVarieties hook fetches
// /api/varieties on mount, which would put a read into apiFetchSpy's call list and make every
// "the first call was the POST" assertion below depend on the picker's internals. The real picker
// has its own five suites. The stub keeps the same contract this component uses: `value` in,
// onChange(variety|null) out.
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value, onChange }) => (
    <div data-testid="variety-picker-stub">
      <span data-testid="variety-picker-value">{value?.id ?? 'none'}</span>
      <button type="button" onClick={() => onChange({ id: 'v-other', name: 'Cherokee Purple' })}>
        stub pick other variety
      </button>
    </div>
  ),
}))

import QuickActions from '../components/planting/QuickActions.jsx'
import SaveSeedSheet, { defaultLotName, seedSavedNote } from '../components/planting/SaveSeedSheet.jsx'
import { todayLocalISO } from '../lib/dateLocal.js'
import { EVENT_TYPES, PLANTING_REQUIRED_TYPES } from '../lib/eventTypes.js'

const PL = {
  id: 'pl1', project_id: 'proj1', name: 'Brandywine #2', status: 'fruiting',
  variety_id: 'v-brandywine',
  variety_ref: { id: 'v-brandywine', name: 'Brandywine', crop_type_slug: 'tomato' },
}

const renderQA = (planting = PL) => render(
  <MemoryRouter><QuickActions planting={planting} /></MemoryRouter>,
)

/** Open the sheet from the real quick-actions button — the entry point is part of what is tested. */
const openSheet = (planting = PL) => {
  renderQA(planting)
  fireEvent.click(screen.getByTestId('save-seed-open'))
}

const bodyOf = (call) => JSON.parse(call[1].body)
const postCalls = () => apiFetchSpy.mock.calls.filter(([, o]) => o?.method === 'POST')

beforeEach(() => { apiFetchSpy.mockReset(); navigateSpy.mockReset(); toastSpy.mockReset() })

describe('V4-SAVESEEDBTN-001 — the entry point on planting detail', () => {
  it('renders a Save seed action in QuickActions', () => {
    renderQA()
    const btn = screen.getByRole('button', { name: /Save seed from this planting/i })
    expect(btn).toBeTruthy()
  })

  it('renders it for every planting — no lifecycle gate, unlike the sprout action beside it', () => {
    // The sprout gate exists because that button ASSERTS germination. This one asserts nothing, and
    // a gate here would re-hide the only door this change opens.
    for (const status of ['seed', 'seedling', 'vegetative', 'fruiting', 'harvested', 'ended']) {
      const { unmount } = renderQA({ ...PL, status })
      expect(screen.getByTestId('save-seed-open')).toBeTruthy()
      unmount()
    }
  })

  it('opening the sheet costs no request and defaults name + variety off the planting', () => {
    openSheet()
    expect(apiFetchSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('save-seed-name').value).toMatch(/^Brandywine — saved \d{4}$/)
    // The planting knows its cultivar, so the picker stays collapsed: no /api/varieties read.
    expect(screen.queryByTestId('variety-picker-stub')).toBeNull()
    expect(screen.getByTestId('save-seed-variety-name').textContent).toBe('Brandywine')
  })
})

describe('V4-SAVESEEDBTN-001 — the POST payload', () => {
  it('carries source_plant_id AND variety_id, plus the consumable-seed discriminators', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())

    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/inventory-items')
    expect(opts.method).toBe('POST')
    const body = bodyOf(apiFetchSpy.mock.calls[0])
    // BUG-SEEDPOSTDROPSPARENT-001 — the whole point of launching from a planting.
    expect(body.source_plant_id).toBe('pl1')
    // chk_inventory_seed_requires_variety — never absent, never null.
    expect(body.variety_id).toBe('v-brandywine')
    // validateCreate's consumable arm needs all three of these together.
    expect(body.category).toBe('seeds')
    expect(body.type).toBe('consumable')
    expect(body.unit).toBe('packet')
    expect(body.name).toMatch(/^Brandywine — saved \d{4}$/)
  })

  it('creates the lot on ZERO — never null, and never a guessed count', async () => {
    // V4-SEEDSTOREDQTY-001. This sheet used to offer a packet count defaulting to 1, which was a
    // guess dressed as data: at "Save seed" the seed is still wet and unthreshed. Two halves, and
    // both are load-bearing:
    //   0 not null — the live CHECK consumable_requires_quantity_on_hand is
    //     `type <> 'consumable' OR quantity_on_hand IS NOT NULL`, so null is refused outright.
    //   0 not 1 — 1 is a fabricated count that survives into Sow now looking measured.
    // Asserted with Object.is so a `0` cannot be satisfied by null/undefined coercion.
    apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    const body = bodyOf(apiFetchSpy.mock.calls[0])
    expect(Object.prototype.hasOwnProperty.call(body, 'quantity_on_hand')).toBe(true)
    expect(body.quantity_on_hand).toBe(0)
    expect(body.quantity_on_hand).not.toBeNull()
  })

  it('offers no count field at all, and says where the question went', async () => {
    // Removing the field silently would read as a regression to anyone who used it; the sheet names
    // the moment the question moved to instead.
    openSheet()
    expect(screen.queryByTestId('save-seed-packets')).toBeNull()
    expect(screen.getByTestId('save-seed-count-note').textContent).toMatch(/stored/i)
  })

  it('sends the edited name, not the default', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
    openSheet()
    fireEvent.change(screen.getByTestId('save-seed-name'), { target: { value: '  1884 tomato  ' } })
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    expect(bodyOf(apiFetchSpy.mock.calls[0]).name).toBe('1884 tomato')
  })

  it('an overridden variety wins over the planting default', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-variety-change'))
    fireEvent.click(screen.getByRole('button', { name: /stub pick other variety/i }))
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    expect(bodyOf(apiFetchSpy.mock.calls[0]).variety_id).toBe('v-other')
  })
})

describe('V4-SAVESEEDBTN-001 — a planting with no variety is handled, never POSTed', () => {
  const NO_VARIETY = { id: 'pl2', project_id: 'proj1', name: 'Volunteer squash', status: 'fruiting' }

  it('opens the picker, says why, and refuses to send a request', async () => {
    openSheet(NO_VARIETY)
    expect(screen.getByTestId('variety-picker-stub')).toBeTruthy()
    expect(screen.getByTestId('save-seed-no-variety')).toBeTruthy()
    // Save is LIVE, not greyed: the guard that stops the write is the one that can say why, and a
    // disabled button beside it would be a redundant second mechanism neither of them could test.
    const submit = screen.getByTestId('save-seed-submit')
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await act(async () => {})
    // Not "the request 400s" — no request at all. The DB CHECK and validateCreate would both
    // refuse it, so a POST here would burn a round trip to be told what the client already knows.
    expect(apiFetchSpy).not.toHaveBeenCalled()
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('save-seed-error').textContent).toMatch(/variety/i)
  })

  it('becomes saveable once a variety is picked, and sends THAT id', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
    openSheet(NO_VARIETY)
    fireEvent.click(screen.getByRole('button', { name: /stub pick other variety/i }))
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    const body = bodyOf(apiFetchSpy.mock.calls[0])
    expect(body.variety_id).toBe('v-other')
    expect(body.source_plant_id).toBe('pl2')
  })

  it('a blank NAME is refused by the disabled control', () => {
    // The count arm of this test went with the count field (V4-SEEDSTOREDQTY-001). The name arm
    // stays: a disabled control is the conventional answer for a field the user can see is blank.
    openSheet()
    fireEvent.change(screen.getByTestId('save-seed-name'), { target: { value: '   ' } })
    expect(screen.getByTestId('save-seed-submit').disabled).toBe(true)
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })
})

describe('V4-SAVESEEDBTN-001 — the success path has an end', () => {
  it('routes to the lot it just created and closes the sheet', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'inv-9', name: 'Brandywine — saved 2026' })
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled())
    // Plain navigate, ONE argument: /inventory/:id is not an overlayable route, so a `background`
    // in route state would leave the page tree on this planting and render nothing.
    expect(navigateSpy.mock.calls[0][0]).toBe('/inventory/inv-9')
    expect(navigateSpy.mock.calls[0][1]).toBeUndefined()
    expect(screen.queryByTestId('save-seed-submit')).toBeNull()
  })

  it('defaults to NO stage — no stage request, and no fabricated ferment', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled())
    // BUG-SEEDPROCFORCED-001 in a new place: a stage write is a PERMANENT seed_lot_stage_log row,
    // so the sheet must never choose a process on the user's behalf.
    // The count is 2 rather than 1 as of V4-SEEDEVENT-001 — create + the seed_saved event. Asserted
    // by PATH below so this stays a statement about the stage rather than about the total.
    expect(postCalls()).toHaveLength(2)
    expect(apiFetchSpy.mock.calls.some(([p]) => String(p).includes('/seed-stage'))).toBe(false)
  })

  it('wet opens the lot in fermenting, dry in drying — the vocabulary of both DB CHECKs', async () => {
    for (const [proc, stage] of [['wet', 'fermenting'], ['dry', 'drying']]) {
      apiFetchSpy.mockReset(); navigateSpy.mockReset()
      apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
      const { unmount } = render(<MemoryRouter><QuickActions planting={PL} /></MemoryRouter>)
      fireEvent.click(screen.getByTestId('save-seed-open'))
      fireEvent.click(screen.getByTestId(`save-seed-process-${proc}`))
      fireEvent.click(screen.getByTestId('save-seed-submit'))
      // 3 as of V4-SEEDEVENT-001: create, stage, seed_saved event. The INDEX below is the part
      // worth keeping — the stage is still the request immediately after the create, so a future
      // reorder that put the event between them reds here.
      await waitFor(() => expect(postCalls()).toHaveLength(3))
      const [stagePath, stageOpts] = apiFetchSpy.mock.calls[1]
      expect(stagePath).toBe('/api/inventory-items/inv-9/seed-stage')
      expect(stageOpts.method).toBe('POST')
      expect(JSON.parse(stageOpts.body)).toEqual({ stage, seed_process: proc })
      unmount()
    }
  })

  it('surfaces a create failure and does NOT route anywhere', async () => {
    apiFetchSpy.mockRejectedValue(Object.assign(new Error('variety_id is required for seeds'), { status: 400 }))
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())
    expect(screen.getByTestId('save-seed-error').textContent).toContain('variety_id is required')
    expect(navigateSpy).not.toHaveBeenCalled()
    // The sheet stays open on its filled-in values so the save is re-tryable.
    expect(screen.getByTestId('save-seed-submit')).toBeTruthy()
  })

  it('a failed STAGE does not report the created lot as lost', async () => {
    // Two independent facts with two independent failures: the lot exists whether or not the
    // optional stage landed, and calling a landed create "failed" is the worse error.
    apiFetchSpy.mockImplementation((path) => (String(path).includes('/seed-stage')
      ? Promise.reject(new Error('nope'))
      : Promise.resolve({ id: 'inv-9' })))
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-process-wet'))
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled())
    expect(navigateSpy.mock.calls[0][0]).toBe('/inventory/inv-9')
    expect(screen.queryByTestId('save-seed-error')).toBeNull()
  })
})

// ── V4-SEEDEVENT-001 — the trace ────────────────────────────────────────────────────────────────
// Saving seed used to pay back nothing: `seed_saved` is a fully declared event type that NOTHING
// wrote, so a two-week ferment→dry→store commitment left no mark on the plant it came off. What is
// worth pinning is not "an event was posted" — it is the three properties that make the event safe
// to add to a flow whose real product is the lot:
//   • it cannot fail the save (the lot is what the user asked for)
//   • exactly one per saved lot, and none for a create that failed or a sheet that was closed
//   • it asserts nothing that is not true at save time — no count, and no stage that did not land
const eventCalls = () => apiFetchSpy.mock.calls
  .filter(([p, o]) => p === '/api/events' && o?.method === 'POST')
const eventBody = () => JSON.parse(eventCalls()[0][1].body)

describe('V4-SEEDEVENT-001 — the event payload', () => {
  it('logs seed_saved against the PLANTING, on the local calendar day', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(eventCalls()).toHaveLength(1))
    const body = eventBody()
    expect(body.event_type).toBe('seed_saved')
    // PLANTING_REQUIRED_TYPES holds seed_saved, and validatePostBody wants project_id OR plant_id.
    expect(body.plant_id).toBe('pl1')
    // BUG-GERMDATEBATCH-001: omitting event_date falls through to the Lambda's UTC `new Date()`,
    // which files an evening save on tomorrow. A bare YYYY-MM-DD is anchored at noon UTC server-side.
    expect(body.event_date).toBe(todayLocalISO())
    expect(body.event_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('is a real declared type that requires the planting it was given', () => {
    // Cheap, and it is the half that would have caught the whole gap: the type has been declared and
    // inert. If it is ever renamed or loses its planting requirement, this flow's payload is wrong.
    expect(EVENT_TYPES.includes('seed_saved')).toBe(true)
    expect(PLANTING_REQUIRED_TYPES.has('seed_saved')).toBe(true)
  })

  it('sends no project_id — the server derives it from the planting', async () => {
    // deriveEventProjectId ignores the body's project_id whenever plant_id is present, so sending
    // one buys a second ownership round trip and a new 400 branch for nothing. PL HAS a project_id,
    // so this asserts a choice rather than an accident of the fixture.
    apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
    expect(PL.project_id).toBe('proj1')
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(eventCalls()).toHaveLength(1))
    expect(Object.prototype.hasOwnProperty.call(eventBody(), 'project_id')).toBe(false)
  })

  it('claims no count it does not have', async () => {
    // The lot is created at 0-because-unmeasured (V4-SEEDSTOREDQTY-001). A quantity on the event
    // would be the same fabrication one request later, and it would read as measured forever.
    apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(eventCalls()).toHaveLength(1))
    const body = eventBody()
    expect(Object.prototype.hasOwnProperty.call(body, 'quantity')).toBe(false)
    expect(body.notes).not.toMatch(/\d+\s*(seed|packet)/i)
    expect(body.notes).toMatch(/no count yet/i)
    // The note names the lot the user just created — the one thing the timeline row cannot know.
    // Built from todayLocalISO rather than a literal year, like the name assertions above: a
    // hardcoded 2026 turns into a January-1st time bomb.
    expect(body.notes).toContain(`Brandywine — saved ${todayLocalISO().slice(0, 4)}`)
  })

  it('names the process ONLY when the stage write actually landed', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-process-wet'))
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(eventCalls()).toHaveLength(1))
    expect(eventBody().notes).toMatch(/fermenting/)
  })

  it('says nothing about a stage whose write FAILED', async () => {
    // The interesting half. The user picked "wet", so the radio says fermenting — but the stage POST
    // 500'd, the column and seed_lot_stage_log row do not exist, and a note claiming "fermenting"
    // would be a permanent false sentence on the plant's timeline. The clause is dropped, not
    // replaced with "unknown": nothing was asked about a process that was never recorded.
    apiFetchSpy.mockImplementation((path) => (String(path).includes('/seed-stage')
      ? Promise.reject(new Error('nope'))
      : Promise.resolve({ id: 'inv-9' })))
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-process-wet'))
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(eventCalls()).toHaveLength(1))
    expect(eventCalls()).toHaveLength(1)
    expect(eventBody().notes).not.toMatch(/fermenting|drying|unknown/i)
    expect(eventBody().notes).toMatch(/no count yet/i)
  })

  it('seedSavedNote is pure and drops the stage clause when there is none', () => {
    expect(seedSavedNote('Brandywine — saved 2026', 'drying'))
      .toBe('Seed lot "Brandywine — saved 2026", drying. No count yet — recorded when it\'s marked stored.')
    expect(seedSavedNote('  Brandywine — saved 2026  '))
      .toBe('Seed lot "Brandywine — saved 2026". No count yet — recorded when it\'s marked stored.')
  })
})

describe('V4-SEEDEVENT-001 — the event can never cost the user their lot', () => {
  it('an event write that fails leaves the save fully successful', async () => {
    // Modelled on the stage above, one step further. The user asked for a lot; the timeline row is
    // ours. A rejected POST /api/events must not surface an error, must not block the toast, and
    // must not stop the route to the lot that DOES exist.
    apiFetchSpy.mockImplementation((path) => (path === '/api/events'
      ? Promise.reject(Object.assign(new Error('events 500'), { status: 500 }))
      : Promise.resolve({ id: 'inv-9' })))
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled())
    expect(navigateSpy.mock.calls[0][0]).toBe('/inventory/inv-9')
    expect(screen.queryByTestId('save-seed-error')).toBeNull()
    expect(screen.queryByTestId('save-seed-submit')).toBeNull()
  })

  it('an event write that fails does not even change the toast', async () => {
    // The stage failure DOES retone the toast, because the user explicitly chose to start tracking.
    // Nobody asked for the event, so there is nothing here they could act on — silence, not an
    // apology for a thing they cannot see.
    apiFetchSpy.mockImplementation((path) => (path === '/api/events'
      ? Promise.reject(new Error('events 500'))
      : Promise.resolve({ id: 'inv-9' })))
    render(<MemoryRouter><QuickActions planting={PL} /></MemoryRouter>)
    fireEvent.click(screen.getByTestId('save-seed-open'))
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled())
    expect(toastSpy).toHaveBeenCalledTimes(1)
    expect(toastSpy.mock.calls[0][0]).toEqual({ message: 'Seed lot saved', tone: 'success' })
  })
})

describe('V4-SEEDEVENT-001 — exactly one event per saved lot', () => {
  it('one successful save logs one event, and only one', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled())
    expect(eventCalls()).toHaveLength(1)
  })

  it('a second tap while the create is still in flight logs nothing extra', async () => {
    let releaseCreate
    apiFetchSpy.mockImplementation((path) => (path === '/api/inventory-items'
      ? new Promise((res) => { releaseCreate = () => res({ id: 'inv-9' }) })
      : Promise.resolve({})))
    openSheet()
    const submit = screen.getByTestId('save-seed-submit')
    fireEvent.click(submit)
    fireEvent.click(submit)
    await act(async () => { releaseCreate() })
    await waitFor(() => expect(eventCalls()).toHaveLength(1))
    // One lot, one event. Two lots here would be the worse bug, but two events on one lot is the
    // one this suite is responsible for.
    expect(apiFetchSpy.mock.calls.filter(([p]) => p === '/api/inventory-items')).toHaveLength(1)
    expect(eventCalls()).toHaveLength(1)
  })

  it('a FAILED create logs no event at all', async () => {
    // The event's whole claim is "a lot came off this plant". If the create threw, no lot exists,
    // and a seed_saved row would be a record of something that never happened.
    apiFetchSpy.mockRejectedValue(Object.assign(new Error('variety_id is required for seeds'), { status: 400 }))
    openSheet()
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())
    expect(eventCalls()).toHaveLength(0)
  })

  it('a sheet the user opens and CLOSES logs no event', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: /^Close$/i }))
    await act(async () => {})
    expect(apiFetchSpy).not.toHaveBeenCalled()
    expect(eventCalls()).toHaveLength(0)
  })

  it('a write refused client-side (no variety) logs no event', async () => {
    // The no-variety guard returns before the create. Nothing was saved, so nothing is traced —
    // the same rule as the failed create, one step earlier.
    openSheet({ id: 'pl2', project_id: 'proj1', name: 'Volunteer squash', status: 'fruiting' })
    fireEvent.click(screen.getByTestId('save-seed-submit'))
    await act(async () => {})
    expect(eventCalls()).toHaveLength(0)
  })
})

describe('defaultLotName', () => {
  it('leads with the variety and carries the local year', () => {
    expect(defaultLotName(PL, '2026-09-02')).toBe('Brandywine — saved 2026')
  })
  it('falls back to the planting name when there is no cultivar', () => {
    expect(defaultLotName({ name: 'Volunteer squash' }, '2026-09-02')).toBe('Volunteer squash — saved 2026')
  })
  it('never produces a bare dash for a nameless record', () => {
    expect(defaultLotName(null, '2026-09-02')).toBe('Saved seed 2026')
    expect(defaultLotName({}, '2026-09-02')).toBe('Saved seed 2026')
  })
})

describe('SaveSeedSheet mounts standalone (the sheet is not welded to QuickActions)', () => {
  it('renders its own fields with a planting prop alone', () => {
    render(<MemoryRouter><SaveSeedSheet planting={PL} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByTestId('save-seed-name')).toBeTruthy()
    expect(screen.getByTestId('save-seed-submit')).toBeTruthy()
  })
})
