// src/lib/supplierPalette.js — V5-SEEDCARDS-001. Each seed supplier's designated colour pair, for
// its chip and the thin accent stripe on a My seeds card.
//
// Dave, 2026-09-19: "Each supplier should have a designated color (primary+secondary) hopefully based
// around their main page of their website … but keep the color set of each distinguishable. It is
// more about visual distinction than pure on-brand style." The pairs below were derived from each
// supplier's own site (theme CSS, logo fills) by the colour seat and then pulled apart where brands
// collide — nine of the thirteen suppliers with a website are green, so only Botanical Interests (139
// of 327 rows) kept its exact green. Evidence per supplier, the CIEDE2000 distances and the contrast
// numbers: Projects/Gardening/_seedpacket_20260919/design/supplier-palette.{md,json}.
//
// Measured rules every entry holds (supplierPalette.test.js re-checks the contrast ones):
//   • `on` text on `primary` >= 4.5:1; `primary` as a stripe >= 3:1 on P.white and P.cream.
//   • The top eight suppliers by rows are >= 20 apart (ΔE00), all twenty >= 12 from their nearest.
//   • Every fill stays >= 15 ΔE00 from the app's danger/warn tones, so a supplier chip never reads as
//     an alert. Bentley's orange is the residual risk (15.7 from P.terra); if it reads as a warning on
//     a phone, swap to its slate `#495057` fill with the orange as the border.
//   • `shop: false` marks the sources that are not a shop (swap, own garden, co-op, association, a
//     relative, a tour): muted fills and a DASHED border — colour alone cannot say "not a shop". The
//     conservatory and the seed library keep a solid border, as the colour seat drew them.
//
// KEYED BY THE FOLDED NAME, never the registry uuid. `supplierKey` is foldSourceKey
// (lambda/varieties/validate.js) — the same fold that generates source.match_key, unique among live
// rows. Source ids are gen_random_uuid() per environment, so a uuid-keyed palette would colour prod
// only and every harness, gate and staging run would exercise the fallback instead. A registry RENAME
// changes the key, and the supplier then falls back until this map is updated.
//
// A SUPPLIER ADDED LATER is never blank: `supplierColors` hands it a deterministic pair from
// FALLBACK_SLOTS (hash of its key), and its name is always on the chip.
//
// This module is the ONE home for these hex values — SupplierChip and the cards read them from here.

export function supplierKey(name) {
  if (typeof name !== 'string') return ''
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// `short` is the chip's label, at most 12 characters (UX spec §1.2): the chip leads a 255px line that
// also carries the amount and the heat, and it is never ellipsised. The full name is on the chip's
// title, in the expanded row and on the detail page.
export const SUPPLIER_COLORS = Object.freeze({
  botanicalinterests:     { name: 'Botanical Interests', short: 'Botanical', primary: '#395d27', secondary: '#d2d3b0', on: '#ffffff', shop: true },
  bentleyseeds:           { name: 'Bentley Seeds', short: 'Bentley', primary: '#d2750f', secondary: '#495057', on: '#1a1a1a', shop: true },
  marysheirloomseeds:     { name: "Mary's Heirloom Seeds", short: "Mary's", primary: '#d06c9c', secondary: '#2c7e3f', on: '#1a1a1a', shop: true },
  sandiaseedcompany:      { name: 'Sandia Seed Company', short: 'Sandia', primary: '#009a5c', secondary: '#ffd521', on: '#1a1a1a', shop: true },
  amazon:                 { name: 'Amazon', short: 'Amazon', primary: '#232f3e', secondary: '#ff9900', on: '#ffffff', shop: true },
  johnnysselectedseeds:   { name: "Johnny's Selected Seeds", short: "Johnny's", primary: '#b51a53', secondary: '#567632', on: '#ffffff', shop: true },
  highmowingorganicseeds: { name: 'High Mowing Organic Seeds', short: 'High Mowing', primary: '#878f1a', secondary: '#264e2d', on: '#1a1a1a', shop: true },
  seedsaversexchange:     { name: 'Seed Savers Exchange', short: 'Seed Savers', primary: '#0097a8', secondary: '#62a60a', on: '#1a1a1a', shop: true },
  hillfolkseedcollective: { name: 'Hillfolk Seed Collective', short: 'Hillfolk', primary: '#7a3d7f', secondary: '#e5c9e5', on: '#ffffff', shop: true },
  belchertownplantswap:   { name: 'Belchertown Plant Swap', short: 'Belchertown', primary: '#848f7f', secondary: '#4c5847', on: '#1a1a1a', shop: false },
  owngarden:              { name: 'Own garden', short: 'Own garden', primary: '#44371e', secondary: '#dfd0b7', on: '#ffffff', shop: false },
  greenfieldfarmerscoop:  { name: 'Greenfield Farmers Co-op', short: 'Greenfield', primary: '#7b6a5f', secondary: '#e2cec1', on: '#ffffff', shop: false },
  massachusettsflowergrowersassociation: { name: 'Massachusetts Flower Growers Association', short: 'Mass. Flower', primary: '#988693', secondary: '#634f5d', on: '#1a1a1a', shop: false },
  magicwings:             { name: 'Magic Wings', short: 'Magic Wings', primary: '#00696f', secondary: '#ffbc42', on: '#ffffff', shop: true },
  gurneysseednurseryco:   { name: "Gurney's Seed & Nursery Co.", short: "Gurney's", primary: '#00658c', secondary: '#004925', on: '#ffffff', shop: true },
  jensuncle:              { name: "Jen's uncle", short: "Jen's uncle", primary: '#55414a', secondary: '#e3cbd5', on: '#ffffff', shop: false },
  panoramatours:          { name: 'Panorama Tours', short: 'Panorama', primary: '#62677e', secondary: '#cdd0e7', on: '#ffffff', shop: false },
  livingstonseed:         { name: 'Livingston Seed', short: 'Livingston', primary: '#224686', secondary: '#19325f', on: '#ffffff', shop: true },
  umassamherstlibrariescommonseedproject: { name: 'UMass Amherst Libraries Common Seed Project', short: 'UMass', primary: '#700828', secondary: '#e68200', on: '#ffffff', shop: true },
  lakevalleyseed:         { name: 'Lake Valley Seed', short: 'Lake Valley', primary: '#8b80c5', secondary: '#6b9347', on: '#1a1a1a', shop: true },
})

// Reserved pairs for a supplier this map does not know yet, each >= 13 ΔE00 from every curated fill.
export const FALLBACK_SLOTS = Object.freeze([
  { primary: '#004232', secondary: '#bbd8cd', on: '#ffffff' },
  { primary: '#645bbe', secondary: '#d5cdf2', on: '#ffffff' },
  { primary: '#3f325d', secondary: '#d7cde7', on: '#ffffff' },
  { primary: '#926481', secondary: '#e7cadb', on: '#ffffff' },
  { primary: '#569787', secondary: '#2c5d51', on: '#1a1a1a' },
  { primary: '#42801b', secondary: '#bddba6', on: '#ffffff' },
])

// A row with no supplier on record: no stripe (its absence is the cue — a grey stripe would read as a
// disabled supplier) and, where a chip is shown, white with a dashed grey border.
export const NO_SUPPLIER = Object.freeze({ primary: '#ffffff', secondary: '#707070', on: '#4a4a4a', stripe: null, shop: false })

function hashKey(k) {
  let h = 0
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0
  return h
}

// The pair for a supplier NAME; null when there is no name (render NO_SUPPLIER's treatment).
export function supplierColors(name) {
  const k = supplierKey(name)
  if (!k) return null
  const known = SUPPLIER_COLORS[k]
  if (known) return known
  const slot = FALLBACK_SLOTS[hashKey(k) % FALLBACK_SLOTS.length]
  return { ...slot, name, short: shortSupplierLabel(name), shop: true, fallback: true }
}

// The default short form for a supplier the map does not know: drop the trade words that carry no
// identity (Seeds, Seed, Company, Co., Co-op, Selected, Organic, Heirloom), then cut at a word
// boundary within 12 characters. "Fedco Seeds" -> "Fedco"; "Baker Creek Heirloom Seeds" -> "Baker Creek".
const TRADE_WORDS = /\b(seeds?|company|co\.?|co-op|selected|organic|heirloom)\b/gi
export function shortSupplierLabel(name) {
  const full = String(name ?? '').trim()
  if (!full) return ''
  const words = full.replace(TRADE_WORDS, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (words.length === 0) return full.slice(0, 12)
  let out = ''
  for (const w of words) {
    const next = out ? `${out} ${w}` : w
    if (next.length > 12) break
    out = next
  }
  return out || words[0].slice(0, 12)
}

// The chip's label for a supplier name: the curated short form, else the default rule above.
export function supplierLabel(name) {
  const k = supplierKey(name)
  if (!k) return ''
  return SUPPLIER_COLORS[k]?.short || shortSupplierLabel(name)
}
