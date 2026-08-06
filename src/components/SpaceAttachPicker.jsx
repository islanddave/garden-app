// src/components/SpaceAttachPicker.jsx — V4-SPACECLIENTGAP-001 Stage 2.
//
// Batch-attach existing photos to the Space. This is the ONLY client caller of
// PUT /api/photos/:id/space (the attach sub-resource shipped dark in v3.83.0); until now the
// route was live in prod with nothing able to invoke it, and the only way a photo could acquire a
// space_id at all was to be uploaded directly on /space.
//
// WHY IT LIVES ON /space AND NOT IN THE PHOTO LIBRARY TAG MODAL (crucible boss, carried into the
// Stage-2 brief). A sixth <select> in that modal was the obvious-looking home and is the wrong one
// on three independent counts: (1) the modal body has no `overflowY`, so a sixth field pushes the
// submit button off-screen on a phone; (2) that form ALREADY has a control labelled "Space" which
// means LOCATION — two different tiers, same word, one form (now renamed "Zone", but the collision
// is what made the modal the wrong surface in the first place); (3) attaching is a BATCH act —
// "these twelve wide shots are the property" — and a per-photo dropdown makes it a twelve-visit
// chore. The general re-tag PUT also cannot carry space_id at all; see the route's own comment.
//
// SEMANTICS. Attach only. Detach is deliberately absent from this surface: the route rejects
// detaching a photo's only parent with a 400, and the honest UI for "this photo belongs nowhere
// now" is the tag modal, not a bulk picker. Nothing here designates a hero either — attach and
// designate are separate acts (that is why there are two routes), so a batch attach never silently
// changes the feature photo.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'
import { P, T } from '../lib/tokens.js'
import PhotoImg from './PhotoImg.jsx'
import Spinner from './forms/Spinner.jsx'
import { useDismissable } from '../context/DismissRegistry.jsx'
import { LAYER } from '../lib/dismissLayers.js'

// Bounded concurrency. Each attach is its own PUT (the route is single-photo by design), so a
// 40-photo selection is 40 requests. Unbounded Promise.all would open 40 sockets at once and, on a
// cold Lambda, hand several of them a 503 that reads to the user as "the app dropped my photos".
// Four keeps the wall-clock reasonable while staying inside a warm container's comfort.
const ATTACH_CONCURRENCY = 4

// GET /api/photos caps at 200 and has NO offset/cursor — there is no pagination to page through.
// Prod carries ~981 photos, so this picker can only ever offer the most recent PAGE_LIMIT of them.
// That is a real limit, not a rounding error, so the sheet SAYS SO when the list comes back full
// (see the truncation notice) rather than quietly presenting a partial library as the whole thing.
// Paginating the endpoint properly means touching all four list SELECTs, each of which is
// flag-off byte-identity-sensitive — deliberately out of scope for the flip commit.
const PAGE_LIMIT = 200

// Run `worker` over `items` with at most `limit` in flight. Resolves to a result array in INPUT
// order — order matters because the failure list is rendered back against the original selection.
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return results
}

export default function SpaceAttachPicker({ spaceId, spaceName, onClose, onAttached }) {
  const { fetch } = useApiFetch()
  const [photos, setPhotos] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [loadTick, setLoadTick] = useState(0)
  const [selected, setSelected] = useState(() => new Set())
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(null)   // { count, ids:Set } after a partial failure
  const dialogRef = useRef(null)
  const closeRef = useRef(null)

  // Garden-wide read, then filter client-side to what is ATTACHABLE. There is no server-side
  // "?space_id=null" filter and this deliberately does not add one: the candidate set is "every
  // photo not already on this space", which is a negation the list endpoint has no vocabulary for,
  // and the wall is already capped at the endpoint's row limit (see PAGE_LIMIT above).
  // V4-BACKNAV-001 Slice 2 — mounted-means-open. `busy: saving` preserves this surface's existing
  // guard: it already refused Escape mid-save by hand, and the registry's blockOnBusy is what lets
  // it join without regressing that.
  const { registered, isTopmost } = useDismissable({ open: true, onDismiss: onClose, busy: saving, layer: LAYER.SHEET })

  useEffect(() => {
    const ac = new AbortController()
    setLoadError(null)
    setPhotos(null)
    fetch(`/api/photos?limit=${PAGE_LIMIT}`, { signal: ac.signal })
      .then((d) => {
        if (ac.signal.aborted) return
        setPhotos(Array.isArray(d) ? d : [])
      })
      .catch((e) => {
        if (ac.signal.aborted) return
        setLoadError(e ?? new Error('Failed to load photos'))
      })
    return () => ac.abort()
  }, [fetch, loadTick])

  // Already-attached rows are EXCLUDED, not shown-and-disabled: they are visible one scroll down in
  // the gallery this picker sits above, so listing them again would be the same photo twice on one
  // screen with different affordances. Depends on the list carrying space_id — it does, on every
  // branch, since the 2026-08-02 server fix (before that it was selected on the ?space_id branch
  // only, and every row here would have read as unattached).
  const candidates = useMemo(
    () => (photos ?? []).filter((p) => p.space_id !== spaceId),
    [photos, spaceId],
  )

  const toggle = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setFailed(null)
  }, [])

  // Escape closes, and focus lands on the close control so a keyboard user is not dropped at the
  // top of the document behind the sheet. Mirrors Lightbox's grammar rather than inventing a
  // second modal idiom. Not a full focus trap — Lightbox owns that pattern and copying half of it
  // would be worse than matching the simpler one.
  useEffect(() => {
    closeRef.current?.focus()
    function onKey(e) {
      if (registered) return   // registry owns Escape (and the busy guard)
      if (e.key === 'Escape' && !saving) { e.preventDefault(); onClose?.() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving, registered])

  async function attach() {
    if (!selected.size || saving || !spaceId) return
    setSaving(true)
    setFailed(null)
    const ids = [...selected]
    const outcomes = await mapWithLimit(ids, ATTACH_CONCURRENCY, async (id) => {
      try {
        await fetch(`/api/photos/${id}/space`, {
          method: 'PUT',
          body: JSON.stringify({ space_id: spaceId }),
        })
        return { id, ok: true }
      } catch {
        return { id, ok: false }
      }
    })
    const bad = outcomes.filter((o) => !o.ok).map((o) => o.id)
    const okCount = ids.length - bad.length
    setSaving(false)

    // PARTIAL FAILURE IS A FIRST-CLASS OUTCOME, not an error toast over a closed sheet. N requests
    // can fail independently, so "some worked" is the common failure, and closing here would hide
    // which ones. The sheet stays open with ONLY the failures still selected, so the retry is the
    // same button again and cannot double-attach the ones that already landed (a re-attach is
    // idempotent server-side anyway, but the user should not have to trust that).
    if (bad.length) {
      setSelected(new Set(bad))
      setFailed({ count: bad.length, ids: new Set(bad) })
      onAttached?.({ attached: okCount, failed: bad.length, done: false })
      return
    }
    onAttached?.({ attached: okCount, failed: 0, done: true })
  }

  const count = selected.size

  return (
    <div
      role="dialog"
      aria-modal={isTopmost ? 'true' : undefined}
      aria-label={`Add existing photos to ${spaceName || 'your space'}`}
      ref={dialogRef}
      data-testid="space-attach-picker"
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: P.cream, display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '12px 16px calc(12px)', borderBottom: `1px solid ${P.border}`, background: P.white }}>
        <div>
          <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: P.dark }}>Add existing photos</p>
          <p style={{ margin: '2px 0 0', fontSize: '0.78rem', color: P.mid }}>
            Pick the wide shots that show the whole place.
          </p>
        </div>
        <button type="button" ref={closeRef} onClick={onClose} disabled={saving}
          style={{ minHeight: T.buttonMinHeight, minWidth: T.buttonMinHeight, borderRadius: 8,
            border: `1px solid ${P.border}`, background: P.white, color: P.dark,
            fontSize: '0.85rem', cursor: saving ? 'not-allowed' : 'pointer' }}>
          Cancel
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px 96px' }}>
        {photos === null && !loadError ? (
          <div style={{ padding: '48px 0' }}><Spinner block /></div>
        ) : loadError ? (
          <div role="alert" style={{ textAlign: 'center', padding: '32px 16px' }}>
            <p style={{ margin: 0, fontSize: '0.9rem', fontWeight: 700, color: P.dark }}>Couldn’t load your photos</p>
            <p style={{ margin: '6px 0 0', fontSize: '0.82rem', color: P.mid }}>
              The photo service had a problem — usually temporary.
            </p>
            <button type="button" onClick={() => setLoadTick((t) => t + 1)}
              style={{ marginTop: 14, minHeight: T.buttonMinHeight, padding: '8px 18px', borderRadius: 8,
                border: `1px solid ${P.border}`, background: P.white, color: P.dark, cursor: 'pointer' }}>
              Retry
            </button>
          </div>
        ) : candidates.length === 0 ? (
          // Distinguished from the error above and from "you have no photos at all": if the wall is
          // non-empty but every row is already on this space, saying "no photos" would be a lie.
          <p data-testid="space-attach-empty" style={{ textAlign: 'center', padding: '32px 16px', color: P.mid, fontSize: '0.88rem' }}>
            {(photos ?? []).length === 0
              ? 'You don’t have any photos yet. Take one below and it lands here.'
              : 'Every photo you have is already on this space.'}
          </p>
        ) : (
          <>
          {/* Honest about the cap. A full page back means there are almost certainly older photos
              this sheet cannot reach, and silently showing 200 of 981 as if it were the library is
              the kind of quiet truncation that reads as "my photo is gone". */}
          {(photos ?? []).length >= PAGE_LIMIT && (
            <p data-testid="space-attach-truncated" style={{ margin: '0 0 10px', fontSize: '0.76rem', color: P.mid }}>
              Showing your {PAGE_LIMIT} most recent photos. Older ones aren’t listed here yet — you
              can still add them from the photo itself.
            </p>
          )}
          <div role="list" aria-label="Photos you can add"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {candidates.map((photo) => {
              const isSel = selected.has(photo.id)
              const didFail = failed?.ids?.has(photo.id)
              // Tile style note: `padding: 0` must come BEFORE paddingBottom — a trailing shorthand
              // would reset the aspect-ratio padding to 0 and collapse every tile to a 1px line.
              return (
                <button
                  key={photo.id}
                  type="button"
                  role="listitem"
                  aria-pressed={isSel}
                  aria-label={`${isSel ? 'Deselect' : 'Select'} ${photo.caption || 'photo'}${didFail ? ' — failed to attach' : ''}`}
                  onClick={() => toggle(photo.id)}
                  disabled={saving}
                  style={{ position: 'relative', padding: 0, height: 0, paddingBottom: '100%',
                    background: P.photoPlaceholder, borderRadius: 8, overflow: 'hidden',
                    border: didFail ? `2px solid ${P.terra}` : isSel ? `2px solid ${P.green}` : `1px solid ${P.border}`,
                    cursor: saving ? 'not-allowed' : 'pointer' }}
                >
                  {(photo.thumb_url || photo.view_url) && (
                    <PhotoImg
                      photoId={photo.id}
                      initialUrl={photo.thumb_url || photo.view_url}
                      fallback="none"
                      alt=""
                      decoding="async"
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  )}
                  <span aria-hidden="true" style={{ position: 'absolute', top: 6, right: 6, width: 22, height: 22,
                    borderRadius: '50%', border: `2px solid ${P.white}`,
                    backgroundColor: isSel ? P.green : 'rgba(0,0,0,0.35)', color: P.white,
                    fontSize: '0.7rem', lineHeight: '18px', textAlign: 'center', fontWeight: 700 }}>
                    {isSel ? '✓' : ''}
                  </span>
                </button>
              )
            })}
          </div>
          </>
        )}
      </div>

      {/* Action bar. Rendered whenever something is selected, so the count and the commit live in
          the same place the thumb already is. aria-live on the failure line: a partial failure that
          only changes tile borders is invisible to a screen reader. */}
      {count > 0 && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 210, background: P.white,
          borderTop: `1px solid ${P.border}`, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          boxShadow: '0 -2px 10px rgba(0,0,0,0.08)' }}>
          <div>
            <span style={{ fontSize: '0.9rem', fontWeight: 700, color: P.mid }}>{count} selected</span>
            {failed && (
              <p role="status" aria-live="polite" style={{ margin: '2px 0 0', fontSize: '0.74rem', color: P.terra }}>
                {failed.count} couldn’t be added — try again
              </p>
            )}
          </div>
          <button type="button" onClick={attach} disabled={saving}
            style={{ minHeight: T.buttonMinHeight, background: saving ? P.light : P.green, color: P.white,
              border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: '0.88rem', fontWeight: 700,
              cursor: saving ? 'not-allowed' : 'pointer' }}>
            {saving ? 'Adding…' : failed ? 'Try again' : `Add ${count} to Space`}
          </button>
        </div>
      )}
    </div>
  )
}
