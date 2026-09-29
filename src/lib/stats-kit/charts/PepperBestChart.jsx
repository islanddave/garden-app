// Best pepper in each heat band (round-2 design): one row per band, a dot per single-plant pepper at
// its pod count, the band leader ringed and named. Plants with no pods logged are grey ticks at zero.
import React from 'react'
import { ChartFrame, Txt, Line, Dot, XAxis } from './ChartFrame.jsx'
import { linear, niceMax, ticks, truncate } from './geom.js'
import { v, BAND_COLOR } from '../palette.js'
import { HEAT_BANDS, HEAT_BAND_LABEL, num, countOf } from '../format.js'

const RH = 50
const TOP = 8
const X0 = 96
const X1 = 386

export function layoutPepperBest(section) {
  const best = (section?.series?.best ?? []).filter(Boolean)
  const labels = Object.fromEntries((section?.series?.bands ?? []).map((b) => [b.band, b.label]))
  const bands = HEAT_BANDS.filter((b) => best.some((r) => r.band === b))
  if (bands.length === 0) return null
  const max = niceMax(Math.max(...best.map((r) => num(r.pods))), 20)
  const x = linear(0, max, X0, X1)
  return {
    height: TOP + bands.length * RH + 34,
    x, max, axisY: TOP + bands.length * RH + 2, ticks: ticks(max, 20),
    rows: bands.map((b, bi) => {
      const rs = best.filter((r) => r.band === b).sort((a, c) => num(c.pods) - num(a.pods) || num(a.rank_in_band) - num(c.rank_in_band))
      const cy = TOP + bi * RH + 30
      const withPods = rs.filter((r) => num(r.pods) > 0)
      const leader = withPods[0]
      const lx = leader ? x(num(leader.pods)) : 0
      const anchor = lx > 300 ? 'end' : 'start'
      return {
        band: b, cy, color: BAND_COLOR[b] ?? v('pepper'),
        label: labels[b] ?? HEAT_BAND_LABEL[b] ?? b,
        count: countOf(rs.length, 'plant'),
        zeros: rs.filter((r) => !(num(r.pods) > 0)).map((r, k) => ({ key: r.planting_id ?? k, x: x(0) + k * 3 })),
        dots: withPods.map((r, k) => ({ key: r.planting_id ?? `${b}${k}`, x: x(num(r.pods)), lead: k === 0 })),
        lead: leader ? { text: `${truncate(leader.cultivar, 24)} · ${num(leader.pods)}`, x: anchor === 'end' ? lx + 6 : lx - 6, anchor } : null,
      }
    }),
  }
}

export default function PepperBestChart({ section }) {
  const L = layoutPepperBest(section)
  if (!L) return null
  return (
    <ChartFrame height={L.height} label="Single-plant peppers by heat band, pods per plant, with each band's leader named" testId="chart-pepper-best">
      {L.ticks.map((t) => <Line key={t} x1={L.x(t)} y1={TOP} x2={L.x(t)} y2={L.axisY - 2} />)}
      {L.rows.map((r) => (
        <g key={r.band}>
          <Txt x={4} y={r.cy + 4} tone="key">{r.label}</Txt>
          <Txt x={4} y={r.cy + 18} tone="muted">{r.count}</Txt>
          {r.zeros.map((z) => <Line key={z.key} x1={z.x} y1={r.cy - 6} x2={z.x} y2={r.cy + 6} stroke={v('gone')} width={2} />)}
          {r.dots.map((d) => (
            <Dot key={d.key} x={d.x} y={r.cy} r={d.lead ? 6 : 4.5} fill={r.color} stroke={d.lead ? v('ink') : undefined} />
          ))}
          {r.lead && <Txt x={r.lead.x} y={r.cy - 11} anchor={r.lead.anchor} tone="key">{r.lead.text}</Txt>}
        </g>
      ))}
      <XAxis scale={L.x} values={L.ticks} y={L.axisY} label="pods per plant" />
    </ChartFrame>
  )
}
