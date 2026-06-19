// critterFlavor — per-critter delight content (fun_fact / call / lore) for the critter detail
// popover (V3-CRITFLAVOR-001). Keyed by roster id (C###/L###/Y###). Sidecar to critters-roster.json.
//
// Reward-UX / Jen-invisible: render fun_fact/call/lore only. Never surface `flag`, confidence,
// tier, rarity, or weights. Entries flagged for Dave accuracy review (C014/C066/C068/L002) are
// GATED — getFlavor returns null for them until Dave clears the flag in src/data/critter-flavor.json.
import flavorData from '../data/critter-flavor.json'

const BY_ID = flavorData.flavor || {}

// Returns { fun_fact, call?, lore? } for a critter, or null when absent or Dave-review-gated.
export function getFlavor(critter) {
  if (!critter) return null
  const rec = BY_ID[critter.id]
  if (!rec || rec.flag) return null
  const out = { fun_fact: rec.fun_fact }
  if (rec.call) out.call = rec.call
  if (rec.lore) out.lore = rec.lore
  return out
}

export { BY_ID as FLAVOR_BY_ID }
