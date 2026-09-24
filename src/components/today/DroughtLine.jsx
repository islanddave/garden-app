// src/components/today/DroughtLine.jsx — V5-DROUGHTSPACE-001.
//
// ONE line, ONCE, for the whole garden. Dave's ruling, 2026-09-08: he chose this over extending the
// per-plant hook because the dryness is measured per Space and is identical for every planting in it,
// and because that is how he noticed the problem — the GARDEN was dry, not one blueberry.
//
// MOUNTED in src/pages/Today.jsx as <DroughtLine plan={plan} /> (f11707f5, 2026-09-08), next to the other
// ambient weather lines. An earlier header here said "NOT MOUNTED"; that stopped being true at that
// commit. src/__tests__/DroughtTodayEndToEnd.test.jsx drives the whole chain (engine -> stored row ->
// daily-plan-read -> Today) on real rain data, so "never fired" cannot hide "cannot fire"
// (BUG-DROUGHTNEVERFIRED-001: it had simply never had a 20-day run to fire on).
//
// PROP IS THE WHOLE PLAN, NOT plan.drought. daily-plan-read returns the stored items payload verbatim
// as `plan`, and the likeliest failure of a line like this is being mounted on the wrong prop path and
// rendering nothing forever while every test stays green. Taking the plan means the test can feed a
// plan-shaped payload and assert what a caller would actually see.
//
// VISUAL TREATMENT MIRRORS FrostAlertLine, and for its stated reason rather than by copying: the
// gold/warn family on Today is a crowded slot (hydrology uncertainty, StorageDeadlineAlert), and a
// third warn item is what turns the other two into wallpaper. So no fill, no boxed border, no severity
// glyph, no gold — a thin sage left rule, and P.dark/600 ink because this line is always imperative.
//
// House rules for an operational alert, unchanged and absolute: no modal, no toast, no snackbar, no
// banner, no sheet, no overlay, no push, no sound, no haptic, no count badge. Dave's only surface is an
// installed PWA on Android; an interrupt there would need his explicit approval. This is one in-page
// line on a screen he already opens daily, and NOTHING on a day the signal is quiet.
import React, { useMemo } from 'react'
import { P } from '../../lib/constants.js'
import { buildDroughtLine } from '../../lib/droughtLine.js'

export default function DroughtLine({ plan = null }) {
  const line = useMemo(() => buildDroughtLine(plan), [plan])

  if (!line) return null

  return (
    <div
      data-testid="drought-line"
      data-drought-days={String(line.dryDays)}
      data-drought-truncated={String(line.truncated)}
      style={{
        borderLeft: `3px solid ${P.sage}`,
        paddingLeft: 10,
        fontSize: '0.84rem',
        lineHeight: 1.45,
        color: P.dark,
        fontWeight: 600,
      }}
    >
      {line.text}
    </div>
  )
}
