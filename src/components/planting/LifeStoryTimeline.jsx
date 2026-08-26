// V4-PLANTINGUI-001 — life-story milestone spine. Renders buildLifeStory(planting) as a vertical
// timeline (lifecycle arc), distinct from the full Event log ledger below it. Current skin.
import React from 'react'
import { P } from '../../lib/constants.js'
import Icon from '../Icon.jsx'
import { buildLifeStory } from '../../lib/lifeStory.js'

function fmtDate(d) {
  if (!d) return ''
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

export default function LifeStoryTimeline({ planting }) {
  const rows = buildLifeStory(planting)
  if (!rows.length) return null
  return (
    <ol data-testid="life-story" style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative' }}>
      {rows.map((r, i) => (
        <li key={r.key} style={{ display: 'flex', gap: 12, alignItems: 'flex-start',
          paddingBottom: i === rows.length - 1 ? 0 : 16, position: 'relative' }}>
          {/* spine connector */}
          {i !== rows.length - 1 && (
            <span aria-hidden="true" style={{ position: 'absolute', left: 15, top: 32, bottom: 0,
              width: 2, backgroundColor: P.greenLight }} />
          )}
          {/* 22, not the emoji's 0.95rem/~15px: an inline SVG has no side bearings, so matching the
              emoji's nominal size would draw a visibly smaller mark inside the same 32px node. 22
              also clears Icon's 21px master crossover, so this takes the 24 master — the 18 master
              closes the planted-out trough at this size. */}
          <span aria-hidden="true" style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
            backgroundColor: P.greenPale, border: `1px solid ${P.greenLight}`, display: 'flex',
            alignItems: 'center', justifyContent: 'center', color: P.green, zIndex: 1 }}>
            <Icon name={r.iconName} size={22} decorative />
          </span>
          <div style={{ minWidth: 0, flex: 1, paddingTop: 4 }}>
            <div style={{ fontWeight: 600, color: P.dark, fontSize: '0.875rem' }}>{r.label}</div>
            <div style={{ fontSize: '0.75rem', color: P.light, marginTop: 1 }}>
              {fmtDate(r.date)}{r.approx ? ' (approx.)' : ''}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}
