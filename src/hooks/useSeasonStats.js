// useSeasonStats — the Season stats envelope for one grow-year (plan D4/D5), read through the app's
// SWR cache (useCachedFetch). Default season = the grow-year today falls in (Nov 1 – Oct 31, ET).
//
// Fail closed on a shape this page did not ask for: an envelope that is not version 1 with a sections
// object is an error, not an empty page — a page that draws a half-understood payload says something
// false (the SeasonEnd rule).
import { useMemo } from 'react'
import { useCachedFetch } from './useCachedFetch.js'
import { currentGrowYear } from '../lib/growYear.js'

export const SEASON_STATS_PATH = '/api/harvests/season-stats'
export const STATS_VERSION = 1

export const seasonStatsPath = (year) => `${SEASON_STATS_PATH}?season=${encodeURIComponent(year)}`

export function isStatsEnvelope(d) {
  return !!d && typeof d === 'object' && !Array.isArray(d) && d.version === STATS_VERSION
    && !!d.sections && typeof d.sections === 'object' && !Array.isArray(d.sections)
}

export function useSeasonStats(season) {
  const year = season ?? currentGrowYear(new Date())
  const { data, loading, error, refetch } = useCachedFetch(year != null ? seasonStatsPath(year) : null)
  return useMemo(() => {
    if (error) return { year, stats: null, loading: false, error, refetch }
    if (loading || data === undefined) return { year, stats: null, loading: true, error: null, refetch }
    if (!isStatsEnvelope(data)) return { year, stats: null, loading: false, error: new Error('unexpected response'), refetch }
    return { year, stats: data, loading: false, error: null, refetch }
  }, [year, data, loading, error, refetch])
}
