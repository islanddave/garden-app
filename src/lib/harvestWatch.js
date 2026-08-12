// V4-HARVSURFACE-001 Slice 1 — the "worth checking" WATCH LIST (Section 2 of the two-section Today
// harvest surface; design `harvest-two-section-design-V100-20260811.md` §3).
//
// THE VOICE RULE IS THE FEATURE. Every string this module and its component produce is in the CHECK
// form — "start checking X", "look for Y" — and never in the assertion form ("X is ready", "your
// window opened"). That is not politeness. Ripeness estimates here are 11.8% calibrated with a −22d
// median error, so an assertion is wrong most of the time; a wrong check-prompt costs one glance,
// a wrong readiness claim costs trust in the whole surface (§3.1, unanimous panel + Dave-approved).
// A row may therefore be wrong about TIMING and still be exactly right about WHAT TO LOOK AT — which
// is why its value does not depend on the calibration number at all.
//
// PURE, like harvestReadiness.js: no `new Date()` anywhere. `watching_since` arrives from the server
// as a reporting-zone date string and is formatted by string surgery, never through a Date object
// (`new Date('2026-08-04')` parses as midnight UTC and renders Aug 3 in America/New_York — L-107).

// §3.5: "Cap the visible group at 5 — a nine-row declarative group is an inventory again."
export const MAX_WATCH_ROWS = 5

const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// §3.5: "Show 'checking since Aug 4' rather than a freshness badge." A freshness badge implies a
// transition just happened; a since-date states a STANDING watch, which is the honest grammar for a
// calendar-inferred row. No year — the queue drains at frost, so every row is this season.
export function watchingSinceLabel(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ''
  const mi = Number(m[2]) - 1
  if (mi < 0 || mi > 11) return ''
  return `Checking since ${_MONTHS[mi]} ${Number(m[3])}`
}

// Newest first (§3.5). ISO date strings sort lexicographically, so no Date object is needed for the
// comparison either. Ties break on name so ordering is deterministic across renders.
//
// A row with no `plant_id` is dropped rather than rendered keyless: the dismissal writes against
// plant_id, so an id-less row would present a control that cannot do anything.
export function rankWatchCandidates(candidates) {
  if (!Array.isArray(candidates)) return []
  return candidates
    .filter(c => c && c.plant_id != null)
    .slice()
    .sort((a, b) =>
      String(b.watching_since ?? '').localeCompare(String(a.watching_since ?? '')) ||
      String(a.name ?? '').localeCompare(String(b.name ?? '')))
}

// THE OBSERVABLE (§3.2 — "the unlock"). The row must name the specific thing Dave's eyes and fingers
// check, because naming a perceptual target reduces an open-ended "is this ready?" into a yes/no
// perceptual judgment — and the open-ended question is exactly what produces walk-out-and-freeze.
//
// We take the FIRST window point's `at` — the name of the state at which the window OPENS, which is
// precisely what "start checking" targets. Deliberately NOT `look` (median ~200 chars) or
// `ripe_vs_unripe` (median 543): a five-row declarative group carrying five essays is the 28-row
// inventory Dave rejected, wearing different clothes. The full window already renders on the planting
// card (CropCard's HarvestWindow) one navigation away; this surface is the DIFF, not the reference.
//
// PROVENANCE IS LABELLED, NEVER IMPLIED (colour-window canon §4/§9: "a labelled derivation is not a
// confident claim"). Two cases get a short qualifier instead of the record's full 374-char caveat,
// which would not survive on a compact row:
//   - crop-level fallback  → the mechanic for the crop, not this cultivar's colour sequence
//   - confidence 'low'     → cultivar record derived from its market class
// Same grain rule as CropCard: the cultivar record wins when present, the crop mechanic fills in.
export function observableFrom(resolved) {
  const rec = resolved?.cultivar ?? resolved?.crop ?? null
  if (!rec) return null
  const pts = Array.isArray(rec.window) ? rec.window : []
  const at = typeof pts[0]?.at === 'string' ? pts[0].at.trim() : ''
  if (!at) return null
  const fromCrop = !resolved.cultivar
  const qualifier = fromCrop
    ? 'general guidance for this crop, not this variety'
    : (rec.confidence === 'low' ? 'derived from the variety type' : null)
  return { at, qualifier }
}
