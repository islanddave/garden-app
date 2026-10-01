// src/components/planting/plantingKitchen.js
// B′ release 3 — the planting page's kitchen lists (V4 §2.5 "Planting page"), the PURE half.
// Reads GET /api/kitchen-batches?plant_id= → { batches, kept_fresh }. Everything here is a LIST — never a
// sum, a count headline or a percentage (V4 §2.5; the reward-UX rule: ambient recognition only).
//
//   · "from <batch> →" — a single-planting batch whose jars already show in the planting's put-up list
//     reads as a link on THOSE jar rows, not as a second row of its own;
//   · every other batch that used the planting (a garden line, or stock drawn from it) is listed once;
//   · each carries its "Next time…" lines (batch: its noted rows; a jar or an item: its notes' lines).
// PURE.

export const plantingBatchesPath = (plantId) => `/api/kitchen-batches?plant_id=${encodeURIComponent(plantId)}`
export const batchHref = (id) => `/put-up?batch=${encodeURIComponent(id)}`

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
