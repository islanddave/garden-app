// V4-PLANTINGUI-001 — computed maturity / harvest window for a planting.
// Pure, null-tolerant. Anchors maturity to the earliest meaningful lifecycle date the
// planting actually has, preferring the agronomically correct "days from sow" when a sow
// date exists (days_to_maturity is conventionally counted from sowing or from transplant
// depending on crop; we count from sow when present, else from the chosen anchor).
//
// variety_ref.days_to_maturity_min/max come from the cultivar (PLANTTYPE substrate).

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
//     harvestWindowLabel, isMature, pctToMaturity }
// Returns nulls (not throws) for every field that can't be computed.
export function computeMaturity(planting, today = new Date()) {
  const out = {
    ageDays: null, anchorField: null, anchorDate: null, anchorLabel: null,
    dtmMin: null, dtmMax: null, maturityMinDate: null, maturityMaxDate: null,
    harvestWindowLabel: null, isMature: null, pctToMaturity: null,
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

  // Maturity window: count days_to_maturity from the SOW date when we have one (most
  // crop DTM figures are sow-relative), else from the display anchor.
  const dtmMin = Number.isFinite(planting?.variety_ref?.days_to_maturity_min) ? planting.variety_ref.days_to_maturity_min : null
  const dtmMax = Number.isFinite(planting?.variety_ref?.days_to_maturity_max) ? planting.variety_ref.days_to_maturity_max : null
  out.dtmMin = dtmMin
  out.dtmMax = dtmMax

  const dtmAnchor = sown || out.anchorDate
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
