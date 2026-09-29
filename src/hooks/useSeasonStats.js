// useSeasonStats — the Season stats envelope for one grow-year (plan D4/D5), read through the app's
// SWR cache (useCachedFetch). Default season = the grow-year today falls in (Nov 1 – Oct 31, ET).
//
// Fail closed on a shape this page did not ask for: an envelope that is not version 1 with a sections
// object is an error, not an empty page — a page that draws a half-understood payload says something
// false (the SeasonEnd rule).
//
// EMPTY-SEASON FALLBACK. From Nov 1 the default grow-year is a new one with no picks, and the page
// would open on nothing for months. When no season was asked for and the current one has no picks,
// step back a year at a time (at most SEASON_FALLBACK_YEARS) to the most recent season that has
// some. `year` is the season shown; `requestedYear` the one asked for, so the page can say which.
// None found → the current season is shown (and the page's empty state says so).
import { useEffect, useMemo, useState } from 'react'
import { useCachedFetch } from './useCachedFetch.js'
import { currentGrowYear } from '../lib/growYear.js'
import { seasonHasPicks } from '../lib/stats-kit/registry.js'

export const SEASON_STATS_PATH = '/api/harvests/season-stats'
export const STATS_VERSION = 1
export const SEASON_FALLBACK_YEARS = 2

export const seasonStatsPath = (year) => `${SEASON_STATS_PATH}?season=${encodeURIComponent(year)}`

export function isStatsEnvelope(d) {
  return !!d && typeof d === 'object' && !Array.isArray(d) && d.version === STATS_VERSION
    && !!d.sections && typeof d.sections === 'object' && !Array.isArray(d.sections)
}

export function useSeasonStats(season) {
  const requestedYear = season ?? currentGrowYear(new Date())
  const fallback = season == null
  const [walk, setWalk] = useState({ from: requestedYear, back: 0, done: false })
  const w = walk.from === requestedYear ? walk : { from: requestedYear, back: 0, done: false }
  const year = w.done ? requestedYear : requestedYear - w.back
  const { data, loading, error, refetch } = useCachedFetch(year != null ? seasonStatsPath(year) : null)

  const ready = !error && !loading && data !== undefined && isStatsEnvelope(data)
  // The plain fetch keeps the previous path's data while the next one loads. The walk only ever
  // moves to EARLIER years, so an envelope for a later year is that leftover, not this answer.
  const stale = ready && Number.isFinite(data?.season?.year) && data.season.year > year
  const searching = fallback && !w.done && ready && !stale && !seasonHasPicks(data)

  useEffect(() => {
    if (!searching) return
    setWalk(w.back < SEASON_FALLBACK_YEARS
      ? { from: requestedYear, back: w.back + 1, done: false }
      : { from: requestedYear, back: w.back, done: true })
  }, [searching, w.back, requestedYear])

  return useMemo(() => {
    const base = { year, requestedYear, refetch }
    if (error) return { ...base, stats: null, loading: false, error }
    if (loading || data === undefined || stale || searching) return { ...base, stats: null, loading: true, error: null }
    if (!isStatsEnvelope(data)) return { ...base, stats: null, loading: false, error: new Error('unexpected response') }
    return { ...base, stats: data, loading: false, error: null }
  }, [year, requestedYear, data, loading, error, refetch, stale, searching])
}
