// V4-HARVGRAIN-001 — the variety/planting weight grain and the honesty machinery around it, on the
// Harvests Totals surface.
//
// The Lambda-side guard (lambda/harvests/harvest-weight-grain.test.js) proves the numbers merge onto
// the right rows. These prove the page renders them, and — the part that is easy to lose — that the
// new WEIGHT-DESCENDING order never arrives without a visible basis. Estimated grams are a flat
// per-variety constant (Cherry Falls resolves to 6.04 g/unit on every one of its 36 live rows,
// min = max), so an all-≈ ranking is the pick count rescaled; shipped bare it would read as a yield
// finding it cannot support.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { fetchSpy, searchParamsRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), searchParamsRef: { current: new URLSearchParams() },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useSearchParams: () => [searchParamsRef.current, () => {}],
}))

import Harvests from '../pages/Harvests.jsx'

beforeEach(() => { fetchSpy.mockReset(); searchParamsRef.current = new URLSearchParams() })

const w = (o) => ({ grams: 0, measured_grams: 0, estimated_grams: 0, measured: 0, estimated: 0, unweighed: 0, ...o })

// The live tomato shape: the server has already ordered varieties by grams, so Moskvich (mostly
// weighed, 8.2 kg over 27 picks) leads Cherry Falls (all modelled, 763 g over 36 picks) even though
// Cherry Falls has more picks and sorts first alphabetically.
const MOSKVICH = w({ grams: 8233, measured_grams: 8200, estimated_grams: 33, measured: 26, estimated: 1 })
const CHERRY_FALLS = w({ grams: 763, estimated_grams: 763, estimated: 36 })

const TOMATO = {
  crop_type_slug: 'tomato', crop_name: 'Tomato', unquantified: 0,
  units: [{ unit: 'count', unit_key: 'count', total: 193, count: 63 }],
  weight: w({ grams: 27712, measured_grams: 13200, estimated_grams: 14512, measured: 142, estimated: 125 }),
  varieties: [
    { variety_id: 'v-moskvich', variety_name: 'Moskvich Heirloom', unquantified: 0, units: [{ unit: 'count', unit_key: 'count', total: 65, count: 27 }], weight: MOSKVICH },
    { variety_id: 'v-cherryfalls', variety_name: 'Cherry Falls', unquantified: 0, units: [{ unit: 'count', unit_key: 'count', total: 128, count: 36 }], weight: CHERRY_FALLS },
  ],
}

async function renderTotals(aggregatesOverride = {}) {
  const aggregates = {
    crops: [TOMATO], other: [], first_pick: [],
    weight: w({ grams: 93301, measured_grams: 44856, estimated_grams: 48445, measured: 313, estimated: 367 }),
    ...aggregatesOverride,
  }
  fetchSpy.mockImplementation((url) => Promise.resolve(
    String(url).includes('timeframe=7d')
      ? { aggregates: { crops: [], other: [] } }
      : { entries: [], aggregates, cursor: null },
  ))
  render(<Harvests />)
  await waitFor(() => expect(screen.getByText('Totals')).toBeTruthy())
  fireEvent.click(screen.getByText('Totals'))
  fireEvent.click(await screen.findByText('Tomato'))
  return aggregates
}

// Provenance is a property of a VARIETY, not of a row position. These originally read
// `[top, second]` off the rendered array, which silently coupled a provenance assertion to the
// ordering decision — so making the order a user control broke tests that have nothing to do with
// order. Look each variety up by name instead: now an ordering change cannot make these lie, and a
// provenance regression cannot hide behind a re-sort.
function weightByVariety() {
  const out = {}
  for (const n of screen.getAllByTestId('variety-weight')) {
    out[n.parentElement.parentElement.firstChild.textContent] = n.textContent
  }
  return out
}

describe('variety sub-rows carry weight', () => {
  it('renders each variety’s grams with its provenance counts attached', async () => {
    await renderTotals()
    expect(weightByVariety()).toEqual({
      'Moskvich Heirloom': '≈ 8.23 kg · 26 weighed · 1 estimated',
      'Cherry Falls': '≈ 763 g · 36 estimated',
    })
  })

  it('an ALL-MODELLED variety is visibly distinguishable from a mostly-weighed one', async () => {
    // The whole point of the counts riding along: both rows are "a number of grams", and only one
    // of them is a measurement. Same ≈, very different standing.
    await renderTotals()
    const rows = weightByVariety()
    expect(rows['Moskvich Heirloom']).toContain('26 weighed')
    expect(rows['Cherry Falls']).not.toContain('weighed')
    expect(rows['Cherry Falls']).toContain('36 estimated')
  })

  // CONTRACT CHANGED — V4-HARVSORTCTRL-001. v4.32.0 shipped weight-desc as the ONLY order, which
  // fixed the misleading ranking and broke retrieval: you cannot scan a ranked list for a known
  // variety. Dave: "having it weighted first and only is not all that useful when I'm trying to find
  // specific items - alphanumeric is better sort for that and the default I want." Ordering is now a
  // control and NAME is the default, so the default render is alphabetical. The weight ranking is
  // still one tap away and still correct — see harvestSort.test.js for the ranking itself.
  it('defaults to ALPHABETICAL, not heaviest-first — the retrieval case', async () => {
    await renderTotals()
    const names = screen.getAllByTestId('variety-weight')
      .map((n) => n.parentElement.parentElement.firstChild.textContent)
    expect(names).toEqual(['Cherry Falls', 'Moskvich Heirloom'])
  })

  it('names the ACTIVE sort key, so a re-ordered list is not read as a broken alphabetical one', async () => {
    await renderTotals()
    // Was a hardcoded "By weight". Once ordering became a control that string was a latent lie: it
    // would keep claiming weight while the rows sat in name order. This is the guard for that.
    expect(screen.getByText('By name · ≈ estimated')).toBeTruthy()
    expect(screen.queryByText('By weight · ≈ estimated')).toBeNull()
  })

  it('claims no ordering when nothing under the crop has a weight', async () => {
    // Then the order IS the name order (the tie-break), and captioning it "by weight" would be false.
    const varieties = TOMATO.varieties.map((v) => ({ ...v, weight: w({ unweighed: 3 }) }))
    await renderTotals({ crops: [{ ...TOMATO, varieties }] })
    expect(screen.queryByText('By weight · ≈ estimated')).toBeNull()
    expect(screen.queryByTestId('variety-weight')).toBeNull()
  })

  it('an older Lambda (no weight key on a variety row) renders the units line and nothing else', async () => {
    // The SPA and the harvests Lambda deploy on separate legs and a rollback must hold. "This API
    // does not compute variety weight" and "nothing under this variety was weighed" are different
    // facts and only the second is safe to render.
    const varieties = TOMATO.varieties.map(({ weight, ...v }) => v) // eslint-disable-line no-unused-vars
    await renderTotals({ crops: [{ ...TOMATO, varieties }] })
    expect(screen.queryByTestId('variety-weight')).toBeNull()
    expect(screen.getByText('Moskvich Heirloom')).toBeTruthy()
  })
})

// V4-HARVCROPTABLE-001 — Dave's own design: "a clean ... table - Planting | Count | Total weight -
// ONE row per planting. Drop all weighed-vs-estimated wording ... show only the total weight, and
// make the weight the visually dominant column." First pick returned as a 4th column on his ruling:
// the block stays a FIRST-PICK table rather than becoming a totals table, and it keeps the page and
// the Totals export saying the same thing.
//
// The provenance drop is scoped to THIS block and nowhere else: the variety sub-rows above still
// carry "≈ 8.23 kg · 26 weighed · 1 estimated" (the describes above pin that), because those rows can
// be ORDERED by grams and a modelled ranking rendered bare reads as a measured finding. A planting
// row is not ranked, and Dave already knows the number is inferred.
const plantingRow = (name) => screen.getByText(name).closest('tr')
const cellsOf = (name) => [...plantingRow(name).cells].map((c) => c.textContent)

// The component year-qualifies a date only when it is NOT the current year, and it reads that year
// off the real clock. A hardcoded '2026-…' fixture would therefore pass this year and start
// rendering "Jul 4, 2026" in January — the dates are built from the clock for that reason.
const CUR_YEAR = new Date().getFullYear()

describe('the per-planting table (V4-HARVCROPTABLE-001)', () => {
  const MOSKVICH_FP = {
    plant_id: 'gn-1', planting_name: 'Moskvich bed', crop_type_slug: 'tomato', first_pick_date: `${CUR_YEAR}-07-04`,
    units: [{ unit: 'count', unit_key: 'count', total: 65, count: 27 }], unquantified: 0, weight: MOSKVICH,
  }

  it('renders Planting | Count | Total weight | First pick, one row per planting, with the live tomato numbers', async () => {
    await renderTotals({
      first_pick: [MOSKVICH_FP, {
        plant_id: 'gn-2', planting_name: 'Cherry Falls bed', crop_type_slug: 'tomato', first_pick_date: `${CUR_YEAR}-07-11`,
        units: [{ unit: 'count', unit_key: 'count', total: 128, count: 36 }], unquantified: 0, weight: CHERRY_FALLS,
      }],
    })
    expect([...screen.getByRole('table').tHead.rows[0].cells].map((c) => c.textContent))
      .toEqual(['Planting', 'Count', 'Total weight', 'First pick'])
    expect(cellsOf('Moskvich bed')).toEqual(['Moskvich bed', '65', '8.23 kg', 'Jul 4'])
    expect(cellsOf('Cherry Falls bed')).toEqual(['Cherry Falls bed', '128', '763 g', 'Jul 11'])
    expect(screen.getByRole('table').tBodies[0].rows.length).toBe(2)
  })

  // The date is rendered by the SAME src/lib helper the Totals export calls, which is what "the
  // export reconciles with the page" rests on. fmtFirstPick appends the year only when it differs
  // from the current one — a prior-season planting must not read as this year's.
  it('renders the first-pick date through fmtFirstPick, year-qualifying a prior season', async () => {
    const priorYear = CUR_YEAR - 2
    await renderTotals({
      first_pick: [{ ...MOSKVICH_FP, first_pick_date: `${priorYear}-07-04` }],
    })
    expect(screen.getByTestId('planting-first-pick').textContent).toBe(`Jul 4, ${priorYear}`)
  })

  it('drops the ≈ and the weighed/estimated counts — the weight only', async () => {
    // Moskvich is 26 weighed + 1 estimated, so the OLD render was ' · ≈ 8.23 kg' and the variety row
    // above it still says so. This cell must be the bare number and nothing else.
    await renderTotals({ first_pick: [MOSKVICH_FP] })
    const cell = screen.getByTestId('planting-weight')
    expect(cell.textContent).toBe('8.23 kg')
    expect(cell.textContent).not.toContain('≈')
    expect(cell.textContent).not.toContain('weighed')
    expect(cell.textContent).not.toContain('estimated')
  })

  it('makes the weight the visually dominant column', async () => {
    await renderTotals({ first_pick: [MOSKVICH_FP] })
    const [nameCell, countCell, weightCell] = plantingRow('Moskvich bed').cells
    expect(weightCell.style.fontWeight).toBe('700')
    expect(parseFloat(weightCell.style.fontSize)).toBeGreaterThan(parseFloat(countCell.style.fontSize))
    expect(parseFloat(weightCell.style.fontSize)).toBeGreaterThan(parseFloat(nameCell.style.fontSize))
  })

  it('carries no borders and scrolls inside its own container, not the page (390px)', async () => {
    await renderTotals({ first_pick: [MOSKVICH_FP] })
    const table = screen.getByRole('table')
    // jsdom DISCARDS `border: none` (it serializes to an empty cssText), so asserting the declared
    // value would pass on any markup at all. Assert the falsifiable thing instead: nothing in the
    // table declares a border rule. jsdom does keep real values — a `1px solid` added to the table
    // or any cell serializes into cssText and turns this red.
    const declared = [table, ...table.querySelectorAll('th,td')]
      .flatMap((el) => el.style.cssText.split(';').map((d) => d.trim()).filter(Boolean))
      .filter((d) => d.startsWith('border') && !d.startsWith('border-collapse'))
    expect(declared).toEqual([])
    // A 390px Chrome/Android viewport: the name cell wraps at any character and the number cells are
    // nowrap, so nothing forces the PAGE sideways; the wrapper is the backstop if it ever did.
    expect(table.parentElement.style.overflowX).toBe('auto')
    const cells = plantingRow('Moskvich bed').cells
    expect(cells[0].style.overflowWrap).toBe('anywhere')
    // All THREE trailing columns must be nowrap, not just the two — a wrapping 4th column is what
    // would push the min-content width past the viewport at 390px.
    expect([cells[1], cells[2], cells[3]].map((c) => c.style.whiteSpace)).toEqual(['nowrap', 'nowrap', 'nowrap'])
  })

  it('dashes a planting with no derivable weight rather than printing a zero', async () => {
    await renderTotals({
      first_pick: [{
        plant_id: 'gn-3', planting_name: 'Volunteer', crop_type_slug: 'tomato', first_pick_date: `${CUR_YEAR}-07-04`,
        units: [], unquantified: 2, weight: w({ unweighed: 2 }),
      }],
    })
    expect(cellsOf('Volunteer')).toEqual(['Volunteer', '—', '—', 'Jul 4'])
  })

  it('an older Lambda (no units key on a first_pick row) dashes the count, not a zero', async () => {
    // The SPA and the harvests Lambda deploy on separate legs and a rollback must hold: "this API
    // does not compute planting counts" must not render as "this planting produced 0".
    await renderTotals({
      first_pick: [{ plant_id: 'gn-1', planting_name: 'Moskvich bed', crop_type_slug: 'tomato', first_pick_date: `${CUR_YEAR}-07-04`, weight: MOSKVICH }],
    })
    expect(cellsOf('Moskvich bed')).toEqual(['Moskvich bed', '—', '8.23 kg', 'Jul 4'])
  })

  // A 1.5 under a header that says "Count" is a lie. Dave's ruling: a mass unit gets the same dash a
  // no-data row gets, so the column always means one thing; the poundage is already one column over.
  describe('Count holds only countable units', () => {
    const beans = (unit, total) => ({
      plant_id: 'gn-4', planting_name: 'Bush beans row', crop_type_slug: 'tomato', first_pick_date: `${CUR_YEAR}-07-04`,
      units: [{ unit, unit_key: unit, total, count: 3 }], unquantified: 0,
      weight: w({ grams: 680, measured_grams: 680, measured: 3 }),
    })

    it('dashes a WEIGHT-unit planting — and the same row still shows its weight', async () => {
      await renderTotals({ first_pick: [beans('lb', 1.5)] })
      expect(cellsOf('Bush beans row')).toEqual(['Bush beans row', '—', '680 g', 'Jul 4'])
      expect(screen.getByTestId('planting-count').textContent).not.toContain('lb')
    })

    // isMassUnit's whole class — a per-unit special case for lb would leave the others lying.
    it.each(['g', 'kg', 'lb', 'oz'])('dashes the %s unit, not just lb', async (u) => {
      await renderTotals({ first_pick: [beans(u, 2)] })
      expect(screen.getByTestId('planting-count').textContent).toBe('—')
    })

    it('still shows the NUMBER for countable units — the reconciliation case', async () => {
      // The reason Count is quantity-not-picks in the first place: 65 fruit -> 8.23 kg reconciles.
      await renderTotals({ first_pick: [MOSKVICH_FP] })
      expect(screen.getByTestId('planting-count').textContent).toBe('65')
    })

    // NOT collateral damage of the dash rule: blueberries are logged in cups, and dashing them would
    // empty the column for a crop this surface exists to summarise. harvestSummary calls these
    // "discrete or volumetric" and keeps them out of the mass class for exactly this reason.
    it.each([['cup', '4 cups'], ['bunch', '4 bunches'], ['head', '4 heads']])(
      '%s is countable and keeps its total', async (u, expected) => {
        await renderTotals({ first_pick: [beans(u, 4)] })
        expect(screen.getByTestId('planting-count').textContent).toBe(expected)
      })

    it('a MIXED-unit planting keeps the countable part and drops only the mass part', async () => {
      await renderTotals({
        first_pick: [{
          ...beans('lb', 1.5),
          units: [{ unit: 'count', unit_key: 'count', total: 12, count: 4 }, { unit: 'lb', unit_key: 'lb', total: 1.5, count: 3 }],
        }],
      })
      expect(screen.getByTestId('planting-count').textContent).toBe('12')
    })
  })
})

describe('B4 — the measured share of the season total', () => {
  it('states the share of the POUNDAGE that is modelled, not just the row counts', async () => {
    // The counts line reads "313 weighed · 367 estimated", which scans as mostly-weighed. 52% of
    // the grams are not, because the weighed rows skew small. Both must be visible.
    await renderTotals()
    expect(screen.getByTestId('totals-weight-basis').textContent).toBe('313 weighed · 367 estimated')
    expect(screen.getByTestId('totals-weight-modelled').textContent).toBe('52% of this weight is estimated, not weighed')
  })

  it('an all-measured total carries no caveat', async () => {
    await renderTotals({ weight: w({ grams: 1420, measured_grams: 1420, measured: 4 }) })
    expect(screen.queryByTestId('totals-weight-modelled')).toBeNull()
  })

  it('an all-estimated total says 100%, not nothing', async () => {
    await renderTotals({ weight: w({ grams: 900, estimated_grams: 900, estimated: 5 }) })
    expect(screen.getByTestId('totals-weight-modelled').textContent).toBe('100% of this weight is estimated, not weighed')
  })
})
