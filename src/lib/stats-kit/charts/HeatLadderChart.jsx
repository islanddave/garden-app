// Heat ladder (round-1 design): pods picked in each pepper heat band, hottest at the top, with pounds.
import React from 'react'
import { ChartFrame, Txt, Rect } from './ChartFrame.jsx'
import { linear } from './geom.js'
import { v, BAND_COLOR } from '../palette.js'
import { HEAT_BANDS, HEAT_BAND_LABEL, fmtInt, fmtLb, num } from '../format.js'

const BAR_X = 118
const BAR_MAX = 120
const PITCH = 26

export function layoutHeatLadder(section) {
  const bands = section?.series?.bands ?? []
  const byBand = Object.fromEntries(bands.map((b) => [b.band, b]))
  const order = [...HEAT_BANDS].reverse().filter((b) => byBand[b])
  if (order.length === 0) return null
  const maxp = Math.max(...order.map((b) => num(byBand[b].pods)))
  const w = linear(0, maxp, 0, BAR_MAX)
  return {
    height: 18 + order.length * PITCH - 8,
    rows: order.map((b, i) => {
      const r = byBand[b]
      const y = 18 + i * PITCH
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

export default function HeatLadderChart({ section }) {
  const L = layoutHeatLadder(section)
  if (!L) return null
  return (
    <ChartFrame height={L.height} label="Pepper pods picked in each heat band, hottest at the top" testId="chart-heat-ladder">
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
