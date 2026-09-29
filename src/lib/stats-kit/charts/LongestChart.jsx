// The longest-giving plants (round-2 design): each planting's picking window as a pale bar, a tick for
// every day it was picked, and an arrow where it is still picking. Right edge: window length in days.
import React from 'react'
import { ChartFrame, Txt, Line, Rect } from './ChartFrame.jsx'
import { linear, f1, truncate } from './geom.js'
import { v } from '../palette.js'
import { dayNum, monthStarts, num } from '../format.js'

const RH = 20
const TOP = 8
const X0 = 146
const X1 = 356

const cropColor = (name) => {
  const n = String(name ?? '').toLowerCase()
  if (n === 'tomato') return v('tomato')
  if (n === 'pepper') return v('pepper')
  return v('veg')
}

export function layoutLongest(section) {
  const rows = (section?.series?.rows ?? []).filter((r) => dayNum(r?.first_pick) != null && dayNum(r?.last_pick) != null)
  if (rows.length === 0) return null
  const first = Math.min(...rows.map((r) => dayNum(r.first_pick)))
  const last = Math.max(...rows.map((r) => dayNum(r.last_pick)), dayNum(section?.meta?.last_pick) ?? -Infinity)
  const d0 = monthStarts(first, first)[0]?.day ?? first
  const d1 = last + 4
  const x = linear(d0, d1, X0, X1)
  const bottom = TOP + rows.length * RH
  return {
    height: bottom + 24, x, bottom,
    months: monthStarts(d0, d1).map((m) => ({ x: x(m.day), label: m.label })),
    rows: rows.map((r, i) => {
      const cy = TOP + i * RH + RH / 2
      const a = x(dayNum(r.first_pick))
      const b = x(dayNum(r.last_pick))
      return {
        key: r.planting_id ?? `${r.cultivar}-${i}`,
        name: `${truncate(r.cultivar, 18)}${num(r.plants) > 1 ? ` (${r.plants})` : ''}`,
        cy, a, b, color: cropColor(r.crop_name),
        ticks: (Array.isArray(r.pick_days) ? r.pick_days : []).map(dayNum).filter((d) => d != null).map((d) => x(d)),
        arrow: r.still_picking ? `M${f1(b + 2)} ${f1(cy - 5)}L${f1(b + 8)} ${f1(cy)}L${f1(b + 2)} ${f1(cy + 5)}Z` : null,
        days: `${num(r.window_days)} d`,
      }
    }),
  }
}

export default function LongestChart({ section }) {
  const L = layoutLongest(section)
  if (!L) return null
  return (
    <ChartFrame height={L.height} label="Picking windows for the longest-giving plantings, one tick per picking day" testId="chart-longest">
      {L.months.map((m) => <Line key={m.label} x1={m.x} y1={TOP} x2={m.x} y2={L.bottom} />)}
      {L.rows.map((r) => (
        <g key={r.key}>
          <Txt x={X0 - 6} y={r.cy + 4} anchor="end" size={11.5}>{r.name}</Txt>
          <Rect x={r.a} y={r.cy - 5} w={r.b - r.a} h={10} rx={2} fill={r.color} opacity={0.22} />
          {r.ticks.map((t, k) => <Line key={k} x1={t} y1={r.cy - 5} x2={t} y2={r.cy + 5} stroke={r.color} width={1.3} />)}
          {r.arrow && <path d={r.arrow} style={{ fill: r.color }} />}
          <Txt x={396} y={r.cy + 4} anchor="end" tone="muted">{r.days}</Txt>
        </g>
      ))}
      {L.months.map((m) => (
        <g key={`a${m.label}`}>
          <Line x1={m.x} y1={L.bottom} x2={m.x} y2={L.bottom + 4} stroke={v('ink-3')} />
          <Txt x={m.x} y={L.bottom + 16} anchor="middle" tone="muted">{m.label}</Txt>
        </g>
      ))}
    </ChartFrame>
  )
}
