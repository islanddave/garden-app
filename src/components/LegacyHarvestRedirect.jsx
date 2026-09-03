// V5-HARVESTONEDOOR-001 — the two pre-combination harvest URLs, kept alive as redirects.
//
// WHY REDIRECT RATHER THAN JUST REPOINT THE PRODUCERS. Every producer inside the app IS repointed
// in this change (TopChrome, the Harvests page CTA, the ＋ sheet, the web manifest). But the
// installed PWA caches its manifest in the LAUNCHER, for days, and there is no way to force a
// re-read — the same constraint V4-PWAHARVSHORTCUT-001 documented when it last moved this shortcut.
// So Dave's home-screen "Harvest" tile keeps firing the OLD url until Chrome gets round to it.
// Without these redirects, the change he asked for would silently not apply to the doorway he
// actually uses most, and it would look like it simply had not shipped.
//
// Same reasoning covers a bookmark, an open tab restored after a deploy, and anything in his
// history — all of which point at strings that were correct yesterday.
import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'

// `/log?session=harvest` -> `/log/harvest?mode=manual`.
//
// This wraps the /log route rather than being its own route, because the discriminator is a QUERY
// PARAM and react-router matches on pathname: /log and /log?session=harvest are the same route.
// Everything that is not the harvest session falls straight through to the children untouched, so
// the plain Log-an-event form — including its overlay posture — is unaffected.
//
// The rest of the query string is CARRIED. `?plant=` and `?project=` are real deep-link scope that
// EventNew reads, and dropping them here would silently turn a scoped harvest into an unscoped one.
export function HarvestSessionRedirect({ children }) {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  if (params.get('session') !== 'harvest') return children
  params.delete('session')
  params.set('mode', 'manual')
  return <Navigate to={{ pathname: '/log/harvest', search: `?${params.toString()}` }} replace />
}

// `/log/voice` -> `/log/harvest` (voice is the default mode, so no ?mode= is added — the canonical
// URL for the common case stays clean).
export default function VoiceHarvestRedirect() {
  const location = useLocation()
  return <Navigate to={{ pathname: '/log/harvest', search: location.search }} replace />
}
