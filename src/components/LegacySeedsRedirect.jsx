// V5-SEEDSTAB-001 — /sow and /seeds/saved, kept alive as redirects into the Seeds page.
//
// Every in-app door now targets /seeds?view=… directly (src/lib/seedsRoutes.js), so these serve only
// what the app cannot repoint: a bookmark, a tab restored after a deploy, an entry already in the
// back stack, a cached launcher. Same reasoning as LegacyHarvestRedirect.jsx.
//
// REPLACE, and that is load-bearing rather than tidy. A pushed redirect turns Back into a trap: Back
// lands on /sow, which pushes forward to Seeds again, forever. Replace swaps the old entry for the
// new one, so one Back from Seeds returns to the page before the old URL.
//
// The rest of the query string is carried, and `view` is set FIRST so the page's first-value-wins
// read cannot be overridden by a stray `view=` the old URL happened to hold.
import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { SEEDS_PATH } from '../lib/seedsRoutes.js'

export function legacySeedsSearch(view, search) {
  const rest = new URLSearchParams(search)
  rest.delete('view')
  const tail = rest.toString()
  return `?view=${view}${tail ? `&${tail}` : ''}`
}

export default function LegacySeedsRedirect({ view }) {
  const location = useLocation()
  return <Navigate to={{ pathname: SEEDS_PATH, search: legacySeedsSearch(view, location.search) }} replace />
}
