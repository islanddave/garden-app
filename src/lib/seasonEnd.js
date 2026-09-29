// src/lib/seasonEnd.js — the End of season page's decisions, kept pure (no React, no fetch).
//
// WHAT THE PAGE IS FOR. After a killing frost most annual plantings still read fruiting / harvested /
// vegetative until someone ends them one at a time. This lists the ones a frost finishes and ends a
// ticked set in one go, as status `ended` — the ONE outcome. Never `failed` (a frost ending a crop
// grown as an annual is its expected end, and a bulk "failed" would turn a productive season into
// losses), never a loss reason, and never an archive: archiving hides a planting's harvests from the
// season totals, and these plantings hold ~70% of 2026's harvest weight (seat-hort-data.md D1, D3).
//
// THE LIST RULE (seat-hort-data.md D4, as decided in the build brief). A planting is FINISHED — listed,
// group-selectable — when all of these hold:
//   · it is a live planting: kind 'planting', not deleted, not archived, container live (the server
//     read applies the last three; `kind` is checked here);
//   · its crop's frost band is `tender` or `chill_sensitive`, read DIRECTLY from the band map
//     (frostBands.generated.js). Not through CLASS_BY_BAND or TENDER_SLUGS, which fold tropical and
//     light-frost crops into tender; and an unmapped or uncertain slug has NO band, so it is never
//     listed — the frost alert counts an unknown crop as tender, and that cautious default is the
//     unsafe one for a surface that ENDS plantings;
//   · nothing up its location chain is covered or heated — the rain roof rule's recursion
//     (lambda/daily-plan/handler.js logRainEvents), walked over GET /api/locations, which carries
//     only live locations, so a deleted location ends the walk exactly as the SQL join does;
//   · its status is not ended, failed or dormant.
// On prod (2026-09-29) that is 114 plantings, and it catches no perennial, fruit, houseplant or
// succulent: those are banded hardy or tropical, or sit under a roof.
//
// STILL GROWING THROUGH FROST — a second, collapsed group, ticked one at a time and never by group:
// outdoor live plantings whose band is `light_frost_tolerant`, whatever the crop's lifecycle (petunia's
// crop is not an annual or biennial, and it still dies in the first hard freeze), or whose band is
// `hardy` AND whose CROP is an annual or biennial (crop_types.default_lifecycle). Not the variety's
// grown_as, which is a bulk default and wrong for ~50 rows. These are for a later pass after hard
// freezes. A hardy perennial (fruit, herbs, the peach) is not listed at all: it goes dormant, it is not
// ended.
//
// "Last logged" is SHOWN on every row and never filtered on: on prod, 89 of the 114 frost-finished
// plantings were worked in the last 14 days, so recent activity runs opposite to frost kill.
import { FROST_BAND_BY_SLUG } from './frostBands.generated.js'
import { toLocalISO } from './dateLocal.js'
import { formatDate } from './format.js'

export const SEASON_END_PATH = '/api/plants/season-end'
export const LOCATIONS_PATH = '/api/locations'
export const plantPath = (id) => `/api/plants/${id}`

export const ENDED_STATUS = 'ended'
export const FINISHED_BANDS = Object.freeze(['tender', 'chill_sensitive'])
export const STILL_GROWING_BANDS = Object.freeze(['hardy', 'light_frost_tolerant'])
// Of those, the bands listed only when the crop is an annual or biennial. light_frost_tolerant is not
// here on purpose: it is listed whatever the crop's lifecycle.
export const LIFECYCLE_GATED_BANDS = Object.freeze(['hardy'])
export const SHORT_LIFECYCLES = Object.freeze(['annual', 'biennial'])
export const CLOSED_STATUSES = Object.freeze(['ended', 'failed', 'dormant'])

// "3-4 in flight". Each PUT is one short transaction on the plants Lambda; 3 keeps a 114-row batch
// near 20 s without stacking Neon connections.
export const WRITE_CONCURRENCY = 3

export const GROUP_FINISHED = 'finished'
export const GROUP_STILL_GROWING = 'still_growing'
export const NO_LOCATION_KEY = 'no-location'
export const NO_LOCATION_LABEL = 'No location'

export function bandForSlug(slug) {
  if (typeof slug !== 'string') return null
  const s = slug.trim().toLowerCase()
  return Object.hasOwn(FROST_BAND_BY_SLUG, s) ? FROST_BAND_BY_SLUG[s] : null
}

export function indexLocations(locations) {
  const byId = new Map()
  for (const l of Array.isArray(locations) ? locations : []) {
    if (l && l.id != null) byId.set(l.id, l)
  }
  return byId
}

// True when the planting's own location, or any parent above it, is covered or heated. Strict `=== true`
// on both flags; a missing location reads as open sky, as it does in the rain roof rule. The visited set
// is a guard against a parent cycle, which the SQL recursion would loop on.
export function isUnderRoof(locationId, byId) {
  const seen = new Set()
  let id = locationId ?? null
  while (id != null && byId.has(id) && !seen.has(id)) {
    seen.add(id)
    const l = byId.get(id)
    if (l.covered === true || l.heated === true) return true
    id = l.parent_id ?? null
  }
  return false
}

export function isLivePlanting(row) {
  return !!row && row.kind === 'planting' && !row.deleted_at && !row.archived_at
}

// 'finished' | 'still_growing' | null (not listed).
export function classifyPlanting(row, byId) {
  if (!isLivePlanting(row)) return null
  if (CLOSED_STATUSES.includes(row.status)) return null
  if (isUnderRoof(row.location_id, byId)) return null
  const band = bandForSlug(row.variety_ref?.crop_type_slug)
  if (FINISHED_BANDS.includes(band)) return GROUP_FINISHED
  if (!STILL_GROWING_BANDS.includes(band)) return null
  if (LIFECYCLE_GATED_BANDS.includes(band) && !SHORT_LIFECYCLES.includes(row.variety_ref?.default_lifecycle)) return null
  return GROUP_STILL_GROWING
}

const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' })

function toItem(row, kind, byId) {
  const loc = row.location_id != null ? byId.get(row.location_id) : null
  return {
    id: row.id,
    name: row.name || row.variety_ref?.name || 'Untitled planting',
    status: row.status ?? null,
    kind,
    band: bandForSlug(row.variety_ref?.crop_type_slug),
    locationKey: loc ? String(loc.id) : NO_LOCATION_KEY,
    locationName: loc?.name || NO_LOCATION_LABEL,
    lastLoggedAt: row.last_logged_at ?? null,
    // A PLANTING IS NOT A PHOTO (PlantingTile.jsx): the photo's id is the hero's, never the plant's.
    photo: row.featured_photo_view_url ? {
      id: row.featured_photo_id ?? null,
      featured_photo_view_url: row.featured_photo_view_url,
      featured_photo_thumb_url: row.featured_photo_thumb_url ?? null,
      plant_id: row.id,
    } : null,
  }
}

// The page's list: finished plantings grouped by their own location (groups and rows alphabetical),
// plus the still-growing plantings as one flat list ordered by location, then name.
export function buildSeasonList(rows, locations) {
  const byId = indexLocations(locations)
  const groups = new Map()
  const stillGrowing = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const kind = classifyPlanting(row, byId)
    if (!kind) continue
    const item = toItem(row, kind, byId)
    if (kind === GROUP_STILL_GROWING) { stillGrowing.push(item); continue }
    if (!groups.has(item.locationKey)) groups.set(item.locationKey, { key: item.locationKey, label: item.locationName, rows: [] })
    groups.get(item.locationKey).rows.push(item)
  }
  const finished = [...groups.values()]
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
    .map((g) => ({ ...g, rows: g.rows.sort(byName) }))
  stillGrowing.sort((a, b) => a.locationName.localeCompare(b.locationName, undefined, { sensitivity: 'base' }) || byName(a, b))
  return { finished, stillGrowing }
}

// A group's select control acts on THAT group's rows only: "Select N" ticks all N, "Clear N" unticks
// all N once every one is ticked. The still-growing group has no group select at all.
export function groupSelectAction(groupRows, selected) {
  const ids = groupRows.map((r) => r.id)
  const all = ids.length > 0 && ids.every((id) => selected.has(id))
  return { verb: all ? 'Clear' : 'Select', count: ids.length, ids, clears: all }
}

export function applyGroupSelect(selected, action) {
  const next = new Set(selected)
  for (const id of action.ids) {
    if (action.clears) next.delete(id)
    else next.add(id)
  }
  return next
}

export const plantingsPhrase = (n) => (n === 1 ? '1 planting' : `${n} plantings`)

// "Bag Area: 5 · Trough: 2" — most first, then alphabetical, so the biggest share reads first.
export function countsByLocation(items) {
  const m = new Map()
  for (const it of items) m.set(it.locationName, (m.get(it.locationName) ?? 0) + 1)
  return [...m.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
}

export function confirmSummary(items) {
  const n = items.length
  return {
    title: `End ${plantingsPhrase(n)}?`,
    button: `End ${plantingsPhrase(n)}`,
    counts: countsByLocation(items).map((c) => `${c.label}: ${c.count}`).join(' · '),
    stillGrowingNames: items.filter((it) => it.kind === GROUP_STILL_GROWING).map((it) => it.name),
  }
}

// The two request bodies this page sends, and nothing else: a status. Never a loss cause, never an
// archive, never a clear.
export const endBody = () => ({ status: ENDED_STATUS })
export const restoreBody = (prevStatus) => ({ status: prevStatus })

// A row can be put back only to a real prior status: the PUT merges with COALESCE, so a null would
// leave it ended while the page claimed otherwise.
export const canRestore = (prevStatus) => typeof prevStatus === 'string' && prevStatus.length > 0

// Runs `worker` over `items` with at most `concurrency` in flight. Never rejects: each result is
// { ok, value } or { ok: false, error }, in input order. onProgress(done, total) after each one.
export async function runPool(items, worker, { concurrency = WRITE_CONCURRENCY, onProgress } = {}) {
  const results = new Array(items.length)
  let next = 0
  let done = 0
  async function lane() {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { ok: true, value: await worker(items[i], i) }
      } catch (error) {
        results[i] = { ok: false, error }
      }
      done++
      onProgress?.(done, items.length)
    }
  }
  const lanes = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: lanes }, lane))
  return results
}

export const progressLine = (verb, done, total) => `${verb} ${Math.min(done + 1, total)} of ${total}…`

// After a batch: what the bar says. Today reads an hourly stored plan, so the copy says the rows leave
// Today's list within the hour — it does not claim they already left.
export const TODAY_LAG_LINE = "They leave Today's list within the hour."

export function endResultLine(landed, failed) {
  if (landed === 0) return "Couldn't end these. Check your signal and try again."
  if (failed === 0) return `Ended ${plantingsPhrase(landed)}.`
  return `Ended ${landed}. ${failed} didn't save.`
}

export function undoResultLine(putBack, attempted) {
  const stillEnded = attempted - putBack
  if (stillEnded === 0) return `Put back ${plantingsPhrase(putBack)}.`
  return `Put back ${putBack} of ${attempted}. ${stillEnded} ${stillEnded === 1 ? 'is' : 'are'} still ended.`
}

// "Last logged Sep 26" (this year) / "Last logged Sep 26, 2025". The event time is a timestamp, so it
// is read as a LOCAL date first: a 9 pm log in Massachusetts is the next day in UTC.
export function lastLoggedLabel(ts, now = new Date()) {
  if (!ts) return 'Nothing logged yet'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return 'Nothing logged yet'
  const iso = toLocalISO(d)
  const full = formatDate(iso)
  const year = String(now.getFullYear())
  return `Last logged ${iso.startsWith(year) ? full.replace(`, ${year}`, '') : full}`
}
