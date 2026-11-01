// ONE empty-state chrome for the list/tab surfaces. It converges the CHROME only: copy, glyph choice
// and the action control stay the call site's, and the action is passed through as a node so a page
// keeps its own button styling (RecentlyDeleted's "Back to Photos" link carries a pinned 44px tap
// target that lives at the call site).
//
// GUARDED SCOPE: living in components/forms/ puts this file under the designsys/no-raw-design-tokens
// glob at full strength (hex, emoji AND dimensional, no debt-register entry), so it must not hold
// literals itself. It is NOT added to index.js: the barrel's export surface is pinned by
// formsPrimitivesFreeze.test.js, and other primitives here (ChoiceGrid, FacetGroupHeader,
// GroupByControl, TagChip, TagFilterBar, VarietyEditor) already ship as direct-path imports.
import React from 'react'
import { P } from '../../lib/constants.js'
import Icon from '../Icon.jsx'
import { T } from './formStyles.js'

// T's space ramp tops out at 20, so this primitive's geometry is derived from it rather than added
// to it (single-use token names for one card are the indirection formStyles.js's header argues
// against). Values are the mode or median of what the earlier per-page empty states used:
//   pad Y  48,  pad X  20
const PAD_Y = T.space.md * 3
const PAD_X = T.space.lg
// The medallion is a tinted tile that gives an <Icon> and an emoji the SAME footprint, so emoji
// surfaces need no registry entry. 64 / 32 glyph.
const MEDALLION = T.space.md * 4
const GLYPH = MEDALLION / 2
// No T token to route this to: T has no maxWidth ramp, so arithmetic on the space ramp would be
// false precision.
const BODY_MAX = 320

const root = {
  textAlign: 'center',
  padding: `${PAD_Y}px ${PAD_X}px`,
  backgroundColor: P.white,
  border: `1px solid ${P.border}`,
  borderRadius: T.radiusCard,
}

const medallion = {
  width: MEDALLION, height: MEDALLION,
  margin: 0, marginLeft: 'auto', marginRight: 'auto', marginBottom: T.space.sm,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: T.radiusPill,
  backgroundColor: P.greenPale,
  color: P.greenDeep,
  fontSize: GLYPH,
  lineHeight: 1,
}

const titleStyle = {
  margin: 0, marginBottom: T.space.xs,
  fontSize: T.type.lg, fontWeight: 700, color: P.dark,
}

// P.mid, not P.light: P.light is 4.478:1 on this white card, and this is the line the user reads to
// act.
const bodyStyle = {
  margin: 0, marginLeft: 'auto', marginRight: 'auto',
  maxWidth: BODY_MAX,
  fontSize: T.type.sm2, lineHeight: 1.5, color: P.mid,
}

const actionStyle = { marginTop: T.space.lg }

export default function EmptyState({ iconName, emoji, title, body, action }) {
  const glyph = iconName ? <Icon name={iconName} size={GLYPH} decorative /> : emoji
  return (
    <div style={root}>
      {/* Kept a FLAT child list: title, body and action are direct children of the card. The Garden
          icon test reaches the medallion via `getByText(title).closest('div')`, which a text-group
          wrapper would silently retarget at a div holding no svg. */}
      {glyph ? <div aria-hidden="true" style={medallion}>{glyph}</div> : null}
      {title ? <p style={titleStyle}>{title}</p> : null}
      {body ? <p style={bodyStyle}>{body}</p> : null}
      {action ? <div style={actionStyle}>{action}</div> : null}
    </div>
  )
}
