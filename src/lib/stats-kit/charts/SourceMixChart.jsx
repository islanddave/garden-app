// Where plants came from (round-1 design): plantings as one stacked bar, plants as a second, joined
// by a ribbon per kind of start, with a key listing both counts.
import React from 'react'
import { ChartFrame, Txt } from './ChartFrame.jsx'
import { f1 } from './geom.js'
import { v, SOURCE_GROUP_COLOR } from '../palette.js'
import { SOURCE_GROUPS, SOURCE_GROUP_LABEL, fmtInt, num } from '../format.js'

const XA = 4
const XB = 396
const GAP = 2
const YA = 36
const YB = 104
const H = 20

export function layoutSourceMix(section) {
  const rows = section?.series?.by_type ?? []
  const byGroup = Object.fromEntries(rows.map((r) => [r.group, r]))
  const groups = [...SOURCE_GROUPS.filter((g) => byGroup[g]), ...rows.map((r) => r.group).filter((g) => !SOURCE_GROUPS.includes(g))]
  if (groups.length === 0) return null
  const tp = groups.reduce((a, g) => a + num(byGroup[g].plantings), 0)
  const tq = groups.reduce((a, g) => a + num(byGroup[g].plants), 0)
  const span = XB - XA - GAP * (groups.length - 1)
  const segs = (key, tot) => {
    let x = XA
    const out = {}
    for (const g of groups) {
      const w = tot > 0 ? (num(byGroup[g][key]) / tot) * span : 0
      out[g] = [x, x + w]
      x += w + GAP
    }
    return out
  }
  const A = segs('plantings', tp)
  const B = segs('plants', tq)
  const ym = (YA + H + YB) / 2
  const bands = groups.map((g) => {
    const [a0, a1] = A[g]
    const [b0, b1] = B[g]
    return {
      group: g,
      color: SOURCE_GROUP_COLOR[g] ?? v('none'),
      label: SOURCE_GROUP_LABEL[g] ?? g,
      plantings: num(byGroup[g].plantings),
      plants: num(byGroup[g].plants),
      top: [a0, a1], bottom: [b0, b1],
      ribbon: `M${f1(a0)} ${YA + H}L${f1(a1)} ${YA + H}C${f1(a1)} ${ym} ${f1(b1)} ${ym} ${f1(b1)} ${YB}`
        + `L${f1(b0)} ${YB}C${f1(b0)} ${ym} ${f1(a0)} ${ym} ${f1(a0)} ${YA + H}z`,
    }
  })
  return { height: YB + H + 42, tp, tq, bands }
}

export default function SourceMixChart({ section }) {
  const L = layoutSourceMix(section)
  if (!L) return null
  return (
    <div>
      <ChartFrame height={L.height} label="Two stacked bars, plantings above and plants below, joined by a ribbon for each kind of start" testId="chart-source-mix">
        <Txt x={4} y={12} tone="key">{`Plantings ${fmtInt(L.tp)}`}</Txt>
        <Txt x={4} y={YB + H + 36} tone="key">{`Plants ${fmtInt(L.tq)}`}</Txt>
        {L.bands.map((b) => (
          <g key={b.group}>
            <path d={b.ribbon} style={{ fill: b.color, opacity: 0.26 }} />
            <rect x={f1(b.top[0])} y={YA} width={f1(Math.max(0, b.top[1] - b.top[0]))} height={H} style={{ fill: b.color }} />
            <rect x={f1(b.bottom[0])} y={YB} width={f1(Math.max(0, b.bottom[1] - b.bottom[0]))} height={H} style={{ fill: b.color }} />
            {b.top[1] - b.top[0] >= 26 && <Txt x={(b.top[0] + b.top[1]) / 2} y={YA - 6} anchor="middle">{fmtInt(b.plantings)}</Txt>}
            {b.bottom[1] - b.bottom[0] >= 30 && <Txt x={(b.bottom[0] + b.bottom[1]) / 2} y={YB + H + 15} anchor="middle">{fmtInt(b.plants)}</Txt>}
          </g>
        ))}
      </ChartFrame>
      <ul style={keyList} aria-label="Plantings and plants by kind of start">
        <li style={{ ...keyRow, color: v('ink-3') }}><span /><span>Start</span><b style={keyNum}>Plantings</b><b style={keyNum}>Plants</b></li>
        {L.bands.map((b) => (
          <li key={b.group} style={keyRow}>
            <i style={{ ...swatch, background: b.color }} />
            <span>{b.label}</span>
            <b style={keyNum}>{fmtInt(b.plantings)}</b>
            <b style={keyNum}>{fmtInt(b.plants)}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}

const keyList = { listStyle: 'none', margin: '8px 0 0', padding: 0, fontSize: '0.82rem', color: v('ink-2'), fontVariantNumeric: 'tabular-nums' }
const keyRow = { display: 'grid', gridTemplateColumns: '14px 1fr 72px 56px', gap: 8, alignItems: 'center', padding: '2px 0' }
const keyNum = { textAlign: 'right', fontWeight: 600 }
const swatch = { display: 'block', width: 12, height: 12, borderRadius: 3 }
