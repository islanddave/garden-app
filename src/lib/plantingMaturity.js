// V4-PLANTINGUI-001 — computed maturity / harvest window for a planting.
// Pure, null-tolerant.
//
// V4-MATURITYBASIS-001 (Slice A) — the DTM anchor is now BASIS-AWARE.
// days_to_maturity is a catalogue figure quoted either from sow or from transplant depending on
// the crop. The basis is carried per crop type on crop_types.dtm_basis and reaches here as
// planting.variety_ref.dtm_basis ('from-sow' | 'from-transplant' | null).
//   from-transplant -> DTM anchors on transplanted_at ?? planted_out_at; with neither, the window
//                      is SUPPRESSED rather than guessed (design D3).
//   from-sow / null -> DTM anchors on sown_at ?? the display anchor. NULL means "uncurated" and
//                      reproduces the pre-basis behaviour EXACTLY, which is what makes this change
//                      a provable no-op until the crop_types backfill lands.
// The AGE anchor (anchorField/anchorDate/anchorLabel, "Day N since transplanted") is UNCHANGED --
// only the DTM anchor is basis-sensitive.
//
// variety_ref.days_to_maturity_min/max come from the cultivar (PLANTTYPE substrate).

export const DTM_BASIS_SOW = 'from-sow'
export const DTM_BASIS_TRANSPLANT = 'from-transplant'

// Only the two CHECK-constrained values resolve; anything else (null, undefined, a value from a
// newer server than this bundle) falls back to the legacy from-sow behaviour.
function resolveBasis(value) {
  return value === DTM_BASIS_SOW || value === DTM_BASIS_TRANSPLANT ? value : null
}

function parseDate(value) {
  if (!value) return null
  const d = new Date(typeof value === 'string' && value.length === 10 ? value + 'T00:00:00' : value)
  return isNaN(d.getTime()) ? null : d
}

function fmt(d) {
  if (!d) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const DAY_MS = 86400000

// computeMaturity(planting, today=new Date()) ->
//   { ageDays, anchorField, anchorDate, anchorLabel,
//     dtmMin, dtmMax, maturityMinDate, maturityMaxDate,
//     harvestWindowLabel, isMature, pctToMaturity,
//     dtmBasis, basisResolved, dtmAnchorField, dtmAnchorDate, dtmAnchorLabel, awaitingTransplant }
// Returns nulls (not throws) for every field that can't be computed.
export function computeMaturity(planting, today = new Date()) {
  const out = {
    ageDays: null, anchorField: null, anchorDate: null, anchorLabel: null,
    dtmMin: null, dtmMax: null, maturityMinDate: null, maturityMaxDate: null,
    harvestWindowLabel: null, isMature: null, pctToMaturity: null,
    dtmBasis: null, basisResolved: false,
    dtmAnchorField: null, dtmAnchorDate: null, dtmAnchorLabel: null,
    awaitingTransplant: false,
  }
  if (!planting) return out

  // Anchor for AGE display: the most advanced lifecycle date present.
  const transplanted = parseDate(planting.transplanted_at)
  const plantedOut = parseDate(planting.planted_out_at)
  const sown = parseDate(planting.sown_at)
  if (transplanted) { out.anchorField = 'transplanted_at'; out.anchorDate = transplanted; out.anchorLabel = 'transplanted' }
  else if (plantedOut) { out.anchorField = 'planted_out_at'; out.anchorDate = plantedOut; out.anchorLabel = 'planted out' }
  else if (sown) { out.anchorField = 'sown_at'; out.anchorDate = sown; out.anchorLabel = 'sown' }

  const now = parseDate(today) || new Date()
  if (out.anchorDate) {
    out.ageDays = Math.max(0, Math.floor((now - out.anchorDate) / DAY_MS))
  }

  // Maturity window: anchor per the crop's DTM basis (see header).
  const dtmMin = Number.isFinite(planting?.variety_ref?.days_to_maturity_min) ? planting.variety_ref.days_to_maturity_min : null
  const dtmMax = Number.isFinite(planting?.variety_ref?.days_to_maturity_max) ? planting.variety_ref.days_to_maturity_max : null
  out.dtmMin = dtmMin
  out.dtmMax = dtmMax

  const basis = resolveBasis(planting?.variety_ref?.dtm_basis)
  out.dtmBasis = basis
  out.basisResolved = basis != null

  let dtmAnchor = null
  if (basis === DTM_BASIS_TRANSPLANT) {
    if (transplanted) { dtmAnchor = transplanted; out.dtmAnchorField = 'transplanted_at'; out.dtmAnchorLabel = 'transplant' }
    else if (plantedOut) { dtmAnchor = plantedOut; out.dtmAnchorField = 'planted_out_at'; out.dtmAnchorLabel = 'planting out' }
  } else {
    dtmAnchor = sown || out.anchorDate
    if (sown) { out.dtmAnchorField = 'sown_at'; out.dtmAnchorLabel = 'sow' }
    else if (dtmAnchor) { out.dtmAnchorField = out.anchorField; out.dtmAnchorLabel = out.anchorLabel }
  }
  out.dtmAnchorDate = dtmAnchor

  // D3: a from-transplant crop with no transplant/planted-out date has an UNKNOWABLE window.
  // Say so instead of projecting one -- start_indoor_weeks is populated for well under half the
  // affected plantings, so a projection would fabricate a confident-looking wrong date.
  if (!dtmAnchor && basis === DTM_BASIS_TRANSPLANT && (dtmMin != null || dtmMax != null)) {
    out.awaitingTransplant = true
    out.harvestWindowLabel = 'Est. harvest — set at transplant'
    return out
  }

  if (dtmAnchor && (dtmMin != null || dtmMax != null)) {
    const lo = dtmMin != null ? dtmMin : dtmMax
    const hi = dtmMax != null ? dtmMax : dtmMin
    out.maturityMinDate = new Date(dtmAnchor.getTime() + lo * DAY_MS)
    out.maturityMaxDate = new Date(dtmAnchor.getTime() + hi * DAY_MS)
    out.isMature = now >= out.maturityMinDate
    // progress toward the EARLIEST maturity date (0..1), clamped.
    const span = out.maturityMinDate - dtmAnchor
    out.pctToMaturity = span > 0 ? Math.max(0, Math.min(1, (now - dtmAnchor) / span)) : (now >= out.maturityMinDate ? 1 : 0)

    const a = fmt(out.maturityMinDate)
    const b = fmt(out.maturityMaxDate)
    if (out.isMature) {
      out.harvestWindowLabel = 'Maturity window reached'
    } else if (a && b && a !== b) {
      out.harvestWindowLabel = `Est. harvest ${a} – ${b}`
    } else if (a) {
      out.harvestWindowLabel = `Est. harvest ~${a}`
    }
  }

  return out
}
