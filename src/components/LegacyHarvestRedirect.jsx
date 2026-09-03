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

// `/log?session=harvest` -> `/log/harvest` (the DEFAULT mode, which is voice).
//
// This wraps the /log route rather than being its own route, because the discriminator is a QUERY
// PARAM and react-router matches on pathname: /log and /log?session=harvest are the same route.
// Everything that is not the harvest session falls straight through to the children untouched, so
// the plain Log-an-event form — including its overlay posture — is unaffected.
//
// WHY NOT `?mode=manual`, WHICH IS WHAT THIS URL USED TO OPEN. The first version of this redirect
// preserved the old behaviour faithfully, and the pre-promote QA pass showed that was wrong — not
// wrong about the mapping, wrong about the CONSEQUENCE. The only caller of this url that still
// exists is Dave's launcher-cached home-screen tile: every in-app producer was repointed in the
// same change. So a faithful mapping meant his primary door kept opening the manual form for as
// long as Chrome held the stale manifest — DAYS — and then silently started opening voice the
// moment it re-read it. Same tap, different screen, on a schedule nothing in the deploy controls
// and no test could see, because each half asserts its own behaviour correctly.
//
// Sending it to the default instead makes the tile agree with the header basket and the Harvests
// button IMMEDIATELY, and makes the eventual manifest refresh a no-op rather than a surprise. It
// also delivers what was actually asked for — voice by default — on the doorway used most, instead
// of holding it back behind a cache. The cost is that a bookmark aimed at the weigh-in session now
// lands on voice, one tap from where it wanted to be. That is the right side to err on: the
// alternative errs by changing behaviour later, invisibly.
//
// The rest of the query string is CARRIED. `?plant=` and `?project=` are real deep-link scope that
// EventNew reads, and dropping them here would silently turn a scoped harvest into an unscoped one.
export function HarvestSessionRedirect({ children }) {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  if (params.get('session') !== 'harvest') return children
  params.delete('session')
  const search = params.toString()
  return <Navigate to={{ pathname: '/log/harvest', search: search ? `?${search}` : '' }} replace />
}

// `/log/voice` -> `/log/harvest` (voice is the default mode, so no ?mode= is added — the canonical
// URL for the common case stays clean).
export default function VoiceHarvestRedirect() {
  const location = useLocation()
  return <Navigate to={{ pathname: '/log/harvest', search: location.search }} replace />
}
