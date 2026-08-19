// src/lib/harvestDisposition.js
// V4-HARVDISPOSITION-001 (capture half) — the harvest_log.disposition vocabulary, in ONE place.
//
// THE SIXTH HOME of this vocabulary, and it is registered as such: the CHECK in
// migrations/v4-losscapture-001/0b-arm-checks.sql is canonical, and lambda/plants/loss-cause-vocab.test.js
// pins every copy against it — the two gates in gates.yml, ALLOWED_DISPOSITION in
// lambda/events/validators.js, and now this one. A list started outside that parity set is the
// BUG-DIVERGENCEVOCAB-001 shape; do not add a value here without the migration moving first.
//
//   harvest_log.disposition  'dropped' | 'culled' | 'aborted' | 'damaged' | NULL
//
// NULL IS A MEANING, NOT A GAP: it says "a normal pick". 703 of the 707 live harvests are normal,
// so the control this vocabulary feeds is OPTIONAL and unselected by default — the opposite of
// waterDepth.js, whose class is preselected because every watering has one. A default here would
// destroy the distinction the column exists to carry and put a required decision on 703 picks to
// record 4. See the bundle's 0a header for the measurements.
//
// A disposition-bearing pick STILL COUNTS AS YIELD (Dave, 2026-08-19). Nothing downstream of this
// file subtracts it from a total; recording the outcome is the whole feature.

export const HARVEST_DISPOSITION_VALUES = ['dropped', 'culled', 'aborted', 'damaged']

// Chip copy is written from the four real prod harvests that wanted a value ("Fell off plant with
// major blotch", "Knocked off plant, very green", "Unripe abort", "Very early aborts"). The anchor
// rides ON the chip rather than in a legend below it, the same rule WATER_DEPTH_CHIPS follows: a
// caption the user looks away to read is one they stop reading by week two.
export const HARVEST_DISPOSITION_CHIPS = [
  { value: 'dropped', label: 'Dropped', anchor: 'knocked off' },
  { value: 'culled',  label: 'Culled',  anchor: 'thrown out' },
  { value: 'aborted', label: 'Aborted', anchor: 'dropped unripe' },
  { value: 'damaged', label: 'Damaged', anchor: 'pest or blemish' },
]

export const HARVEST_DISPOSITION_LABELS = Object.fromEntries(
  HARVEST_DISPOSITION_CHIPS.map(c => [c.value, c.label]),
)

export function isHarvestDisposition(v) {
  return HARVEST_DISPOSITION_VALUES.includes(v)
}

// Normalises anything the wire hands back into the two states the control can render. An unknown
// string is treated as UNSET rather than rendered as a fifth chip: the CHECK makes one impossible
// today, and a value the control cannot show is one the user cannot correct.
export function readHarvestDisposition(v) {
  return isHarvestDisposition(v) ? v : null
}
