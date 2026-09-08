// src/components/today/FrostAlertLine.jsx — BUG-FROSTALERTNOAPP-001.
//
// The frost ADVISORY, finally rendered. The daily-plan engine has published these by SNS since
// V4-FROST-001 and the app has never shown one: `alerts_sent` had zero consumers anywhere in src/.
// This is the consumer. No threshold is touched and the engine is not rewritten — buildFrostAlertLine
// words the decision the engine already made and already texted.
//
// SCOPE IS THE LEAD TIME, NOT "FROST". Today already speaks about tonight (WeatherCueLine's freeze
// cue, < 40F). It has never spoken about a night that is not tonight, which is exactly what an
// advisory is: the coldest night in the D1..D3 window. See src/lib/frostAlertLine.js for the
// measurement that settles this — the 2026-09-07 plan carried an advisory with tonightLow 55 and a
// NULL callout, so Today was silent on a night Dave had been texted about.
//
// VISUAL TREATMENT MIRRORS WeatherCueLine, AND FOR ITS STATED REASON, NOT BY COPYING. That header
// argues the gold/warn family is a crowded slot — hydrology uncertainty plus StorageDeadlineAlert
// from 09-28, the same weeks this line is most active — and that a third warn item is what turns
// the other two into wallpaper. That argument applies here unchanged, so: no fill, no boxed border,
// no severity glyph, no gold. A thin sage left rule and, because this line is ALWAYS imperative (it
// exists only when a cold night is coming), the P.dark/600 ink WeatherCueLine reserves for its
// imperative cues.
//
// THE RULE IS P.sage AND NOT P.warnBorder, and that is a correction worth recording. warnBorder was
// the obvious reach for a frost warning and it is wrong: WeatherCueLine.test.jsx guards its sibling
// against the whole warn family BY NAME, warnBorder included, and the house answer to "this one
// deserves more weight" is ink and weight, not a borrowed warn signal. Taking warnBorder here would
// have re-opened the exact crowding the neighbouring component refuses, one line below it.
//
// It sits directly BELOW WeatherCueLine so that on a night carrying both, the reading order is
// tonight first, then the days ahead. Same visual family is CORRECT — both are ambient weather
// notes — and the text is what separates them: this one always names a night that is not tonight.
//
// House rules for an operational alert, unchanged and absolute (§Reward UX names frost warnings as
// operational alerts, explicitly NOT reward surfaces): no modal, no toast, no snackbar, no banner,
// no sheet, no overlay, no push, no sound, no haptic, no count badge, no
// Notification.requestPermission(). Dave's only surface is an installed PWA on Android; an interrupt
// there would need his explicit approval, which has not been given. This is one in-page line on a
// screen he already opens daily, and NOTHING on a day with no advisory.
import React, { useMemo } from 'react'
import { P } from '../../lib/constants.js'
import { buildFrostAlertLine } from '../../lib/frostAlertLine.js'

export default function FrostAlertLine({ alertsSent = null }) {
  const line = useMemo(() => buildFrostAlertLine(alertsSent), [alertsSent])

  // Renders NOTHING when no advisory is live — which is most days, and on every day whose stored
  // entries predate the handler persisting lowF/dayOffset. Never a blank strip, never a heading
  // over silence.
  if (!line) return null

  return (
    <div
      data-testid="frost-alert-line"
      data-frost-tier={line.tier}
      data-frost-day-offset={String(line.dayOffset)}
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
