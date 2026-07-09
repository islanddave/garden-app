// src/lib/plantingSequence.js
// PLANTING-PAGER — in-memory, cross-route paging sequence for the planting detail view.
//
// Mirrors the module-scoped nav-state idiom already used in Garden.jsx (lastSubtab /
// lastGardenScrollY): captured when a planting is opened from a Garden GROUP (a project-tree node
// or a facet group like Type→Peppers) and read by PlantingDetail to render a group-bounded
// prev/next pager. Deliberately NOT persisted — a hard refresh or an entry from Search / Favorites
// / ProjectDetail / a lineage link leaves no sequence, so the pager simply doesn't render (the
// page stays fully functional). This is why the sequence must be captured at tap-time: a planting
// can belong to MULTIPLE facet groups, so its "siblings" are ambiguous from the URL alone.
//
// Item shape: { projectId, plantingId, name }. Each item carries its OWN projectId because facet
// groups mix projects and the detail route (/projects/:id/plantings/:plantingId) + its ownership
// guard require the correct project segment per target.

let _seq = null // { items: [{ projectId, plantingId, name }], ctxLabel: string } | null

export function setPlantingSequence(seq) {
  _seq = seq && Array.isArray(seq.items) && seq.items.length > 0
    ? { items: seq.items, ctxLabel: seq.ctxLabel || '' }
    : null
}

export function getPlantingSequence() {
  return _seq
}

// Test hook — reset the singleton between tests.
export function __resetPlantingSequence() {
  _seq = null
}

// Resolve the pager view for a given plantingId against the current sequence.
// Returns null when there is no usable pager: no sequence, fewer than 2 items, or the current
// planting is not in the captured sequence (stale sequence, other-group entry, or a lineage jump
// out of the sequence). Callers treat null as "no pager, gestures/keys inert".
export function resolvePager(plantingId) {
  const seq = _seq
  if (!seq || !Array.isArray(seq.items) || seq.items.length < 2) return null
  const idx = seq.items.findIndex(i => String(i.plantingId) === String(plantingId))
  if (idx < 0) return null
  const n = seq.items.length
  const prev = seq.items[(idx - 1 + n) % n]
  const next = seq.items[(idx + 1) % n]
  return {
    index: idx,
    total: n,
    ctxLabel: seq.ctxLabel || '',
    current: seq.items[idx],
    prev,
    next,
    prevHref: `/projects/${prev.projectId}/plantings/${prev.plantingId}`,
    nextHref: `/projects/${next.projectId}/plantings/${next.plantingId}`,
  }
}

// Swipe geometry — exported so the wiring and the tests share one source of truth.
export const SWIPE_MIN_DX = 50 // px of horizontal travel before a swipe counts
export const SWIPE_AXIS_RATIO = 1.5 // |dx| must exceed |dy| * this to be "decisively horizontal"
export const EDGE_IGNORE_PX = 24 // cede this zone at BOTH screen edges to the OS back/forward gesture

// Pure swipe decision (DOM-independent → unit-testable; jsdom cannot deliver real touch).
//   dx, dy    : cumulative delta from pointerdown (x_end - x_start, y_end - y_start)
//   startX    : pointerdown clientX
//   viewportW : window.innerWidth (0/NaN → right-edge check skipped)
// Returns 'next' (drag left) | 'prev' (drag right) | 'none'.
export function resolveSwipe(dx, dy, startX, viewportW) {
  // Both edges are uncapturable OS gesture zones (iOS Safari edge back/forward; Android two-edge
  // back). Ceding them is the only mitigation — a JS handler cannot preventDefault the system swipe.
  if (startX <= EDGE_IGNORE_PX) return 'none'
  if (Number.isFinite(viewportW) && viewportW > 0 && startX >= viewportW - EDGE_IGNORE_PX) return 'none'
  if (Math.abs(dx) < SWIPE_MIN_DX) return 'none'
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return 'none' // not decisively horizontal
  return dx < 0 ? 'next' : 'prev'
}
