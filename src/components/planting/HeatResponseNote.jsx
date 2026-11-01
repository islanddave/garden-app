// The curated per-cultivar heat prose, on the page: read-only prose, no engine, no threshold, no fetch of its own (the
// string rides in the record GET /api/plants/:id already returns, resolved through v_resolved_care).
//
// WHY IT RENDERS ON UNCOVERED PLANTS TOO. The corpus is SILENT on some crops (collards, kale, carrot, bean). Rendering
// nothing there would be the worse failure: an absent line reads as "nothing to worry about", and the reader cannot
// tell it apart from a plant that genuinely wants nothing in the heat. So absence is stated, in muted copy, as
// absence. It must never FILL the gap: a generic "water more in heat" would be the app inventing horticulture,
// indistinguishable on screen from the rows where a human actually wrote something.
//
// SALIENCE: same chrome-less low-salience shape as OverwinterPrompt directly below it (0.82rem, no card, no banner, no
// colour block, no badge). Deliberately NOT the gold/warn family: those slots are spoken for (hydrology uncertainty,
// StorageDeadlineAlert) and this is a standing fact about a plant, not an alert about today. P.light for the absence
// variant is the same tone the vessel-gap copy uses: quieter than a real value, never a problem.
import React from 'react'
import { P } from '../../lib/constants.js'

export default function HeatResponseNote({ planting }) {
  if (!planting?.id) return null

  // Whitespace-only is treated as absent: a blank string is a data gap wearing a value's clothes,
  // and rendering it would produce a labelled empty line, which is the silent-region failure again.
  const prose = typeof planting.heat_response === 'string' ? planting.heat_response.trim() : ''

  return (
    <div
      data-testid="heat-response-note"
      style={{ fontSize: '0.82rem', color: P.mid, lineHeight: 1.5, margin: '0 0 12px' }}
    >
      <span aria-hidden="true">🌡️ </span>
      <span style={{ fontWeight: 600 }}>In heat — </span>
      {prose
        ? <span>{prose}</span>
        : (
          <span style={{ color: P.light, fontStyle: 'italic' }}>
            nothing recorded for this plant
          </span>
        )}
    </div>
  )
}
