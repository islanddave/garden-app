import React from 'react'
import Today from '../../../pages/Today.jsx'
import TodayV2 from '../../../pages/TodayV2.jsx'
import { useTodayV2Flag } from '../../../lib/todayV2Flag.js'
import { TODAY_V2_PREVIEW_ROW } from '../../../lib/featureFlags.js'

// TodayRoute — /today's element: the current Today, or the redesign when this device's Debug & smoke switch
// "New Today (preview) on this phone" is on (V5-TODAYREDESIGN-001 S2; off by default, so V2 ships dark).
// The flag is read synchronously on the first render, so the chosen page paints first time.
// While that row is hidden (featureFlags TODAY_V2_PREVIEW_ROW false, until S8a) a stored flag is IGNORED: a
// phone that turned the preview on earlier would otherwise be held on the unfinished page with no row to turn
// it off.
//
// Both pages are STATIC imports, not React.lazy — the plan asked for a lazy TodayV2, and App.jsx's
// V4-LAZYRETRY-001 note is why not: React caches a rejected lazy payload for good, so one failed chunk
// fetch in a dead zone would leave /today unrecoverable until a reload the service worker may not allow.
// The redesign also has to paint first time behind the flag (plan-v2 §6.4) without a chunk-loading frame.
// tests/harness/todaymeasure.jsx mounts this same chooser for gate:today-shape:v2.
export default function TodayRoute() {
  const on = useTodayV2Flag()
  return TODAY_V2_PREVIEW_ROW && on ? <TodayV2 /> : <Today />
}
