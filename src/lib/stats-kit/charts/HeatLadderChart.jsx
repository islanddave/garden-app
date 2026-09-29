// Heat ladder (round-1 design): the heat tube — one dot per single-plant pepper variety on a log
// Scoville axis, a thermometer whose bulb holds the sweet (0 SHU) ones and the hottest named — above
// the pods picked in each pepper heat band, hottest at the top, with pounds.
import React from 'react'
import { ChartFrame, Txt, Rect, Line, Dot } from './ChartFrame.jsx'
import { linear, logShu, W } from './geom.js'
import { v, BAND_COLOR } from '../palette.js'
import {
  HEAT_BANDS, HEAT_BAND_LABEL, HEAT_BAND_TOP, heatBandOf, fmtInt, fmtLb, fmtShu, isNum, num,
} from '../format.js'

const BAR_X = 118
const BAR_MAX = 120
const PITCH = 26

// Tube geometry. The axis always reaches 1.3M SHU (the round-1 axis) and grows if a variety is hotter.
const TUBE_X0 = 26
const TUBE_X1 = 384
const SHU_AXIS_MAX = 1300000
const BULB_R = 9
const DOT_R = 4
const DOT_PITCH = 9
const DOT_GAP = 2 * DOT_R + 0.8
const LABEL_Y = 12
const STACK_TOP = 22
const SHU_TICKS = [100, 1000, 10000, 100000, 1000000]

// Pure: one dot per `best` row that carries a Scoville number; a null/junk scoville_max is skipped.
// Dots at the same heat stack upward (lowest free level wins), the 0-SHU ones in two columns on the bulb.
export function layoutHeatTube(section) {
  const best = (section?.series?.best ?? [])
    .filter((r) => r && isNum(r.scoville_max) && r.scoville_max >= 0)
  if (best.length === 0) return null
  const maxShu = Math.max(SHU_AXIS_MAX, ...best.map((r) => r.scoville_max))
  const x = logShu(maxShu, TUBE_X0, TUBE_X1)
  const sorted = [...best].sort((a, b) => a.scoville_max - b.scoville_max || num(b.pods) - num(a.pods))
  let zeros = 0
  const levels = []
  const dots = sorted.map((r) => {
    const dx = r.scoville_max === 0 ? (zeros++ % 2 === 0 ? -1 : 1) * (DOT_GAP / 2) : 0
    const cx = x(r.scoville_max) + dx
    let level = 0
    while ((levels[level] ?? []).some((px) => Math.abs(px - cx) < DOT_GAP - 0.01)) level++
    ;(levels[level] ??= []).push(cx)
    const band = BAND_COLOR[r.band] ? r.band : heatBandOf(r.scoville_max)
    return { key: r.planting_id ?? `${r.cultivar}-${r.scoville_max}`, cultivar: r.cultivar, shu: r.scoville_max, band, cx, level, color: BAND_COLOR[band] ?? v('pepper') }
  })
  const tubeY = STACK_TOP + DOT_R + (levels.length - 1) * DOT_PITCH + 16
  for (const d of dots) d.cy = tubeY - 16 - d.level * DOT_PITCH
  const hot = dots.reduce((a, d) => (d.shu > a.shu ? d : a), dots[0])
  const right = hot.cx > W / 2
  const hottest = hot.shu > 0
    ? {
      text: `${hot.cultivar ?? ''} ${fmtShu(hot.shu)}`.trim(),
      x: right ? Math.min(W - 2, hot.cx + 10) : Math.max(2, hot.cx - 10),
      anchor: right ? 'end' : 'start',
      lineX: hot.cx, lineY1: LABEL_Y + 4, lineY2: Math.min(...dots.filter((d) => d.cx === hot.cx).map((d) => d.cy)) - DOT_R - 2,
    }
    : null
  // Band segments inside the tube: each band from the previous band's top to its own, clipped to the axis.
  const segs = []
  let lo = 0
  for (const b of HEAT_BANDS.slice(1)) {
    const hi = Math.min(HEAT_BAND_TOP[b], maxShu)
    if (hi > lo) segs.push({ band: b, x0: x(lo), x1: x(hi), color: BAND_COLOR[b] })
    lo = hi
  }
  return {
    x, maxShu, dots, hottest, segs, tubeY,
    ticks: [{ v: 0, x: TUBE_X0, label: '0 SHU' }, ...SHU_TICKS.map((t) => ({ v: t, x: x(t), label: fmtShu(t) }))],
    height: tubeY + BULB_R + 22,
  }
}

export function layoutHeatLadder(section) {
  const bands = section?.series?.bands ?? []
  const byBand = Object.fromEntries(bands.map((b) => [b.band, b]))
  const order = [...HEAT_BANDS].reverse().filter((b) => byBand[b])
  const tube = layoutHeatTube(section)
  if (order.length === 0 && !tube) return null
  const top = tube ? tube.height + 14 : 0
  const maxp = Math.max(0, ...order.map((b) => num(byBand[b].pods)))
  const w = linear(0, maxp, 0, BAR_MAX)
  return {
    tube,
    height: top + (order.length ? 18 + order.length * PITCH - 8 : 0),
    rows: order.map((b, i) => {
      const r = byBand[b]
      const y = top + 18 + i * PITCH
      return {
        band: b, y, color: BAND_COLOR[b] ?? v('pepper'),
        label: r.label ?? HEAT_BAND_LABEL[b] ?? b,
        plantings: num(r.plantings),
        barW: Math.max(1.5, w(num(r.pods))),
        text: `${fmtInt(num(r.pods))} pods · ${fmtLb(num(r.lb))} lb`,
      }
    }),
  }
}

function HeatTube({ T }) {
  const y = T.tubeY
  return (
    <g data-testid="heat-tube">
      <Rect x={TUBE_X0} y={y - 5} w={TUBE_X1 - TUBE_X0 + 5} h={10} rx={5} fill={v('well')} stroke={v('hair')} />
      {T.segs.map((s) => <Rect key={s.band} x={s.x0} y={y - 3.5} w={s.x1 - s.x0} h={7} fill={s.color} />)}
      <Dot x={TUBE_X0} y={y} r={BULB_R} fill={BAND_COLOR.sweet} stroke={v('hair')} />
      {T.hottest && (
        <g>
          <Txt x={T.hottest.x} y={LABEL_Y} anchor={T.hottest.anchor} tone="key">{T.hottest.text}</Txt>
          <Line x1={T.hottest.lineX} y1={T.hottest.lineY1} x2={T.hottest.lineX} y2={T.hottest.lineY2} stroke={v('ink-3')} width={0.8} />
        </g>
      )}
      {T.dots.map((d) => <Dot key={d.key} x={d.cx} y={d.cy} r={DOT_R} fill={d.color} stroke={v('card')} />)}
      {T.ticks.map((t) => (
        <g key={t.v}>
          {t.v > 0 && <Line x1={t.x} y1={y + 7} x2={t.x} y2={y + 11} stroke={v('ink-3')} />}
          <Txt x={t.x} y={y + BULB_R + 16} anchor={t.v > 0 ? 'middle' : 'start'} tone="muted">{t.label}</Txt>
        </g>
      ))}
    </g>
  )
}

export default function HeatLadderChart({ section }) {
  const L = layoutHeatLadder(section)
  if (!L) return null
  return (
    <ChartFrame
      height={L.height}
      label="Pepper heat on a log Scoville scale, one dot per variety; below it, pepper pods picked in each heat band, hottest at the top"
      testId="chart-heat-ladder"
    >
      {L.tube && <HeatTube T={L.tube} />}
      {L.rows.map((r) => (
        <g key={r.band}>
          <Rect x={4} y={r.y - 10} w={10} h={10} fill={r.color} rx={2} />
          <Txt x={20} y={r.y} tone="key">{r.label}</Txt>
          <Txt x={BAR_X - 6} y={r.y} anchor="end" tone="muted">{r.plantings}</Txt>
          <Rect x={BAR_X} y={r.y - 11} w={r.barW} h={12} fill={r.color} rx={2} />
          <Txt x={BAR_X + r.barW + 6} y={r.y}>{r.text}</Txt>
        </g>
      ))}
    </ChartFrame>
  )
}
