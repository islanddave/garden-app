// Each cultivar's heat clock (round-2 design): one bar per planting from planting out to first pick in
// heat units, with the crop's typical (median) value as a dashed gold line. Drawn once for tomatoes
// and once for peppers; pepper bars take their heat band's colour.
import React from 'react'
import { ChartFrame, Txt, Line, Rect, Dot, XAxis } from './ChartFrame.jsx'
import { linear, niceMax, ticks, truncate } from './geom.js'
import { v, BAND_COLOR } from '../palette.js'
import { fmtInt, num, isNum } from '../format.js'

const RH = 16
const TOP = 18
const X0 = 146
const X1 = 318

export function layoutCultivarClock(rows, median, crop) {
  const rs = (rows ?? []).filter((r) => r && isNum(r.heat_units)).sort((a, b) => a.heat_units - b.heat_units)
  if (rs.length === 0) return null
  const max = niceMax(Math.max(...rs.map((r) => r.heat_units), num(median)), 500)
  const x = linear(0, max, X0, X1)
  return {
    height: TOP + rs.length * RH + 34,
    x, max, median: isNum(median) ? median : null,
    axisY: TOP + rs.length * RH,
    ticks: ticks(max, 500),
    rows: rs.map((r, i) => ({
      key: r.planting_id ?? `${r.cultivar}-${i}`,
      name: truncate(r.cultivar, 22),
      cy: TOP + i * RH + RH / 2,
      x: x(r.heat_units),
      color: crop === 'pepper' ? BAND_COLOR[r.heat_band] ?? v('pepper') : v('tomato'),
      text: `${fmtInt(r.heat_units)}${isNum(r.days) ? ` · ${r.days} d` : ''}`,
    })),
  }
}

export default function CultivarClockChart({ rows, median, crop, title }) {
  const L = layoutCultivarClock(rows, median, crop)
  if (!L) return null
  return (
    <ChartFrame height={L.height} label={`${title}: heat units from planting out to first pick`} testId={`chart-cultivar-clock-${crop}`}>
      {L.ticks.map((t) => <Line key={t} x1={L.x(t)} y1={TOP - 4} x2={L.x(t)} y2={L.axisY} />)}
      {L.median != null && (
        <g>
          <Line x1={L.x(L.median)} y1={TOP - 8} x2={L.x(L.median)} y2={L.axisY} stroke={v('gold')} width={1.4} dash="4 3" />
          <Txt x={L.x(L.median) + 4} y={TOP - 6} tone="muted">{`typical ${fmtInt(L.median)}`}</Txt>
        </g>
      )}
      {L.rows.map((r) => (
        <g key={r.key}>
          <Txt x={X0 - 6} y={r.cy + 4} anchor="end" size={11.5}>{r.name}</Txt>
          <Rect x={X0} y={r.cy - 2} w={r.x - X0} h={4} fill={r.color} rx={2} />
          <Dot x={r.x} y={r.cy} r={4} fill={r.color} />
          <Txt x={r.x + 7} y={r.cy + 4} tone="muted" size={11}>{r.text}</Txt>
        </g>
      ))}
      <XAxis scale={L.x} values={L.ticks} y={L.axisY} format={fmtInt} />
    </ChartFrame>
  )
}
