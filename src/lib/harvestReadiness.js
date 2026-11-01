// Harvest-readiness predicate. PURE: every time input arrives as an argument (`etDoy`, and
// `days_since_last_harvest` already computed server-side in America/New_York). NO internal
// `new Date()` — jsdom tests would flake across a midnight boundary, and the reporting zone is the
// Lambda's, not the browser's.
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

// STALENESS CEILING.
// A candidate this far past its own cadence is evidence the MODEL is wrong about that plant — it has
// gone dormant, finished for the season, been pulled, or carries a mis-set repeat_interval_days — not
// evidence the plant is urgent. This matters more here than anywhere else because rankHarvestReady
// sorts by overdue_ratio DESCENDING, so without a ceiling the model promotes its own
// least-trustworthy rows to the top of a 5-row band (a bramble already closed out as `dormant` ranked
// #1 at a 10.5x ratio).
//
// 3 is a deliberately loose ceiling: it keeps a genuinely-missed pick (a 2-day cucumber left 5 days)
// while rejecting the order-of-magnitude rows. It is a CLIENT-side sanity bound.
// `dormant` is excluded SERVER-side (lambda/events/index.js filters status NOT IN
// ('failed','ended','dormant')) and never reaches this payload; the ratio bound is for a mis-set
// repeat_interval_days, not a dormant backstop. The payload carries no `status` field, so a
// client-side dormant filter is not constructible here, which is why the server-side gate is the
// load-bearing one.
export const MAX_OVERDUE_RATIO = 3

// ABSOLUTE FLOOR. A pure ratio makes the grace period scale with the crop's own interval, which
// inverts the urgency it is supposed to encode: a 3-day tomato gets 9 days before it is called
// finished, a 30-day bay laurel gets 90 — and the tomato is the one dropping a spoiling, splitting
// crop every day it is missed. The ratio was fitted to the POOLED gap distribution across intervals
// spanning 1–30 days; tomato's own p99 is 4.33 (13 days), well past it.
//
// Measured on live data, not inferred: of 8 ceiling-ejected plantings 6 were wrong (peak-season
// tomatoes at 10–14 days that had been tended three days earlier, plus a 22-day pepper), and across
// all recorded history TEN consecutive-harvest gaps exceeded ratio 3 and ALL TEN ended in a real
// pick. The harm lands on the LOGGING path: EventNew.jsx consumes the flat (un-rolled-up) ranking, so
// each ejected planting is individually absent from the harvest tray, and the recency fallback cannot
// recover them (its 50-row page reaches back only 3 days).
//
// A suppressed row generates no ready_impression, so this failure mode is INVISIBLE to the very
// telemetry built to calibrate this model. It could only be found by re-deriving the predicate
// against prod. Do not expect the impression series to surface a regression here.
//
// 18 is the largest floor that restores all five tomatoes while preserving BOTH founding regression
// cases: a bramble (interval 2, 21 days) stays rejected because 21 > 18, and two genuinely stale
// scallions (interval 14, 75 days) stay rejected. Sweep: F=12 restores 3 of 5, F=15 restores 5, F=18
// cuts false negatives from 63 planting-days/10 gaps to 20/1, F=21 re-admits the bramble and turns its
// test red. The surviving suppression is a strawberry 38-day gap — a real June-bearing season break
// that SHOULD stay suppressed.
//
// THE BRAMBLE MARGIN IS 3 DAYS, NOT COMFORTABLE. Raising this constant past 20 silently re-admits the
// row the ceiling was built for. If more headroom is ever wanted, bound the floor by its own max
// ratio (GREATEST(3·iv, LEAST(F, K·iv))) rather than nudging F — that variant was NOT measured across
// the corpus, so it is not a drop-in.
//
// DELIBERATELY NOT AN UPPER CAP. LEAST(3·iv, C) would fix the bay-laurel end, but no planting on prod
// with 3·iv > 45 has ever been harvested and the model is evidence-only (zero prior picks ⇒ never a
// candidate at any ceiling), so a cap would ship as an unvalidatable constant. Revisit only if a bay
// or lemongrass is picked for the first time.
//
// DELIBERATELY NOT SEASON-SENSITIVE. The defect occurs at PEAK season, when a frost term would be
// inert. Note the ~Nov 8 ten-hour-daylength wall cuts the OTHER way for the frost-hardy set (they
// survive frost but stop regrowing, so a cut_and_come_again interval becomes meaningless and the
// ceiling should TIGHTEN) — conflating the two would produce a constant wrong in both seasons.
// Mirrored (defence-in-depth) as HARVEST_STALE_ABSOLUTE_FLOOR_DAYS in lambda/events/index.js and
// pinned in lockstep by harvest-ready.test.js — see MAX_OVERDUE_RATIO's note on why divergence is
// not merely untidy.
export const MIN_STALE_DAYS = 18

// The partition key stamped on every impression this model produces
// (public.ready_impression.model_version). It lives HERE, beside the predicate, because this model
// runs CLIENT-side: unlike the watch band the server cannot reconstruct what was ranked, so the
// browser build that made the claim is the honest provenance. BUMP IT whenever isReadyToPick,
// rankHarvestReady or MAX_OVERDUE_RATIO changes behaviour — an impression joined across a definition
// change is a rate computed over two different models. uq_ready_impression_day is (user_id, plant_id,
// shown_on, region) and does NOT include model_version, so a bump creates no duplicates; the deploy
// day gets one day of mixed attribution under ON CONFLICT DO NOTHING, which is not data loss.
export const READY_MODEL_VERSION = 'ready-v2'

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
  // Staleness ceiling — see MAX_OVERDUE_RATIO and MIN_STALE_DAYS. Placed AFTER the habit/interval/
  // negative guards so the NULL-means-UNKNOWN and `single`-is-terminal contracts still decide first
  // and this only ever narrows. Stated as a multiplication rather than `days / interval > ratio` so
  // the two arms compose in one comparison and the shape matches the server's GREATEST(); interval > 0
  // is already guaranteed above, so the two forms are equivalent.
  if (Number(days) > Math.max(MAX_OVERDUE_RATIO * Number(interval), MIN_STALE_DAYS)) return false
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

// ── CROP ROLLUP ──────────────────────────────────────────────────────────────────────────────────
// PRESENTATION ONLY, and deliberately NOT part of the versioned model above. It runs on the OUTPUT of
// rankHarvestReady, changes no predicate, no score and no ordering, so READY_MODEL_VERSION does NOT
// move: a gratuitous bump fragments the ready_impression series and drops rows on an ON CONFLICT the
// deploy day it lands, for zero gain. It also keeps the ranker's return shape untouched, so
// EventNew.jsx's live harvest tray — the only other consumer — is unaffected.
//
// THE DEFECT IT FIXES IS GRANULARITY, NOT RANKING. A row is a PLANTING, so a garden with many pepper
// and tomato plantings against fewer herb plantings lets two crops hold every visible slot. Measured:
// 93.3% of the fruiting group's slot share was pure population count and only 6.7% came from the
// ranking function, so overdue_ratio is innocent. One row per crop delivers what a second group,
// heading or sort key would, with one heading and no model change.
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
    // The crop's own last pick is its MOST RECENT one, not the representative's. The representative is
    // the most OVERDUE member, so using its age would tell the grower a crop picked yesterday has gone
    // 8 days untouched — a claim the row would be making about plantings it has folded in.
    if (Number.isFinite(days) && (held.crop_days_since_last_harvest == null || days < held.crop_days_since_last_harvest)) {
      held.crop_days_since_last_harvest = days
    }
  }
  return [...byCrop.values()]
}

// The rolled row's second line. Count in the LABEL, never a pill — the magnitude is what the grower
// needs to decide whether to carry a basket, not a badge. A crop covering one planting reads
// byte-identically to the un-rolled row, so the rollup is invisible on a one-planting crop.
export function cropSubLabel(row) {
  const picked = lastPickedLabel(row?.crop_days_since_last_harvest ?? row?.days_since_last_harvest)
  const n = Number(row?.crop_planting_count)
  if (!Number.isFinite(n) || n <= 1) return picked
  return picked ? `${n} plantings · ${picked}` : `${n} plantings`
}
