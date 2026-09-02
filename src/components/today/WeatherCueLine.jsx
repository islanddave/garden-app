// src/components/today/WeatherCueLine.jsx — V5-WXCALLOUTRENDER-001.
//
// The daily weather cue, finally rendered. lambda/daily-plan/engine.js computeCallout has produced
// one priority-ordered cue per day (or an explicit silence — 56% of archived days) since it was
// written, with ZERO client consumers. This is the consumer. The engine is not rewritten and no
// threshold is touched: buildCueLine words the cue the engine already chose.
//
// AMBIENT, AND AN OPERATIONAL ALERT RATHER THAN A REWARD SURFACE. §Reward UX names frost/heat/
// watering-crisis warnings as operational alerts, explicitly NOT reward surfaces, so the ambient
// reward rules do not govern the content. The app's house style still does, and it is absolute
// here: no modal, no toast, no snackbar, no banner, no sheet, no overlay, no push, no sound, no
// haptic, no count badge, no Notification.requestPermission(). Dave's only surface is an installed
// PWA on Android; an interrupt on it would need his explicit approval, which has not been given.
// This is one in-page line on the screen he already opens daily, and NOTHING on a silent day.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// IT DOES NOT ENTER THE GOLD/WARN FAMILY, AND THAT IS A CONSTRAINT, NOT A PREFERENCE.
//
// P.warn fill + P.warnBorder + a severity glyph is a crowded slot on this screen already:
// hydrology.status.uncertainty.flag is true today, and from 09-28 StorageDeadlineAlert holds a
// second warn slot for ~4 weeks — the same weeks this cue is most active. Three warn-family items
// stacked on Today is the failure mode, and the third one is the one that turns the other two into
// wallpaper. So: no fill, no boxed border, no severity icon and no gold anywhere. A thin sage left
// rule and muted ink — a note, visually subordinate to every alert around it.
//
// The ONE weight difference is keyed on FORM, not on gold: an imperative cue (freeze/cold — act
// tonight or lose a plant) renders in P.dark at 600, a check-form cue in P.mid at 400. That keeps a
// freeze from reading exactly like "the soil is wet" without borrowing any warn-family signal.
//
// No icon at all — partly because the quiet treatment does not need one, and partly because there is
// no freeze/cold anchor in iconRegistry and inventing a dependency on one would couple this line to
// whatever the icon set does next.
import React, { useEffect, useMemo, useRef } from 'react'
import { P } from '../../lib/constants.js'
import { useApiFetch } from '../../lib/api.js'
import { buildCueLine } from '../../lib/weatherCue.js'
import { sendCueImpression } from '../../lib/weatherCueImpressions.js'

export default function WeatherCueLine({ callout = null, generatedAt = null, planDate = null }) {
  const { fetch: apiFetch } = useApiFetch()
  const line = useMemo(() => buildCueLine(callout), [callout])

  // THE IMPRESSION FIRES ON EVERY RENDERED CUE, AND ONLY ON A RENDERED ONE. The effect is inside the
  // component that owns the render and gated on the same `line` the JSX below returns, so a silent
  // day (no callout, or a cue buildCueLine declines) cannot write a row: there is no code path that
  // beacons without painting. The ref suppresses duplicate requests from React re-renders only — the
  // per-ET-day grain is the server's (uq_weather_cue_impression_day + ON CONFLICT DO NOTHING), never
  // a device clock's. Not awaited and cannot reject (src/lib/weatherCueImpressions.js).
  const sentRef = useRef(null)
  useEffect(() => {
    if (!line) return
    const key = `${planDate ?? ''}|${line.cue}|${line.form}`
    if (sentRef.current === key) return
    sentRef.current = key
    sendCueImpression(apiFetch, line, generatedAt)
  }, [line, apiFetch, generatedAt, planDate])

  // Renders NOTHING on a silent day — never a blank strip, never a heading over silence. 56% of
  // archived days are silent and that silence is what makes the other 44% mean something.
  if (!line) return null

  const imperative = line.form === 'imperative'
  return (
    <div
      data-testid="weather-cue-line"
      data-cue={line.cue}
      data-cue-form={line.form}
      style={{
        borderLeft: `3px solid ${P.sage}`,
        paddingLeft: 10,
        fontSize: '0.84rem',
        lineHeight: 1.45,
        color: imperative ? P.dark : P.mid,
        fontWeight: imperative ? 600 : 400,
      }}
    >
      {line.text}
    </div>
  )
}
