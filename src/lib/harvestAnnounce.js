// harvestAnnounce.js — V4-HAPTICVOCAB-001. The spoken text for the weigh-in session's live region.
//
// Pure string math, no React, for the same reason numberPad.js is: the WORDING is the conformance
// artefact (WCAG 2.2 SC 4.1.3), and it should be falsifiable without rendering a page.
//
// It reads the SAME `sessionRows` shape the visible strip reads (EventNew.jsx:1528-1540) and repeats
// the strip's own arithmetic — `live = rows.filter(!undone)`, grams summed over live rows, kg above
// 1000 (EventNew.jsx:2657-2664). One rule, two renderings: if the spoken total and the printed total
// could be computed differently they would eventually disagree, and the eyes-free channel would be
// the one that was wrong.
//
// Units are SPELLED OUT ("grams", not "g"). This string is sr-only, so there is no width cost, and
// a single letter is exactly the sort of token a screen reader renders as a letter name.

function spokenWeight(grams) {
  if (grams == null || !Number.isFinite(grams) || grams <= 0) return null
  if (grams >= 1000) {
    const kg = Math.round(grams / 100) / 10
    return `${kg} kilogram${kg === 1 ? '' : 's'}`
  }
  const g = Math.round(grams)
  return `${g} gram${g === 1 ? '' : 's'}`
}

// rows = the session ledger INCLUDING the row that was just saved. The caller owns that append —
// see the lane report's call-site table for why the announcement reads a locally-built array rather
// than being computed inside the setSessionRows updater (side effects in a state updater are
// double-invoked under StrictMode).
export function formatHarvestSaveAnnouncement(rows = []) {
  const live = rows.filter(r => r && !r.undone)
  const row = rows[rows.length - 1]
  if (!row) return ''
  const totalG = live.reduce((s, r) => s + (r.grams ?? 0), 0)
  const weight = spokenWeight(row.grams)
  const total = spokenWeight(totalG)
  // "Saved" first: the outcome is the fact he is waiting on, and a polite region can be interrupted
  // by the next keypress — anything after the first clause is a bonus, so the first clause is the
  // one that has to carry the answer.
  return [
    `Saved. ${row.plantName || 'Planting'}, ${row.qty} ${row.unit}`,
    weight ? `, ${weight}` : '',
    `. ${live.length} harvest${live.length === 1 ? '' : 's'} this session`,
    total ? `, ${total} total` : '',
    '.',
  ].join('')
}

export function formatHarvestUndoAnnouncement(plantName) {
  return `${plantName || 'Planting'} harvest removed.`
}
