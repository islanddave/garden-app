// src/lib/tokens.js — DESIGNSYS Pass A canonical token surface (contract §1/§9).
// New code imports color/space/type/radius from HERE. P stays physically in
// constants.js (76 importers must not break); T stays in components/forms/formStyles.js.
// This module is the single re-export index — it imports from constants + formStyles
// ONLY (neither imports tokens.js), so there is no circular dependency.
import { P } from './constants.js'
import { T } from '../components/forms/formStyles.js'

export { P, T }

export const tokens = {
  color: P,
  space: T.space,
  type: T.type,
  radius: {
    field:  T.radiusField,
    button: T.radiusButton,
    card:   T.radiusCard,
    badge:  T.radiusBadge,
  },
}

// Facet color tokens (additive, unused until TAGSUB). Shaped per facet for direct
// {bg,text,border} consumption. The lifecycle facet is NOT here — it reuses
// getStatusColors() (status.js), so no new token is minted for it.
export const FACET_TOKENS = {
  type:     { bg: P.fTypeBg,     text: P.fTypeText,     border: P.fTypeBorder },
  group:    { bg: P.fGroupBg,    text: P.fGroupText,    border: P.fGroupBorder },
  location: { bg: P.fLocationBg, text: P.fLocationText, border: P.fLocationBorder },
  freeform: { bg: P.fFreeformBg, text: P.fFreeformText, border: P.fFreeformBorder },
}

// Lifecycle facet is value-colored (not a single facet token): each lifecycle slug maps to its own
// {bg,text,border}. facetColors(facet, value) resolves through here when facet === 'lifecycle'.
// Unknown lifecycle values fall back to the neutral freeform token (same as before).
export const LIFECYCLE_TOKENS = {
  annual:            { bg: P.fLcAnnualBg,    text: P.fLcAnnualText,    border: P.fLcAnnualBorder },
  biennial:          { bg: P.fLcBiennialBg,  text: P.fLcBiennialText,  border: P.fLcBiennialBorder },
  perennial:         { bg: P.fLcPerennialBg, text: P.fLcPerennialText, border: P.fLcPerennialBorder },
  tender_perennial:  { bg: P.fLcTenderBg,    text: P.fLcTenderText,    border: P.fLcTenderBorder },
}

// ── V4-ICON-001 (DESIGNSYS Pass B V101) icon tokens — single source for the Icon
// component (JS import) AND the generated CSS vars (main.jsx). §11. ──────────────
export const ICON = {
  stroke: 1.75, strokeSmall: 2.0, strokeInverse: 2.0, strokeHero: 2.25, minStroke: 1.6,
  tint: '#c8e6cd', keyline: 2, cornerRadius: 2, circleD: 18,
  defaultColor: P.greenDeep, inverseColor: P.white,
}
export function iconCssVars() {
  return `:root{--icon-stroke:${ICON.stroke}px;--icon-stroke-inverse:${ICON.strokeInverse}px;--icon-stroke-hero:${ICON.strokeHero}px;--icon-tint:${ICON.tint};--icon-keyline:${ICON.keyline};--icon-corner-radius:${ICON.cornerRadius};--icon-circle-d:${ICON.circleD};--icon-color:${ICON.defaultColor};}`
}

// ── V4-ICONCOLOR-001 icon region-color tokens — the ONLY place icon region hex lives.
// Registry entries reference these by NAME via entry.colorFills:{region:tokenName};
// Icon.jsx resolves name->hex at render (masters stay hex-free, per the §14 no-hex lint).
// Values pull from P so they stay in palette lockstep; one minted value (lcSproutLeaf)
// because P.greenLight #52b788 fails the 3:1 silhouette floor on cream.
export const ICON_COLORS = {
  dropBody:      P.blue,      // #4a7fb5 teardrop (water) — 3.87:1 on cream
  dropHighlight: P.white,     // inner sheen stroke
  sunBody:       P.gold,      // #8a6e2a solar disc — 4.44:1
  sunRays:       P.gold,      // rays (one-color read)
  lcSproutLeaf:  '#349160',   // minted — fresh-growth green, 3.60:1 (greenLight fails)
  lcStem:        P.greenDeep, // #1f5138 stem/structure — 8.42:1
  lcSoil:        P.brown,     // #7a5c3c soil bar — 5.64:1
  lcBud:         P.purple,    // #7b5ea7 closed bud — 4.83:1
  lcBloomPetals: P.terra,     // #b7532a open petals — 4.51:1
  lcBloomCenter: P.gold,      // flower center
  lcFruit:       P.terra,     // ripe fruit body
}
