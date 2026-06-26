// facetColors — per-facet chip colors for the V4-GARDENIA-001 faceted render.
// type/group/location/freeform have minted FACET_TOKENS. lifecycle's values (annual/perennial/
// biennial) have NO palette yet — they fall back to the neutral freeform token rather than
// gold-defaulting through getStatusColors. A dedicated lifecycle palette is a V200 design-pass item.
import { FACET_TOKENS } from './tokens.js'
const NEUTRAL = FACET_TOKENS.freeform
export function facetColors(facet) {
  return FACET_TOKENS[facet] || NEUTRAL
}
