// V5-HEATRESPONSEDISPLAY-001 — the curated per-cultivar heat prose, on the page.
//
// Dave asked "does that change what tomatoes need? collards?" and the answer for the tomato half
// was already written down and shown to nobody: 193 of 264 care_profile rows carry a hand-authored,
// cultivar-aware heat_response ("bolts >80F sustained; mulch heavily, harvest promptly"), resolving
// through v_resolved_care to 45 of 47 non-deleted tomato plantings. This component is the whole of
// surfacing it — read-only prose, no engine, no threshold, no fetch of its own (the string rides in
// the record GET /api/plants/:id already returns).
//
// WHY IT RENDERS ON UNCOVERED PLANTS TOO, which is the part that took a decision. The corpus is
// SILENT on collards — zero entries match it, Dave's one live collard has no heat_response, and
// neither do his kale (3), carrot (3) or bean (3). Rendering nothing there would be the worse of the
// two failures available: an absent line reads as "nothing to worry about", and the reader cannot
// tell it apart from a plant that genuinely wants nothing in the heat. So absence is stated, in
// muted copy, as absence. The one thing it must never do is FILL the gap — a generic "water more in
// heat" here would be the app inventing horticulture, and it would be indistinguishable on screen
// from the 193 rows where a human actually wrote something.
//
// SALIENCE: same chrome-less low-salience shape as OverwinterPrompt directly below it — 0.82rem, no
// card, no banner, no colour block, no badge. Deliberately NOT the gold/warn family: those slots are
// spoken for (hydrology uncertainty today, StorageDeadlineAlert from 09-28) and this is a standing
// fact about a plant, not an alert about today. P.light for the absence variant is the same tone the
// vessel-gap copy uses — quieter than a real value, never a problem.
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
