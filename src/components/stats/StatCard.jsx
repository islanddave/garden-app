// StatCard — one Season stats section: title, the verdict sentence, the chart, a small "Limits" line,
// and the numbers behind the chart in a closed <details> table. Static: no count-ups, no scores, no
// celebration (Reward UX — this is a look-back surface).
import React from 'react'
import { v } from '../../lib/stats-kit/palette.js'

// `table` is one { caption?, columns, numeric?, rows } or an array of them.
export function NumbersTable({ table }) {
  const tables = (Array.isArray(table) ? table : [table]).filter((t) => t && Array.isArray(t.rows) && t.rows.length > 0)
  if (tables.length === 0) return null
  return (
    <details style={details} data-testid="stat-card-numbers">
      <summary style={summary}>The numbers</summary>
      {tables.map((t, i) => <OneTable key={t.caption ?? i} table={t} />)}
    </details>
  )
}

function OneTable({ table }) {
  const numeric = table.numeric ?? []
  return (
    <div style={scroller}>
      <table style={tableStyle}>
        {table.caption && <caption style={caption}>{table.caption}</caption>}
        <thead>
          <tr>{table.columns.map((c, i) => <th key={c} scope="col" style={{ ...th, textAlign: numeric[i] ? 'right' : 'left' }}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {table.rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((cell, ci) => (
                ci === 0
                  ? <th key={ci} scope="row" style={{ ...td, fontWeight: 600, textAlign: 'left' }}>{cell}</th>
                  : <td key={ci} style={{ ...td, textAlign: numeric[ci] ? 'right' : 'left' }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function StatCard({ id, title, verdict, limits, table, children }) {
  return (
    <section style={card} data-testid="stat-card" data-section={id} aria-labelledby={`stat-${id}-title`}>
      <h2 id={`stat-${id}-title`} style={titleStyle}>{title}</h2>
      {verdict && <p style={verdictStyle} data-testid="stat-card-verdict">{verdict}</p>}
      <div style={chartBox}>{children}</div>
      {limits && (
        <p style={limitsStyle} data-testid="stat-card-limits"><b style={limitsLabel}>Limits</b> {limits}</p>
      )}
      <NumbersTable table={table} />
    </section>
  )
}

const card = {
  background: v('card'), border: `1px solid ${v('hair')}`, borderRadius: 10, padding: '14px 12px 6px',
  margin: '0 0 14px', color: v('ink'),
}
const titleStyle = { margin: 0, fontSize: '1.02rem', fontWeight: 700, color: v('title') }
const verdictStyle = { margin: '6px 0 10px', fontSize: '0.92rem', lineHeight: 1.45, color: v('ink') }
const chartBox = { margin: '4px 0' }
const limitsStyle = { margin: '8px 0 2px', fontSize: '0.78rem', lineHeight: 1.45, color: v('ink-3') }
const limitsLabel = { fontWeight: 700, color: v('ink-2'), marginRight: 2 }
const details = { borderTop: `1px solid ${v('hair')}`, marginTop: 8 }
const summary = {
  // list-item keeps the disclosure triangle (a flex summary loses it in Chrome); 44 px tap target.
  display: 'list-item', minHeight: 44, padding: '12px 0', boxSizing: 'border-box', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600,
  color: v('link'),
}
const scroller = { overflowX: 'auto', paddingBottom: 8 }
const caption = { textAlign: 'left', fontSize: '0.8rem', fontWeight: 700, color: v('ink-2'), padding: '6px 0 2px' }
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums' }
const th = { padding: '4px 6px', color: v('ink-3'), fontWeight: 600, borderBottom: `1px solid ${v('hair')}`, whiteSpace: 'nowrap' }
const td = { padding: '4px 6px', color: v('ink-2'), borderBottom: `1px solid ${v('hair')}`, whiteSpace: 'nowrap' }
