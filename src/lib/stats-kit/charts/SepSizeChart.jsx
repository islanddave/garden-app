// September tomatoes came in smaller (round-2 design): each cultivar's September fruit weight divided
// by its August one, as a bar from the 1× centre line — rust when smaller, sage when it held or grew —
// with "114 → 75 g" on the right.
import React from 'react'
import { ChartFrame, Txt, Line, Rect, XAxis } from './ChartFrame.jsx'
import { linear, truncate } from './geom.js'
import { v } from '../palette.js'
import { fmtInt, isNum } from '../format.js'

const RH = 17
const TOP = 20
const X0 = 136
const X1 = 316

export function layoutSepSize(section) {
  const rows = (section?.series?.rows ?? []).filter((r) => r && isNum(r.ratio)).sort((a, b) => a.ratio - b.ratio)
  if (rows.length === 0) return null
  const lo = Math.min(0.6, Math.floor(rows[0].ratio * 5) / 5)
  const hi = Math.max(1.2, Math.ceil(rows[rows.length - 1].ratio * 5) / 5)
  const x = linear(lo, hi, X0, X1)
  const ticks = []
  for (let t = lo; t <= hi + 1e-9; t += 0.2) ticks.push(Math.round(t * 10) / 10)
  const bottom = TOP + rows.length * RH
  return {
    height: bottom + 36, x, lo, hi, ticks, bottom,
    rows: rows.map((r, i) => {
      const a = x(Math.min(1, r.ratio))
      const b = x(Math.max(1, r.ratio))
      return {
        key: `${r.cultivar}-${i}`,
        name: truncate(r.cultivar, 20),
        cy: TOP + i * RH + RH / 2,
        a, b, color: r.ratio < 1 ? v('rust') : v('sage'),
        text: `${fmtInt(r.aug_g)} → ${fmtInt(r.sep_g)} g`,
      }
    }),
  }
}

export default function SepSizeChart({ section }) {
  const L = layoutSepSize(section)
  if (!L) return null
  return (
    <ChartFrame height={L.height} label="September fruit weight compared with August, by tomato" testId="chart-sep-size">
      {L.ticks.map((t) => (
        <Line key={t} x1={L.x(t)} y1={TOP - 4} x2={L.x(t)} y2={L.bottom} stroke={t === 1 ? v('ink-3') : v('grid')} width={t === 1 ? 1.4 : 1} />
      ))}
      <Txt x={L.x(1)} y={TOP - 8} anchor="middle" tone="muted">same as August</Txt>
      {L.rows.map((r) => (
        <g key={r.key}>
          <Txt x={X0 - 6} y={r.cy + 4} anchor="end">{r.name}</Txt>
          <Rect x={r.a} y={r.cy - 4} w={Math.max(1, r.b - r.a)} h={8} fill={r.color} rx={2} />
          <Txt x={396} y={r.cy + 4} anchor="end" tone="muted">{r.text}</Txt>
        </g>
      ))}
      <XAxis scale={L.x} values={L.ticks} y={L.bottom} label="September fruit weight ÷ August" format={(t) => `${t.toFixed(1)}×`} />
    </ChartFrame>
  )
}
