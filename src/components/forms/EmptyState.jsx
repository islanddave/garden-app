// src/components/forms/EmptyState.jsx — V4-EMPTYSTATE-001.
//
// ONE empty-state chrome. Seven surfaces had grown seven local `EmptyState`s (Garden,
// Harvests, Inventory, Locations, ProjectList, ArchivedPlantings, RecentlyDeleted) with zero
// shared import, and they had diverged at STRUCTURE scale, not at the pixel: card / card /
// no-card, radius 8 / 12 / none, and a bare 48px Icon vs a 34px Icon in a tinted tile vs a
// 2.4rem emoji. Garden and Harvests are bottom-nav tabs and Inventory is one row down in the
// same bar's More sheet, so three of the seven are reachable in one session.
//
// This converges the CHROME and nothing else. Copy, glyph choice and the action control are
// still the call site's — the action is passed through as a node so a page keeps its own
// button styling (RecentlyDeleted's "Back to Photos" link carries a pinned 44px tap target
// that lives at the call site, not here).
//
// GUARDED SCOPE, deliberately. Landing in components/forms/ puts this file under the
// designsys/no-raw-design-tokens glob at full strength — hex, emoji AND dimensional, with no
// debt-register entry. That is the point: the primitive that exists to stop literals being
// re-scattered should not itself be allowed to hold any. It is NOT added to index.js —
// the barrel's export surface is pinned by formsPrimitivesFreeze.test.js, and six files here
// (ChoiceGrid, FacetGroupHeader, GroupByControl, TagChip, TagFilterBar, VarietyEditor)
// already ship as direct-path imports.
import React from 'react'
import { P } from '../../lib/constants.js'
import Icon from '../Icon.jsx'
import { T } from './formStyles.js'

// T's space ramp tops out at 20, so this primitive's own geometry is derived from it rather
// than added to it — adding four single-use names to the token HOME to describe one card is
// the indirection formStyles.js's own header argues against. Each value is the mode or the
// median of what the seven were already doing:
//   pad Y  48 — Garden 48, Harvests 48, ProjectList 48, Inventory 52
//   pad X  20 — Harvests 20, Inventory 20, against Garden/ProjectList 24 and Locations 16
const PAD_Y = T.space.md * 3
const PAD_X = T.space.lg
// The medallion is Inventory's tinted tile, generalised: it is the one treatment that gives an
// <Icon> and an emoji the SAME footprint, which is what lets all seven converge without forcing
// the emoji surfaces onto icons they have no registry entry for. 64/32 for Inventory's 66/34.
const MEDALLION = T.space.md * 4
const GLYPH = MEDALLION / 2
// No T token to route this to — T has no maxWidth ramp (and no minWidth token at all), so
// arithmetic on the space ramp here would be false precision. RecentlyDeleted's measured value.
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

// P.mid, not P.light. Five of the seven used P.light (#777, 4.478:1 on this white card) for the
// line the user has to read to act; the other two already used P.mid. Converging UP means no
// surface loses contrast and five gain it, and it leaves this independent of the separate
// P.light repaint — nothing here has to be revisited whichever way that lands.
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
      {/* Kept a FLAT child list — title, body and action are direct children of the card. The
          Garden icon test reaches the medallion via `getByText(title).closest('div')`, which a
          text-group wrapper would silently retarget at a div holding no svg. */}
      {glyph ? <div aria-hidden="true" style={medallion}>{glyph}</div> : null}
      {title ? <p style={titleStyle}>{title}</p> : null}
      {body ? <p style={bodyStyle}>{body}</p> : null}
      {action ? <div style={actionStyle}>{action}</div> : null}
    </div>
  )
}
