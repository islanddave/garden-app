// Heat in, fruit out (round-2 design, the ribbon's weekly layer): heat units a week rise above the
// centre line, tomato fruit and pepper pods picked hang below it, and the number of nights under 55°F
// sits over each week in blue. A bracket spans the hottest week to the week with the most tomatoes.
import React from 'react'
import { ChartFrame, Txt, Line, Rect } from './ChartFrame.jsx'
import { linear, niceMax } from './geom.js'
import { v } from '../palette.js'
import { MONTHS, num, dayNum, plural } from '../format.js'

const LEFT = 34
const RIGHT = 388
const MID = 150
const UP = 110
const DOWN = 118
const HEIGHT = 318

export function layoutWeekly(section) {
  const weeks = (section?.series?.weeks ?? []).filter((w) => dayNum(w?.week_start) != null)
  if (weeks.length === 0) return null
  const hMax = niceMax(Math.max(...weeks.map((w) => num(w.heat_units))), 100)
  const fMax = niceMax(Math.max(...weeks.map((w) => Math.max(num(w.tomato_fruit), num(w.pepper_pods)))), 100)
  const yu = linear(0, hMax, MID, MID - UP)
  const yd = linear(0, fMax, MID, MID + DOWN)
  const cw = (RIGHT - LEFT) / weeks.length
  const bw = Math.max(0.5, (cw - 4) / 2)
  let hi = 0
  let ti = 0
  const cols = weeks.map((w, i) => {
    if (num(w.heat_units) > num(weeks[hi].heat_units)) hi = i
    if (num(w.tomato_fruit) > num(weeks[ti].tomato_fruit)) ti = i
    const x0 = LEFT + i * cw
    const mo = Number(w.week_start.slice(5, 7))
    const dd = Number(w.week_start.slice(8, 10))
    return {
      key: w.week_start, x0,
      heat: { x: x0 + 2, y: yu(num(w.heat_units)), w: cw - 4, h: MID - yu(num(w.heat_units)) },
      tom: { x: x0 + 2, y: MID + 1, w: bw, h: yd(num(w.tomato_fruit)) - MID },
      pep: { x: x0 + 2 + bw, y: MID + 1, w: bw, h: yd(num(w.pepper_pods)) - MID },
      cool: num(w.cool_nights),
      month: dd <= 7 || i === 0 ? MONTHS[mo - 1] : null,
    }
  })
  const hx = LEFT + hi * cw + cw / 2
  const tx = LEFT + ti * cw + cw / 2
  return {
    height: HEIGHT, yu, yd, hMax, fMax, cw, cols,
    bracket: ti > hi && num(weeks[ti].tomato_fruit) > 0 ? { hx, tx, y: MID + 128, weeks: ti - hi } : null,
  }
}

export default function WeeklyHeatFruitChart({ section }) {
  const L = layoutWeekly(section)
  if (!L) return null
  const upTicks = [L.hMax / 2, L.hMax]
  const downTicks = [L.fMax / 2, L.fMax]
  return (
    <ChartFrame height={L.height} label="Weekly heat units above the line; tomato fruit and pepper pods picked below it" testId="chart-weekly">
      <Txt x={LEFT} y={12} tone="muted">heat units a week · blue = nights under 55°F</Txt>
      {upTicks.map((t) => (
        <g key={`u${t}`}>
          <Line x1={LEFT} y1={L.yu(t)} x2={RIGHT} y2={L.yu(t)} />
          <Txt x={LEFT - 4} y={L.yu(t) + 4} anchor="end" tone="muted">{t}</Txt>
        </g>
      ))}
      {downTicks.map((t) => (
        <g key={`d${t}`}>
          <Line x1={LEFT} y1={L.yd(t)} x2={RIGHT} y2={L.yd(t)} />
          <Txt x={LEFT - 4} y={L.yd(t) + 4} anchor="end" tone="muted">{t}</Txt>
        </g>
      ))}
      {L.cols.map((c) => (
        <g key={c.key}>
          <Rect {...c.heat} fill={v('h1')} rx={1} />
          {c.cool > 0 && <Txt x={c.x0 + L.cw / 2} y={26} anchor="middle" size={11} fill={v('water')} weight={600}>{c.cool}</Txt>}
          <Rect {...c.tom} fill={v('tomato')} rx={1} />
          <Rect {...c.pep} fill={v('pepper')} rx={1} />
          {c.month && <Txt x={c.x0 + 1} y={L.height - 8} tone="muted">{c.month}</Txt>}
        </g>
      ))}
      <Line x1={LEFT} y1={MID} x2={RIGHT} y2={MID} stroke={v('ink-3')} />
      <Txt x={LEFT + 2} y={MID + 16} tone="muted">tomato fruit and pepper pods picked</Txt>
      {L.bracket && (
        <g>
          <Line x1={L.bracket.hx} y1={L.bracket.y} x2={L.bracket.tx} y2={L.bracket.y} stroke={v('ink-3')} width={1.2} />
          <Line x1={L.bracket.hx} y1={L.bracket.y - 4} x2={L.bracket.hx} y2={L.bracket.y + 4} stroke={v('ink-3')} width={1.2} />
          <Line x1={L.bracket.tx} y1={L.bracket.y - 4} x2={L.bracket.tx} y2={L.bracket.y + 4} stroke={v('ink-3')} width={1.2} />
          <Txt x={(L.bracket.hx + L.bracket.tx) / 2} y={L.bracket.y - 5} anchor="middle" tone="key" size={11.5}>
            {`${L.bracket.weeks} ${plural(L.bracket.weeks, 'week')} from hottest week to most tomatoes`}
          </Txt>
        </g>
      )}
    </ChartFrame>
  )
}
