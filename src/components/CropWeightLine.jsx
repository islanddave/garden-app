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
// V4-HARVCROPTABLE-001 — the weighed/estimated COUNT LINE is gone (2026-08-24). It used to print
// "3 weighed · 12 estimated" under the number, on the reasoning — still correct — that a bare
// "12 kg" claims every gram was weighed, which is false for nearly every row. Dave asked for it
// dropped on TWO different harvest surfaces in one week, so this is a stance on the surface family,
// not a one-off tidy.
//
// The honesty requirement it served is NOT dropped: it moves entirely onto the `≈` prefix, which
// already rode the same number and already meant exactly "some of this is modelled". The counts
// were the redundant channel, not the load-bearing one. Screen readers keep the full sentence via
// aria-label ("Estimated total harvest weight: …"), so nothing lost a channel it depended on.
//
// If a future surface needs the split back, weightParts() still exists in lib/harvestWeight.js and
// still produces it — this is a rendering decision, not a data one.
//
// Spans, not divs: the Harvests call site renders this inside the crop row's expand <button>.
import React from 'react'
import { P } from '../lib/constants.js'
import { formatGrams, NO_WEIGHT_COPY } from '../lib/harvestWeight.js'

// `weight` is undefined against a harvests Lambda older than this feature — the frontend can and does
// deploy ahead of it. That renders NOTHING: the old response cannot distinguish "no weight recorded"
// from "this API doesn't compute weight", and only the first is safe to tell Dave.
// `inline` (V4-HARVCROPTABLE-001): render the number as an inline span so a call site can fold it
// onto an existing line instead of giving it a row of its own. Opt-in, so the Garden crop-group
// call site keeps the stacked layout it was designed around — the ask was about the Harvests crop
// block being five rows tall, and quietly restacking a second surface to fix the first is how a
// tidy-up becomes a regression somewhere nobody looked.
export default function CropWeightLine({ weight, inline = false }) {
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
    <span
      data-testid="crop-weight"
      // role="img" (V4-A11YGATE-001): a role-less span is role=generic and cannot hold a name, so
      // this label was discarded and AT read the raw "≈ 2.4 kg" — the ≈ being exactly the glyph
      // the label exists to spell out. img names the number+qualifier as one unit. The label still
      // carries the full "Estimated total" sentence now that the visible count line is gone.
      role="img"
      aria-label={`${weight.estimated > 0 ? 'Estimated total' : 'Total'} harvest weight: ${text}`}
      style={inline
        // Inline: lighter and smaller than the units it follows, so it still reads as a distinct
        // fact rather than more of the same sentence, without taking a row to say so.
        ? { fontSize: '0.8rem', fontWeight: 600, color: P.light, marginLeft: 8 }
        : { display: 'block', fontSize: '0.85rem', fontWeight: 600, color: P.green, marginTop: 2 }}
    >
      {weight.estimated > 0 ? `≈ ${text}` : text}
    </span>
  )
}
