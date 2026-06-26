// facetColors — per-facet chip colors for the V4-GARDENIA-001 faceted render.
// type/group/location/freeform have minted FACET_TOKENS. The lifecycle facet is VALUE-colored:
// each lifecycle value (annual/biennial/perennial/tender_perennial) has its own LIFECYCLE_TOKENS
// entry, resolved via the optional second arg. Unknown/missing lifecycle values fall back to the
// neutral freeform token (the prior behavior for the whole facet).
import { FACET_TOKENS, LIFECYCLE_TOKENS } from './tokens.js'
const NEUTRAL = FACET_TOKENS.freeform
export function facetColors(facet, value) {
  if (facet === 'lifecycle') return LIFECYCLE_TOKENS[value] || NEUTRAL
  return FACET_TOKENS[facet] || NEUTRAL
}
