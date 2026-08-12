// V4-HARVEXPORT-001: reconcile with Lane A's S2 mint at merge.
//
// This is the SAME component Lane A's S2 slice mints at this path (design §1b: "S2 first mints
// FilterChipRow {options, selected(set), onToggle, pinned?, onClear?} adopting TimeframeChips'
// aria-pressed + P-token conventions, then consumes it; S5 consumes it too"). Lane B reached S5
// before that file existed in THIS worktree, and cross-worktree imports are forbidden, so this is
// built against the §1b prop spec verbatim. At merge, keep ONE of the two — Lane A's if it differs,
// since S2 is the mint and this is the consumer — and verify the export sheet still passes its
// crop-multi-select pins. The prop contract is the reconciliation surface; do not "fix" a
// divergence by widening this API.
//
// Multi-select OR across chips, one-tap clear. `selected` is a Set (not an array): the S5 sheet and
// the S2 picker both toggle single slugs, and a Set makes membership O(1) and identity-change
// explicit. `pinned` orders those slugs first; the rest follow in the caller's given order.
// Selected state is NOT color-only (WCAG 1.4.1) — weight + border change together, plus
// aria-pressed. >=48px touch targets per the build-spec addendum (design §5.8).
import React from 'react'
import { P } from '../../lib/constants.js'

const chipStyle = (active) => ({
  padding: '6px 14px', minHeight: 48, borderRadius: 20, fontSize: '0.82rem',
  fontWeight: active ? 800 : 600, cursor: 'pointer',
  border: `${active ? 2 : 1}px solid ${active ? P.green : P.border}`,
  backgroundColor: active ? P.greenPale : P.white, color: active ? P.green : P.mid,
})

export default function FilterChipRow({ options = [], selected, onToggle, pinned = [], onClear, ariaLabel = 'Filter' }) {
  const sel = selected instanceof Set ? selected : new Set(selected ?? [])
  const rank = (v) => { const i = pinned.indexOf(v); return i === -1 ? pinned.length : i }
  const ordered = [...options].sort((a, b) => rank(a.value) - rank(b.value))
  if (ordered.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }} role="group" aria-label={ariaLabel}>
      {ordered.map((o) => {
        const active = sel.has(o.value)
        return (
          <button key={o.value} type="button" onClick={() => onToggle?.(o.value)} aria-pressed={active} style={chipStyle(active)}>
            {o.label}
          </button>
        )
      })}
      {/* Clear is offered only when it would DO something — a permanently-inert control beside an
          untouched filter row is noise, and it is the affordance the filtered-to-empty state points at. */}
      {onClear && sel.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          style={{ padding: '6px 12px', minHeight: 48, background: 'transparent', border: 'none', color: P.green, fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer' }}
        >
          Clear
        </button>
      )}
    </div>
  )
}
