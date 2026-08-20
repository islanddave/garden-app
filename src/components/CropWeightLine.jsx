// CropWeightLine — the crop-level harvest-weight presentation, in ONE place.
//
// V4-HARVWEIGHTSURF-001 (Garden slice): lifted VERBATIM out of src/pages/Harvests.jsx, where it was a
// local function, because the Garden's crop-type groups now render the same fact. A second copy of
// this markup is precisely the defect this row exists to close — the weight axis is only trustworthy
// if "≈ 2.4 kg · 3 weighed · 12 estimated" means the same thing and reads the same way on every
// surface that shows it. The formatting itself still lives in src/lib/harvestWeight.js (formatGrams /
// weightParts); this is the shared RENDERING of it, not a second formatter.
//
// The weight objects come off GET /api/harvests already summed — grams are `numeric` in Postgres, so
// the arithmetic happens there and arrives exact — and they carry the SAME field names
// sumHarvestWeights() produces client-side (grams/measured/estimated/unweighed), so this surface,
// PlantingDetail's per-planting total and the log row chip cannot drift apart in meaning.
//
// The counts are never optional next to a number. A bare "12 kg" claims every gram was weighed, which
// is false for nearly every row today; the qualifier prints in a fixed order (weighed / estimated /
// no weight yet), each clause dropped only when its count is zero — the same phrasing
// PlantingWeightTotal uses in src/pages/PlantingDetail.jsx.
//
// Spans, not divs: the Harvests call site renders this inside the crop row's expand <button>.
import React from 'react'
import { P } from '../lib/constants.js'
import { formatGrams, weightParts, NO_WEIGHT_COPY } from '../lib/harvestWeight.js'

// `weight` is undefined against a harvests Lambda older than this feature — the frontend can and does
// deploy ahead of it. That renders NOTHING: the old response cannot distinguish "no weight recorded"
// from "this API doesn't compute weight", and only the first is safe to tell Dave.
export default function CropWeightLine({ weight }) {
  if (!weight) return null
  const text = formatGrams(weight.grams)
  if (text == null) {
    // Nothing weighable under this crop. Row-level, so it borrows the log row's short chip +
    // title pairing rather than the full sentence, which would repeat once per crop and stop being
    // read. The counts line goes with it: with no number to qualify, "2 with no weight yet" is the
    // same fact twice — the same double-negative suppression the log row does.
    if (weight.unweighed === 0) return null
    return (
      <span data-testid="crop-weight-none" title={NO_WEIGHT_COPY} style={{ display: 'block', fontSize: '0.75rem', color: P.light, marginTop: 2 }}>
        no weight yet
      </span>
    )
  }
  return (
    <>
      <span
        data-testid="crop-weight"
        // role="img" (V4-A11YGATE-001): a role-less span is role=generic and cannot hold a name, so
        // this label was discarded and AT read the raw "≈ 2.4 kg" — the ≈ being exactly the glyph
        // the label exists to spell out. img names the number+qualifier as one unit.
        role="img"
        aria-label={`${weight.estimated > 0 ? 'Estimated total' : 'Total'} harvest weight: ${text}`}
        style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: P.green, marginTop: 2 }}
      >
        {weight.estimated > 0 ? `≈ ${text}` : text}
      </span>
      <span data-testid="crop-weight-basis" style={{ display: 'block', fontSize: '0.72rem', color: P.light }}>
        {weightParts(weight).join(' · ')}
      </span>
    </>
  )
}
