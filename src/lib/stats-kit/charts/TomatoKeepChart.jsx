// Tomato keep list (round-2 design): single-plant tomatoes ranked by pounds picked, as lollipops,
// against the typical plant (dashed gold). Colour carries the server's verdict — grow again (sage),
// fine (grey), rethink (rust) — and a hollow head marks a plant that went in late (August).
import React from 'react'
import { ChartFrame, Txt, TxtBox, Line, Dot, XAxis } from './ChartFrame.jsx'
import { linear, niceMax, ticks, truncate } from './geom.js'
import { v } from '../palette.js'
import { fmtLb, num, isNum } from '../format.js'

const RH = 19
const TOP = 26
const X0 = 136
const X1 = 364

export const KEEP_COLOR = { grow_again: v('sage'), fine: v('ink-3'), rethink: v('rust') }
export const KEEP_WORD = { grow_again: 'Grow again', fine: 'Fine', rethink: 'Rethink' }
export const isLate = (r) => Array.isArray(r?.flags) && r.flags.includes('late_aug')

export function layoutTomatoKeep(section) {
  const rows = (section?.series?.rows ?? []).filter((r) => r && isNum(r.lb)).sort((a, b) => b.lb - a.lb)
  if (rows.length === 0) return null
  const med = section?.meta?.median_lb
  const step = rows[0].lb > 12 ? 5 : 2
  const max = niceMax(Math.max(rows[0].lb, num(med)), step)
  const x = linear(0, max, X0, X1)
  const bottom = TOP + rows.length * RH
  return {
    height: bottom + 36, x, max, bottom, ticks: ticks(max, step),
    median: isNum(med) ? med : null,
    rows: rows.map((r, i) => ({
      key: r.planting_id ?? `${r.cultivar}-${i}`,
      name: truncate(r.cultivar, 20),
      cy: TOP + i * RH + RH / 2,
      x: x(r.lb),
      color: KEEP_COLOR[r.verdict] ?? v('ink-3'),
      strong: r.verdict === 'grow_again',
      late: isLate(r),
      text: fmtLb(r.lb),
    })),
  }
}

export default function TomatoKeepChart({ section }) {
  const L = layoutTomatoKeep(section)
  if (!L) return null
  return (
    <div>
      <ChartFrame height={L.height} label="Single-plant tomatoes ranked by pounds picked, against the typical plant" testId="chart-tomato-keep">
        {L.ticks.map((t) => <Line key={t} x1={L.x(t)} y1={TOP - 6} x2={L.x(t)} y2={L.bottom} />)}
        {L.median != null && (
          <g>
            <Line x1={L.x(L.median)} y1={TOP - 10} x2={L.x(L.median)} y2={L.bottom} stroke={v('gold')} width={1.4} dash="4 3" />
            <Txt x={L.x(L.median) + 4} y={TOP - 12} tone="muted">{`typical ${fmtLb(L.median, 2)} lb`}</Txt>
          </g>
        )}
        {L.rows.map((r) => (
          <g key={r.key}>
            <Txt x={X0 - 6} y={r.cy + 4} anchor="end" tone={r.strong ? 'key' : 'body'}>{r.name}</Txt>
            <Line x1={X0} y1={r.cy} x2={r.x} y2={r.cy} stroke={r.color} width={2} />
            <Dot x={r.x} y={r.cy} r={4.5} fill={r.color} hollow={r.late} />
            <TxtBox x={r.x + 8} y={r.cy + 4} tone="muted">{r.text}</TxtBox>
          </g>
        ))}
        <XAxis scale={L.x} values={L.ticks} y={L.bottom} label="lb picked per plant" />
      </ChartFrame>
      <ul style={legend} aria-label="Colour key">
        {Object.keys(KEEP_WORD).map((k) => (
          <li key={k} style={legendItem}><i style={{ ...swatch, background: KEEP_COLOR[k] }} />{KEEP_WORD[k]}</li>
        ))}
        <li style={legendItem}><i style={{ ...swatch, background: 'transparent', border: `1.6px solid ${v('ink-3')}` }} />Went in late (August)</li>
      </ul>
    </div>
  )
}

const legend = { listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: '0.78rem', color: v('ink-2') }
const legendItem = { display: 'flex', alignItems: 'center', gap: 6 }
const swatch = { display: 'inline-block', width: 10, height: 10, borderRadius: 5, boxSizing: 'border-box' }
