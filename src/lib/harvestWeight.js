// V4-HARVWEIGHTREAD-001 — the harvest-weight READ model, as pure functions.
//
// Weight has been derived server-side since V4-HARVWEIGHTGAP-001 (395 of 397 live harvests carry
// weight_grams), but it rendered in exactly one place: the EventDetail EDIT form. You had to tap
// Edit on a single harvest to see it at all. This module is the shared vocabulary the fan-out needs,
// and it lives in src/lib because that IS the instrumented tree (src/pages is not in
// coverage.include) — the same split backNav.js/decideBack and scrollRestore.js use.
//
// SCOPE BOUNDARY, deliberate: the POLICY question — whether an un-sampled variety may fall back to
// its crop's average — is decided by resolve_harvest_weight's tier ladder in SQL, not here. This
// module never invents a number. It reports what the resolver produced, or says plainly that there
// isn't one. Anything else would let the client and the database disagree about a total.

// Where an ESTIMATED weight came from, in Dave-facing words. Keyed on harvest.weight_basis as
// produced by public.resolve_harvest_weight (migrations/v4-harvbasis-sample-001/).
//
// DELIBERATELY NOT A BARE MAP LOOKUP — the fallback is the point. weight_basis is a server-derived
// enum that has grown twice (v2 introduced it, v4 added 'cultivar_sample') and can grow again; an
// unhandled value in a switch or a map miss renders `undefined` into the sentence and is exactly
// the silent read-path failure this feature was audited for. Anything unrecognised — a future
// value, a null, or a legacy row — degrades to the generic wording, which is true of every estimate.
export const ESTIMATE_SOURCE_COPY = {
  // Derived from Dave's OWN weighings of this cultivar (resolver tiers 3 and 5).
  cultivar_sample: 'Currently estimated from your own weighings of this variety.',
  // The CURATED catalogue reference for the variety (tier 4). Rows written before
  // v4-harvbasis-sample-001 carry 'cultivar' even where they were sample-backed — history was
  // deliberately not backfilled, so this wording is approximate for pre-2026-08 harvests.
  cultivar:        'Currently estimated from this variety’s typical weight.',
  // A crop-level average, used only where the crop permits it (tier 6).
  crop_type:       'Currently estimated from a typical weight for this crop.',
}
export const ESTIMATE_SOURCE_FALLBACK = 'Currently estimated.'
export const estimateSourceCopy = basis =>
  ESTIMATE_SOURCE_COPY[basis] ?? ESTIMATE_SOURCE_FALLBACK

// V4-HARVWEIGHTSURF-001 — the SAME provenance, short enough to RENDER instead of hover.
//
// ESTIMATE_SOURCE_COPY above reaches every harvest surface through the HTML `title` attribute,
// which is a hover affordance. There is no hover on a touch screen, and this app is read on Chrome
// for Android — so the basis, which is the entire reason the weight axis is trustworthy, collapsed
// in practice to a single ≈ glyph. That matters because only ~37% of stored weights are real
// weighings: a bare number reads as measured on nearly two-thirds of rows where it is not.
//
// These are the same three concepts in the same words — "your own weighings", "typical weight" for
// the variety, "typical weight for this crop" — compressed to fit a dense log row at a 390px
// viewport beside the amount and the number. No new vocabulary is introduced.
//
// Same `??` discipline as ESTIMATE_SOURCE_COPY, for the same reason: weight_basis is a server enum
// widened by migration, not by a frontend deploy, so an unrecognised value must degrade to a
// statement that is still true rather than render `undefined` onto the row.
export const ESTIMATE_SOURCE_SHORT = {
  cultivar_sample: 'your weighings',
  cultivar:        'typical for this variety',
  crop_type:       'typical for this crop',
}
export const ESTIMATE_SOURCE_SHORT_FALLBACK = 'estimated'
// A measured weight is labelled too. Today the ONLY at-a-glance mark separating a weighing from an
// estimate is the ABSENCE of ≈, and an absence is not a disclosure — it also hides the ratchet at
// the one moment it pays off, when a row Dave weighed himself stops being a guess.
export const MEASURED_SHORT = 'weighed'
export const estimateSourceShort = basis =>
  ESTIMATE_SOURCE_SHORT[basis] ?? ESTIMATE_SOURCE_SHORT_FALLBACK

// The visible basis label for one harvest row, or null where there is nothing to label.
//
// ADDITIVE ON PURPOSE: it takes the raw harvests read-model row rather than a describeHarvestWeight
// result, so the existing return shape of that function is untouched and every existing caller keeps
// working unchanged. Two surfaces render this label (the Harvests log and the PlantingDetail
// timeline chip) and they must say the same words, which is why the decision lives here and not in
// either page.
export function weightBasisLabel(harvest) {
  const d = describeHarvestWeight(harvest)
  if (d.state === 'none') return null
  return d.estimated ? estimateSourceShort(harvest?.weight_basis) : MEASURED_SHORT
}

// The ratchet, in words. A harvest with no derivable weight is not an error and must not read as
// one — it is the state that IMPROVES when the next one gets weighed, which is the whole point of
// surfacing this. Kept here so every surface says it identically.
export const NO_WEIGHT_COPY = 'No weight yet — weigh one to start the estimate.'

// Grams → a string a person reads. Switches to kg at 1 kg because four-digit gram counts are the
// point where the number stops being legible at a glance; drops the decimals past 10 kg where they
// are noise on an estimate. Returns null (not '0 g', not '—') for absent input so callers must
// branch explicitly rather than printing a fake zero — a harvest that weighs nothing is not a
// harvest, so 0 is always missing data, never a measurement.
export function formatGrams(grams) {
  const n = Number(grams)
  if (grams == null || grams === '' || !Number.isFinite(n) || n <= 0) return null
  if (n >= 10000) return `${Math.round(n / 1000)} kg`
  if (n >= 1000) return `${(n / 1000).toFixed(2).replace(/\.?0+$/, '')} kg`
  return `${Math.round(n)} g`
}

// THE read decision, resolved once so no surface re-derives it. Three states, and they are not
// interchangeable:
//   'measured'  — a real weighing (user-supplied, or logged in a weight unit). Authoritative.
//   'estimated' — the resolver inferred it. Real enough to total, must be labelled as inferred.
//   'none'      — nothing derivable. The ratchet state, NOT an error.
//
// `weight_estimated` is the discriminator rather than `weight_basis`, because basis is overloaded:
// 'measured' appears for BOTH a user-typed weight and a harvest logged directly in grams, while
// weight_estimated is a clean boolean the resolver sets in the same CASE that sets the number.
// A null weight_estimated with a present weight cannot happen by construction
// (chk_harvest_log_weight_basis_pairing), but is treated as 'estimated' if it ever does — labelling
// a real measurement as an estimate is a harmless understatement; the reverse launders a guess.
export function describeHarvestWeight(harvest) {
  const grams = harvest?.weight_grams
  const text = formatGrams(grams)
  if (text == null) {
    return { state: 'none', grams: null, text: null, sourceCopy: NO_WEIGHT_COPY, estimated: false }
  }
  const measured = harvest?.weight_estimated === false
  return {
    state: measured ? 'measured' : 'estimated',
    grams: Number(grams),
    text,
    estimated: !measured,
    sourceCopy: measured ? null : estimateSourceCopy(harvest?.weight_basis),
  }
}

// Season/crop totals. Estimated and measured grams are summed together — that is the honest
// arithmetic, since an estimate IS the best available value for that row — but the counts come back
// alongside so a surface can qualify the total ("3 of 12 weighed") instead of implying the whole
// number was measured. `unweighed` is surfaced for the same reason: a total that silently omits
// rows it could not weigh reads as complete when it is not.
export function sumHarvestWeights(harvests) {
  const out = { grams: 0, measured: 0, estimated: 0, unweighed: 0, text: null }
  for (const h of harvests ?? []) {
    const d = describeHarvestWeight(h)
    if (d.state === 'none') { out.unweighed += 1; continue }
    out.grams += d.grams
    if (d.state === 'measured') out.measured += 1
    else out.estimated += 1
  }
  out.text = formatGrams(out.grams)
  return out
}

// BUG-PLANTHARVCURSOR-001. The same total, but taken from the server's roll-up instead of summed
// here — the entries a client holds are a PAGE (PAGE_LIMIT = 50) while the aggregate is computed
// over the full filter range with no cursor and no limit, so past 50 harvests only one of the two
// is the real number. Postgres also sums `numeric` exactly, where a JS reduce over parsed decimals
// does not.
//
// This is a SHAPE ADAPTER and nothing more. The server (lambda/harvests/aggregate.js shapeWeightRow)
// speaks grams/measured_grams/estimated_grams/measured/estimated/unweighed; sumHarvestWeights above
// speaks the same vocabulary minus the gram split and plus the rendered `text`. Converting here
// rather than at the call site keeps ONE definition of the object every weight surface renders, so a
// total sourced from the wire and a total summed locally cannot drift in shape or in phrasing.
// Returns null for an absent row, which callers must treat as "say nothing" — a missing roll-up is
// an older Lambda, not a planting that weighs zero.
export function serverWeightTotal(weight) {
  if (!weight || typeof weight !== 'object') return null
  const grams = Number(weight.grams)
  if (!Number.isFinite(grams)) return null
  return {
    grams,
    measured: Number(weight.measured) || 0,
    estimated: Number(weight.estimated) || 0,
    unweighed: Number(weight.unweighed) || 0,
    text: formatGrams(grams),
  }
}

// V4-HARVEXPORT-001: the qualifier clauses that must ride every weight number. Lifted out of
// Harvests.jsx (where it was local) so the Totals view and the Totals EXPORT emit the SAME
// phrasing — a bare "12 kg" claims every gram was weighed, which is false for nearly every row
// today, and an export that drops the qualifier launders that claim into a spreadsheet. Fixed
// order (weighed / estimated / no weight yet); each clause dropped only when its count is zero.
export function weightParts(w) {
  const parts = []
  if (!w) return parts
  if (w.measured > 0) parts.push(`${w.measured} weighed`)
  if (w.estimated > 0) parts.push(`${w.estimated} estimated`)
  if (w.unweighed > 0) parts.push(`${w.unweighed} with no weight yet`)
  return parts
}
