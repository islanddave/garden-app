// V4-PHOTOQUICK-001 — hand a File captured by a TRUSTED tap on the planting page to EventNew,
// which mounts on the next route. Two constraints force this park-and-claim seam:
//   1. a URL cannot carry a File object, and
//   2. iOS Safari / standalone PWA suppresses a file picker opened from a post-navigation effect
//      (the tap gesture was consumed by the route change) — so the picker MUST fire synchronously
//      inside the tap handler on the planting page, and the resulting File parked here for the
//      freshly-mounted EventNew to claim exactly once.
// Module-level state survives the SPA route change (same JS context); it is intentionally NOT
// persisted (a File in memory only, cleared on claim).
let held = null

export function setPendingCapture(file) { held = file || null }

export function takePendingCapture() {
  const f = held
  held = null
  return f
}
