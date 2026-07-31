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

// Confidence tier from dispersion + min-n. < min-n => 'provisional' (not row-count-based rigor theater).
export function confidenceTier(samples, { minN = DEFAULT_MIN_N } = {}) {
  const usable = usableSamples(samples)
  if (usable.length < minN) return 'provisional'
  const cv = dispersionCV(usable)
  if (cv == null) return 'provisional'
  if (cv <= CV_HIGH) return 'high'
  if (cv <= CV_MEDIUM) return 'medium'
  return 'low'
}

// Mirrors one row of the cultivar_weight_derived VIEW for a single (cultivar,unit). Null if no usable
// samples (=> the view emits no row for that key => LEFT JOIN yields NULL => fallback/NULL downstream).
export function deriveCultivarWeight(samples, { minN = DEFAULT_MIN_N } = {}) {
  const usable = usableSamples(samples)
  const grams_per_unit = pooledGramsPerUnit(usable)
  if (grams_per_unit == null) return null
  return {
    grams_per_unit,
    sample_n: usable.length,
    total_units: usable.reduce((a, s) => a + Number(s.unit_count), 0),
    cv: dispersionCV(usable),
    confidence: confidenceTier(usable, { minN }),
    usable_for_comparison: usable.length >= minN,
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
