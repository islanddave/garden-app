// V4-PLANTINGUI-001 — QuickActions: water (POST watering) + photo (deep-link).
// V4-STATUSTAP-001: status moved to the hero StatusPicker (see StatusPicker.test.jsx); the
// former inline status <select> and its tests were removed from here.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { navigateSpy, setPendingSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn(), setPendingSpy: vi.fn() }))
vi.mock('react-router-dom', async (orig) => { const actual = await orig(); return { ...actual, useNavigate: () => navigateSpy } })
vi.mock('../lib/pendingCapture.js', () => ({ setPendingCapture: setPendingSpy, takePendingCapture: vi.fn() }))

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))

import QuickActions, { canMarkSprouted } from '../components/planting/QuickActions.jsx'

const PL = { id: 'pl1', project_id: 'proj1', status: 'seedling' }

function renderQA(props = {}) {
  return render(
    <MemoryRouter>
      <QuickActions planting={PL} {...props} />
    </MemoryRouter>,
  )
}

beforeEach(() => { apiFetchSpy.mockReset() })

describe('QuickActions', () => {
  it('Water POSTs a watering event and calls onLogged (no provider = no throw)', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'ev1', event_type: 'watering' })
    const onLogged = vi.fn()
    renderQA({ onLogged })
    fireEvent.click(screen.getByRole('button', { name: /Log watering/i }))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/events')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ project_id: 'proj1', plant_id: 'pl1', event_type: 'watering' })
    await waitFor(() => expect(onLogged).toHaveBeenCalled())
  })

  it('no longer renders a status control (moved to the hero StatusPicker)', () => {
    renderQA()
    expect(screen.queryByRole('combobox', { name: /status/i })).toBeNull()
  })

  it('Photo opens a picker; on pick it parks the file and jumps into the photo log flow (V4-PHOTOQUICK-001)', () => {
    navigateSpy.mockReset(); setPendingSpy.mockReset()
    const { container } = renderQA()
    fireEvent.click(screen.getByRole('button', { name: /Add a photo/i }))
    const input = container.querySelector('input[type="file"]')
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(setPendingSpy).toHaveBeenCalledWith(file)
    // V4-OVERLAY-001 Slice 2: the photo deep-link now opens /log as an overlay, so the nav carries a
    // `background` in options state (flag on). Assert the target + that a background is carried.
    const [toArg, optsArg] = navigateSpy.mock.calls[0]
    expect(toArg).toBe('/log?project=proj1&plant=pl1&event_type=photo&fromquick=1')
    expect(optsArg?.state?.background).toBeTruthy()
  })

  it('It sprouted! POSTs a germination event and calls onLogged (CAL-2)', async () => {
    apiFetchSpy.mockResolvedValue({ id: 'ev2', event_type: 'germination', event_date: '2026-07-30' })
    const onLogged = vi.fn()
    renderQA({ onLogged })
    fireEvent.click(screen.getByRole('button', { name: /sprouted/i }))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/events')
    expect(opts.method).toBe('POST')
    // BUG-GERMDATEBATCH-001: event_date is now ALWAYS sent. It used to be absent, which handed the
    // date to the server's UTC clock. Its VALUE is pinned in the suite below.
    expect(JSON.parse(opts.body)).toEqual({
      project_id: 'proj1', plant_id: 'pl1', event_type: 'germination',
      event_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    })
    await waitFor(() => expect(onLogged).toHaveBeenCalled())
  })

  it('hides the "It sprouted!" action once the planting has germinated_at (CAL-2)', () => {
    renderQA({ planting: { ...PL, germinated_at: '2026-07-01' } })
    expect(screen.queryByRole('button', { name: /sprouted/i })).toBeNull()
  })
})

// BUG-SPROUTGATE-001 — the stamp alone is not a gate. Measured against live prod on 2026-08-04:
// 264 of 269 plantings rendered the button before this change, 21 after.
describe('BUG-SPROUTGATE-001 — sprout gate (stage + sown origin, not the stamp alone)', () => {
  it('shows for a sown, pre-emergence planting', () => {
    expect(canMarkSprouted({ status: 'seed', source_type: 'seed_packet' })).toBe(true)
    expect(canMarkSprouted({ status: 'seed', source_type: 'saved_seed' })).toBe(true)
  })

  it('keeps "seedling" — the one stage where the event is true and still unrecorded', () => {
    // The germination event does not write status, and StatusPicker does not write germinated_at,
    // so a hand-advanced seedling has no other route to capture it.
    expect(canMarkSprouted({ status: 'seedling', source_type: 'seed_packet' })).toBe(true)
  })

  it('hides for every post-emergence lifecycle stage', () => {
    for (const status of ['vegetative', 'flowering', 'fruiting', 'harvested', 'dormant', 'ended', 'failed']) {
      expect(canMarkSprouted({ status, source_type: 'seed_packet' })).toBe(false)
    }
  })

  it('hides for "rooting" — a cutting striking roots is not germination', () => {
    expect(canMarkSprouted({ status: 'rooting', source_type: 'seed_packet' })).toBe(false)
  })

  it('hides for origins that arrived already growing, whatever the stage', () => {
    for (const source_type of ['nursery_transplant', 'division', 'volunteer', 'gift', 'cutting_taken', 'rescued', 'plant_swap']) {
      expect(canMarkSprouted({ status: 'seed', source_type })).toBe(false)
    }
  })

  it('origin is a DENY-list: unknown / absent / future free-text origins still pass the stage gate', () => {
    // source_type is free-text (V4-SOURCEFREE-001) — an allow-list would silently break on a new
    // dropdownRegistry value. NULL means UNKNOWN, and the stage gate already carries the reduction.
    expect(canMarkSprouted({ status: 'seed' })).toBe(true)
    expect(canMarkSprouted({ status: 'seed', source_type: null })).toBe(true)
    expect(canMarkSprouted({ status: 'seed', source_type: 'unknown' })).toBe(true)
    expect(canMarkSprouted({ status: 'seed', source_type: 'bulb_order_2027' })).toBe(true)
  })

  it('the stamp still wins over everything', () => {
    expect(canMarkSprouted({ status: 'seed', source_type: 'seed_packet', germinated_at: '2026-05-01' })).toBe(false)
  })

  it('is null-safe', () => {
    expect(canMarkSprouted(null)).toBe(false)
    expect(canMarkSprouted({})).toBe(false)
  })

  it('the rendered button follows the gate (nursery transplant at fruiting: gone)', () => {
    renderQA({ planting: { ...PL, status: 'fruiting', source_type: 'nursery_transplant' } })
    expect(screen.queryByRole('button', { name: /sprouted/i })).toBeNull()
    // the other two quick actions are untouched
    expect(screen.getByRole('button', { name: /Log watering/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add a photo/i })).toBeTruthy()
  })
})

// BUG-GERMDATEBATCH-001 — the sprout tap used to send NO event_date, so lambda/events/index.js fell
// through to `?? new Date().toISOString()` and stamped the server's UTC instant into a DATE column.
// Live prod, read-only 2026-08-20: all 18 stamped plantings sit on exactly two dates across five sow
// dates (batch catch-up, not seed behaviour), and 5 of the 17 app-logged ones are a calendar day
// late on top of that — the whole 2026-07-31 cluster was tapped 22:55–23:13 EDT on 07-30. Purple
// Vienna Kohlrabi's "1 day to germinate" is really ZERO days.
describe('BUG-GERMDATEBATCH-001 — the sprout tap sends its own date', () => {
  // Independent of dateLocal.js on purpose: asserting against the helper the component calls would
  // be tautological. Intl 'en-CA' formats as YYYY-MM-DD in the runner's local zone.
  const localDay = (d) => new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)

  const bodyOf = (call) => JSON.parse(call[1].body)

  afterEach(() => { vi.useRealTimers() })

  it('one tap posts the LOCAL calendar day, not the UTC one', async () => {
    // 2026-08-06T01:13:00Z is 2026-08-05 21:13 EDT — the exact shape of the five off-by-one prod
    // rows (they were tapped at 22:55–23:13 local and filed on the next UTC day).
    vi.useFakeTimers()
    const NOW = new Date('2026-08-06T01:13:00Z')
    vi.setSystemTime(NOW)
    apiFetchSpy.mockResolvedValue({ id: 'ev2', event_type: 'germination' })
    renderQA()
    fireEvent.click(screen.getByRole('button', { name: /sprouted/i }))
    await vi.waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    expect(bodyOf(apiFetchSpy.mock.calls[0]).event_date).toBe(localDay(NOW))
    // The strict half only manifests in a UTC-negative zone (LANE-RULES requires a
    // TZ=America/New_York run); elsewhere the assertion above still pins the property.
    if (NOW.getTimezoneOffset() > 0) {
      expect(bodyOf(apiFetchSpy.mock.calls[0]).event_date).toBe('2026-08-05')
      expect(bodyOf(apiFetchSpy.mock.calls[0]).event_date).not.toBe(NOW.toISOString().slice(0, 10))
    }
  })

  it('the one-tap path is STILL ONE TAP — no confirm, no date step, no dialog', async () => {
    // The affordance is the thing worth protecting: usage went 5/269 plantings to 18 once
    // BUG-SPROUTGATE-001 stopped rendering the button on transplants. A fix that made the happy
    // path ask for a date would undo that, and would do it invisibly to every other assertion here.
    apiFetchSpy.mockResolvedValue({ id: 'ev2', event_type: 'germination' })
    renderQA()
    fireEvent.click(screen.getByRole('button', { name: /sprouted/i }))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledTimes(1))
    // ...and the tap did not open the date affordance as a side effect.
    expect(screen.queryByLabelText(/Sprouted on/i)).toBeNull()
  })

  it('the date affordance is ambient and opt-in — never a dialog, alert or toast (Reward-UX)', () => {
    renderQA()
    // Closed by default: a muted line of text, not a picker in the user's way.
    expect(screen.queryByLabelText(/Sprouted on/i)).toBeNull()
    expect(screen.getByRole('button', { name: /earlier date/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /earlier date/i }))
    expect(screen.getByLabelText(/Sprouted on/i)).toBeTruthy()
    // Ambient-over-interrupt: opening it introduces no modal/dialog and no status/alert region.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the adjusted-date path posts the ADJUSTED date, not today', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T14:00:00Z'))
    apiFetchSpy.mockResolvedValue({ id: 'ev3', event_type: 'germination' })
    const onLogged = vi.fn()
    renderQA({ onLogged })
    fireEvent.click(screen.getByRole('button', { name: /earlier date/i }))
    fireEvent.change(screen.getByLabelText(/Sprouted on/i), { target: { value: '2026-08-02' } })
    fireEvent.click(screen.getByRole('button', { name: /^Log$/ }))
    await vi.waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    expect(bodyOf(apiFetchSpy.mock.calls[0])).toEqual({
      project_id: 'proj1', plant_id: 'pl1', event_type: 'germination', event_date: '2026-08-02',
    })
    await vi.waitFor(() => expect(onLogged).toHaveBeenCalled())
    // A successful dated log closes the affordance rather than leaving a stale open form.
    expect(screen.queryByLabelText(/Sprouted on/i)).toBeNull()
  })

  it('bounds the picker: no future date, and never before the seed went in', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T14:00:00Z'))
    renderQA({ planting: { ...PL, sown_at: '2026-07-30' } })
    fireEvent.click(screen.getByRole('button', { name: /earlier date/i }))
    const input = screen.getByLabelText(/Sprouted on/i)
    expect(input.getAttribute('type')).toBe('date')
    expect(input.getAttribute('max')).toMatch(/^2026-08-0[45]$/)   // local day, either side of UTC
    expect(input.getAttribute('min')).toBe('2026-07-30')
  })

  it('omits the lower bound rather than inventing one when sown_at is unknown', () => {
    // 0 of the 18 stamped prod rows lack sown_at today, but a planting created in a hurry can.
    renderQA()
    fireEvent.click(screen.getByRole('button', { name: /earlier date/i }))
    expect(screen.getByLabelText(/Sprouted on/i).getAttribute('min')).toBeNull()
  })

  it('Cancel closes the affordance without logging anything', () => {
    renderQA()
    fireEvent.click(screen.getByRole('button', { name: /earlier date/i }))
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(screen.queryByLabelText(/Sprouted on/i)).toBeNull()
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('follows the sprout gate — a planting that cannot sprout gets no dated path either', () => {
    // One gate, not two that can drift: BUG-SPROUTGATE-001 would be re-opened by a date affordance
    // that rendered on all 264 plantings the button no longer does.
    renderQA({ planting: { ...PL, status: 'fruiting', source_type: 'nursery_transplant' } })
    expect(screen.queryByRole('button', { name: /earlier date/i })).toBeNull()
    renderQA({ planting: { ...PL, germinated_at: '2026-07-01' } })
    expect(screen.queryByRole('button', { name: /earlier date/i })).toBeNull()
  })
})
