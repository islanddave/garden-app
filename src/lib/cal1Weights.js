// CAL-1 per-variety harvest-weight math — pure REFERENCE implementation (V4-CAL1HARV-001, crucible V100).
//
// NOT the runtime path. At harvest INSERT the lambda stores MEASURED grams only; ESTIMATED grams are
// computed ON-READ by the SQL view `cultivar_weight_derived` + the resolution join. This module locks the
// EXACT math the SQL must reproduce (so tests can assert expected values) and drives the seed generator's
// coverage preview. Keep in lockstep with migrations/v4-cal1-pervariety-001/0a-additive-ddl.sql.
//
// Dave's hard rule: NEVER emit a guessed conversion factor — a wrong number silently corrupts multi-season
// yield comparison; NULL beats a guess. That is why (a) the aggregate is count-weighted (unbiased for
// yield totals), (b) confidence is dispersion-based (a tight n=2 beats a scattered n=6), (c) a cultivar
// estimate requires min-n and (d) a high-variance crop with no usable samples resolves to NULL, not a
// crop-type average.
//
// (e) since V4-CAL1INDEP-001, min-n and dispersion are both measured over INDEPENDENT observations, not
// raw rows: duplicated rows describing one weighing used to give cv = 0 and buy the top confidence tier.
// See migrations/v4-cal1-indep-001/ — keep this file in lockstep with 0a-derived-v3.sql.

export const WEIGHT_UNITS = { g: 1, kg: 1000, lb: 453.592, oz: 28.3495 }
export const UNIT_VOCAB = ['lb', 'oz', 'kg', 'g', 'count', 'bunch', 'cup', 'head']
export const DEFAULT_MIN_N = 2
export const CV_HIGH = 0.15   // <= high confidence
export const CV_MEDIUM = 0.35 // <= medium; above = low

function usableSamples(samples) {
  return (samples || []).filter((s) => {
    const tg = Number(s?.total_grams)
    const uc = Number(s?.unit_count)
    return Number.isFinite(tg) && Number.isFinite(uc) && tg > 0 && uc > 0
  })
}

// Measured path: a harvest logged in a weight unit converts directly (mirrors the lambda factor table).
export function measuredGrams(unit, quantity) {
  const f = WEIGHT_UNITS[unit]
  if (f == null) return null
  const q = Number(quantity)
  if (!Number.isFinite(q) || q < 0) return null
  return q * f
}

// Count-weighted pooled ratio over non-voided samples of ONE (cultivar,unit): SUM(grams)/SUM(count).
// Unbiased for yield totals (total mass = ratio * count). Null if no usable samples.
export function pooledGramsPerUnit(samples) {
  let g = 0
  let c = 0
  for (const s of usableSamples(samples)) {
    g += Number(s.total_grams)
    c += Number(s.unit_count)
  }
  return c > 0 ? g / c : null
}

// Coefficient of variation of the per-sample ratios (dispersion / mixed-cultivar contamination signal).
// Uses the SAMPLE stddev (n-1), matching Postgres STDDEV_SAMP. Null when n < 2 or mean <= 0.
export function dispersionCV(samples) {
  const ratios = usableSamples(samples).map((s) => Number(s.total_grams) / Number(s.unit_count))
  const n = ratios.length
  if (n < 2) return null
  const mean = ratios.reduce((a, b) => a + b, 0) / n
  if (mean <= 0) return null
  const variance = ratios.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)
  return Math.sqrt(variance) / mean
}

// ── INDEPENDENCE GUARD (V4-CAL1INDEP-001) ─────────────────────────────────────────────────────────
// cv and COUNT(*) are both blind to whether rows describe DIFFERENT OBSERVATIONS. N rows carrying the
// same ratio give stddev exactly 0, hence cv 0, hence the top confidence tier — on a set that says
// nothing about dispersion. The two counts below restore the distinction the originals lost.

// Ratio rounded to 6 dp, so numeric-scale artifacts (3/2 vs 9/6) cannot split one ratio into two and
// silently re-open the hole this guard closes. Mirrors round(total_grams/unit_count, 6) in the view.
function ratioKey(s) {
  return Math.round((Number(s.total_grams) / Number(s.unit_count)) * 1e6) / 1e6
}

// The distinctness key for one sample: same instant AND same ratio => same observation, however many
// rows recorded it. A sample with no sampled_at keys on 'null', so ratio-identical untimed samples
// collapse to one — the conservative reading, and the same answer the SQL gives (sampled_at is NOT
// NULL there). An unparseable sampled_at keys on itself rather than throwing: this is the reference
// oracle for a view over user data, so bad input must degrade, not crash.
function observationKey(s) {
  const t = s?.sampled_at == null ? null : new Date(s.sampled_at).getTime()
  const at = t == null ? 'null' : Number.isNaN(t) ? `raw:${String(s.sampled_at)}` : String(t)
  return `${at}|${ratioKey(s)}`
}

// How many DIFFERENT answers have been seen. At 1 the sample stddev is 0 by construction, so cv
// carries no information and the top tier must be withheld.
export function distinctRatios(samples) {
  return new Set(usableSamples(samples).map(ratioKey)).size
}

// How many SEPARATE observations are actually held. Samples flagged `crossunit_twin` are excluded:
// one weighing logged under two units leaves a row in each of two (cultivar,unit) groups, we cannot
// tell which unit was the mistake, so neither may corroborate its own group — fail closed. That flag
// is cross-GROUP information and so cannot be derived here; the SQL view computes it and passes it
// through (see migrations/v4-cal1-indep-001/0a-derived-v3.sql, the `flagged` CTE).
export function independentN(samples) {
  const u = usableSamples(samples).filter((s) => !s?.crossunit_twin)
  return new Set(u.map(observationKey)).size
}

// Confidence tier from independence + dispersion + min-n. Repetition can no longer raise it:
//   independent < min-n     => 'provisional'  (one observation, whatever the row count says)
//   distinct ratios < 2     => 'medium' cap   (cv 0 is arithmetic, not evidence of tightness)
//   otherwise               => the cv ladder, unchanged
export function confidenceTier(samples, { minN = DEFAULT_MIN_N } = {}) {
  const usable = usableSamples(samples)
  if (independentN(usable) < minN) return 'provisional'
  if (distinctRatios(usable) < 2) return 'medium'
  const cv = dispersionCV(usable)
  if (cv == null) return 'provisional'
  if (cv <= CV_HIGH) return 'high'
  if (cv <= CV_MEDIUM) return 'medium'
  return 'low'
}

// Mirrors one row of the cultivar_weight_derived VIEW for a single (cultivar,unit). Null if no usable
// samples (=> the view emits no row for that key => LEFT JOIN yields NULL => fallback/NULL downstream).
// sample_n keeps its original meaning (raw usable row count); independent_n is the honest count.
export function deriveCultivarWeight(samples, { minN = DEFAULT_MIN_N } = {}) {
  const usable = usableSamples(samples)
  const grams_per_unit = pooledGramsPerUnit(usable)
  if (grams_per_unit == null) return null
  const independent_n = independentN(usable)
  return {
    grams_per_unit,
    sample_n: usable.length,
    total_units: usable.reduce((a, s) => a + Number(s.unit_count), 0),
    cv: dispersionCV(usable),
    confidence: confidenceTier(usable, { minN }),
    usable_for_comparison: independent_n >= minN,
    independent_n,
    distinct_ratios: distinctRatios(usable),
  }
}

// Resolution order for an ESTIMATED harvest weight (on-read). Measured harvests bypass this (measuredGrams).
// `derived` = deriveCultivarWeight(...) for this harvest's (cultivar,unit), or null.
// Returns { grams, basis } with basis in {'cultivar','crop_type'}, or { grams:null, basis:null } (NULL beats
// a guess: a high-variance crop with no usable cultivar samples gets NO estimate).
export function resolveEstimatedWeight({
  quantity,
  derived = null,
  cropTypeGramsPerUnit = null,
  varietyGramsRequired = true,
} = {}) {
  const q = Number(quantity)
  if (!Number.isFinite(q) || q < 0) return { grams: null, basis: null }
  if (derived && derived.usable_for_comparison && derived.grams_per_unit > 0) {
    return { grams: q * derived.grams_per_unit, basis: 'cultivar' }
  }
  if (!varietyGramsRequired && Number(cropTypeGramsPerUnit) > 0) {
    return { grams: q * Number(cropTypeGramsPerUnit), basis: 'crop_type' }
  }
  return { grams: null, basis: null }
}
