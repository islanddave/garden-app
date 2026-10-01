// Put-Up release F — the Salt block (06 §3.1-3.3, §4 item 4) and Jar & heat with its breakdown sheet
// (06 §2.6, §4 item 5), rendered inside batch detail. Expected values are the golden table's (06 §5.3).
// Each assertion names the mutation that reds it. CI LANE: `npm test` + TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import BatchDetailView from '../components/putup/BatchDetailView.jsx'
import { SALT_ERRORS, saltStepBody, newStep, suggestedBase } from '../components/putup/SaltBlock.jsx'
import { refusalWords, dominantLine } from '../components/putup/ShuSheet.jsx'
import { jarHeatSummary } from '../components/putup/JarHeatRow.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date('2026-10-02T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()
const BATCH = {
  id: 'kb-1', user_id: 'user_dave', label: 'Petri Dish', kind: 'ferment', kind_other: null,
  started_at: local('2026-09-25T09:00:00'), start_precision: 'day', first_recorded_at: local('2026-09-25T09:00:00'),
  suspended_at: null, closed_at: null, outcome: null, outcome_note: null, current_stage_kind: 'started',
  current_stage_entered_at: local('2026-09-25T09:00:00'), input_count: '4', output_count: '0', garden_names: [],
  vessel_label: null, vessel_size: null, vessel_unit: null, vessel_count: null, no_salt: null,
  shu_est_low: null, shu_est_high: null, shu_est_basis: null, recipe_ref: null,
}
let n = 0
const L = (label, qty, qty_unit, o = {}) => ({ id: `kbi-${++n}`, batch_id: 'kb-1', input_kind: 'other', label, qty, qty_unit,
  role: null, put_up_stage_id: null, output_id: null, ordinal: n, from_garden: false, count_drawn: null, ...o })
const PETRI = [L('jalapeño', '170', 'g'), L('garlic', '8', 'g'), L('onion', '20', 'g'), L('Water', '250', 'ml', { role: 'water' })]
const SETTLERS = [L('Ristra Cayenne', '150', 'g'), L('sugar', '2', 'g')]
const KIMCHI = [L('napa', '1500', 'g'), L('radish', '300', 'g'), L('gochugaru', '40', 'g', { form: 'dried' }), L('garlic', '20', 'g'),
  L('ginger', '10', 'g'), L('fish sauce', '30', 'ml')]
const STARTED = { id: 'ksl-start', batch_id: 'kb-1', stage_kind: 'started', label: null, amount: null, amount_unit: null,
  entered_at: local('2026-09-25T09:00:00'), entered_precision: 'day', cue_observed: null, note: null, ph_reading: null, ph_read_at: null }

const writes = () => fetchMock.mock.calls.filter(([, o]) => o?.method && o.method !== 'GET').map(([p, o]) => [o.method, p, JSON.parse(o.body ?? '{}')])
function wire(extra = () => null) {
  fetchMock.mockImplementation((path, o = {}) => {
    const x = extra(path, o)
    if (x) return x
    if (o.method) return Promise.resolve({ ok: true, inputs: [{ id: 'kbi-new' }] })
    return Promise.resolve(null)
  })
}
function renderDetail(o = {}) {
  return render(<BatchDetailView batch={{ ...BATCH, ...o.batch }} inputs={o.inputs ?? []} stages={o.stages ?? [STARTED]}
    outputs={[]} loading={false} error={false} nowMs={NOW} onChanged={vi.fn()} />)
}
const step = (i, part) => screen.getByTestId(`salt-step-${i}-${part}`)
const write = (i = 0) => act(async () => { fireEvent.click(step(i, 'write')) })

beforeEach(() => { fetchMock.mockReset(); wire(); localStorage.clear(); clearReloadBlocks() })
afterEach(() => clearReloadBlocks())

describe('the Salt block — the helper (golden table)', () => {
  it('Petri: Brine, 3.5% of Veg + water (suggested — there is a water line) → 448 g → 15.7 g, stored 15.68', async () => {
    renderDetail({ inputs: PETRI })
    fireEvent.click(step(0, 'method-brine'))
    fireEvent.change(step(0, 'pct'), { target: { value: '3.5' } })
    expect(step(0, 'base-all').getAttribute('aria-pressed')).toBe('true')
    expect(step(0, 'live-words').textContent).toBe('3.5% of veg + water (448 g) →')
    expect(step(0, 'live-grams').value).toBe('15.7')
    expect(step(0, 'write').textContent).toBe('I put in 15.7 g')
    await write()
    const [method, path, body] = writes()[0]
    expect([method, path]).toEqual(['POST', '/api/kitchen-batches/kb-1/inputs'])
    expect({ ...body.inputs[0], idempotency_key: 'K' }).toEqual({ idempotency_key: 'K', input_kind: 'other', label: 'Salt', role: 'salt',
      qty_unit: 'g', ordinal: 5, salt_method: 'brine', qty: '15.68', salt_pct: 3.5, salt_base: 'all', base_g: '448', base_from: 'lines' })
  })

  // HS-I5: the grams are editable before anything is written, and the aim is kept.
  it('Petri card: grams edited to 13.5 → qty 13.5 with the aimed 3.5% kept', async () => {
    renderDetail({ inputs: PETRI })
    fireEvent.change(step(0, 'pct'), { target: { value: '3.5' } })
    fireEvent.change(step(0, 'live-grams'), { target: { value: '13.5' } })
    expect(step(0, 'write').textContent).toBe('I put in 13.5 g')
    await write()
    expect(writes()[0][2].inputs[0]).toMatchObject({ qty: '13.5', salt_pct: 3.5, base_g: '448' })
  })

  it('Settlers: Dry, 3% of Veg only → 152 g (sugar in) → 4.56 g', async () => {
    renderDetail({ inputs: SETTLERS })
    fireEvent.click(step(0, 'method-dry'))
    expect(step(0, 'base-produce').getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(step(0, 'pct'), { target: { value: '3' } })
    expect(step(0, 'live-words').textContent).toBe('3% of veg (152 g) →')
    await write()
    expect(writes()[0][2].inputs[0]).toMatchObject({ qty: '4.56', salt_base: 'produce', base_g: '152', salt_method: 'dry' })
  })

  // FS-I4: the soak is its own typed base, never a line, never the ferment's %. Two salt steps.
  it('Kimchi: rinsed 10% of 2,000 g soak water (no water line) and a second step, 1% of Veg only → 18.7 g', async () => {
    renderDetail({ inputs: KIMCHI })
    fireEvent.click(step(0, 'method-rinsed'))
    fireEvent.change(step(0, 'soak'), { target: { value: '2000' } })
    fireEvent.change(step(0, 'pct'), { target: { value: '10' } })
    expect(step(0, 'live-words').textContent).toBe('10% of 2,000 g soak water →')
    expect(screen.getByTestId('salt-step-0').textContent).toContain('Soaked, then rinsed off, so not what’s in the jar.')
    await write()
    expect(writes()[0][2].inputs[0]).toMatchObject({ qty: '200', salt_pct: 10, salt_base: 'water', base_g: '2000', base_from: 'scale', salt_method: 'rinsed' })
    fireEvent.click(screen.getByTestId('salt-another'))
    fireEvent.change(step(0, 'pct'), { target: { value: '1' } })
    expect(step(0, 'live-words').textContent).toBe('1% of veg (1,870 g) →')
    expect(step(0, 'aside').textContent).toBe('no weight: fish sauce')
    expect(step(0, 'live-grams').value).toBe('18.7')
    await write()
    expect(writes()).toHaveLength(2)
    expect(writes().every(([, , b]) => b.inputs.every(l => l.role === 'salt'))).toBe(true)   // no water line was created
  })

  it('"Weighed it all together" takes one typed reading as the base', async () => {
    renderDetail({ inputs: PETRI })
    fireEvent.change(step(0, 'pct'), { target: { value: '2' } })
    fireEvent.click(step(0, 'together'))
    fireEvent.change(step(0, 'scale'), { target: { value: '500' } })
    await write()
    expect(writes()[0][2].inputs[0]).toMatchObject({ qty: '10', salt_base: 'all', base_g: '500', base_from: 'scale' })
  })

  it('"I just know the grams" writes a grams-only salt line', async () => {
    renderDetail({ inputs: PETRI })
    fireEvent.click(step(0, 'grams-only'))
    fireEvent.change(step(0, 'grams'), { target: { value: '12' } })
    await write()
    const line = writes()[0][2].inputs[0]
    expect(line).toMatchObject({ role: 'salt', qty: '12', qty_unit: 'g' })
    expect('salt_pct' in line || 'base_g' in line).toBe(false)
  })

  // No default %, ever (V4 salt helper). MUTATION: default the % -> a POST happens here.
  it('refuses a step with no % and writes nothing', async () => {
    renderDetail({ inputs: PETRI })
    await write()
    expect(screen.getByTestId('salt-error').textContent).toBe(SALT_ERRORS.pct)
    expect(writes()).toHaveLength(0)
  })

  it('method chips only on a Ferment batch; the helper itself on every kind', () => {
    renderDetail({ inputs: PETRI, batch: { kind: 'dehydrate' } })
    expect(screen.queryByTestId('salt-step-0-method-dry')).toBeNull()
    expect(screen.getByTestId('salt-step-0-pct')).toBeTruthy()
  })

  it('"No salt" is offered with no salt line, and a refusal says why', async () => {
    wire((p, o) => (o.method === 'PUT' ? Promise.reject(Object.assign(new Error('409'), { status: 409, body: { code: 'has_salt_line', error: 'x' } })) : null))
    renderDetail({ inputs: PETRI })
    await act(async () => { fireEvent.click(screen.getByTestId('salt-none-set')) })
    expect(writes()[0]).toEqual(['PUT', '/api/kitchen-batches/kb-1', { no_salt: true }])
    await waitFor(() => expect(screen.getByTestId('salt-error').textContent).toBe('Take the salt line out first.'))
  })

  it('a salt line says both what was aimed and what went in; the block requires nothing', () => {
    renderDetail({ inputs: [...PETRI, L('Salt', '13.5', 'g', { id: 'kbi-salt', role: 'salt', salt_pct: '3.5', salt_base: 'all', base_g: '448', salt_method: 'brine' })] })
    expect(screen.getByTestId('salt-line-kbi-salt').textContent).toBe('Brine · aimed 3.5% · put in 13.5 g = 3.0% of 448 g')
    expect(screen.getByTestId('salt-block').querySelectorAll('[aria-required="true"]')).toHaveLength(0)
    // With a salt line there, a new step is opened only on request.
    expect(screen.queryByTestId('salt-step-0')).toBeNull()
    expect(screen.queryByTestId('salt-none-set')).toBeNull()
  })

  // The ferment walks at 426×492: with the % focused, "I put in" sat under the keyboard (y494-542).
  // MUTATION: drop the write button's reveal -> the first arm reds; re-run it on focus only (not when
  // the live line appears) -> the second reds; keep it running after blur -> the last reds.
  it('keeps "I put in" in view while a step field has focus — on focus, and when the live line appears', async () => {
    const seen = []
    const hadScroll = Object.prototype.hasOwnProperty.call(Element.prototype, 'scrollIntoView')
    const orig = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function scrollIntoView(opts) { seen.push([this.getAttribute('data-testid'), opts]) }
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    try {
      renderDetail({ inputs: PETRI })
      await act(async () => { step(0, 'pct').focus() })
      expect(seen).toEqual([['salt-step-0-write', { block: 'nearest' }], ['salt-step-0-pct', { block: 'nearest' }]])
      seen.length = 0
      fireEvent.change(step(0, 'pct'), { target: { value: '3.5' } })       // the live line appears
      expect(seen.map(([t]) => t)).toEqual(['salt-step-0-write', 'salt-step-0-pct'])
      seen.length = 0
      fireEvent.change(step(0, 'pct'), { target: { value: '3.6' } })       // same shape: nothing moves under the finger
      expect(seen).toEqual([])
      await act(async () => { step(0, 'pct').blur() })
      window.dispatchEvent(new Event('resize'))
      expect(seen).toEqual([])
      expect(step(0, 'write').style.scrollMarginBottom).toBe('64px')      // clears the 56px nav when the keyboard is down
    } finally {
      if (hadScroll) Element.prototype.scrollIntoView = orig
      else delete Element.prototype.scrollIntoView
      raf.mockRestore()
    }
  })

  // No F writer writes 'peppers' (06 §3.1). MUTATION: suggest 'peppers' -> both arms red.
  it('the suggested base is never "peppers"', () => {
    expect(suggestedBase(PETRI)).toBe('all')
    expect(suggestedBase(SETTLERS)).toBe('produce')
    const res = saltStepBody({ ...newStep(), pct: '3' }, { lines: SETTLERS, ferment: true })
    expect(res.body.salt_base).toBe('produce')
  })
})

describe('Jar & heat — the summary, never opened by itself', () => {
  const SAVED = { vessel_label: 'Quart jar', vessel_size: '1', vessel_unit: 'qt', vessel_count: 2, shu_est_low: 949, shu_est_high: 3036, shu_est_basis: 'computed' }
  it('says the vessel, about how much, and the heat as est. with its basis', () => {
    renderDetail({ batch: SAVED, inputs: PETRI })
    expect(screen.getByTestId('jar-heat-words').textContent).toBe('Quart jar × 2 · about 448 g · heat est. 950–3.0k SHU (worked out)')
    expect(screen.getByTestId('jar-heat-summary').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('jar-heat-panel')).toBeNull()
  })

  // 06 §2.6.4. MUTATION: drop the stale gate (or flag a typed one) -> an arm reds.
  it('flags a worked-out figure that is out of date, and never a typed one', () => {
    renderDetail({ batch: { ...SAVED, shu_est_stale: true }, inputs: PETRI })
    expect(screen.getByTestId('jar-heat-stale').textContent).toContain('worked out before later changes')
    renderDetail({ batch: { ...SAVED, shu_est_basis: 'typed', shu_est_stale: true }, inputs: PETRI })
    expect(screen.getAllByTestId('jar-heat-stale')).toHaveLength(1)
  })

  it('a typed About wins over the sum of what went in', () => {
    expect(jarHeatSummary(BATCH, { ...STARTED, amount: '500', amount_unit: 'g' }, PETRI)).toBe('about 500 g')
    expect(jarHeatSummary(BATCH, STARTED, PETRI)).toBe('about 448 g')
    expect(jarHeatSummary(BATCH, STARTED, [])).toBe('Jar size, how much is in it, heat')
  })

  it('writes the vessel, the count and the About, each as one write', async () => {
    renderDetail({ batch: SAVED, inputs: PETRI })
    fireEvent.click(screen.getByTestId('jar-heat-summary'))
    await act(async () => { fireEvent.click(screen.getByTestId('jar-vessel-half-gallon-jar')) })
    await act(async () => { fireEvent.click(screen.getByTestId('jar-count-plus')) })
    fireEvent.change(screen.getByTestId('jar-about'), { target: { value: '600' } })
    await act(async () => { fireEvent.click(screen.getByTestId('jar-about-save')) })
    expect(writes()).toEqual([
      ['PUT', '/api/kitchen-batches/kb-1', { vessel_label: 'Half-gallon jar', vessel_size: 2, vessel_unit: 'qt' }],
      ['PUT', '/api/kitchen-batches/kb-1', { vessel_count: 3 }],
      ['PATCH', '/api/kitchen-batches/kb-1/stages/ksl-start', { amount: '600', amount_unit: 'g' }],
    ])
  })

  // The walk measured About's Save at 39×44 px. MUTATION: drop the quiet style's minWidth -> red.
  // Amended with the Put-Up UX pass R1 (F27, F16) in the same commit as the change: the Save is 48 px
  // down; across it keeps the 44 px floor it had.
  it('its short Save keeps the 44 px floor across, and is 48 px down', () => {
    renderDetail({ batch: SAVED, inputs: PETRI })
    fireEvent.click(screen.getByTestId('jar-heat-summary'))
    expect(screen.getByTestId('jar-about-save').style.minWidth).toBe('44px')
    expect(screen.getByTestId('jar-about-save').style.minHeight).toBe('48px')
  })

  // Amended with the Put-Up UX pass R1 (D2) in the same commit as the change: this batch has lines, so its
  // add row is behind "+ Add what went in" and is opened FIRST — before Jar & heat — so that what closes
  // the panel below is still the typing, as it was.
  it('closes again when a line add starts (it is never left open over the add row)', () => {
    renderDetail({ batch: SAVED, inputs: PETRI })
    fireEvent.click(screen.getByTestId('line-add-open'))
    fireEvent.click(screen.getByTestId('jar-heat-summary'))
    expect(screen.getByTestId('jar-heat-panel')).toBeTruthy()
    fireEvent.change(screen.getByTestId('line-add-name'), { target: { value: 'x' } })
    expect(screen.queryByTestId('jar-heat-panel')).toBeNull()
  })
})

describe('the heat sheet — the server works it out; never 0 from absence', () => {
  const FIGURE = { low: 949, high: 3036, denominator_g: 448, denominator_source: 'lines', breakdown: [
    { line_id: 'a', label: 'jalapeño', grams: 170, form: 'fresh', factor_low: 1, factor_high: 1, rating_low: 2500, rating_high: 8000, rating_source: 'variety' },
    { line_id: 'b', label: 'reaper', grams: 8, form: 'dried', factor_low: 7, factor_high: 10, rating_low: 1400000, rating_high: 2200000, rating_source: 'typed' },
  ], not_counted: [{ line_id: 'c', label: 'garlic' }, { line_id: 'd', label: 'Water' }] }

  async function openSheet(answer) {
    wire((p) => (String(p).includes('/shu-estimate') && !String(p).endsWith('/save') ? Promise.resolve(answer) : null))
    renderDetail({ inputs: PETRI })
    fireEvent.click(screen.getByTestId('jar-heat-summary'))
    await act(async () => { fireEvent.click(screen.getByTestId('jar-heat-work-it-out')) })
    await waitFor(() => expect(screen.queryByText('Working it out…')).toBeNull())
  }

  it('shows the figure as est., the breakdown in words (dried counted 7–10×), what was not counted, and saves', async () => {
    await openSheet(FIGURE)
    expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches/kb-1/shu-estimate?scope=batch')
    expect(screen.getByTestId('shu-figure').textContent).toBe('est. 950–3.0k SHU')
    expect(within(screen.getByTestId('shu-breakdown')).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      'jalapeño · 170 g · fresh · 2,500–8,000 SHU from the variety',
      'reaper · 8 g · dried · 1,400,000–2,200,000 SHU as typed · counted 7–10× as dried',
    ])
    expect(screen.getByTestId('shu-dominant').textContent).toBe('Most of the heat: reaper')
    expect(screen.getByTestId('shu-not-counted').textContent).toBe('not counted: garlic, Water')
    await act(async () => { fireEvent.click(screen.getByTestId('shu-save')) })
    expect(writes()).toEqual([['POST', '/api/kitchen-batches/kb-1/shu-estimate/save', { scope: 'batch' }]])
  })

  // HS-B1 / FS-I6. MUTATION: render a refusal as "est. 0 SHU" -> the digit arm reds.
  it('"can\'t work it out" names each line and why, offers Type it, and never shows a figure', async () => {
    await openSheet({ refusal: 'cannot_work_it_out', missing: [{ line_id: 'g', label: 'gochugaru', why: 'no_rating' }], not_counted: [] })
    expect(screen.getByTestId('shu-refusal').textContent).toBe('Can’t work it out: gochugaru — no listed heat')
    expect(screen.queryByTestId('shu-figure')).toBeNull()
    expect(screen.queryByTestId('shu-save')).toBeNull()
    expect(screen.getByTestId('shu-sheet').textContent).not.toMatch(/\b0 SHU\b|est\. 0/)
    fireEvent.click(screen.getByTestId('shu-type-it'))
    fireEvent.change(screen.getByTestId('shu-typed'), { target: { value: '16000–23000' } })
    await act(async () => { fireEvent.click(screen.getByTestId('shu-typed-save')) })
    expect(writes()).toEqual([['PUT', '/api/kitchen-batches/kb-1', { shu_est_low: 16000, shu_est_high: 23000 }]])
  })

  it('the refusal words, one per case', () => {
    expect(refusalWords({ refusal: 'no_heat_lines' })).toBe('Nothing with a listed heat — type it.')
    expect(refusalWords({ refusal: 'cannot_work_it_out', missing: [{ label: 'onion', why: 'no_weight' }, { label: 'onion', why: 'no_rating' }] }))
      .toBe('Can’t work it out: onion — no weight, no listed heat')
    expect(refusalWords({ refusal: 'row_net_unknown' })).toBe('Can’t work it out: how much is in these bottles.')
    expect(refusalWords({ low: 1 })).toBeNull()
    expect(dominantLine([])).toBeNull()
  })

  // What the weight it divided by IS. A jar with no additions of its own is the sitting's figure, so its
  // weight is the sitting's Made too (the walks: Petri's jar read "over 256 g." with nothing after it).
  // MUTATION: drop the 'sitting' words -> the first arm reds; drop 'row' -> the second.
  it('says what it divided by: made, for a plain jar too; the bottles, for a row with its own additions', async () => {
    await openSheet({ ...FIGURE, denominator_g: 256, denominator_source: 'sitting' })
    expect(screen.getByTestId('shu-sheet').textContent).toContain('over 256 g made.')
  })
  it('…and a row with its own additions is over what is in those bottles', async () => {
    await openSheet({ ...FIGURE, denominator_g: 473, denominator_source: 'row' })
    expect(screen.getByTestId('shu-sheet').textContent).toContain('over 473 g in these bottles.')
  })

  it('the heat sheet requires nothing', async () => {
    await openSheet(FIGURE)
    expect(screen.getByTestId('shu-sheet').querySelectorAll('[aria-required="true"]')).toHaveLength(0)
  })
})
