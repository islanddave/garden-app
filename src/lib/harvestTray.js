// src/lib/harvestTray.js
// V4-HARVTRAYVIEWPORT-001 — which weigh-in chips the harvest-session tray renders while COLLAPSED,
// and the geometry bound that stops it from owning the keyboard-shrunk viewport.
//
// THE DEFECT (Dave, this session): "I use it regularly. I love it. I do have issues with the
// reduced viewport size." Measured from the source CSS at 390px with real font advance widths
// (method + limits in the lane report), 14 chips wrap to 6-8 rows for typical planting names and
// 14 rows for long ones, so the tray card renders 387-499px — and up to 835px — against the
// ~500px layout viewport Chrome Android leaves once the keyboard is up. 77-100% of the screen,
// worst case 167%.
//
// TWO MECHANISMS, and the reason it is two:
//   1. HARVEST_TRAY_MAX_HEIGHT — a dvh-relative bound on the chip container. This is the
//      load-bearing half. A chip-COUNT cap alone cannot bound the height, because one long
//      planting name is one whole row: at 24-char names even 6 chips is 6 rows / 387px. Only a
//      height bound is safe against the data.
//   2. selectTrayChips + an explicit "Show N more" — so the COMMON case never has to scroll a
//      nested region at all, the tab order stays short for keyboard/AT users, and the hidden
//      count is stated rather than silently clipped.
//
// WHY dvh AND NOT A visualViewport READ. index.html ships interactive-widget=resizes-content
// (V4-KBVIEWPORT-001), so the soft keyboard shrinks the LAYOUT viewport and `dvh` re-resolves with
// it — PhotoLibrary.jsx:974 records the same mechanism measured at ~731px -> ~460px. That makes
// this a pure-CSS bound with no JS keyboard detection, no listener, and nothing to thrash on
// open/close. It is deliberately NOT useKeyboardChromeSuppressed(): that detector is contracted
// for CHROME VISIBILITY ONLY and "must never feed content positioning" (keyboardChrome.js:27-29),
// and its 300ms restore debounce would pop the tray open and shut as focus moves qty -> weight.
// It is also not the deleted `innerHeight - vv.height` inset arithmetic that
// noViewportInsetArithmetic.static.test.js guards — no JS reads any viewport here.
//
// The floor in the max() keeps the tray usable on a short landscape viewport (2 chip rows:
// 2*48 + 8). Browsers without dvh drop the whole declaration and fall back to the unbounded
// pre-change render — fail-open to today's behavior, never to a clipped tray.

export const HARVEST_TRAY_COLLAPSED_MAX = 6
export const HARVEST_TRAY_MAX_HEIGHT = 'max(104px, 28dvh)'

// Scrollport style for the chip container. overscrollBehavior 'contain' is MANDATORY and has the
// same rationale as PlantingSelect's listboxStyle and FilterChipRow's trayMaxHeight: a flick that
// runs off the end of the tray must not chain into the page and drag the form out from under the
// user mid-weigh.
export const harvestTrayScrollport = {
  maxHeight: HARVEST_TRAY_MAX_HEIGHT,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
}

function asSet(v) {
  return v instanceof Set ? v : new Set(v ?? [])
}

// Collapsed view = the chips carrying USER STATE (current + queued) ∪ the top-ranked remainder,
// filled not-done-first, capped at `max`.
//
// ORDER IS PRESERVED, NOT REGROUPED — the return is always a FILTER of `chips`, never a sort.
// The tray's order is the readiness rank; queue position is carried by the `· N` suffix instead.
// Hoisting current/queued to the front would make chips jump under the thumb as they are tapped,
// which costs more than it buys (same stability argument as FilterChipRow's bandOrder note).
//
// User-state chips are NEVER truncated: if current + queued alone exceed `max`, all of them still
// render. Hiding a chip the user just queued is the invisible-state trap the "More" affordance
// exists to avoid, not to cause.
export function selectTrayChips({
  chips = [],
  expanded = false,
  currentPlantId = '',
  queuedPlantIds,
  donePlantIds,
  max = HARVEST_TRAY_COLLAPSED_MAX,
} = {}) {
  if (expanded || chips.length <= max) return chips
  const queued = asSet(queuedPlantIds)
  const done = asSet(donePlantIds)
  const keep = new Set()
  for (const c of chips) {
    if (c.plant_id === currentPlantId || queued.has(c.plant_id)) keep.add(c.plant_id)
  }
  // Two fill passes so a not-yet-picked candidate always outranks an already-logged one for the
  // remaining slots — a done chip's information is already in the session ledger below.
  for (const wanted of [false, true]) {
    for (const c of chips) {
      if (keep.size >= max) break
      if (keep.has(c.plant_id) || done.has(c.plant_id) !== wanted) continue
      keep.add(c.plant_id)
    }
  }
  return chips.filter(c => keep.has(c.plant_id))
}
