// src/lib/waterDepth.js
// V4-WATERMATH-001 F0 (capture) — the water-amount CLASS vocabulary, in ONE place.
//
// CONTRACT with the events Lambda (W-F0-LAMBDA, sibling lane). The class rides in event
// metadata, NOT in quantity_numeric: that column is structurally harvest-only (544/544 live
// rows are harvest) and a dimensionless class code there would collide with future real
// gallons. Categories also survive a magnitude retune of the ledger math; recorded numerics
// would not. Canon: watering-cadence-math-design-V100 Part 3.
//
//   metadata.water_depth         'light' | 'normal' | 'deep'
//   metadata.water_depth_source  'user' | 'default'
//
// `water_depth_source` is the honesty channel and the whole point of the instrumentation
// gate (Part 3: "if <5% of waterings carry a user-set depth at 30 days, the deep-bank
// magnitudes are declared unfeedable"). A row written by the preselected default MUST say
// so, or the annotation rate reads 100% on day one and the gate can never fire.
//
// Chip copy is deliberately RELATIVE to the planting's own need ("what it needed"), never
// absolute volume — an honest Light pass on a lettuce flat logs as Normal, so shallow-rooted
// crops are not phantom-penalized by the ledger fold. Do not "clarify" these into gallons.

export const WATER_DEPTH_LIGHT = 'light'
export const WATER_DEPTH_NORMAL = 'normal'
export const WATER_DEPTH_DEEP = 'deep'

// Ordered light -> deep. Order is rendered order; the fold treats them as ordinal.
export const WATER_DEPTH_VALUES = [WATER_DEPTH_LIGHT, WATER_DEPTH_NORMAL, WATER_DEPTH_DEEP]

// Preselected. Zero added taps on the default path — the single most load-bearing property
// of this capture layer (a required decision per watering is the failure the chips exist to
// avoid), and the value the ledger fold assumes for every absent/historical row.
export const WATER_DEPTH_DEFAULT = WATER_DEPTH_NORMAL

export const WATER_DEPTH_SOURCE_USER = 'user'
export const WATER_DEPTH_SOURCE_DEFAULT = 'default'

// V4-ICON-001 (done). The amount class was encoded as a REPEATED glyph, so what the user counts is
// the tier — that is a count channel, not a colour one, and it survives greyscale and forced-colors
// (SC 1.4.1). It stays a count: the field is now `dropCount` and WaterDepthChips renders that many
// <Icon name="care.drop">. Kept as a number rather than a pre-built string so this module stays
// JSX-free and the two render sites (the chip group, and LogMany's compact per-row chip) cannot
// drift into showing different numbers of drops for one class.
export const WATER_DEPTH_CHIPS = [
  { value: WATER_DEPTH_LIGHT,  dropCount: 1, label: 'Light',  anchor: 'a quick pass' },
  { value: WATER_DEPTH_NORMAL, dropCount: 2, label: 'Normal', anchor: 'what it needed' },
  { value: WATER_DEPTH_DEEP,   dropCount: 3, label: 'Deep',   anchor: 'soaked to runoff' },
]

export const WATER_DEPTH_LABELS = {
  [WATER_DEPTH_LIGHT]:  'Light',
  [WATER_DEPTH_NORMAL]: 'Normal',
  [WATER_DEPTH_DEEP]:   'Deep',
}

// Which event types carry an amount class. Watering ONLY — 'rain' is a measured natural
// event whose magnitude comes from the gauge/forecast, not from the user's hose, and the
// engine already gives it full-reset semantics. Adding rain here would invent a user
// judgement the ledger does not read.
export function isWaterDepthType(eventType) {
  return eventType === 'watering'
}

export function isWaterDepth(v) {
  return WATER_DEPTH_VALUES.includes(v)
}

// Tolerant read for surfaces that render a stored row. Absent / unknown / historical rows
// read as the default, exactly as the engine fold treats them — so the UI can never claim a
// class the math would not use.
export function readWaterDepth(metadata) {
  const v = metadata && typeof metadata === 'object' ? metadata.water_depth : null
  return isWaterDepth(v) ? v : WATER_DEPTH_DEFAULT
}

export function waterDepthLabel(depth) {
  return WATER_DEPTH_LABELS[depth] ?? WATER_DEPTH_LABELS[WATER_DEPTH_DEFAULT]
}

// The metadata fragment to merge into an event payload. `userChose` false => the row records
// that the preselected default wrote it.
export function waterDepthMetadata(depth, userChose) {
  const value = isWaterDepth(depth) ? depth : WATER_DEPTH_DEFAULT
  return {
    water_depth: value,
    water_depth_source: userChose ? WATER_DEPTH_SOURCE_USER : WATER_DEPTH_SOURCE_DEFAULT,
  }
}
