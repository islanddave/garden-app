// Source report card (round-2 design): one row per named source — name and kind, pounds with a bar,
// then "N plantings · N picked · N lost · seed saved from N" — sources under 2 lb folded behind
// "N more sources", and a "No source recorded" row last.
import React, { useState } from 'react'
import { v } from '../palette.js'
import { kindWord, fmtLb, fmtInt, countOf, num, isNum } from '../format.js'

export const SMALL_SOURCE_LB = 2

export function splitSources(section) {
  const cards = section?.series?.cards ?? []
  const named = cards.filter((c) => c && c.source_id != null).sort((a, b) => num(b.lb) - num(a.lb))
  const none = cards.find((c) => c && c.source_id == null) ?? null
  const big = named.filter((c) => num(c.lb) >= SMALL_SOURCE_LB)
  const small = named.filter((c) => num(c.lb) < SMALL_SOURCE_LB)
  const max = Math.max(num(named[0]?.lb), 0)
  return { big, small, none, max }
}

export function sourceMetaLine(c) {
  const parts = [countOf(num(c.plantings), 'planting')]
  if (isNum(c.picked)) parts.push(`${fmtInt(c.picked)} picked`)
  if (num(c.lost) > 0) parts.push(`${fmtInt(c.lost)} lost`)
  if (num(c.saved_lots) > 0) parts.push(`seed saved from ${fmtInt(c.saved_lots)}`)
  return parts.join(' · ')
}

function Row({ name, kind, lb, max, meta, muted }) {
  const pct = max > 0 ? Math.min(100, (100 * num(lb)) / max) : 0
  return (
    <li style={row} data-testid="source-row">
      <span style={{ ...nameStyle, color: muted ? v('ink-2') : v('ink') }}>
        {name}
        {kind && <small style={kindStyle}>{kind}</small>}
      </span>
      <span style={lbStyle}>{fmtLb(num(lb))} lb</span>
      <span style={barWell} aria-hidden="true">
        <i style={{ ...barFill, width: `${pct.toFixed(1)}%`, background: muted ? v('gone') : v('sage') }} />
      </span>
      <span style={metaStyle}>{meta}</span>
    </li>
  )
}

export default function SourceReportCard({ section }) {
  const [open, setOpen] = useState(false)
  const { big, small, none, max } = splitSources(section)
  if (big.length === 0 && small.length === 0 && !none) return null
  const smallLb = small.reduce((a, c) => a + num(c.lb), 0)
  return (
    <div>
      <ul style={list} data-testid="source-report">
        {big.map((c) => (
          <Row key={c.source_id} name={c.name} kind={kindWord(c.kind)} lb={c.lb} max={max} meta={sourceMetaLine(c)} />
        ))}
        {open && small.map((c) => (
          <Row key={c.source_id} name={c.name} kind={kindWord(c.kind)} lb={c.lb} max={max} meta={sourceMetaLine(c)} />
        ))}
        {none && (
          <Row name="No source recorded" lb={none.lb} max={max} meta={sourceMetaLine(none)} muted />
        )}
      </ul>
      {small.length > 0 && (
        <button type="button" style={moreBtn} aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="source-more">
          {open ? 'Show fewer sources' : `${countOf(small.length, 'more source')} · ${fmtLb(smallLb)} lb, each under ${SMALL_SOURCE_LB} lb`}
        </button>
      )}
    </div>
  )
}

const list = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }
const row = { display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 10px', alignItems: 'baseline' }
const nameStyle = { fontWeight: 600, fontSize: '0.9rem', minWidth: 0 }
const kindStyle = { marginLeft: 6, fontWeight: 400, fontSize: '0.75rem', color: v('ink-3') }
const lbStyle = { fontWeight: 600, fontSize: '0.88rem', fontVariantNumeric: 'tabular-nums', color: v('ink'), whiteSpace: 'nowrap' }
const barWell = { gridColumn: '1 / -1', display: 'block', height: 6, borderRadius: 3, background: v('well'), overflow: 'hidden' }
const barFill = { display: 'block', height: '100%', borderRadius: 3 }
const metaStyle = { gridColumn: '1 / -1', fontSize: '0.78rem', color: v('ink-3'), fontVariantNumeric: 'tabular-nums' }
const moreBtn = {
  marginTop: 8, minHeight: 44, width: '100%', padding: '0 12px', textAlign: 'left', borderRadius: 8,
  border: `1px solid ${v('hair')}`, background: 'transparent', color: v('link'), fontWeight: 600,
  fontSize: '0.85rem', fontFamily: 'inherit', cursor: 'pointer',
}
