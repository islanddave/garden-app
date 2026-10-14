// V5-TODAYREDESIGN-001 finish plan §3.3 (Dave's D15, 2026-10-14 "Fold into Protect") — where the redesigned Today
// says tonight's frost / cold words (src/lib/todayV2/alerts.js), Protect's summary carrying the reason instead of
// the low (protect.js protectSummary), and the frost line's halves the page prints without the low
// (frostAlertLine.js buildFrostAlertLines `parts`).
import { describe, it, expect } from 'vitest'
import { cueFolds, pickLinkText, frostLineText, frostTonight, frostPlacement, PICK_DEFAULT } from '../lib/todayV2/alerts.js'
import { protectSummary } from '../lib/todayV2/protect.js'
import { buildFrostAlertLines } from '../lib/frostAlertLine.js'

const PICK = { icon: 'cold', text: 'Cold night (42°F) — pick coloring peppers & tomatoes' }
const COOL_PICK = { icon: 'cool', text: 'Cool night (47°F) — pick coloring peppers & tomatoes' }
const COVER = { icon: 'freeze', text: 'Freeze tonight (35°F) — cover or bring peppers & tomatoes in' }
const SPRING = { icon: 'cold', text: 'Cold night (42°F) — protect flowering peppers/tomatoes' }
const HEAT = { icon: 'heat', text: 'Hot day (91°F) — deep-water thirsty crops, shade if wilting' }

// busyfull's frost watch (tests/harness/_todaymeasure/busyfull-grafts.json), and a later night's advisory.
const WATCH = { at: '2026-09-23T18:00:25.841Z', run: 'intraday-pm', date: '2026-09-24', lowF: 41.8, tier: 'advisory', trip: 'radiative', dayOffset: 0, nightOffset: 0 }
const LATER = { at: '2026-09-23T18:00:25.841Z', run: 'intraday-pm', date: '2026-09-26', lowF: 34, tier: 'advisory', dayOffset: 2, nightOffset: 1 }

describe('the cue folds into Protect only when Protect is on the page, and only a cold-side cue', () => {
  it('cold / cool / freeze fold under a Protect section; never without one', () => {
    for (const c of [PICK, COOL_PICK, COVER, SPRING]) {
      expect(cueFolds(c, true), c.text).toBe(true)
      expect(cueFolds(c, false), c.text).toBe(false)
    }
  })
  it('heat, rain and wet never fold — Protect has nothing to say about them', () => {
    expect(cueFolds(HEAT, true)).toBe(false)
    expect(cueFolds({ icon: 'rain', text: '0.58" rain tomorrow (100% chance) — skip watering' }, true)).toBe(false)
    expect(cueFolds(null, true)).toBe(false)
  })
})

describe('the pick link carries a pick cue\'s words', () => {
  it('"Pick coloring peppers & tomatoes first — log a harvest ›" from the fall cold / cool cue', () => {
    expect(pickLinkText(PICK)).toBe('Pick coloring peppers & tomatoes first — log a harvest ›')
    expect(pickLinkText(COOL_PICK)).toBe('Pick coloring peppers & tomatoes first — log a harvest ›')
  })
  it('a cover cue, a spring cue, a heat cue or none: no words of its own (the link keeps its default)', () => {
    for (const c of [COVER, SPRING, HEAT, null]) expect(pickLinkText(c)).toBeNull()
    expect(PICK_DEFAULT).toBe('Pick what’s ripe first — log a harvest ›')
  })
})

describe('the frost lines, placed', () => {
  const lines = (alerts, lowShown) => buildFrostAlertLines(alerts, { lowShown, parts: true })
  it('`parts` adds the halves and changes nothing else about the line', () => {
    const plain = buildFrostAlertLines([WATCH], { lowShown: 42 })
    const withParts = lines([WATCH], 42)
    expect(withParts[0].text).toBe(plain[0].text)
    expect(withParts[0]).toEqual({ ...plain[0], lead: 'Frost watch tonight — clear and calm', tail: 'Plan cover for tender plants.' })
    expect(Object.keys(plain[0])).not.toContain('lead')
  })
  it('tonight\'s line prints without the low (the card states it); a later night keeps its own', () => {
    const [tonight, later] = lines([WATCH, LATER], 42)
    expect(frostTonight(tonight)).toBe(true)
    expect(frostLineText(tonight, { short: true })).toBe('Frost watch tonight — clear and calm.')
    expect(frostLineText(tonight)).toBe('Frost watch tonight — clear and calm. Plan cover for tender plants.')
    expect(frostTonight(later)).toBe(false)
    expect(frostLineText(later)).toBe(later.text)
    expect(later.text).toMatch(/low 34°F/)
  })
  it('a non-radiative advisory naming tonight: "Frost possible tonight."', () => {
    const { trip, ...adv } = WATCH // eslint-disable-line no-unused-vars
    expect(frostLineText(lines([adv], 42)[0], { short: true })).toBe('Frost possible tonight.')
  })
  it('a Protect section takes every line behind Details; without one the first stays under the card', () => {
    const ls = lines([WATCH, LATER], 42)
    expect(frostPlacement(ls, { protectShown: true })).toEqual({ under: null, details: ls })
    expect(frostPlacement(ls, { protectShown: false })).toEqual({ under: ls[0], details: [ls[1]] })
    expect(frostPlacement([], { protectShown: false })).toEqual({ under: null, details: [] })
  })
})

describe('protectSummary — timing and reason open, timing and names closed; never the low (D15)', () => {
  const rows = [50, 50, 50, 50, 50].map((t, i) => ({ name: ['Lemon Verbena', 'Sweet Basil', 'Lantana', 'Begonia', 'Spider Plant'][i], threshold: t }))
  it('open, frost night: "Before dark · tender below 50°"', () => {
    expect(protectSummary({ tier: 'frost', rows, open: true })).toBe('Before dark · tender below 50°')
  })
  it('closed: the timing and the first two names', () => {
    expect(protectSummary({ tier: 'frost', rows })).toBe('Before dark · Lemon Verbena, Sweet Basil +3')
    expect(protectSummary({ tier: 'chill', rows: rows.slice(0, 2) })).toBe('Tonight · Lemon Verbena, Sweet Basil')
  })
  it('thresholds that differ read as a range; cover rows with none add nothing; a hard freeze says so', () => {
    expect(protectSummary({ tier: 'chill', rows: [{ threshold: 50 }, { threshold: 45 }, { threshold: null }], open: true })).toBe('Tonight · tender below 45–50°')
    expect(protectSummary({ tier: 'hardfreeze', rows: [{ threshold: null }], open: true })).toBe('Before dark · hard freeze')
  })
  it('no low figure anywhere in it', () => {
    for (const open of [true, false]) expect(protectSummary({ tier: 'frost', lowF: 42, rows, open })).not.toMatch(/42|\blow\b/)
  })
})
