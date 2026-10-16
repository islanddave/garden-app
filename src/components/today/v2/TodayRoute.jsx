import React from 'react'
import Today from '../../../pages/Today.jsx'
import TodayV2 from '../../../pages/TodayV2.jsx'
import ErrorBoundary from '../../ErrorBoundary.jsx'
import { useTodayV2Flag } from '../../../lib/todayV2Flag.js'
import { TODAY_V2_PREVIEW_ROW, TODAY_V2_DEFAULT } from '../../../lib/featureFlags.js'

// TodayRoute — /today's element: the redesigned Today, or the old one on a phone whose Debug & smoke row
// "New Today on this phone" is turned off (V5-TODAYREDESIGN-001 S2; the redesign is the default since S8b / L7,
// featureFlags TODAY_V2_DEFAULT). The choice is read synchronously on the first render, so the chosen page paints
// first time. While that row is hidden (featureFlags TODAY_V2_PREVIEW_ROW false) a stored choice is IGNORED and
// every phone gets TODAY_V2_DEFAULT: a phone is never held on a page with no row to leave it.
//
// Both pages are STATIC imports, not React.lazy — the plan asked for a lazy TodayV2, and App.jsx's
// V4-LAZYRETRY-001 note is why not: React caches a rejected lazy payload for good, so one failed chunk
// fetch in a dead zone would leave /today unrecoverable until a reload the service worker may not allow.
// The redesign also has to paint first time behind the flag (plan-v2 §6.4) without a chunk-loading frame.
// tests/harness/todaymeasure.jsx mounts this same chooser for gate:today-shape:v2.
//
// Until S8c (L8) a redesign that throws while rendering, in an effect or in a lifecycle method falls back to the OLD
// page, not the route's error screen (a throw in an event handler or async code reaches no boundary, as before).
// Before S8b only phones that chose the preview could reach a V2 crash; now every phone lands here. The fallback is
// SILENT on the phone: the app has no remote error reporting and ErrorBoundary logs to the console only (scope
// "today-v2"), so a post-release check must confirm the redesign itself (its jump bar), not just that Today loads.
// If the old page throws too, only the route boundary logs, with the old page's error. L8 removes this boundary.
export default function TodayRoute() {
  const on = useTodayV2Flag()
  if (!(TODAY_V2_PREVIEW_ROW ? on : TODAY_V2_DEFAULT)) return <Today />
  return <ErrorBoundary scope="today-v2" fallback={<Today />}><TodayV2 /></ErrorBoundary>
}
