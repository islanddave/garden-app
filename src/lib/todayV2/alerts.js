// src/lib/todayV2/alerts.js — where the redesigned Today says tonight's weather alerts (V5-TODAYREDESIGN-001,
// finish plan §3.3; Dave's D15 2026-10-14 "Fold into Protect"). PURE: lines and a callout in, placements out.
//
// THE RULE: each thing is said once, where it is acted on.
//   · A Protect tonight section on the page takes the frost / cold words. The verdict already carries the urgent
//     phrase ("frost watch tonight", verdict.js urgentPhrase), Protect's summary carries the timing and the reason
//     (protect.js protectSummary), and the engine's cold-side cue folds into Protect: a pick cue ("Cold night (42°F)
//     — pick coloring peppers & tomatoes") becomes the pick link's words, a cover cue is what Protect's rows do. The
//     full frost sentence waits behind the glance card's Details.
//   · No Protect section: the first frost line stays under the glance card, tonight's in its short form ("Frost
//     watch tonight — clear and calm.": the card's row A states the low), and the rest wait behind Details.
//   · A cue that is not cold-side (heat, rain, wet) never folds: Protect has nothing to say about it.
// Operational alerts, never a reward surface: no banner, toast or fill anywhere here (§3.9).
import { buildCueLine, CUE_SEPARATOR } from '../weatherCue.js'

// engine.js computeCallout's cold-side cues: they key on tonight's low, as Protect does.
export const COLD_CUES = new Set(['freeze', 'cold', 'cool'])
export const PICK_DEFAULT = 'Pick what’s ripe first — log a harvest ›'

// -> true when the page's Protect section carries this cue, so it is not printed as its own line.
export function cueFolds(callout, protectShown) {
  const line = buildCueLine(callout)
  return !!(protectShown && line && COLD_CUES.has(line.cue))
}

// -> the pick link's words when the cue's action is to pick ("Pick coloring peppers & tomatoes first — log a
// harvest ›"), else null (the link keeps PICK_DEFAULT, and shows only on the nights it always did).
export function pickLinkText(callout) {
  const line = buildCueLine(callout)
  if (!line || !COLD_CUES.has(line.cue)) return null
  const i = line.text.indexOf(CUE_SEPARATOR)
  const action = i > 0 ? line.text.slice(i + CUE_SEPARATOR.length).trim() : ''
  if (!/^pick\b/i.test(action)) return null
  return `${action[0].toUpperCase()}${action.slice(1)} first — log a harvest ›`
}

// A frost line (frostAlertLine.js buildFrostAlertLines with `parts`) as the page prints it. `tonight` = a watch or
// possible line naming tonight (it has a lead): the tonight treatment, and no low. A warmed line or a later night's
// line prints as built, in the advisory treatment — a later night's low is that night's, not the one on the card.
export function frostLineText(line, { short = false } = {}) {
  if (!line) return null
  if (line.nightOffset === 0 && line.lead) return short ? `${line.lead}.` : `${line.lead}. ${line.tail}`
  return line.text
}
export const frostTonight = (line) => !!(line && line.nightOffset === 0 && line.lead)

// -> { under, details }: the one line kept under the card (short form) or null, and the lines behind Details.
export function frostPlacement(lines, { protectShown = false } = {}) {
  const all = Array.isArray(lines) ? lines : []
  if (protectShown || !all.length) return { under: null, details: all }
  return { under: all[0], details: all.slice(1) }
}
