import React, { useId } from 'react'
import { facetColors } from '../../lib/facetColors.js'
import { P, T } from '../../lib/tokens.js'

// The chevron's two glyphs, shared by both modes (the designsys emoji ceiling counts literals, not uses).
const CHEVRON = { closed: '▸', open: '▾' }

// FacetGroupHeader — section header for one group in the faceted Garden render. Shows label +
// count; optional collapse chevron when onToggle is provided. Unsorted renders neutral + italic.
//
// V5-TODAYREDESIGN-001 S2 — an OPT-IN native mode, engaged by `headingLevel` (plan-v2 §4 "Section band",
// §5.2 disclosure contract). Absent, every caller (Garden, My seeds) renders the div[role=button] below
// byte-for-byte (FacetGroupHeader.native.test.jsx pins it). Present:
//   <hN><button aria-expanded aria-controls> chevron · label · count / summary </button></hN> + trailing
// with the panel (children) mounted as the band's next sibling ONLY while open, under an id from useId —
// so aria-controls names a node that exists, and two instances never share an id (V1's CareNeeded
// hand-built its ids and duplicated them across the household lists).
export default function FacetGroupHeader({ label, count, facet, value, collapsed = false, onToggle, isUnsorted = false, style, headingLevel, ...native }) {
  if (headingLevel != null) {
    return <NativeFacetGroupHeader label={label} count={count} facet={facet} value={value} collapsed={collapsed}
      onToggle={onToggle} isUnsorted={isUnsorted} style={style} headingLevel={headingLevel} {...native} />
  }
  const c = facetColors(isUnsorted ? 'freeform' : facet, value)
  const interactive = typeof onToggle === 'function'
  return (
    <div
      data-testid="facet-group-header"
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={interactive ? !collapsed : undefined}
      onClick={interactive ? onToggle : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } } : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: T.space.sm,
        padding: `${T.space.xs}px ${T.space.sm}px`,
        backgroundColor: c.bg, color: c.text, borderLeft: `3px solid ${c.border}`,
        borderRadius: T.radiusField, fontWeight: 700, fontSize: T.type.sm,
        cursor: interactive ? 'pointer' : 'default', ...style,
      }}
    >
      {interactive && <span aria-hidden="true" style={{ fontSize: T.type.xs }}>{collapsed ? CHEVRON.closed : CHEVRON.open}</span>}
      <span style={{ fontStyle: isUnsorted ? 'italic' : 'normal' }}>{label}</span>
      {/* Full opacity (V5-SEEDCARDS-001): at .7 the count read 3.74:1 on its fill, under 4.5 — and on a
          collapsed My seeds group it is the header's only content. */}
      {typeof count === 'number' && <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{count}</span>}
    </div>
  )
}

// size 'section' — the flat band (plan §4): facet fill, 3px left rule, title T.type.sm 700, count right,
// summary line 2 in P.mid (P.light is 4.24:1 on fTypeBg, §5.9). size 'row' — a spot row's disclosure
// (S4): no chrome of its own (the row card is the caller's), name T.type.md 600 P.dark, count, chevron
// last. Both: a native button, minHeight 48, chevron glyph swapped — never rotated, never animated.
// `trailing` is the band's sibling control zone (Not today / Water all): never inside the button.
// No onToggle = the non-collapsible form: a static heading, the panel always mounted.
function NativeFacetGroupHeader({ label, count, facet, value, collapsed, onToggle, isUnsorted, style, headingLevel, summary, trailing, size = 'section', children, panelStyle, testId = 'facet-group-header' }) {
  const panelId = useId()
  const c = facetColors(isUnsorted ? 'freeform' : facet, value)
  const interactive = typeof onToggle === 'function'
  const open = !interactive || !collapsed
  const hasPanel = open && children != null && children !== false
  const Heading = `h${Math.min(6, Math.max(2, Number(headingLevel) || 2))}`
  const row = size === 'row'
  const band = row
    ? { display: 'flex', alignItems: 'stretch', gap: 8, ...style }
    : {
      display: 'flex', alignItems: 'stretch', gap: 8,
      backgroundColor: c.bg, color: c.text, borderLeft: `3px solid ${c.border}`, borderRadius: T.radiusField,
      ...style,
    }
  const hit = {
    display: 'block', width: '100%', minHeight: T.buttonMinHeight, margin: 0, boxSizing: 'border-box',
    padding: `${T.space.xs}px ${T.space.sm}px`,
    background: 'none', border: 'none', color: 'inherit', font: 'inherit', textAlign: 'left',
    cursor: interactive ? 'pointer' : 'default',
  }
  const chevron = interactive && (
    <span aria-hidden="true" style={{ fontSize: T.type.xs, color: row ? P.light : undefined, flex: '0 0 auto' }}>{collapsed ? CHEVRON.closed : CHEVRON.open}</span>
  )
  const line1 = (
    <span style={{ display: 'flex', alignItems: 'baseline', gap: row ? 6 : T.space.sm }}>
      {!row && chevron}
      <span style={{
        flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere',
        fontSize: row ? T.type.md : T.type.sm, fontWeight: row ? 600 : 700,
        color: row ? P.dark : undefined, fontStyle: isUnsorted ? 'italic' : 'normal',
      }}>{label}</span>
      {count != null && count !== '' && (
        <span style={{ flex: '0 0 auto', fontSize: T.type.sm, fontWeight: row ? 700 : 600, color: row ? P.dark : undefined, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      )}
      {row && chevron}
    </span>
  )
  const line2 = summary != null && summary !== '' && (
    <span style={{ display: 'block', fontSize: T.type.sm, fontWeight: 400, color: P.mid, overflowWrap: 'anywhere' }}>{summary}</span>
  )
  return (
    <>
      <div data-testid={testId} data-size={size} style={band}>
        <Heading style={{ margin: 0, flex: '1 1 auto', minWidth: 0, fontSize: 'inherit', fontWeight: 'inherit' }}>
          {interactive ? (
            <button type="button" aria-expanded={!collapsed} aria-controls={hasPanel ? panelId : undefined} onClick={onToggle} style={hit}>
              {line1}{line2}
            </button>
          ) : (
            <span style={hit}>{line1}{line2}</span>
          )}
        </Heading>
        {trailing}
      </div>
      {hasPanel && <div id={panelId} style={panelStyle}>{children}</div>}
    </>
  )
}
