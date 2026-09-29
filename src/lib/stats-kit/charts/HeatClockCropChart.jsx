// Heat clock by crop (round-1 design): heat units banked since the weather record starts, rising
// through the summer, with a dot where each crop's first pick came in. The series gives each crop's
// banked heat at its first pick, so the dots themselves trace the curve. Labels are placed greedily
// left or right of their dot and dropped where they would collide; every crop is in the table.
import React from 'react'
import { ChartFrame, Txt, Line, Dot } from './ChartFrame.jsx'
import { linear, niceMax, ticks, f1, W } from './geom.js'
import { v } from '../palette.js'
import { dayNum, monthStarts, fmtInt, num } from '../format.js'

const X0 = 46
const X1 = 392
const YB = 226
const YT = 34
const CHAR_W = 6.6
const PRIORITY = ['tomato', 'pepper', 'cucumber', 'squash']

export function layoutHeatClockCrop(section) {
  const rows = (section?.series?.by_crop ?? []).filter((r) => dayNum(r?.first_pick) != null)
  if (rows.length === 0) return null
  const sorted = [...rows].sort((a, b) => dayNum(a.first_pick) - dayNum(b.first_pick) || num(a.heat_units) - num(b.heat_units))
  const origin = dayNum(section?.meta?.origin_date)
  const d0 = origin != null && origin <= dayNum(sorted[0].first_pick) ? origin : dayNum(sorted[0].first_pick)
  const d1 = dayNum(sorted[sorted.length - 1].first_pick) + 3
  const top = niceMax(Math.max(...sorted.map((r) => num(r.heat_units))), 500)
  const x = linear(d0, d1, X0, X1)
  const y = linear(0, top, YB, YT)
  const pts = sorted.map((r) => ({ ...r, cx: x(dayNum(r.first_pick)), cy: y(num(r.heat_units)) }))
  const curve = [`M${f1(x(d0))} ${f1(YB)}`, ...pts.map((p) => `L${f1(p.cx)} ${f1(p.cy)}`)].join('')

  // Label order: the first crop in, then the headline crops, then the rest by date.
  const order = [pts[0], ...PRIORITY.map((s) => pts.find((p) => p.crop_slug === s)), ...pts].filter(Boolean)
  const seen = new Set()
  const placed = []
  const labels = []
  const hitsDot = (b) => pts.some((p) => p.cx >= b[0] - 3 && p.cx <= b[2] + 3 && p.cy >= b[1] - 3 && p.cy <= b[3] + 3)
  const overlaps = (b) => placed.some((q) => !(b[2] < q[0] || b[0] > q[2] || b[3] < q[1] || b[1] > q[3]))
  for (const p of order) {
    if (seen.has(p.crop_slug)) continue
    seen.add(p.crop_slug)
    const text = p.crop_name ?? p.crop_slug
    const w = String(text).length * CHAR_W
    let best = null
    for (const dy of [0, -10, 10, -20, 20]) {
      for (const side of ['left', 'right']) {
        const bx = side === 'left' ? p.cx - 7 - w : p.cx + 7
        const box = [bx, p.cy + dy - 10, bx + w, p.cy + dy + 3]
        if (box[0] < 2 || box[2] > W - 2 || box[1] < 2 || box[3] > YB - 2) continue
        if (overlaps(box) || hitsDot(box)) continue
        best = { side, box, dy }
        break
      }
      if (best) break
    }
    if (!best) continue
    placed.push(best.box)
    labels.push({ key: p.crop_slug, text, x: best.side === 'left' ? best.box[2] : best.box[0], y: p.cy + best.dy, anchor: best.side === 'left' ? 'end' : 'start' })
  }

  return {
    height: YB + 26, x, y, top, pts, curve, labels,
    yTicks: ticks(top, 500).filter((t) => t > 0),
    months: monthStarts(d0, d1).filter((m) => m.day >= d0).map((m) => ({ x: x(m.day), label: m.label })),
  }
}

export default function HeatClockCropChart({ section }) {
  const L = layoutHeatClockCrop(section)
  if (!L) return null
  return (
    <ChartFrame height={L.height} label="Heat units banked through the season, with a dot where each crop's first pick came in" testId="chart-heat-clock-crop">
      {L.yTicks.map((t) => (
        <g key={t}>
          <Line x1={X0} y1={L.y(t)} x2={X1} y2={L.y(t)} />
          <Txt x={X0 - 6} y={L.y(t) + 4} anchor="end" tone="muted">{fmtInt(t)}</Txt>
        </g>
      ))}
      <Txt x={X0 - 6} y={YB + 4} anchor="end" tone="muted">0</Txt>
      <path d={L.curve} style={{ fill: 'none', stroke: v('gold'), strokeWidth: 2 }} />
      <Line x1={X0} y1={YB} x2={X1} y2={YB} stroke={v('ink-3')} />
      {L.months.map((m) => (
        <g key={m.label}>
          <Line x1={m.x} y1={YB} x2={m.x} y2={YB + 5} stroke={v('ink-3')} />
          <Txt x={m.x + 3} y={YB + 18} tone="muted">{m.label}</Txt>
        </g>
      ))}
      {L.pts.map((p) => <Dot key={p.crop_slug} x={p.cx} y={p.cy} r={3} fill={v('gold')} />)}
      {L.labels.map((l) => <Txt key={l.key} x={l.x} y={l.y} anchor={l.anchor} size={11}>{l.text}</Txt>)}
    </ChartFrame>
  )
}
