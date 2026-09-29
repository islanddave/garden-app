// PlantsCatchUp — V5-PLANTSTARTDATES-001. Rough start dates for the plantings that have none.
//
// Replaces the V1.2a-4 "Catch up — coming soon" stub that sat behind CATCH_UP_EDITOR_SHIPPED. The
// rules (who is listed, which months, which day, the PUT body) live in lib/catchUp.js; this file is
// the list and its per-row state.
//
// ROWS NEVER MOVE. The list is a snapshot taken at load: a saved row now has a date, so re-deriving
// membership after a save would slide it out from under the finger that just tapped Save — and every
// row below it up by one row's height, onto the next Save button. A saved row stays exactly where it
// was, says "Saved", and can be changed again. It leaves the list the next time the page loads.
//
// REWARD UX: a task surface, so no celebration, no tally and no count-down. The header count is what
// the page opened with and does not tick down as rows are saved; "Saved" is a plain per-row
// confirmation of the thing the user just asked for. The More row that leads here carries no count.
//
// MOBILE IS THE GATE (Android PWA, 426x836 CSS px): the two pickers share one line at half width each,
// and every control — both pickers and Save — is at least 48px tall.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApiFetch } from '../lib/api.js'
import useNearViewport from '../hooks/useNearViewport.js'
import { IMAGE_WINDOW_PAGE } from '../hooks/useImageWindow.js'
import { P, T } from '../lib/tokens.js'
import { invalidatePrefix } from '../lib/dataCache.js'
import { TIER } from '../lib/photoModel.js'
import { cropTypeLabel } from '../lib/projectTree.js'
import {
  needsStartDates, groupCatchUpRows, locationPath, plantingGrowYear, monthOptions, monthLabel,
  outBeforeSown, catchUpBody, todayKey,
} from '../lib/catchUp.js'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import SharedEmptyState from '../components/forms/EmptyState.jsx'
import Button from '../components/forms/Button.jsx'
import Field from '../components/forms/Field.jsx'
import Select from '../components/forms/Select.jsx'
import PhotoView from '../components/photo/PhotoView.jsx'
import Icon from '../components/Icon.jsx'
import PageShell from '../components/forms/PageShell.jsx'

export const CATCH_UP_PLANTS_PATH = '/api/plants'
export const CATCH_UP_LOCATIONS_PATH = '/api/locations'
export const plantPutPath = (id) => `/api/plants/${id}`

// 48px — the same tap-height the pickers and Save carry, so the thumb lines up with them.
const THUMB = T.space.md * 3
const EMPTY_DRAFT = { sown: '', plantedOut: '' }
const FRESH = { draft: EMPTY_DRAFT, saved: EMPTY_DRAFT, status: 'idle' }
const rowIdOf = (el) => el.getAttribute('data-planting-id')

export function headerLine(n) {
  return n === 1 ? '1 planting has no start dates.' : `${n} plantings have no start dates.`
}

// Title = the planting's name, which is its cultivar for almost every planting here. The line under
// it names what the title does not already say: the crop, the cultivar when the planting was renamed,
// and where it is.
export function rowTitle(p) {
  return p?.name || p?.variety_ref?.name || 'Untitled'
}
export function rowDetail(p, where) {
  const title = rowTitle(p).trim().toLowerCase()
  const differs = (s) => s && String(s).trim().toLowerCase() !== title
  const parts = []
  const crop = cropTypeLabel(p?.variety_ref?.crop_type_slug)
  if (differs(crop)) parts.push(crop)
  if (differs(p?.variety_ref?.name)) parts.push(p.variety_ref.name)
  parts.push(where || 'No location')
  return parts.join(' · ')
}

function Thumb({ p, withPhoto }) {
  // A PLANTING IS NOT A PHOTO: remapped exactly as PlantingTile does, so PhotoView's presign self-heal
  // re-mints the PHOTO id rather than the plant id. A photo outside the image window keeps its box,
  // empty, until its row comes within reach; the sprout means the planting has no photo at all.
  const photo = useMemo(() => (p.featured_photo_view_url ? {
    id: p.featured_photo_id ?? null,
    featured_photo_view_url: p.featured_photo_view_url,
    featured_photo_thumb_url: p.featured_photo_thumb_url ?? null,
    plant_id: p.id,
  } : null), [p.featured_photo_id, p.featured_photo_view_url, p.featured_photo_thumb_url, p.id])
  return (
    <div
      aria-hidden="true"
      data-testid="catchup-thumb-box"
      style={{
        width: THUMB, height: THUMB, flexShrink: 0, overflow: 'hidden',
        borderRadius: T.radiusField, backgroundColor: P.greenPale, color: P.greenDeep,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {photo
        ? withPhoto && <PhotoView photo={photo} tier={TIER.THUMB} alt="" decoding="async" data-testid="catchup-thumb"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : <Icon name="lifecycle.sprout" size={24} decorative />}
    </div>
  )
}

function MonthPicker({ id, label, ariaLabel, value, saved, options, disabled, onChange }) {
  // No blank choice once a month is SAVED: the PUT cannot unset a date (an absent key means "leave it
  // as it is"), so a blank here would show nothing while the planting still holds the saved month.
  return (
    <Field label={label} id={id}>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={saved ? undefined : '—'}
        options={options.map(ym => ({ value: ym, label: monthLabel(ym) }))}
        disabled={disabled}
        aria-label={ariaLabel}
        style={{ width: '100%', minHeight: T.buttonMinHeight }}
      />
    </Field>
  )
}

function CatchUpRow({ p, where, state, today, withPhoto, onPick, onSave }) {
  const { draft, saved, status } = state
  const title = rowTitle(p)
  const options = useMemo(() => monthOptions(plantingGrowYear(p, today), today), [p, today])
  const saving = status === 'saving'
  const dirty = draft.sown !== saved.sown || draft.plantedOut !== saved.plantedOut
  const outOfOrder = outBeforeSown(draft)
  const canSave = !saving && dirty && Boolean(draft.sown || draft.plantedOut) && !outOfOrder

  let note = null
  if (outOfOrder) note = { text: 'Planted out can’t be before sown.', color: P.terra }
  else if (status === 'error') note = { text: 'Didn’t save', color: P.terra }
  else if (status === 'saved') note = { text: 'Saved', color: P.green }

  return (
    <li
      data-testid="catchup-row"
      data-planting-id={p.id}
      style={{ padding: 0, paddingTop: T.space.md, paddingBottom: T.space.md, borderBottom: `1px solid ${P.border}` }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm }}>
        <Thumb p={p} withPhoto={withPhoto} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: P.dark, fontSize: T.type.md, fontWeight: 600 }}>{title}</div>
          <div style={{ color: P.mid, fontSize: T.type.sm }}>{rowDetail(p, where)}</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: T.space.sm, marginTop: T.space.sm }}>
        <MonthPicker
          id={`catchup-${p.id}-sown`} label="Sown ~" ariaLabel={`Sown month for ${title}`}
          value={draft.sown} saved={saved.sown} options={options} disabled={saving}
          onChange={(v) => onPick(p.id, 'sown', v)}
        />
        <MonthPicker
          id={`catchup-${p.id}-out`} label="Planted out ~" ariaLabel={`Planted-out month for ${title}`}
          value={draft.plantedOut} saved={saved.plantedOut} options={options} disabled={saving}
          onChange={(v) => onPick(p.id, 'plantedOut', v)}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: T.space.md, marginTop: T.space.sm }}>
        <Button
          onClick={() => onSave(p, draft)}
          disabled={!canSave}
          loading={saving}
          loadingLabel="Saving…"
          aria-label={`${status === 'error' ? 'Try again saving' : 'Save'} start dates for ${title}`}
        >
          {status === 'error' ? 'Try again' : 'Save'}
        </Button>
        <span role="status" data-testid="catchup-row-note" style={{ color: note?.color, fontSize: T.type.base, fontWeight: 600 }}>
          {note?.text ?? ''}
        </span>
      </div>
    </li>
  )
}

export default function PlantsCatchUp() {
  const { fetch: apiFetch } = useApiFetch()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [groups, setGroups] = useState([])
  const [locations, setLocations] = useState([])
  const [today, setToday] = useState(() => todayKey())
  const [rowStates, setRowStates] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [plants, locs] = await Promise.all([
        apiFetch(CATCH_UP_PLANTS_PATH),
        apiFetch(CATCH_UP_LOCATIONS_PATH),
      ])
      const locList = Array.isArray(locs) ? locs : (locs?.locations ?? [])
      setLocations(locList)
      setGroups(groupCatchUpRows((Array.isArray(plants) ? plants : []).filter(needsStartDates), locList))
      setRowStates({})
      setToday(todayKey())
    } catch (err) {
      setGroups([])
      setLoadError(err?.message || 'Could not load your plantings.')
    }
    setLoading(false)
  }, [apiFetch])

  useEffect(() => { load() }, [load])

  const setRow = useCallback((id, fn) => {
    setRowStates(prev => ({ ...prev, [id]: fn(prev[id] ?? FRESH) }))
  }, [])

  // Any change clears "Saved" / "Didn't save": the note describes the last attempt, and after an edit
  // there is a newer choice on screen that has not been attempted.
  const onPick = useCallback((id, field, value) => {
    setRow(id, s => ({ ...s, draft: { ...s.draft, [field]: value }, status: 'idle' }))
  }, [setRow])

  // A second tap cannot send a second PUT: 'saving' puts Save into its loading state, which disables
  // it, and the pickers are disabled with it so the draft being saved cannot change underneath.
  const onSave = useCallback(async (p, draft) => {
    if (outBeforeSown(draft)) return
    const body = catchUpBody(draft, today)
    if (!Object.keys(body).length) return
    setRow(p.id, s => ({ ...s, status: 'saving' }))
    try {
      await apiFetch(plantPutPath(p.id), { method: 'PUT', body: JSON.stringify(body) })
      setRow(p.id, s => ({ ...s, saved: draft, status: 'saved' }))
      // Every cached plants list now holds a stale copy of this row.
      invalidatePrefix('/api/plants')
    } catch {
      setRow(p.id, s => ({ ...s, status: 'error' }))
    }
  }, [apiFetch, today, setRow])

  const total = groups.reduce((n, g) => n + g.count, 0)

  // Photos are windowed, rows are not (the My seeds and End of season pattern, BUG-PHOTOTHUMB-001): a
  // thumbnail mounts for the first IMAGE_WINDOW_PAGE rows on the page, or once its row comes within
  // reach of the viewport. ~134 rows mounting every thumbnail at once is the eager-image freeze, and a
  // photo with no thumb falls back to its full original.
  const listRef = useRef(null)
  const inReach = useNearViewport(listRef, { selector: '[data-testid="catchup-row"]', keyOf: rowIdOf })
  const imageRank = useMemo(() => new Map(groups.flatMap((g) => g.plantings).map((p, n) => [p.id, n])), [groups])
  const withPhoto = (id) => (imageRank.get(id) ?? Infinity) < IMAGE_WINDOW_PAGE || inReach.has(String(id))

  // PageShell for the frame and title only: its own AsyncRegion takes no retry, and a load failure
  // here must offer one, so the async states are the inner region's.
  return (
    <PageShell title="Catch up">
      <AsyncRegion
        loading={loading}
        error={loadError}
        empty={!loading && !loadError && total === 0}
        emptyLabel={<SharedEmptyState iconName="care.plantedOut" body="Every planting has a start date." />}
        onRetry={load}
        errorTitle="Couldn’t load your plantings"
        retryLabel="Try again"
        loadingLabel="Loading plantings…"
      >
        <p data-testid="catchup-header" style={{ margin: 0, marginBottom: T.space.xs, color: P.dark, fontSize: T.type.md, fontWeight: 600 }}>
          {headerLine(total)}
        </p>
        <p style={{ margin: 0, marginBottom: T.space.md, color: P.mid, fontSize: T.type.sm, lineHeight: 1.5 }}>
          A rough month is enough — it is saved as approximate.
        </p>
        <div ref={listRef}>
          {groups.map(g => {
            const label = g.isUnsorted ? g.label : (locationPath(g.slug, locations) || g.label)
            const where = g.isUnsorted ? null : g.label
            return (
              <section key={g.slug} aria-label={label} data-testid="catchup-group" style={{ marginBottom: T.space.lg }}>
                <h2 style={{ margin: 0, color: P.mid, fontSize: T.type.sm, fontWeight: 700 }}>{label}</h2>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {g.plantings.map(p => (
                    <CatchUpRow
                      key={p.id} p={p} where={where} today={today} withPhoto={withPhoto(p.id)}
                      state={rowStates[p.id] ?? FRESH} onPick={onPick} onSave={onSave}
                    />
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </AsyncRegion>
    </PageShell>
  )
}
