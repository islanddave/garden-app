// Single source of truth for project-status badge styling.
// Created 2026-05-18 (V1.2a-3 Increment C / PR-C2 — I7 fix).
//
// Before this module: STATUS_COLORS was duplicated in ProjectList.jsx and
// ProjectDetail.jsx with only {planning, active, harvested, ended} mapped,
// so all the "in-progress" stages (seeding, sprouting, growing, flowering,
// fruiting) fell through to `planning` and rendered GOLD — while Dashboard's
// StatusBadge correctly mapped them to GREEN. The user sees a project's
// status flip color depending on which surface it's on.
//
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
  ended:     { bg: P.neutralFill,  text: P.mid,     border: P.border },  // V4-A11Y-001: P.light #777 was 3.86:1 on #eee
  // ── Plant lifecycle statuses (V3-FORMSYS-001 §3.2 — were falling through to planning gold) ──
  seed:       ACTIVE_STAGE,
  seedling:   ACTIVE_STAGE,
  vegetative: ACTIVE_STAGE,
  dormant:    { bg: P.neutralFill,  text: P.mid,         border: P.border },
  failed:     { bg: P.alert, text: P.severityUrgent, border: P.alertBorder },  // V4-A11Y-001: alertBorder #b7532a was 4.15:1 on #fde8e0
}

export function getStatusColors(status) {
  return STATUS_COLORS[status] ?? STATUS_COLORS.planning
}
