// SeedLotCard — one saved seed lot on Season stats (round-2 "saved-seed cards, rebuilt"). Leads with
// the cultivar and how many seeds ("~" when the count is an estimate), then the plant it came off and
// where that plant came from. Link chips come from sourceLinkChips, so only filled fields appear.
// Deliberately NO F1 / OP / "?" badges (Dave, round 2). "Edit source" opens the source's edit screen.
import React from 'react'
import { Link } from 'react-router-dom'
import { sourceLinkChips } from '../../lib/sourceLinks.js'
import { v } from '../../lib/stats-kit/palette.js'
import { kindWord, monthDay, fmtInt, fmtLb, isNum, cropWord, capitalize } from '../../lib/stats-kit/format.js'

export function seedCountText(lot) {
  if (isNum(lot?.count)) return `${lot.count_estimated ? '~' : ''}${fmtInt(lot.count)} seeds`
  return lot?.stage ? capitalize(String(lot.stage)) : ''
}

export default function SeedLotCard({ lot }) {
  if (!lot) return null
  const src = lot.source ?? null
  const chips = sourceLinkChips(src)
  const sub = [capitalize(cropWord(lot.crop_slug)), lot.saved_on ? `saved ${monthDay(lot.saved_on)}` : null, lot.stage ?? null]
    .filter(Boolean).join(' · ')
  const parent = lot.parent ?? null
  const origin = src?.name
    ? [src.name, kindWord(src.kind), src.locality, src.via ? `via ${src.via}` : null].filter(Boolean)
    : null
  return (
    <article style={card} data-testid="seed-lot-card">
      <div style={head}>
        <b style={name}>{lot.cultivar}</b>
        <span style={count} data-testid="seed-lot-count">{seedCountText(lot)}</span>
      </div>
      {sub && <div style={subStyle}>{sub}</div>}
      <div style={body}>
        {parent?.name && (
          <span>
            From your {parent.name} planting{isNum(parent.lb) ? ` · ${fmtLb(parent.lb)} lb picked` : ''}
          </span>
        )}
        {origin ? (
          <span>
            {parent ? 'Originally: ' : 'From '}<b>{origin[0]}</b>{origin.length > 1 ? ` · ${origin.slice(1).join(' · ')}` : ''}
          </span>
        ) : (
          <span style={missing}>Source not recorded</span>
        )}
        {(chips.length > 0 || src?.id) && (
          <span style={links}>
            {chips.map((c) => (
              <a key={c.kind} href={c.href} target="_blank" rel="noopener noreferrer" style={chip} data-testid={`seed-lot-chip-${c.kind}`}>
                {c.label}
              </a>
            ))}
            {src?.id && (
              <Link to={`/sources/${src.id}`} style={{ ...chip, ...editChip }} data-testid="seed-lot-edit-source">Edit source</Link>
            )}
          </span>
        )}
      </div>
    </article>
  )
}

const card = {
  background: v('card'), border: `1px solid ${v('hair')}`, borderRadius: 10, padding: '10px 12px',
  display: 'grid', gap: 3, color: v('ink'),
}
const head = { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }
const name = { fontSize: '1rem', fontWeight: 700, minWidth: 0 }
const count = { fontSize: '0.85rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: v('ink-2') }
const subStyle = { fontSize: '0.78rem', color: v('ink-3') }
const body = {
  borderTop: `1px solid ${v('hair')}`, marginTop: 5, paddingTop: 6, fontSize: '0.85rem', display: 'grid', gap: 3, color: v('ink-2'),
}
const missing = { color: v('ink-3'), fontStyle: 'italic' }
const links = { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }
const chip = {
  display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 14px', borderRadius: 22,
  border: `1px solid ${v('hair')}`, background: v('well'), color: v('link'), fontWeight: 600, fontSize: '0.8rem',
  textDecoration: 'none', boxSizing: 'border-box',
}
const editChip = { background: 'transparent' }
