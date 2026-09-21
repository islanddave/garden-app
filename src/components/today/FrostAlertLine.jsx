// src/components/today/FrostAlertLine.jsx — BUG-FROSTALERTNOAPP-001.
//
// The frost ADVISORY, finally rendered. The daily-plan engine has published these by SNS since
// V4-FROST-001 and the app has never shown one: `alerts_sent` had zero consumers anywhere in src/.
// This is the consumer. No threshold is touched and the engine is not rewritten — buildFrostAlertLine
// words the decision the engine already made and already texted.
//
// SCOPE IS THE ADVISORY, NOT "FROST". Today already speaks about tonight (WeatherCueLine's freeze
// cue, < 40F on NWS tonightLow). The advisory is the coldest civil day in the D1..D3 window on
// Open-Meteo, and BUG-FROSTADVISORYNIGHTWORDING-001 found that its night is usually TONIGHT (a D1
// minimum falls before dawn on 78% of cold days here). So this line CAN name tonight; it names the
// night the SNS text named. See src/lib/frostAlertLine.js.
// V5-TODAYRADIATIVEWATCH-001 — the one imminent send that cue does NOT cover renders here too: a
// radiative "Frost watch tonight", which fires at 39-42F where the cue says "Cool night" or nothing. It
// and a radiative-only advisory read "Frost watch <night> — clear and calm, low N°F. …", as their
// emails are titled. Same slot, same treatment below: no new element, colour or tap target.
// V5-FROSTTWOMODELS-001 — on such a night the two models' lows used to sit on screen side by side for
// one night. Today now passes `lowShown` (src/lib/tonightLow.js, the colder of the two, rounded) and
// the card, the cue and this line all print it. Absent `lowShown` this line prints its own figure.
// V5-TODAYFROSTLINEGAPS-001 (Dave 2026-09-21) — up to TWO lines now, one per night, tonight's first: a
// watch no longer hides the advisory for a later night. Tonight's can also be "Forecast warmed to 44°F
// since the 3 PM frost email." when a threshold frost email went out and the plan low has since left
// the freeze cue; `planLow` (plan.weather.tonightLow) is read for that line only. Each line is the same
// element as before — same test id, same style — so one line renders exactly the DOM it always did.
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
// notes — and the text is what separates them: this one always NAMES its night.
//
// House rules for an operational alert, unchanged and absolute (§Reward UX names frost warnings as
// operational alerts, explicitly NOT reward surfaces): no modal, no toast, no snackbar, no banner,
// no sheet, no overlay, no push, no sound, no haptic, no count badge, no
// Notification.requestPermission(). Dave's only surface is an installed PWA on Android; an interrupt
// there would need his explicit approval, which has not been given. This is one in-page line on a
// screen he already opens daily, and NOTHING on a day with no advisory.
import React, { useMemo } from 'react'
import { P } from '../../lib/constants.js'
import { buildFrostAlertLines } from '../../lib/frostAlertLine.js'

export default function FrostAlertLine({ alertsSent = null, lowShown = null, planLow = null }) {
  const lines = useMemo(() => buildFrostAlertLines(alertsSent, { lowShown, planLow }), [alertsSent, lowShown, planLow])

  // Renders NOTHING when no advisory or watch is live — which is most days, and on every day whose
  // stored entries predate the handler persisting lowF/dayOffset. Never a blank strip, never a heading
  // over silence.
  if (!lines.length) return null

  // A fragment, not a wrapper: each line is its own item in Today's column, exactly as the one line was.
  return (
    <>
      {lines.map((line, i) => (
        <div
          key={i}
          data-testid="frost-alert-line"
          data-frost-tier={line.tier}
          data-frost-day-offset={String(line.dayOffset)}
          data-frost-night-offset={String(line.nightOffset)}
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
      ))}
    </>
  )
}
