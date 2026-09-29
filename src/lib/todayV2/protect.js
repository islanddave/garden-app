// protect.js — Protect tonight, as data (V5-TODAYREDESIGN-001 S5; plan-v2 §1.1 / §1.2, §2.4, §4, §13 SF1; the
// orchestrator's household rule, 2026-09-29). PURE: plans in, rows / order / summary out. What opens the section
// is triggers.js's; the page state is useProtect's; the body is ProtectTonight.jsx.
//
// ROWS. The engine's cold cards (engine.js coldFor, the plan's `cold` bucket) as careNeeded.js builds them —
// key `<planting id>:cold`, the one-tap event `brought_inside`, the reason with the "(low …)" clause dropped on
// a night the frost line names (tonightLow.js) — joined to the card's own `level` and the tender threshold its
// text names (triggers.js protectThreshold). Cold rows have ONE owner, this section: Needs care never lists them
// (useNeedsCare keeps only water / feed / check needs), and neither does a household section.
//
// HOUSEHOLD. When this person has the household view on (lib/householdView.js, SF6), every other member's cold
// rows join Protect tonight, each carrying that member's first name — frost hits the whole garden, and a
// household section never opens by itself (plan-v2 §10 item 6, adopted by default in design-todayux-V100).
//
// TWO ROW KINDS (§4). A `protect` card is a tender planting at or under its own threshold: its own row, with
// Covered and Brought in. `bring_in` / `optional` cards are the nightshade mass of a cold night: grouped by spot
// into a cover row ("Bag Area · 68", "Cover all 68") that opens to its plants.
import { buildCareNeeded } from '../careNeeded.js'
import { protectThreshold } from './triggers.js'
import { takeOrder, OUTSIDE } from './spots.js'

export const COVER_LEVELS = new Set(['bring_in', 'optional'])

// The cold rows of one plan. `owner` = null for the viewer's own plan, else the member's first name ("Jen").
export function coldRows(plan, owner = null) {
  if (!plan) return []
  const cards = new Map((Array.isArray(plan.cold) ? plan.cold : []).filter((c) => c && c.id).map((c) => [c.id, c]))
  return buildCareNeeded(plan).filter((r) => r.need === 'cold').map((r) => {
    const c = cards.get(r.plantingId) || {}
    return { ...r, level: c.level || null, threshold: protectThreshold(c.text), owner }
  })
}

// The visit's held order of Protect's rows (plan-v2 §2.2): spots in the PAGE's spot order — takeOrder (spots.js)
// over the care rows and the cold rows together, so Protect lists spots as Needs care does wherever they share
// one (Bag Area, Trough, Deck, then Stable on the 09-24 plan, §1.1) — then the engine's order within a spot.
// `rows` and `careRows` are enriched (spotKey, group). -> [row key].
export function protectOrder(rows, careRows = [], groupOrder = [OUTSIDE]) {
  const order = takeOrder([...(careRows || []), ...rows], groupOrder)
  const rank = new Map()
  let i = 0
  for (const g of order.groups) for (const s of order.spots[g] || []) if (!rank.has(s)) rank.set(s, i++)
  const at = (r) => (rank.has(r.spotKey) ? rank.get(r.spotKey) : Number.POSITIVE_INFINITY)
  return rows.map((r, idx) => ({ r, idx })).sort((a, b) => (at(a.r) - at(b.r)) || (a.idx - b.idx)).map(({ r }) => r.key)
}

// The band's one-line summary (§1.1 / §1.2): when to act, tonight's low, the first two names. "Before dark" on a
// frost or hard-freeze night (the pick link and the cover work need daylight), "Tonight" otherwise.
export function protectSummary({ tier, lowF, rows }) {
  const bits = [tier === 'frost' || tier === 'hardfreeze' ? 'Before dark' : 'Tonight']
  if (tier === 'hardfreeze') bits.push('hard freeze')
  if (lowF != null) bits.push(`low ${lowF}°F`)
  const names = (rows || []).map((r) => r.name).filter(Boolean)
  if (names.length) bits.push(names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', '))
  return bits.join(' · ')
}

// A frost or hard-freeze night: the nights the pick link is shown on (§1.1; §1.2 has none).
export const pickNight = (tier) => tier === 'frost' || tier === 'hardfreeze'

// What this visit did, for an emptied section's summary: "All handled · 2 covered · 3 brought in".
const DONE_KINDS = [['covered', 'covered'], ['brought', 'brought in'], ['skipped', 'skipped']]
export function handledSummary(slice) {
  const n = { covered: 0, brought: 0, skipped: 0 }
  for (const d of Object.values(slice?.rowsDone || {})) if (n[d.kind] != null) n[d.kind]++
  for (const b of Object.values(slice?.batches || {})) if (b.kind === 'covered') n.covered += (b.created || []).length
  const parts = DONE_KINDS.filter(([k]) => n[k]).map(([k, w]) => `${n[k]} ${w}`)
  return ['All handled', ...parts].join(' · ')
}
