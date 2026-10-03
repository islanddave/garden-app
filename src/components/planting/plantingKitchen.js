// src/components/planting/plantingKitchen.js
// B′ release 3 — the planting page's kitchen lists (V4 §2.5 "Planting page"), the PURE half; and (Put-Up R2a)
// the What its "Put something up" door opens with.
// Reads GET /api/kitchen-batches?plant_id= → { batches, kept_fresh }. Everything here is a LIST — never a
// sum, a count headline or a percentage (V4 §2.5; the reward-UX rule: ambient recognition only).
//
//   · "from <batch> →" — a single-planting batch whose jars already show in the planting's put-up list
//     reads as a link on THOSE jar rows, not as a second row of its own;
//   · every other batch that used the planting (a garden line, or stock drawn from it) is listed once;
//   · each carries its "Next time…" lines (batch: its noted rows; a jar or an item: its notes' lines).
//
// Put-Up UX pass R1 — the put-up rows say what the Pantry says about the same jar: how many are left, and
// the discard-date sentence from the one module every surface says it in (putup/jarWords.js discardWords),
// so cured and cellared produce keep "use by" and everything else says "discard by". The words below read
// the planting's own read (whats-put-up's record, jarRules.js projectRow), not the Pantry's row.
// PURE.
import { discardWords } from '../putup/jarWords.js'
import { gramsOf } from '../putup/fermentMath.js'
import { withFrom } from '../putup/origin.js'
// The engine's own list, imported (as pantry/pantryRows.js imports it), so there is no copy to drift.
import { HOUSE_SOURCED_SHELF_LIFE } from '../../../lambda/preservation/shelfLife.js'

export const plantingBatchesPath = (plantId) => `/api/kitchen-batches?plant_id=${encodeURIComponent(plantId)}`
export const batchHref = (id) => `/put-up?batch=${encodeURIComponent(id)}`

// The router state a link from the planting page to a batch carries: where it came from, so the batch's
// Back can say "← <planting name>" and go back there (putup/origin.js). Built from nothing — this page
// never spreads its own route state into /put-up. null when the planting has no name to say.
export const batchLinkState = (planting) => withFrom(null, { label: planting?.name })

// Put-Up R2a, lane K — the What the planting page's "Put something up" door opens with: THIS planting, so a
// save records its plant_id, crop and variety exactly as the old Log form's prefill did. The name is the
// planting's own, else its variety's (plantingWaveLabel's fallback, forms/PlantingSelect.jsx, without its
// "Planting" word, which would be saved as the put-up's name). A blank name is never seeded: the door would
// refuse it at Save. null when there is no id or no name to say — then the page offers no door at all.
export function doorWhatOf(planting) {
  if (planting?.id == null) return null
  const name = String(planting.name ?? '').trim() || String(planting.variety_ref?.name ?? '').trim()
  if (!name) return null
  const what = { source: 'planting', name, plant_id: planting.id }
  const crop = planting.variety_ref?.crop_type_slug
  const variety = planting.variety_id ?? planting.variety_ref?.id
  if (crop) what.crop_type_slug = crop
  if (variety) what.variety_id = variety
  return what
}

// jar id → the single-planting batch it came from.
export function batchByJar(batches) {
  const m = new Map()
  for (const b of batches ?? []) {
    if (!b?.single_planting) continue
    for (const id of b.output_ids ?? []) if (!m.has(id)) m.set(id, b)
  }
  return m
}

// The batches listed on their own: all but a single-planting batch with a jar already shown.
export function listedBatches(batches, shownJarIds = []) {
  const shown = new Set(shownJarIds)
  return (batches ?? []).filter(b => !(b?.single_planting && (b.output_ids ?? []).some(id => shown.has(id))))
}

export const batchNextTime = (b) => (Array.isArray(b?.next_time) ? b.next_time.map(n => n?.note).filter(Boolean) : [])

// How the batch used the planting, in words.
export function usedWords(b) {
  if (b?.used_via === 'jar') return 'used some of what was put up from it'
  if (b?.used_via === 'both') return 'used it fresh and from what was put up'
  return 'used it fresh'
}

// ── a put-up row's words ─────────────────────────────────────────────────────────────────────────
// A row is USED UP only on an explicit zero. NULL remaining_count means the count was never tracked, not
// that the jar is gone — the same reading the endpoint's own default filter uses
// (`remaining_count IS NULL OR remaining_count > 0`), so the two cannot disagree about which rows the
// un-flagged call would have returned.
export const isUsedUp = (r) => r?.remaining_count != null && Number(r.remaining_count) <= 0

// How many are left, on EVERY row still in the Pantry: "3 left" for counted stock, "about 412 g left" for a
// weighed bag (one container in a mass unit; its grams are what was last weighed, else what it held). The
// Pantry row's words. null when nothing can be said.
export function leftWords(r) {
  if (!r) return null
  if (r.stock_mode === 'weighed') {
    const g = r.remaining_amount != null ? Number(r.remaining_amount) : gramsOf(r.quantity_value, r.quantity_unit)
    if (g != null && Number.isFinite(g)) return `about ${Math.round(g)} g left`
  }
  const n = r.remaining_count ?? r.package_count
  if (n == null || !Number.isFinite(Number(n))) return null
  return `${Number(n)} left`
}

// A jar of a house-sourced method written before a basis was stored has none on the wire, and still says
// "house estimate", never nothing (FOODSAFETY-RULING-V101: a house date is told apart on the surface).
const HOUSE_METHODS = new Set(HOUSE_SOURCED_SHELF_LIFE)
// The discard-date sentence, stated once, in jarWords' words. null when there is nothing to say (no date
// and no basis), and always null for a used-up row: a finished jar is never asked to be used soon.
export function plantingDiscardWords(r, now = new Date()) {
  if (!r || isUsedUp(r)) return null
  const date = r.use_by_target ?? null
  const basis = r.use_by_basis ?? (date && HOUSE_METHODS.has(r.method) ? 'house' : null)
  return discardWords({ date, basis, method: r.method ?? null, kind: r.storage_kind ?? null, status: r.use_by_status ?? null, now })
}

// The server's classification, read and never re-decided: inside the use-soon window, or past the date.
export const isSoonOrPast = (r) => !isUsedUp(r) && (r?.use_by_status === 'use_soon' || r?.use_by_status === 'past_use_by')
