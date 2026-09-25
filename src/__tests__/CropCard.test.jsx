// V4-PLANTINGUI-001 — CropCard: maturity band + cultivar attrs (projected chips inert w/o tags API).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
// V4-RIPENESSCUES-001: CropCard lazy-loads the colour-window resolver in an effect — stub it to
// the sync no-window resolver so nothing async mutates state mid-test (no act() churn; absence
// assertions race-free). Window rendering is covered in CropCard.window*.test.jsx.
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import CropCard from '../components/planting/CropCard.jsx'

beforeEach(() => { apiFetchSpy.mockReset(); apiFetchSpy.mockResolvedValue(null) })

describe('CropCard', () => {
  it('renders nothing when there is no maturity, no chips, and no attrs', () => {
    const { container } = render(<CropCard planting={{ id: 'p', variety_ref: null }} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the age band and a harvest window when dates + DTM exist', () => {
    const planting = {
      id: 'p', sown_at: '2026-03-01', transplanted_at: '2026-04-01',
      variety_ref: { days_to_maturity_min: 60, days_to_maturity_max: 75, sun_requirements: 'Full sun' },
    }
    render(<CropCard planting={planting} />)
    expect(screen.getByText(/^Day \d+/)).toBeTruthy()
    expect(screen.getByText('Full sun')).toBeTruthy()
    expect(screen.getByText('Sun')).toBeTruthy()
    expect(screen.getByText('60–75 days')).toBeTruthy()
  })

  // V4-MATURITYBASIS-001 Slice A
  it('names the basis when the window was anchored on the transplant date', () => {
    const planting = {
      id: 'p', sown_at: '2026-04-20', transplanted_at: '2026-06-23',
      variety_ref: { days_to_maturity_min: 70, days_to_maturity_max: 80, dtm_basis: 'from-transplant' },
    }
    render(<CropCard planting={planting} />)
    expect(screen.getByText('(from transplant)')).toBeTruthy()
  })

  it('does not name a basis when the crop type is uncurated (NULL)', () => {
    const planting = {
      id: 'p', sown_at: '2026-04-20', transplanted_at: '2026-06-23',
      variety_ref: { days_to_maturity_min: 70, days_to_maturity_max: 80, dtm_basis: null },
    }
    render(<CropCard planting={planting} />)
    expect(screen.queryByText(/\(from /)).toBeNull()
  })

  // D3 + the "add transplant date" affordance: the suppressed window slot is no longer a dead
  // static label — it carries the tappable prompt that fills the missing date.
  it('D3: the suppressed window slot renders the add-transplant-date prompt', () => {
    const planting = {
      id: 'p', sown_at: '2026-04-20',
      variety_ref: { days_to_maturity_min: 70, days_to_maturity_max: 80, dtm_basis: 'from-transplant' },
    }
    render(<CropCard planting={planting} />)
    expect(screen.getByTestId('add-transplant-date')).toBeTruthy()
    expect(screen.getByText('add transplant date')).toBeTruthy()
    // No fabricated date, and no basis parenthetical on a window that does not exist.
    expect(screen.queryByText(/Est\. harvest [A-Z]/)).toBeNull()
    expect(screen.queryByText(/\(from /)).toBeNull()
  })

  it('does NOT render the prompt once a transplant date exists', () => {
    const planting = {
      id: 'p', sown_at: '2026-04-20', transplanted_at: '2026-06-23',
      variety_ref: { days_to_maturity_min: 70, days_to_maturity_max: 80, dtm_basis: 'from-transplant' },
    }
    render(<CropCard planting={planting} />)
    expect(screen.queryByTestId('add-transplant-date')).toBeNull()
  })

  it('does NOT render the prompt for a from-sow crop missing a transplant date', () => {
    const planting = {
      id: 'p', sown_at: '2026-04-20',
      variety_ref: { days_to_maturity_min: 70, days_to_maturity_max: 80, dtm_basis: 'from-sow' },
    }
    render(<CropCard planting={planting} />)
    expect(screen.queryByTestId('add-transplant-date')).toBeNull()
  })
})

// ── V4-RIPECUE-001 — researched ripeness cues on the card ─────────────────────────────────────
// The crucible killed the maturity-window section (11.8% calibration) and put the cues here
// instead, for reach: 100% of plantings vs 6%. These tests pin the two behaviours that make that
// trade honest — a sourced cue reaches the card even on a bare record, and an unsourced crop
// renders NOTHING rather than a guess.
describe('CropCard — ripeness cues (V4-RIPECUE-001)', () => {
  it('renders the crop-level mechanic for a sourced crop', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'tomato', name: 'Big Boy' } }} />)
    expect(screen.getByText(/When it.s ripe/i)).toBeTruthy()
    expect(screen.getByText(/90% of its ripe colour/i)).toBeTruthy()
  })

  it('leads with the cultivar target-state when one exists, and keeps the mechanic under it', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'pepper', name: 'Pick-N-Pop Yellow' } }} />)
    expect(screen.getByText(/bright canary yellow/i)).toBeTruthy()
    expect(screen.getByText(/full size while firm/i)).toBeTruthy()
  })

  it('renders NOTHING for a crop with no sourced cue — a blank is the correct outcome', () => {
    const { container } = render(
      <CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'fittonia', name: 'Nerve Plant' } }} />,
    )
    // No cue, no maturity, no chips, no attrs -> the whole card stays away.
    expect(container.firstChild).toBeNull()
  })

  it('a sourced cue alone is enough to render the card on an otherwise bare cultivar record', () => {
    // Without this the cue would be silently dropped from exactly the sparsest records.
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'pepper', name: 'No Such Cultivar' } }} />)
    expect(screen.getByText(/When it.s ripe/i)).toBeTruthy()
  })

  it('attributes the cue to a checkable source — the verifiability half of the downgrade path', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'tomato', name: 'Big Boy' } }} />)
    const link = screen.getByRole('link', { name: /Extension/i })
    expect(link.getAttribute('href')).toMatch(/^https:\/\//)
    expect(link.getAttribute('rel')).toContain('noopener')
  })
})

// Batch-2 crop mechanics + the low-confidence caveat channel.
describe('CropCard — crop-mechanic breadth and derived-cue honesty (V4-RIPECUE-001)', () => {
  it('renders the crop mechanic for a non-pepper/tomato crop', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'garlic', name: 'Music' } }} />)
    expect(screen.getByText(/lower leaves have browned/i)).toBeTruthy()
  })

  it('summer squash gets the pierces-easily half, not the winter-squash half', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'squash', name: 'Dark Green Zucchini' } }} />)
    expect(screen.getByText(/should pierce easily/i)).toBeTruthy()
    expect(screen.queryByText(/cured for storage/i)).toBeNull()
  })

  it('shows the caveat on the derived wineberry cue, so it cannot pass as a quoted instruction', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'wineberry', name: 'Wild Wineberry' } }} />)
    expect(screen.getByText(/bristly calyx/i)).toBeTruthy()
    expect(screen.getByText(/neither source gives an actual harvest instruction/i)).toBeTruthy()
  })

  it('a high-confidence cue renders no caveat line', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'broccoli', name: 'Calabrese' } }} />)
    expect(screen.queryByText(/Derived from/i)).toBeNull()
  })
})

// V5-SEEDCARDS-001 / v5-scovillesource-001 — the SHU chip as it actually paints. CropCard hands the
// whole variety_ref to shuLabel, so scoville_source reaches the label with no card-side plumbing;
// these pin that handoff end to end (the formatter's own cases live in varietySpec.test.js).
describe('CropCard — SHU chip labels an estimate (V5-SEEDCARDS-001)', () => {
  const pepper = (source) => ({
    id: 'p',
    variety_ref: {
      name: 'Habanero', crop_type_slug: 'pepper', scoville_min: 100000, scoville_max: 350000,
      ...(source === undefined ? {} : { scoville_source: source }),
    },
  })

  it("an 'inference' figure paints as est. … SHU", () => {
    render(<CropCard planting={pepper('inference')} />)
    expect(screen.getByText('est. 100K–350K SHU')).toBeTruthy()
    expect(screen.queryByText('100K–350K SHU')).toBeNull()
  })

  it('a vendor figure, and a figure with no source at all, paint exactly as before', () => {
    for (const source of ['vendor_catalog', null, undefined]) {
      const { unmount } = render(<CropCard planting={pepper(source)} />)
      expect(screen.getByText('100K–350K SHU')).toBeTruthy()
      expect(screen.queryByText(/^est\. /)).toBeNull()
      unmount()
    }
  })
})

// The determinacy pill (the V4-VARSLUG-001 spec chip) as it actually paints. Until 2026-09-25 this card
// printed a bean's whole growth_habit as a three-line dark-green pill (146 live non-tomato cards on
// prod). Prose below is live prod growth_habit; the formatter's own cases live in varietySpec.test.js.
describe('CropCard — the determinacy pill is a determinacy word or absent', () => {
  // Spec chips are CropCard's own 999px pills; the facet TagChip row is inert here (no tags API).
  const pills = container => [...container.querySelectorAll('span')].filter(s => s.style.borderRadius === '999px')
  const card = variety_ref => render(<CropCard planting={{ id: 'p', variety_ref }} />)

  it('a bean with a long growth_habit gets no pill, and the rest of the card still paints', () => {
    const { container } = card({
      name: 'Contender', crop_type_slug: 'bean', days_to_maturity_min: 50, days_to_maturity_max: 50,
      growth_habit: 'Compact bush plant ~18-24 in tall, self-supporting; heavy sets of round, meaty, medium-green stringless snap pods ~6 in long. Early and heat-tolerant.',
    })
    expect(screen.getByText('50 days')).toBeTruthy() // the card rendered, so "no pill" below is not vacuous
    expect(pills(container)).toEqual([])
    expect(screen.queryByText(/Compact bush plant/i)).toBeNull()
  })

  it('a pepper whose prose says semi-vining gets no Semi-determinate pill', () => {
    const { container } = card({
      name: 'Sugar Rush Peach', crop_type_slug: 'pepper', days_to_maturity_min: 90, days_to_maturity_max: 90,
      growth_habit: 'vigorous bushy semi-vining, 4-5 ft tall; pendant elongated 3 in peachy-orange pods; prolific branching habit',
    })
    expect(screen.getByText('90 days')).toBeTruthy()
    expect(pills(container)).toEqual([])
    expect(screen.queryByText('Semi-determinate')).toBeNull()
  })

  it('a tomato whose prose says indeterminate keeps its Indeterminate pill', () => {
    const { container } = card({
      name: '1884', crop_type_slug: 'tomato', days_to_maturity_min: 78, days_to_maturity_max: 85,
      growth_habit: 'indeterminate vine; 5-7 ft; stake or cage required',
    })
    expect(pills(container).map(s => s.textContent)).toEqual(['Indeterminate'])
  })

  it('Rosso Sicilian reads its leading term, not the hedge in brackets', () => {
    const { container } = card({
      name: 'Rosa Sicilian', crop_type_slug: 'tomato',
      growth_habit: 'indeterminate vine (semi-determinate per some sources); deeply ribbed costoluto-type; 5-6 ft; stake or cage required',
    })
    expect(pills(container).map(s => s.textContent)).toEqual(['Indeterminate'])
  })

  it('a pepper keeps its SHU pill alone when its prose names no determinacy', () => {
    const { container } = card({
      name: 'Habanero', crop_type_slug: 'pepper', scoville_min: 100000, scoville_max: 350000,
      growth_habit: 'sturdy productive bushy, 2-3 ft tall; massive blocky 4-lobed fruit 4-6 in wide and long, thick-walled; may need staking',
    })
    expect(pills(container).map(s => s.textContent)).toEqual(['100K–350K SHU'])
  })
})

// The Sun row as it paints on prod data. The column holds a code; until 2026-09-25 this row printed it
// ('full_sun') on 205 of 244 live plantings. The 'Full sun' fixture at the top of this file is a shape
// the plant_varieties CHECK can never produce, which is how the raw code stayed green.
describe('CropCard — the Sun row reads as words, never the stored code', () => {
  const card = variety_ref => render(<CropCard planting={{ id: 'p', variety_ref }} />)
  // Attr is <div><div>{label}</div><div>{value}</div></div>
  const sunRow = () => screen.getByText('Sun').parentElement

  it.each([
    ['full_sun', 'Full sun'], ['part_sun', 'Part sun'], ['part_shade', 'Part shade'], ['full_shade', 'Full shade'],
  ])('%s paints as %s', (code, words) => {
    const { container } = card({
      name: 'Contender', crop_type_slug: 'bean', days_to_maturity_min: 50, days_to_maturity_max: 50, sun_requirements: code,
    })
    expect(sunRow().textContent).toBe(`Sun${words}`)
    expect(container.textContent).not.toContain(code)
  })

  it('no sun value keeps the old behaviour: no Sun row, and the rest of the card still paints', () => {
    card({ name: 'Contender', crop_type_slug: 'bean', days_to_maturity_min: 50, days_to_maturity_max: 50, sun_requirements: null })
    expect(screen.getByText('50 days')).toBeTruthy()
    expect(screen.queryByText('Sun')).toBeNull()
  })

  it('a sun code alone still earns the card (a coleus: no dates, no DTM, no chips)', () => {
    const { container } = card({ name: 'Fairway Orange', crop_type_slug: 'coleus', sun_requirements: 'part_shade' })
    expect(container.firstChild).not.toBeNull()
    expect(sunRow().textContent).toBe('SunPart shade')
  })
})

// V4-MATURITYREPEAT-001 (BD-024) — the maturity band as it actually paints for the row this item
// was filed against. computeMaturity() is called with no `today` here, so the clock is pinned:
// only `Date` is faked, leaving testing-library's own timers alone.
describe('CropCard — continuous-harvest window (V4-MATURITYREPEAT-001)', () => {
  // Live prod 2026-08-16: Armageddon F1 pepper, transplanted 2026-05-23, DTM 75-95 from-transplant,
  // crop_types.pepper harvest_habit=repeat. Its window "closed" while it was fruiting — on Aug 12
  // at the 0.70 factor the defect was filed under, on Aug 16 after the V4-DROPCALIB-001 re-fit to
  // 0.75 the same day. Dates below track the shipped factor; the defect is the same either way.
  const armageddon = (habit) => ({
    id: 'p', name: 'Armageddon', transplanted_at: '2026-05-23',
    variety_ref: {
      name: 'Armageddon F1', crop_type_slug: 'pepper',
      days_to_maturity_min: 75, days_to_maturity_max: 95,
      dtm_basis: 'from-transplant', harvest_habit: habit,
    },
  })

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-08-16T12:00:00')) })
  afterEach(() => { vi.useRealTimers() })

  it('paints an open-ended window on the repeat-habit pepper', () => {
    render(<CropCard planting={armageddon('repeat')} />)
    expect(screen.getByText(/Harvest window open — picking from Jul 4, 2026/)).toBeTruthy()
    expect(screen.queryByText(/through Aug 16/)).toBeNull()
    // the rest of the band is untouched
    expect(screen.getByText(/^Day 85 since transplanted$/)).toBeTruthy()
    expect(screen.getByText('(from transplant)')).toBeTruthy()
  })

  it('still paints the closing date on a single-habit crop', () => {
    render(<CropCard planting={armageddon('single')} />)
    expect(screen.getByText(/Harvest window open — through Aug 16, 2026/)).toBeTruthy()
  })
})
