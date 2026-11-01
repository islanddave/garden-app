// CropWeightLine — the crop-level harvest-weight presentation, in ONE place.
//
// V4-HARVWEIGHTSURF-001: shared by the Harvests crop rows and the Garden crop-type groups. A second
// copy of this markup is the defect this component closes: the weight axis is only trustworthy if
// the same number reads the same way on every surface that shows it. The formatting lives in
// src/lib/harvestWeight.js (formatGrams / weightParts); this is the shared RENDERING of it, not a
// second formatter.
//
// The weight objects come off GET /api/harvests already summed (grams are `numeric` in Postgres, so
// the arithmetic arrives exact) and carry the SAME field names sumHarvestWeights() produces
// client-side (grams/measured/estimated/unweighed), so this surface, PlantingDetail's per-planting
// total and the log row chip cannot drift apart in meaning.
//
// V4-HARVCROPTABLE-001 — there is deliberately NO weighed/estimated count line under the number. A
// bare "12 kg" would claim every gram was weighed, but the honesty requirement lives entirely on the
// `≈` prefix, which rides the same number and means "some of this is modelled"; the counts were the
// redundant channel. Screen readers keep the full sentence via aria-label ("Estimated total harvest
// weight: …"). If a future surface needs the split, weightParts() in lib/harvestWeight.js still
// produces it; this is a rendering decision, not a data one.
//
// Spans, not divs: the Harvests call site renders this inside the crop row's expand <button>.
import React from 'react'
import { P } from '../lib/constants.js'
import { formatGrams, NO_WEIGHT_COPY } from '../lib/harvestWeight.js'

// `weight` is undefined against a harvests Lambda older than this feature (the frontend can deploy
// ahead of it). That renders NOTHING: the old response cannot distinguish "no weight recorded" from
// "this API doesn't compute weight", and only the first is safe to tell the user.
// `inline` (V4-HARVCROPTABLE-001): render the number as an inline span so a call site can fold it
// onto an existing line. Opt-in, so the Garden crop-group call site keeps its stacked layout.
export default function CropWeightLine({ weight, inline = false }) {
  if (!weight) return null
  const text = formatGrams(weight.grams)
  if (text == null) {
    // Nothing weighable under this crop. Row-level, so it borrows the log row's short chip + title
    // pairing rather than the full sentence, which would repeat once per crop and stop being read.
    // With no number to qualify, "2 with no weight yet" would be the same fact twice (the log row
    // suppresses it the same way).
    if (weight.unweighed === 0) return null
    return (
      <span data-testid="crop-weight-none" title={NO_WEIGHT_COPY} style={{ display: 'block', fontSize: '0.75rem', color: P.light, marginTop: 2 }}>
        no weight yet
      </span>
    )
  }
  return (
    <span
      data-testid="crop-weight"
      // role="img" (V4-A11YGATE-001): a role-less span is role=generic and cannot hold a name, so
      // the label was discarded and AT read the raw "≈ 2.4 kg". img names the number+qualifier as one
      // unit; the label carries the full "Estimated total" sentence.
      role="img"
      aria-label={`${weight.estimated > 0 ? 'Estimated total' : 'Total'} harvest weight: ${text}`}
      style={inline
        // Inline: lighter and smaller than the units it follows, so it still reads as a distinct fact.
        ? { fontSize: '0.8rem', fontWeight: 600, color: P.light, marginLeft: 8 }
        : { display: 'block', fontSize: '0.85rem', fontWeight: 600, color: P.green, marginTop: 2 }}
    >
      {weight.estimated > 0 ? `≈ ${text}` : text}
    </span>
  )
}
