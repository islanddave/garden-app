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
