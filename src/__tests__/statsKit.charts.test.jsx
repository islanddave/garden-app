/**
 * stats-kit chart geometry. Each chart exports a pure layout(section) and draws only what it returns,
 * so the scales are proved here directly: the stated domain endpoints land on the stated range ends,
 * and no mark (from the fixture, from an empty section, or from junk values) carries NaN / Infinity
 * into an SVG attribute.
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { linear, logShu, niceMax, ticks, W } from '../lib/stats-kit/charts/geom.js'
import { layoutRibbon } from '../lib/stats-kit/charts/RibbonChart.jsx'
import { layoutWeekly } from '../lib/stats-kit/charts/WeeklyHeatFruitChart.jsx'
import { layoutSourceMix } from '../lib/stats-kit/charts/SourceMixChart.jsx'
import { splitSources, sourceMetaLine } from '../lib/stats-kit/charts/SourceReportCard.jsx'
import { layoutHeatClockCrop } from '../lib/stats-kit/charts/HeatClockCropChart.jsx'
import { layoutCultivarClock } from '../lib/stats-kit/charts/CultivarClockChart.jsx'
import { layoutHeatLadder, layoutHeatTube } from '../lib/stats-kit/charts/HeatLadderChart.jsx'
import { layoutPepperBest } from '../lib/stats-kit/charts/PepperBestChart.jsx'
import { layoutTomatoKeep } from '../lib/stats-kit/charts/TomatoKeepChart.jsx'
import { layoutLongest } from '../lib/stats-kit/charts/LongestChart.jsx'
import { layoutSepSize } from '../lib/stats-kit/charts/SepSizeChart.jsx'
import { STATS_REGISTRY } from '../lib/stats-kit/registry.js'
import { dayNum, monthDay, monthStarts, fmtShu, heatBandOf } from '../lib/stats-kit/format.js'

const fixture = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/season-stats.v1.json'), 'utf8'))
const S = fixture.sections
const BAD = /NaN|Infinity|undefined/

function renderBody(id, section) {
  const { Body } = STATS_REGISTRY[id]
  return render(<MemoryRouter><Body section={section} /></MemoryRouter>)
}

function badAttributes(container) {
  const out = []
  for (const el of container.querySelectorAll('*')) {
    for (const a of el.attributes) if (BAD.test(a.value)) out.push(`${el.tagName} ${a.name}=${a.value.slice(0, 60)}`)
  }
  return out
}

describe('geom', () => {
  it('linear maps the domain ends onto the range ends, and is linear between', () => {
    const x = linear(0, 10, 136, 364)
    expect(x(0)).toBe(136)
    expect(x(10)).toBe(364)
    expect(x(5)).toBe(250)
  })
  it('linear never returns NaN: zero-width domain and junk input fall to the range start', () => {
    expect(linear(3, 3, 10, 20)(3)).toBe(10)
    expect(linear(0, 1, 10, 20)(NaN)).toBe(10)
    expect(linear(0, 1, 10, 20)(undefined)).toBe(10)
  })
  it('logShu: 0 SHU on the range start, the max on the range end, 100 -> 1M strictly increasing', () => {
    const x = logShu(1300000, 26, 384)
    expect(x(0)).toBe(26)
    expect(x(1300000)).toBeCloseTo(384)
    const xs = [100, 1000, 10000, 100000, 1000000].map(x)
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1])
    // log: every decade is (nearly — it is log10(1 + shu)) the same width
    expect(xs[4] - xs[3]).toBeCloseTo(xs[3] - xs[2], 1)
  })
  it('logShu never returns NaN: junk, negatives and a zero max fall to the range start', () => {
    const x = logShu(1300000, 26, 384)
    for (const junk of [NaN, undefined, null, '5000', -10, Infinity]) expect(x(junk)).toBe(26)
    expect(logShu(0, 26, 384)(5000)).toBe(26)
    expect(logShu(NaN, 26, 384)(5000)).toBe(26)
  })
  it('fmtShu and heatBandOf', () => {
    expect([1300000, 350000, 2500, 200, 0].map(fmtShu)).toEqual(['1.3M', '350k', '2.5k', '200', '0'])
    expect([0, 100, 999, 1000, 49999, 50000, 250000, -1, null].map(heatBandOf))
      .toEqual(['sweet', 'mild', 'mild', 'medium', 'hot', 'very_hot', 'superhot', null, null])
  })
  it('niceMax and ticks', () => {
    expect(niceMax(9.36, 2)).toBe(10)
    expect(niceMax(0, 500)).toBe(500)
    expect(niceMax(NaN, 20)).toBe(20)
    expect(ticks(10, 2)).toEqual([0, 2, 4, 6, 8, 10])
  })
  it('day math is TZ-proof string math', () => {
    expect(monthDay('2026-07-02')).toBe('Jul 2')
    expect(dayNum('2026-05-11') - dayNum('2026-05-10')).toBe(1)
    expect(dayNum('junk')).toBeNull()
    expect(monthStarts(dayNum('2026-05-10'), dayNum('2026-07-02')).map(m => m.label)).toEqual(['May', 'Jun', 'Jul'])
  })
})

describe('chart layouts on the fixture', () => {
  it('ribbon: first sowing sits on the left edge, the last weather day ends on the right edge', () => {
    const L = layoutRibbon(S.ribbon)
    expect(L.x(dayNum('2026-04-18'))).toBeCloseTo(62)
    expect(L.x(dayNum('2026-09-28')) + (394 - 62) / (L.d1 - L.d0 + 1)).toBeCloseTo(394)
    expect(L.pins.map(p => p.word)).toEqual(['Sown', 'Set out', '96°', '2.84″'])
    for (const p of L.pins) { expect(p.x).toBeGreaterThanOrEqual(62); expect(p.x).toBeLessThanOrEqual(394) }
    expect(L.carePaths.every(c => c.d.length > 0)).toBe(true)
  })

  it('weekly: zero heat sits on the centre line, the top tick sits 110 units above it', () => {
    const L = layoutWeekly(S.ribbon)
    expect(L.yu(0)).toBe(150)
    expect(L.yu(L.hMax)).toBe(40)
    expect(L.yd(L.fMax)).toBe(268)
    expect(L.hMax).toBe(200)
    expect(L.fMax).toBe(300)
    expect(L.bracket.weeks).toBe(8)
  })

  it('source mix: segments fill the bar from 4 to 396, less the gaps', () => {
    const L = layoutSourceMix(S.sources)
    const first = L.bands[0]
    const last = L.bands[L.bands.length - 1]
    expect(first.top[0]).toBe(4)
    expect(last.top[1]).toBeCloseTo(396)
    expect(last.bottom[1]).toBeCloseTo(396)
    expect(L.tp).toBe(274)
    expect(L.bands.map(b => b.group)).toEqual(['nursery', 'seed', 'rescued', 'gift', 'other', 'none'])
  })

  it('source report: over-2-lb sources shown, the rest folded, no-source row kept', () => {
    const { big, small, none, max } = splitSources(S.sources)
    expect(big.map(c => c.name).slice(0, 2)).toEqual(['Starview Gardens', 'High Mowing Organic Seeds'])
    expect(big.every(c => c.lb >= 2)).toBe(true)
    expect(small.every(c => c.lb < 2)).toBe(true)
    expect(big.length + small.length).toBe(34)
    expect(none.lb).toBe(187.1)
    expect(max).toBe(154.3)
    expect(sourceMetaLine(big[0])).toBe('46 plantings · 37 picked · 5 lost · seed saved from 11')
    expect(sourceMetaLine(S.sources.series.cards.find(c => c.name === 'Hart Farm'))).toBe('1 planting · 1 picked')
    // the no-source card (source_id null, picked/lost null) still says its saved lots
    expect(none.source_id).toBeNull()
    expect(sourceMetaLine(none)).toBe('96 plantings · seed saved from 3')
    // the fixture is the regenerated real one: 35 cards (34 named + the no-source card), real ids
    expect(S.sources.series.cards).toHaveLength(35)
    for (const c of [...big, ...small]) expect(c.source_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('heat clock by crop: the origin sits on the left axis, 0 heat on the baseline', () => {
    const L = layoutHeatClockCrop(S.heat_clock)
    expect(L.x(dayNum('2026-05-10'))).toBe(46)
    expect(L.y(0)).toBe(226)
    expect(L.y(L.top)).toBe(34)
    expect(L.pts).toHaveLength(S.heat_clock.series.by_crop.length)
    expect(L.labels.length).toBeGreaterThan(3)
    for (const l of L.labels) { expect(l.x).toBeGreaterThanOrEqual(2); expect(l.x).toBeLessThanOrEqual(W - 2) }
  })

  it('cultivar clock: 0 heat at 146, the axis top at 318, rows sorted fastest first', () => {
    const rows = S.heat_clock.series.by_cultivar.filter(r => r.crop_slug === 'pepper')
    const L = layoutCultivarClock(rows, 1184, 'pepper')
    expect(L.x(0)).toBe(146)
    expect(L.x(L.max)).toBe(318)
    expect(L.rows[0].x).toBeLessThanOrEqual(L.rows[L.rows.length - 1].x)
    expect(L.rows[0].color).toBe('var(--gs-h5)')
  })

  it('heat ladder: hottest band on top, the biggest band fills the bar', () => {
    const L = layoutHeatLadder(S.heat_ladder)
    expect(L.rows.map(r => r.band)).toEqual(['superhot', 'very_hot', 'hot', 'medium', 'mild', 'sweet'])
    expect(L.rows.find(r => r.band === 'very_hot').barW).toBe(120)
  })

  it('heat tube: one dot per variety with a Scoville number, the hottest named, ticks 0..1M left to right', () => {
    const T = layoutHeatTube(S.heat_ladder)
    const best = S.heat_ladder.series.best
    expect(best).toHaveLength(31)
    expect(T.dots).toHaveLength(best.filter(r => typeof r.scoville_max === 'number').length)
    expect(T.hottest.text).toBe('Armageddon F1 1.3M')
    expect(T.hottest.x).toBeLessThanOrEqual(W)
    expect(T.ticks.map(t => t.label)).toEqual(['0 SHU', '100', '1k', '10k', '100k', '1M'])
    for (let i = 1; i < T.ticks.length; i++) expect(T.ticks[i].x).toBeGreaterThan(T.ticks[i - 1].x)
    // hotter never sits left of milder
    const byShu = [...T.dots].sort((a, b) => a.shu - b.shu)
    for (let i = 1; i < byShu.length; i++) if (byShu[i].shu > byShu[i - 1].shu) expect(byShu[i].cx).toBeGreaterThan(byShu[i - 1].cx)
    // sweet dots sit on the bulb; colours follow the band
    for (const d of T.dots.filter(d => d.shu === 0)) { expect(Math.abs(d.cx - 26)).toBeLessThan(5.5); expect(d.color).toBe('var(--gs-h0)') }
    // ...in two even columns (9 sweet -> levels 0-4 left, 0-3 right), not a zig-zag
    const sweet = T.dots.filter(d => d.shu === 0)
    expect(sweet.filter(d => d.cx < 26).map(d => d.level)).toEqual([0, 1, 2, 3, 4])
    expect(sweet.filter(d => d.cx > 26).map(d => d.level)).toEqual([0, 1, 2, 3])
    expect(T.dots.find(d => d.cultivar === 'Armageddon F1').color).toBe('var(--gs-h5)')
    // no two dots overlap
    for (const a of T.dots) for (const b of T.dots) if (a !== b) expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeGreaterThan(7.9)
    for (const d of T.dots) { expect(Number.isFinite(d.cx)).toBe(true); expect(Number.isFinite(d.cy)).toBe(true); expect(d.cy).toBeGreaterThan(0) }
    // the ladder rows sit below the tube
    const L = layoutHeatLadder(S.heat_ladder)
    expect(Math.min(...L.rows.map(r => r.y)) - 11).toBeGreaterThan(T.height)
  })

  it('heat tube: null scoville skipped, all-null -> no tube, bars still drawn; nothing NaN', () => {
    const sec = { series: { bands: S.heat_ladder.series.bands, best: [
      { band: 'hot', cultivar: 'A', scoville_max: null, pods: 3 },
      { band: 'hot', cultivar: 'B', scoville_max: 30000, pods: 1 },
      { band: 'hot', cultivar: 'C', pods: 1 },
      { band: 'hot', cultivar: 'D', scoville_max: 'x', pods: 1 },
    ] } }
    const T = layoutHeatTube(sec)
    expect(T.dots.map(d => d.cultivar)).toEqual(['B'])
    expect(T.hottest.text).toBe('B 30k')
    expect(layoutHeatTube({ series: { bands: [], best: [{ cultivar: 'A', scoville_max: null }] } })).toBeNull()
    expect(layoutHeatLadder({ series: { bands: [], best: [] } })).toBeNull()
    const noTube = layoutHeatLadder({ series: { bands: S.heat_ladder.series.bands, best: [] } })
    expect(noTube.tube).toBeNull()
    expect(noTube.rows[0].y).toBe(18)
    const { container } = renderBody('heat_ladder', sec)
    expect(container.querySelector('[data-testid="heat-tube"]')).not.toBeNull()
    expect(badAttributes(container)).toEqual([])
  })

  it('pepper best: 0 pods at 96, the axis top at 386; the leader of each band is named', () => {
    const L = layoutPepperBest(S.heat_ladder)
    expect(L.x(0)).toBe(96)
    expect(L.x(L.max)).toBe(386)
    expect(L.rows.find(r => r.band === 'sweet').lead.text).toBe('Red Mini Bell · 18')
  })

  it('tomato keep: 0 lb at 136, the axis top at 364, heaviest first, late plants hollow', () => {
    const L = layoutTomatoKeep(S.tomato_keep)
    expect(L.x(0)).toBe(136)
    expect(L.x(L.max)).toBe(364)
    expect(L.max).toBe(10)
    expect(L.rows[0].name).toBe('Ukrainian Purple')
    expect(L.median).toBe(2.05)
    expect(L.rows.some(r => r.late)).toBe(true)
    expect(L.rows.filter(r => r.late).every(r => r.color === 'var(--gs-rust)')).toBe(true)
  })

  it('longest: the first month starts at 146; every pick tick sits inside its window', () => {
    const L = layoutLongest(S.longest)
    expect(L.x(dayNum('2026-07-01'))).toBe(146)
    for (const r of L.rows) for (const t of r.ticks) {
      expect(t).toBeGreaterThanOrEqual(r.a - 1e-9)
      expect(t).toBeLessThanOrEqual(r.b + 1e-9)
    }
    expect(L.rows[0].arrow).toMatch(/^M/)
  })

  it('sep size: the 1× centre line is inside the axis, and bars start or end on it', () => {
    const L = layoutSepSize(S.sep_size)
    expect(L.x(L.lo)).toBe(136)
    expect(L.x(L.hi)).toBe(316)
    const one = L.x(1)
    for (const r of L.rows) expect(r.a === one || r.b === one).toBe(true)
    expect(L.rows[0].text).toBe('114 → 75 g')
  })
})

describe('no NaN in any attribute', () => {
  it('SELF-TEST: the attribute scan catches NaN and Infinity', () => {
    const { container } = render(<svg><rect width={NaN} x={Infinity} y={1} /></svg>)
    expect(badAttributes(container)).toHaveLength(2)
  })

  it('fixture: every section body renders clean', () => {
    for (const id of Object.keys(S)) {
      const { container, unmount } = renderBody(id, S[id])
      expect(container.querySelector('svg, article, ul'), id).not.toBeNull()
      expect(badAttributes(container), id).toEqual([])
      unmount()
    }
  })

  it('empty sections render nothing and do not throw', () => {
    for (const id of Object.keys(S)) {
      const { container, unmount } = renderBody(id, { meta: {}, series: {} })
      expect(badAttributes(container), id).toEqual([])
      expect(container.querySelector('svg'), id).toBeNull()
      unmount()
    }
  })

  it('junk values (nulls, strings, a single row) render clean', () => {
    const junk = {
      ribbon: { meta: { pins: { hottest: { date: '2026-07-02', tmax_f: null } } }, series: { days: [{ date: '2026-07-02', tmax_f: 'x', tmin_f: null, precip_in: null, care: null }], weeks: [{ week_start: '2026-07-06', heat_units: null }] } },
      sources: { meta: {}, series: { by_type: [{ group: 'nursery', plantings: 0, plants: 0 }], cards: [{ source_id: null, lb: null, plantings: null }] } },
      heat_clock: { meta: { median_heat: {} }, series: { by_crop: [{ crop_slug: 'x', first_pick: '2026-07-02', heat_units: null }], by_cultivar: [{ crop_slug: 'tomato', cultivar: 'Solo', heat_units: 0 }] } },
      heat_ladder: { meta: {}, series: { bands: [{ band: 'hot', pods: 0 }], best: [{ band: 'hot', cultivar: 'Solo', pods: 0 }] } },
      tomato_keep: { meta: { median_lb: null }, series: { rows: [{ cultivar: 'Solo', lb: 0, verdict: 'mystery' }] } },
      longest: { meta: {}, series: { rows: [{ cultivar: 'Solo', first_pick: '2026-07-02', last_pick: '2026-07-02', pick_days: ['bad'] }] } },
      sep_size: { meta: {}, series: { rows: [{ cultivar: 'Solo', ratio: 1, aug_g: null, sep_g: null }] } },
      seed_lots: { meta: {}, series: { rows: [{ cultivar: 'Solo', count: null, source: null, parent: null }] } },
    }
    for (const id of Object.keys(junk)) {
      const { container, unmount } = renderBody(id, junk[id])
      expect(badAttributes(container), id).toEqual([])
      unmount()
    }
  })
})
