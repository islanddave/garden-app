// V4-OVERWINTERCARE-001 — the affordance that turns overwintering ON for a planting, and the only
// thing in the app that can. Covers the wire contract (route, verb, body), the SET -> read-back ->
// CLEAR -> reverts round trip through the same onUpdated patch PlantingDetail applies, and the
// picker's parity with the shipped evaluator's regime table.
//
// Each `it` names the source edit that turns it red; the lane report carries the measured results.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))

import OverwinterPrompt from '../components/planting/OverwinterPrompt.jsx'
import { OVERWINTER_REGIME_OPTIONS, OVERWINTER_REGIME_KEYS, overwinterLabel } from '../lib/overwinterRegimes.js'
import ow from '../../lambda/daily-plan/overwinter.js'

const PLANTING = { id: 'plant-1', name: 'Lacinato kale' }
const SET = { ...PLANTING, overwintering: { regime: 'protected_productive' } }

beforeEach(() => { apiFetchSpy.mockReset(); apiFetchSpy.mockResolvedValue({ overwintering: null }) })

const openSheet = () => fireEvent.click(screen.getByTestId('overwinter-prompt'))
const pick = (label) => fireEvent.click(screen.getByText(label))

describe('OverwinterPrompt — the affordance', () => {
  it('renders nothing without a planting id', () => {
    const { container } = render(<OverwinterPrompt planting={null} />)
    expect(container.firstChild).toBeNull()
  })

  // Mutation: gate the render on a month/date check. That is date-based gating of a garden
  // affordance, and it would hide the control in the exact week Dave is putting covers on.
  it('is present on a planting with nothing set, and says so', () => {
    render(<OverwinterPrompt planting={PLANTING} />)
    expect(screen.getByTestId('overwinter-prompt').textContent).toMatch(/set up winter care/i)
  })

  // Mutation: promote it to a card/banner. It is a setting, not a nudge — same low-salience chrome
  // and >=44px Android touch target as TransplantDatePrompt.
  it('is low-key, not headline treatment, and thumb-sized', () => {
    render(<OverwinterPrompt planting={PLANTING} />)
    const btn = screen.getByTestId('overwinter-prompt')
    expect(btn.style.fontSize).toBe('0.82rem')
    expect(btn.style.background).toBe('none')
    expect(btn.style.padding).toBe('0px')
    expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
  })

  // Mutation: delete the read-back branch (or the `overwintering` column in the Lambda's by-id
  // GET). The row would read "set up winter care" forever, no matter what was saved.
  it('reads back what is already set', () => {
    render(<OverwinterPrompt planting={SET} />)
    expect(screen.getByTestId('overwinter-prompt').textContent)
      .toMatch(new RegExp(overwinterLabel(SET.overwintering)))
    expect(screen.getByTestId('overwinter-prompt').textContent).not.toMatch(/set up winter care/i)
  })

  it('does not open a sheet until it is tapped', () => {
    render(<OverwinterPrompt planting={PLANTING} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    openSheet()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('OverwinterPrompt — the wire contract', () => {
  // Mutation: change the path to /api/plants/:id (the PUT) or the verb to PUT/POST. The plants
  // Lambda routes /overwinter PATCH-only and 405s everything else; a mocked fetch cannot notice a
  // 405 on its own, so the route shape is pinned here and cross-checked against the Lambda's own
  // regexes by clientRouteLambdaContract.test.js.
  it('PATCHes the /overwinter sub-route with only the regime', async () => {
    const onUpdated = vi.fn()
    // The response deliberately carries a key the client did not send. It is the row as STORED —
    // `RETURNING profile -> 'overwintering'` — and the client's own `{regime}` is only a request.
    // The divergence here is constructed rather than observed: the picker sends no `note` today, so
    // nothing in the shipped path normalises the payload. It pins the DIRECTION of the contract
    // before the field exists, because the first version of this test asserted a response that was
    // byte-identical to the client's guess and therefore could not tell them apart — a mutation
    // that patched from local state survived it (M16 in the lane report).
    apiFetchSpy.mockResolvedValue({ overwintering: { regime: 'field_hardy', note: 'stored server-side' } })
    render(<OverwinterPrompt planting={PLANTING} onUpdated={onUpdated} />)
    openSheet()
    pick('Hardy, out in the ground')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/plants/plant-1/overwinter')
    expect(opts.method).toBe('PATCH')
    expect(JSON.parse(opts.body)).toEqual({ regime: 'field_hardy' })
    // Mutation: patch from the local `regime` state instead of the response. The record would then
    // claim a shape the server never confirmed.
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith({
      overwintering: { regime: 'field_hardy', note: 'stored server-side' },
    }))
  })

  // Mutation: drop the `!regime` guard. Save with nothing picked would send {regime: undefined},
  // which JSON.stringify omits — a bare {} the Lambda 400s, reported to the user as a save failure.
  it('will not save without a choice, and does not call the API', async () => {
    render(<OverwinterPrompt planting={PLANTING} />)
    openSheet()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Pick how/i))
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  // Mutation: render the Clear button unconditionally, or never. The first offers an undo for
  // something that was never done; the second makes the attribute one-way — the dormant trap this
  // design was chosen over a status value to avoid.
  it('offers the clear half only when something is set', () => {
    const { unmount } = render(<OverwinterPrompt planting={PLANTING} />)
    openSheet()
    expect(screen.queryByText('Not overwintering')).toBeNull()
    unmount()
    render(<OverwinterPrompt planting={SET} />)
    openSheet()
    expect(screen.getByText('Not overwintering')).toBeTruthy()
  })

  // Mutation: send {overwintering: false} as a SET body, or omit the key entirely. `{regime: null}`
  // is what parseOverwinterBody reads as CLEAR; an omitted key is a malformed SET and 400s.
  it('clearing sends the explicit off-shape and patches back to null', async () => {
    const onUpdated = vi.fn()
    apiFetchSpy.mockResolvedValue({ overwintering: null })
    render(<OverwinterPrompt planting={SET} onUpdated={onUpdated} />)
    openSheet()
    fireEvent.click(screen.getByText('Not overwintering'))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/plants/plant-1/overwinter')
    expect(opts.method).toBe('PATCH')
    expect(JSON.parse(opts.body)).toEqual({ regime: null })
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith({ overwintering: null }))
  })

  it('surfaces a save failure and keeps the sheet open', async () => {
    apiFetchSpy.mockRejectedValue(new Error('boom'))
    const onUpdated = vi.fn()
    render(<OverwinterPrompt planting={PLANTING} onUpdated={onUpdated} />)
    openSheet()
    pick('Held indoors, tender')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Couldn't save/i))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onUpdated).not.toHaveBeenCalled()
  })
})

describe('OverwinterPrompt — set, read back, clear, revert (in place)', () => {
  // The round trip as PlantingDetail runs it: the same onUpdated patch, applied to the same record,
  // with no refetch. Mutation: have the component ignore its own `planting.overwintering` prop and
  // hold the label in local state — the label would still change here, but it would stop tracking
  // the record and would revert on the next reload. Asserting through the parent's state is what
  // makes this test notice that.
  it('the row re-labels on save and reverts on clear', async () => {
    function Harness() {
      const [pl, setPl] = React.useState(PLANTING)
      return <OverwinterPrompt planting={pl} onUpdated={(patch) => setPl((prev) => ({ ...prev, ...patch }))} />
    }
    apiFetchSpy.mockResolvedValue({ overwintering: { regime: 'protected_quiescent' } })
    render(<Harness />)
    expect(screen.getByTestId('overwinter-prompt').textContent).toMatch(/set up winter care/i)

    openSheet()
    pick('Cold and resting')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByTestId('overwinter-prompt').textContent).toMatch(/Cold and resting/))

    apiFetchSpy.mockResolvedValue({ overwintering: null })
    openSheet()
    fireEvent.click(screen.getByText('Not overwintering'))
    await waitFor(() => expect(screen.getByTestId('overwinter-prompt').textContent).toMatch(/set up winter care/i))
  })
})

// The reachability guard. Everything above tests a component nobody can necessarily get to; this
// is the assertion that the planting page actually mounts it, and that it is wired to the record
// patch rather than dropped in decoratively. Source-text because a full PlantingDetail render pulls
// the router, Clerk, the toast context and eight data fetches — the cost of that harness is not
// what makes this guard non-vacuous, and it would obscure what is being asserted.
//
// Mutation: delete the <OverwinterPrompt …/> element from PlantingDetail.jsx. Every other test in
// this file stays green and the feature is unreachable in the app — which is precisely the state
// v4.34.0 shipped in and this lane exists to end.
describe('the prompt is reachable from the planting page', () => {
  const PD = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../pages/PlantingDetail.jsx'), 'utf8',
  ).split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')

  it('PlantingDetail imports and renders OverwinterPrompt', () => {
    expect(PD).toMatch(/import OverwinterPrompt from '\.\.\/components\/planting\/OverwinterPrompt\.jsx'/)
    expect(PD).toMatch(/<OverwinterPrompt\b/)
  })

  it('it is handed the loaded record and the in-place patch callback', () => {
    const el = PD.slice(PD.indexOf('<OverwinterPrompt'))
    expect(el.slice(0, el.indexOf('/>'))).toMatch(/planting=\{pl\}[\s\S]*onUpdated=\{/)
  })

  // Mutation: move it above <CareStatus>. Ordering is the argument for where it lives — the setting
  // changes what the band above it will say, so it reads as a consequence rather than a stray
  // control.
  it('it sits directly under the care band it changes', () => {
    expect(PD.indexOf('<OverwinterPrompt')).toBeGreaterThan(PD.indexOf('<CareStatus'))
  })
})

describe('the picker offers exactly the regimes the evaluator implements', () => {
  // Mutation: add a fifth option, drop one, or typo a value. The picker would offer a regime the
  // engine resolves to its DEFAULT_REGIME fallback — a plant silently checked on the wrong cadence,
  // with the picker showing the label the user chose. The two lists cannot be imported into one
  // another at runtime (SPA bundle vs CJS Lambda source), so this parity assertion is the join.
  it('option values === lambda/daily-plan/overwinter.js OVERWINTER_REGIMES', () => {
    expect([...OVERWINTER_REGIME_KEYS].sort()).toEqual(Object.keys(ow.OVERWINTER_REGIMES).sort())
  })

  // Mutation: swap two check intervals in the copy. The description is the only place the user can
  // see what picking a regime costs in attention, so a stale number there is a lie about the model.
  it('every description states the regime\'s real check interval', () => {
    for (const o of OVERWINTER_REGIME_OPTIONS) {
      const days = ow.OVERWINTER_REGIMES[o.value].check_interval_days
      expect(o.description, o.value).toMatch(new RegExp(`every ${days} days`, 'i'))
    }
  })

  // Mutation: make a description promise a skip. "Reduced, never skip" is the safety property of
  // the whole feature — a dry freeze kills more overwintered plants than the cold does.
  it('no option copy promises a skip', () => {
    for (const o of OVERWINTER_REGIME_OPTIONS) {
      expect(`${o.label} ${o.description}`.toLowerCase()).not.toMatch(/\b(skip|no water|never water|don't water)\b/)
    }
  })
})
