// Single source of truth for project-status badge styling.
//
// Every in-progress stage (seeding, sprouting, growing, flowering, fruiting) must map to GREEN, the
// same as Dashboard's StatusBadge. An unmapped status falls through to `planning` and renders GOLD, so
// a project's status would flip color depending on which surface it is on.
//
// All callers MUST import from here. Do not redefine inline.
// All callers MUST import from here. Do not redefine inline.

import { P } from './constants.js'

const ACTIVE_STAGE = { bg: P.greenPale, text: P.green, border: P.greenLight }

export const STATUS_COLORS = {
  planning:  { bg: P.warn,  text: P.statusInkGold, border: P.warnBorder },
  preparing: { bg: P.preparingFill, text: P.brown, border: P.border },
  active:    ACTIVE_STAGE,
  seeding:   ACTIVE_STAGE,
  sprouting: ACTIVE_STAGE,
  growing:   ACTIVE_STAGE,
  flowering: ACTIVE_STAGE,
  fruiting:  ACTIVE_STAGE,
  harvesting:{ bg: P.warn,  text: P.statusInkGold, border: P.warnBorder },
  harvested: { bg: P.neutralFill,  text: P.mid,     border: P.border },
  ended:     { bg: P.neutralFill,  text: P.mid,     border: P.border },  // text must clear AA contrast on the neutral fill
  // ── Plant lifecycle statuses (each needs its own entry, or it falls through to planning gold) ──
  seed:       ACTIVE_STAGE,
  seedling:   ACTIVE_STAGE,
  vegetative: ACTIVE_STAGE,
  dormant:    { bg: P.neutralFill,  text: P.mid,         border: P.border },
  failed:     { bg: P.alert, text: P.severityUrgent, border: P.alertBorder },  // border must clear AA contrast on the alert fill
}

export function getStatusColors(status) {
  return STATUS_COLORS[status] ?? STATUS_COLORS.planning
}
