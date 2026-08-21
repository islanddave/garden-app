// V4-HARVESTSURF-001 — harvest-readiness predicate. PURE: every time input arrives as an argument
// (`etDoy`, and `days_since_last_harvest` already computed server-side in America/New_York). NO
// internal `new Date()` — jsdom tests would flake across a midnight boundary, and the reporting zone
// is the Lambda's, not the browser's.
//
// Evidence-only, never prediction: a candidate must already have ≥1 prior harvest (the server
// enforces that join). NULL means UNKNOWN and must NOT fire — a crop with no repeat_interval_days or
// no harvest_habit is silently skipped rather than nagged about.

// DOY window is a SUPPRESSOR, not a trigger. The CHECK constraint permits start > end, which means a
// wrap-around (Dec→Feb) window, so both orderings are handled. Absent window (both NULL) => no
// suppression. Asparagus is the motivating case: a readiness nudge after ~Jun 15 is actively harmful
// (cutting damages the crown), so out-of-window must be silent.
export function inHarvestWindow(doy, startDoy, endDoy) {
  if (startDoy == null || endDoy == null) return true
  if (!Number.isFinite(doy)) return false
  return startDoy <= endDoy
    ? doy >= startDoy && doy <= endDoy
    : doy >= startDoy || doy <= endDoy
}

const REPEATING_HABITS = new Set(['repeat', 'cut_and_come_again'])

// STALENESS CEILING (BD-001 / harvest-window crucible V100 §6.1, 2026-08-04).
// A candidate this far past its own cadence is evidence the MODEL is wrong about that plant — it has
// gone dormant, finished for the season, been pulled, or carries a mis-set repeat_interval_days — not
// evidence the plant is urgent. The distinction matters here more than anywhere else because
// rankHarvestReady sorts by overdue_ratio DESCENDING, so without a ceiling the model promotes its own
// least-trustworthy rows to the top of a 5-row band.
//
// The motivating row, measured on live prod data 2026-08-04: Wild Wineberry, repeat_interval_days=2,
// 21 days since the last pick => ratio 10.5, rank #1 of 18 candidates — on a bramble Dave had already
// closed out with a `status_change` to `dormant` on 07-31. Three of the top five were that class.
// With the ceiling the candidate set goes 18 -> 13 and the top five becomes Aster Blackberry (2.0),
// Purple Blush Tomatillo (1.67), Bush Early Girl (1.67), Sunray (1.33), Italian Parsley (1.08):
// five actively-producing plants, all picked in the last 4-13 days.
//
// 3 is a deliberately loose ceiling: it keeps a genuinely-missed pick (a 2-day cucumber left 5 days)
// while rejecting the order-of-magnitude rows. It is a CLIENT-side sanity bound.
// CORRECTED 2026-08-10 — the paragraph that stood here was STALE and said the opposite of the truth.
// It claimed `lambda/events/index.js` filters only `status NOT IN ('failed','ended')` so "`dormant`
// still sails through into the payload". That stopped being true at `b5a347b` (2026-08-04):
// `lambda/events/index.js:893` now reads `NOT IN ('failed','ended','dormant')`, so dormant is excluded
// SERVER-side and never reaches this payload. The old text told a future maintainer the server was
// broken when it was not — worse than no comment. The ratio bound remains useful for its own reason
// (mis-set repeat_interval_days), not as a dormant backstop.
// Still true and worth keeping: the payload carries no `status` field, so a client-side dormant filter
// is not constructible here — which is exactly why the server-side gate is the load-bearing one.
export const MAX_OVERDUE_RATIO = 3

// V4-READYTRAYIMPRESSION-001 — the partition key stamped on every impression this model produces
// (public.ready_impression.model_version). It lives HERE, beside the predicate, because this model
// runs CLIENT-side: unlike the watch band the server cannot reconstruct what was ranked, so the
// browser build that made the claim is the honest provenance. BUMP IT whenever isReadyToPick,
// rankHarvestReady or MAX_OVERDUE_RATIO changes behaviour — an impression joined across a
// definition change is a rate computed over two different models. Mirrored (fallback only) in
// lambda/harvests/ready-impression.js, pinned in lockstep by ready-impression.test.js.
export const READY_MODEL_VERSION = 'ready-v1'

export function isReadyToPick(c, etDoy) {
  if (!c) return false
  const interval = c.repeat_interval_days
  if (interval == null || !Number.isFinite(Number(interval)) || Number(interval) <= 0) return false
  // 'single' is a terminal harvest — firing on it would nag forever.
  if (!REPEATING_HABITS.has(c.harvest_habit)) return false
  const days = c.days_since_last_harvest
  if (days == null || !Number.isFinite(Number(days))) return false
  // Clock-skew guard: a future-dated harvest yields a negative age and must never fire.
  if (Number(days) < 0) return false
  if (Number(days) < Number(interval)) return false
  // Staleness ceiling — see MAX_OVERDUE_RATIO. Placed AFTER the habit/interval/negative guards so the
  // NULL-means-UNKNOWN and `single`-is-terminal contracts still decide first and this only ever narrows.
  if (Number(days) / Number(interval) > MAX_OVERDUE_RATIO) return false
  return inHarvestWindow(etDoy, c.harvest_season_start_doy, c.harvest_season_end_doy)
}

export function overdueRatio(c) {
  const interval = Number(c?.repeat_interval_days)
  if (!Number.isFinite(interval) || interval <= 0) return 0
  return Number(c.days_since_last_harvest) / interval
}

// Eligible candidates, most-overdue first. Ties break on days_since (then name) so ordering is
// deterministic across renders.
export function rankHarvestReady(candidates, etDoy) {
  if (!Array.isArray(candidates)) return []
  return candidates
    .filter(c => isReadyToPick(c, etDoy))
    .map(c => ({ ...c, overdue_ratio: overdueRatio(c) }))
    .sort((a, b) =>
      b.overdue_ratio - a.overdue_ratio ||
      Number(b.days_since_last_harvest) - Number(a.days_since_last_harvest) ||
      String(a.name || '').localeCompare(String(b.name || '')))
}

export function lastPickedLabel(days) {
  const n = Number(days)
  if (!Number.isFinite(n)) return ''
  if (n === 0) return 'last picked today'
  if (n === 1) return 'last picked 1 day ago'
  return `last picked ${n} days ago`
}

// ── CROP ROLLUP (V4-HARVSURFACE-001, 7-seat crucible 2026-08-20) ─────────────────────────────────
// PRESENTATION ONLY, and deliberately NOT part of the versioned model above. It runs on the OUTPUT of
// rankHarvestReady, changes no predicate, no score and no ordering, so READY_MODEL_VERSION does NOT
// move: two seats measured that a gratuitous bump fragments the 46-row ready_impression series and
// drops rows on an ON CONFLICT the deploy day it lands, for zero gain. It also keeps the ranker's
// return shape untouched, so EventNew.jsx's live harvest tray — the only other consumer — is unaffected.
//
// THE DEFECT IT FIXES IS GRANULARITY, NOT RANKING. A row is a PLANTING, and Dave runs 10 pepper and
// 7 tomato plantings against 14 herb plantings, so two crops can hold every visible slot. Measured on
// the binding days: 93.3% of the fruiting group's slot share is pure population count and only 6.7%
// comes from the ranking function — overdue_ratio is innocent. Three seats independently rejected a
// second group, a second heading and a second sort key; one row per crop delivers what the split was
// for (herbs at 3-of-5 on 15 of 18 days, never 0) with one heading and no model change.
//
// ORDER IS INHERITED, NEVER RECOMPUTED. The first member of a crop in the already-ranked list wins
// that crop's position, so crops sort by their best member's overdue_ratio exactly as before. A Map
// preserves insertion order, which is what makes that true without a second sort. Alphabetical was
// measured and rejected: it promotes Blackberry — a deliberately-unmanaged legacy perennial sitting
// last of 29 on prod — 26 places into a visible slot.
//
// NULL KEY FALLS BACK TO THE PLANTING. crop_type_slug is non-null by construction in the payload (an
// INNER JOIN on ct.slug = pv.crop_type_slug), so this only fires on a malformed response — and there
// it must degrade to today's per-planting rows rather than collapsing unrelated plantings under one
// arbitrary crop name. Same idiom as selectWatchDisplay's projectless key in harvestWatch.js.
export function rollUpByCrop(ranked) {
  if (!Array.isArray(ranked)) return []
  const byCrop = new Map()
  for (const c of ranked) {
    if (!c) continue
    const key = c.crop_type_slug ?? `plant:${c.plant_id}`
    const days = Number(c.days_since_last_harvest)
    const held = byCrop.get(key)
    if (!held) {
      byCrop.set(key, {
        ...c,
        crop_planting_count: 1,
        crop_days_since_last_harvest: Number.isFinite(days) ? days : null,
      })
      continue
    }
    held.crop_planting_count += 1
    // The crop's own last pick is its MOST RECENT one, not the representative's. The representative
    // is the most OVERDUE member, so using its age would tell Dave a crop he picked yesterday has
    // gone 8 days untouched — a claim the row would be making about plantings it has folded in.
    if (Number.isFinite(days) && (held.crop_days_since_last_harvest == null || days < held.crop_days_since_last_harvest)) {
      held.crop_days_since_last_harvest = days
    }
  }
  return [...byCrop.values()]
}

// The rolled row's second line. Count in the LABEL, never a pill (Reward-UX V102 / panel Q1) — the
// magnitude is what Dave needs to decide whether to carry a basket, not a badge. A crop covering one
// planting reads byte-identically to what shipped, so the rollup is invisible on a one-planting crop.
export function cropSubLabel(row) {
  const picked = lastPickedLabel(row?.crop_days_since_last_harvest ?? row?.days_since_last_harvest)
  const n = Number(row?.crop_planting_count)
  if (!Number.isFinite(n) || n <= 1) return picked
  return picked ? `${n} plantings · ${picked}` : `${n} plantings`
}
