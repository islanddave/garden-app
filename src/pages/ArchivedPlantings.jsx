// V4-ARCHIVEBROWSE-001 — the browse surface for archived plantings.
//
// WHY THIS PAGE EXISTS. Archiving is hidden-but-alive: the row keeps every relation, it just stops
// appearing in lists. All four active reads carry a literal `archived_at IS NULL`, and the ONLY
// discoverable way back was the 6-second Undo strip that appears on Garden immediately after you
// archive something. Once that closed, the planting was unreachable unless you already held its URL.
// 30 live rows on prod sat in that state at authoring time. The same shape as Recently deleted's
// founding defect — a control that hides things, shipped without the place they go.
//
// NOT BOLTED ONTO RECENTLY DELETED, which states its own boundary in source: "it is a recovery
// surface, not an archive browser." Archived and deleted are different states with different
// verbs, and the two prod rows that are BOTH archived and deleted belong to that page, not this one
// — the archive PATCH refuses a deleted row, so an Unarchive button on one would 404 with nothing
// useful to say. The server excludes them; this page never sees them.
//
// NOT AN INLINE FILTER ON GARDEN. Dave's call, and the structural reason is that Garden has no
// filter axis to extend — GroupBySlugSelect is a group-by and the SegmentedControl is a caretaker
// lens, both the wrong axis — so an archived mode would be a third interacting state on the app's
// busiest page, layered over a cached ?view=grid fetch and scroll restore.
//
// REWARD-UX: unarchiving is operational. No celebration, no badge, no count-up — an ambient toast
// confirming the thing the user just asked for, which is the Toast primitive's operational carve-out.
//
// MOBILE IS THE GATE (Android Chrome, ~390px). Row is text + a 44px-minimum Unarchive control that
// wraps to its own line rather than shrinking below the tap floor. Nothing here is destructive, so
// the safe action is allowed to be the easy one.
import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { formatDate } from '../lib/format.js'
import { invalidatePrefix } from '../lib/dataCache.js'
import { useOptionalToast } from '../context/ToastContext.jsx'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import SharedEmptyState from '../components/forms/EmptyState.jsx'
import Button from '../components/forms/Button.jsx'
import ErrorBanner from '../components/forms/ErrorBanner.jsx'
import PlantStatusBadge from '../components/PlantStatusBadge.jsx'

export const ARCHIVED_PLANTINGS_PATH = '/api/plants/archived'
export const unarchivePath = (id) => `/api/plants/${id}/archive`

// Slug → label, locally. MEASURED on the 30 archived rows live on prod 2026-08-27: all 9 crop types
// present (asparagus, cilantro, culantro, lettuce, lithops, luffa, pepper, spinach, tomato) have a
// crop_types.display_name that is exactly the title-cased slug, so fetching /api/varieties/crop-types
// to render this would add a second network dependency — and a second failure mode — to a recovery
// surface, in exchange for nothing on any row that exists. An irregular slug arriving later costs a
// slightly-off label, not a broken page, which is the cheaper way to be wrong.
export function cropLabelFromSlug(slug) {
  if (!slug) return null
  return String(slug).split(/[-_]/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// The row's secondary line.
//
// NO CONTAINER NAME, unlike Recently deleted's planting rows which use project_name as their
// subtitle. Containers are not a user-facing noun in this app; the server does not even send it.
//
// NEITHER NAME REPEATS THE TITLE, and both suppressions were earned by looking at the real rows
// rather than by reasoning about the shape. Measured on the 30 live archived plantings, 2026-08-27:
//   * display_name IS the variety name in 21 of them — printing both would render
//     "Emerald Green · Emerald Green" on the majority of rows;
//   * display_name IS the crop in 4 of them ("Culantro", "Asparagus", "Lettuce", "Spinach") —
//     which a browser render caught and the unit tests had not, because the fixture they were
//     written around was a pepper called "Emerald Green", i.e. the case where nothing repeats.
// When both are suppressed the line is just "Archived {date}", which is the whole of what is left
// to say about a planting whose name already told you what it is.
export function rowSubtitle(row) {
  const parts = []
  const title = String(row?.name ?? '').trim().toLowerCase()
  const same = (s) => s && String(s).trim().toLowerCase() === title
  const crop = cropLabelFromSlug(row?.crop_type_slug)
  if (crop && !same(crop)) parts.push(crop)
  const variety = row?.variety_name
  if (variety && !same(variety)) parts.push(variety)
  const when = formatDate(row?.archived_at)
  if (when) parts.push(`Archived ${when}`)
  return parts.join(' · ')
}

// V4-EMPTYSTATE-001: chrome from the shared primitive. Body-only, and it gains the card this
// page never had — the surrounding AsyncRegion renders emptyLabel bare, so before this the copy
// floated on the page background with nothing marking it as a state rather than a load failure.
function EmptyState() {
  return (
    <SharedEmptyState body="Nothing is archived. Archiving hides a planting from your garden without deleting it — anything you archive shows up here, and you can bring it back any time." />
  )
}

export default function ArchivedPlantings() {
  const { fetch: apiFetch } = useApiFetch()
  const toast = useOptionalToast()

  const [rows, setRows] = useState([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  // TWO error states, deliberately, for the reason Recently deleted gives: a LOAD failure replaces
  // the region because there is nothing to show, but an UNARCHIVE failure must NOT — routing it
  // through the same state would blank the list the user is working in and take away every other
  // row's button because one row failed.
  const [loadError, setLoadError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setActionError(null)
    try {
      const body = await apiFetch(ARCHIVED_PLANTINGS_PATH)
      setRows(Array.isArray(body?.plants) ? body.plants : [])
      setTruncated(Boolean(body?.truncated))
    } catch (err) {
      setRows([])
      setTruncated(false)
      setLoadError(err?.message || 'Could not load archived plantings.')
    }
    setLoading(false)
  }, [apiFetch])

  useEffect(() => { load() }, [load])

  const unarchive = useCallback(async (row) => {
    if (busyId) return
    setBusyId(row.id)
    setActionError(null)
    try {
      // NO NEW WRITE ROUTE. The existing archive toggle already carries the household-ownership
      // checks and already refuses deleted rows, so unarchiving introduces no authorization surface
      // to review — `{archived:false}` is the same endpoint the archive button uses.
      await apiFetch(unarchivePath(row.id), {
        method: 'PATCH',
        body: JSON.stringify({ archived: false }),
      })
      // Drop locally rather than refetching — the server answer IS the confirmation.
      setRows((prev) => prev.filter((r) => r.id !== row.id))
      // Every cached plants list filtered this row out and is now wrong: it belongs back in Garden.
      invalidatePrefix('/api/plants')
      toast?.show?.({ message: 'Planting unarchived' })
    } catch (err) {
      setActionError(err?.message || 'Could not unarchive that planting.')
    }
    setBusyId(null)
  }, [apiFetch, busyId, toast])

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '28px 16px 60px' }}>
        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
          <Link to="/garden" style={{ color: P.green, textDecoration: 'none' }}>Garden</Link>
          {' › Archived'}
        </div>
        <h1 style={{ margin: '0 0 8px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
          Archived plantings
        </h1>
        <p style={{ margin: '0 0 20px', color: P.mid, fontSize: '0.88rem', lineHeight: 1.5 }}>
          Archived plantings are hidden from your garden but kept in full — every photo, event and
          harvest stays attached. Unarchive one and it goes straight back where it was.
        </p>

        <AsyncRegion
          loading={loading}
          error={loadError}
          empty={!loading && !loadError && rows.length === 0}
          emptyLabel={<EmptyState />}
          onRetry={load}
          errorTitle="Couldn’t load archived plantings"
          loadingLabel="Loading archived plantings…"
        >
          {actionError && <ErrorBanner>{actionError}</ErrorBanner>}
          {truncated && (
            // A list that stops at its own LIMIT without saying so is a list that lies about being
            // complete, and an archive is precisely where "it isn't there" gets believed.
            <p role="status" style={{ margin: '0 0 12px', color: P.mid, fontSize: '0.82rem' }}>
              Showing the {rows.length} most recently archived. Unarchive some to see older ones.
            </p>
          )}
          <ul data-testid="archived-plantings-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {rows.map((row) => {
              const busy = busyId === row.id
              return (
                <li
                  key={row.id}
                  data-testid="archived-planting-row"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                    padding: '10px 0', borderBottom: `1px solid ${P.line ?? '#e6e2d8'}`,
                  }}
                >
                  <div style={{ minWidth: 0, flex: '1 1 60%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {/* The row title is a link because an archived planting is still fully
                          openable — the by-id GET deliberately carries no archived filter, and a
                          regression test pins that. Deciding whether to unarchive usually means
                          looking at the thing first. */}
                      <Link
                        to={`/plantings/${row.id}`}
                        style={{ color: P.dark, fontSize: '0.95rem', fontWeight: 600, textDecoration: 'none' }}
                      >
                        {row.name || 'Untitled'}
                      </Link>
                      <PlantStatusBadge status={row.status} />
                    </div>
                    <div style={{ color: P.mid, fontSize: '0.82rem' }}>
                      {rowSubtitle(row)}
                    </div>
                  </div>
                  <Button
                    onClick={() => unarchive(row)}
                    disabled={busy}
                    aria-label={busy ? undefined : `Unarchive ${row.name || 'planting'}`}
                    style={{ minWidth: 108, minHeight: 44, marginLeft: 'auto' }}
                  >
                    {busy ? 'Unarchiving…' : 'Unarchive'}
                  </Button>
                </li>
              )
            })}
          </ul>
        </AsyncRegion>
      </div>
    </div>
  )
}
