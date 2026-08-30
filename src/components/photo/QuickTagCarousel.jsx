// src/components/photo/QuickTagCarousel.jsx
// V4-PHOTOBULK-001 S6 — drain the inbox one photo at a time.
//
// Dave's brief, verbatim (2026-08-30): "bulk uploading unattached to specific plants where I can
// review in the app the unassigned photos one at a time and assign them to plants." That is this
// component. Bulk upload already puts photos into the inbox (intake_status='pending_tag', no
// parent); the Photo Library's tag modal can already empty it. This exists because that modal costs
// roughly four taps and a scroll per photo, which is fine for five photos and abandoned at twenty.
//
// ENTRY POINT is the Untagged COUNT (Dave, D4): tapping the number opens this, tapping the word
// still filters the grid.
//
// ── TAPS, NOT SWIPES ─────────────────────────────────────────────────────────────────────────
// A swipe has no discoverable mapping to "which planting", cannot express more than two or three
// destinations, and is unrecoverable — a mis-swipe on photo 12 of 17 is a mis-tag nobody notices
// until much later. This surface's whole job is bulk CORRECTNESS, so it buys precision with taps.
//
// ── UNDO MEANS RE-ASSIGN, NOT RETURN-TO-INBOX. THIS IS A CONSTRAINT, NOT A CHOICE. ───────────
// PUT /api/photos/:id computes `setsParent` from the body and then does
//     intake_status = CASE WHEN setsParent THEN NULL ELSE p.intake_status END
// (lambda/photos/index.js). Assigning a plant therefore drains the row out of the inbox correctly.
// But clearing the parent again makes setsParent FALSE, so intake_status stays NULL — leaving a
// parentless row with no intake_status, which is exactly what photos_must_have_parent forbids. The
// route cannot express "put this back in the inbox", and it does not read body.intake_status at all.
//
// So Undo reopens the photo for RE-assignment: it stays attached to the wrong planting until a right
// one is chosen. That is honest about what the server can do, and it covers the real mistake, which
// is "wrong plant" rather than "should not have been tagged". A true return-to-inbox needs a Lambda
// change and therefore a promote; it is recorded as such rather than faked here.
//
// ── SHORTCUTS ────────────────────────────────────────────────────────────────────────────────
// Most-recently-used within this drain, seeded from the plantings the library's own photos are
// already attached to. A garden walk photographs the same handful repeatedly, so the MRU converges
// after two or three photos and the rest of the batch is one tap each. Deliberately NOT
// most-photographed-all-time: that is stable and exactly wrong, surfacing last spring's tomatoes
// while the user is standing in the pepper bed.
//
// ── NO COMPLETION CELEBRATION (Reward UX rule) ───────────────────────────────────────────────
// A plain "N to go" count is cadence utility and fine. "You tagged all 17!" is a celebration in
// response to completion, which is squarely a reward surface, and the rule's falsifiable test sends
// yes-but-uncertain to yes. So: no badge, no animation, no count-up, no streak. The empty state
// states a fact and stops.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PhotoView from './PhotoView.jsx'
import PlantingSelect from '../forms/PlantingSelect.jsx'
import { useDismissable } from '../../context/DismissRegistry.jsx'
// LAYER lives in dismissLayers, not the registry — the registry imports it too. formStyles
// re-exports the same frozen T object as lib/tokens (verified identical), and PhotoLibrary reaches
// for lib/tokens; matching that here keeps one import path per module across this feature.
import { LAYER } from '../../lib/dismissLayers.js'
import { TIER } from '../../lib/photoModel.js'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'

// Enough shortcuts to cover a garden walk's working set without turning the row into its own
// scanning problem. Six is two rows of three at 390px.
const MAX_SHORTCUTS = 6

export default function QuickTagCarousel({
  photos = [],
  plants = [],
  seedTargets = [],
  onAssigned,
  onClose,
  apiFetch,
}) {
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // Plant ids in most-recently-used order, this drain only.
  const [mru, setMru] = useState([])
  // photoId -> plantId, for the Undo affordance. Keyed by photo so a re-assign overwrites rather
  // than stacking, and so Undo can name WHICH photo it will reopen.
  const [assigned, setAssigned] = useState({})

  // The working list is frozen at mount. Recomputing it from the parent's live list as photos drain
  // would make the deck shrink under the user's finger and silently renumber "4 of 17" mid-drain.
  const deck = useRef(photos).current
  const total = deck.length
  const photo = deck[index] ?? null
  const remaining = total - index

  const byId = useMemo(() => {
    const m = new Map()
    for (const p of plants) m.set(p.id, p)
    return m
  }, [plants])

  // MRU first, then the seed, deduped, capped. The seed only fills the first few photos' worth of
  // gap — once the user has tagged three, their own choices have displaced it entirely.
  const shortcuts = useMemo(() => {
    const out = []
    const seen = new Set()
    for (const id of [...mru, ...seedTargets]) {
      if (seen.has(id)) continue
      const row = byId.get(id)
      if (!row) continue          // a planting that is gone, or outside this list
      seen.add(id)
      out.push(row)
      if (out.length >= MAX_SHORTCUTS) break
    }
    return out
  }, [mru, seedTargets, byId])

  const { requestDismiss } = useDismissable({
    open: true,
    onDismiss: onClose,
    // Never "dirty": nothing here is unsaved typing. Each assignment commits as it is made, so
    // leaving mid-drain loses nothing — the untagged remainder is still untagged, which is the
    // state the user came from.
    dirty: false,
    busy,
    layer: LAYER.SHEET,
    armsBack: true,
  })

  const advance = useCallback(() => {
    setError(null)
    setPickerOpen(false)
    setIndex(i => i + 1)
  }, [])

  const assign = useCallback(async (plantId) => {
    if (!photo || busy || !plantId) return
    const planting = byId.get(plantId) ?? null
    setBusy(true)
    setError(null)
    try {
      // The same PUT the tag modal uses. project_id rides along from the planting because the
      // library's own tag form derives it that way when projects are hidden — a plant-only row is
      // legal, but keeping the pair consistent keeps the two surfaces telling one story.
      await apiFetch('/api/photos/' + photo.id, {
        method: 'PUT',
        body: JSON.stringify({
          project_id:  planting?.project_id ?? null,
          location_id: null,
          plant_id:    plantId,
          caption:     photo.caption ?? null,
          tags:        photo.tags ?? null,
        }),
      })
      setAssigned(a => ({ ...a, [photo.id]: plantId }))
      setMru(prev => [plantId, ...prev.filter(id => id !== plantId)])
      if (typeof onAssigned === 'function') {
        try { onAssigned(photo.id, plantId, planting) } catch (e) { console.error('onAssigned threw', e) }
      }
      setBusy(false)
      advance()
    } catch (err) {
      setBusy(false)
      // Stay on this photo. Advancing past a failed assignment would leave it silently untagged in a
      // deck the user believes they finished — the exact "it said it worked" failure this whole
      // track keeps running into.
      setError(err?.message || 'Could not assign that photo — try again.')
    }
  }, [photo, busy, byId, apiFetch, onAssigned, advance])

  // Undo = step BACK to the previous photo and reopen it. See the header: the server cannot return
  // a row to the inbox, so this is a correction affordance, not a retraction.
  const undo = useCallback(() => {
    if (busy || index === 0) return
    setError(null)
    setPickerOpen(false)
    setIndex(i => i - 1)
  }, [busy, index])

  // Escape/Back are handled by the registry; this only guards the browser's own scroll while the
  // full-bleed deck is up.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const done = index >= total

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Assign untagged photos"
      data-testid="quicktag-carousel"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        backgroundColor: P.cream ?? P.white,
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* SAFE-AREA INSETS, top and bottom. The app sets viewport-fit=cover, so a full-bleed fixed
          overlay that pads with plain pixels puts its header under the status bar and its action row
          under the gesture bar on Dave's Android. Every other full-screen surface here already does
          this — Lightbox, ConfirmSheet, PhotoHero, SpaceAttachPicker — and the harness could not
          have caught it: desktop Chrome reports both insets as 0, so the layout measured clean. This
          is a convention to copy, not a value to discover. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 12px', paddingTop: 'calc(10px + env(safe-area-inset-top, 0px))',
                    borderBottom: `1px solid ${P.border}` }}>
        <span data-testid="quicktag-progress" style={{ fontSize: T.type.sm, color: P.mid, fontWeight: 600 }}>
          {done ? 'Nothing left to tag' : `${index + 1} of ${total} · ${remaining} to go`}
        </span>
        <button type="button" onClick={requestDismiss} data-testid="quicktag-close"
                style={{ background: 'transparent', border: 'none', color: P.sage,
                         fontSize: T.type.base, fontWeight: 700, cursor: 'pointer',
                         minHeight: T.tapMinHeight, padding: '0 8px' }}>
          Done
        </button>
      </div>

      {done ? (
        // Deliberately flat. A completion celebration here would be a reward surface (see header).
        <div data-testid="quicktag-empty"
             style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: 24, textAlign: 'center', color: P.mid, fontSize: T.type.base }}>
          That's the last of them.
        </div>
      ) : (
        <>
          <div style={{ flex: 1, minHeight: 0, backgroundColor: P.photoPlaceholder,
                        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <PhotoView
              photo={photo}
              tier={TIER.FULL}
              alt={photo?.caption ?? 'Untagged photo'}
              decoding="async"
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
            />
          </div>

          <div style={{ padding: '12px 12px calc(12px + env(safe-area-inset-bottom, 0px))',
                        borderTop: `1px solid ${P.border}`, backgroundColor: P.white }}>
            {error && (
              <div role="alert" data-testid="quicktag-error"
                   style={{ marginBottom: T.space.sm, color: P.photoErrorInk, fontSize: T.type.sm }}>
                {error}
              </div>
            )}

            {shortcuts.length > 0 && !pickerOpen && (
              <div data-testid="quicktag-shortcuts"
                   style={{ display: 'flex', flexWrap: 'wrap', gap: T.space.sm, marginBottom: T.space.sm }}>
                {shortcuts.map(pl => (
                  <button
                    key={pl.id}
                    type="button"
                    data-testid="quicktag-shortcut"
                    disabled={busy}
                    onClick={() => assign(pl.id)}
                    style={{
                      padding: '10px 14px', borderRadius: T.radiusPill,
                      border: `1px solid ${P.border}`, backgroundColor: P.white, color: P.mid,
                      fontSize: T.type.sm, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer',
                      minHeight: T.tapMinHeight,
                    }}
                  >{pl.name}</button>
                ))}
              </div>
            )}

            {pickerOpen ? (
              <div data-testid="quicktag-picker">
                <PlantingSelect
                  plants={plants}
                  value=""
                  onChange={(id) => { if (id) assign(id) }}
                  labelFormat="qtyVariety"
                  emptyMeaning="unset"
                  disabled={busy}
                />
              </div>
            ) : (
              <button type="button" data-testid="quicktag-other" disabled={busy}
                      onClick={() => setPickerOpen(true)}
                      style={{ width: '100%', padding: '12px 16px', borderRadius: T.radiusButton,
                               border: `1px solid ${P.border}`, backgroundColor: P.white,
                               color: P.mid, fontSize: T.type.base, fontWeight: 600,
                               cursor: busy ? 'not-allowed' : 'pointer', minHeight: T.tapMinHeight }}>
                Something else…
              </button>
            )}

            <div style={{ display: 'flex', gap: T.space.sm, marginTop: T.space.sm }}>
              {/* Skip is "not now", never "never": the photo keeps intake_status='pending_tag' and
                  comes back next time. A photo skipped every time is a photo that keeps
                  reappearing, which is correct for a to-do list. */}
              <button type="button" data-testid="quicktag-skip" disabled={busy} onClick={advance}
                      style={{ flex: 1, padding: '12px 16px', borderRadius: T.radiusButton,
                               border: `1px solid ${P.border}`, backgroundColor: P.white,
                               color: P.mid, fontSize: T.type.base, fontWeight: 600,
                               cursor: busy ? 'not-allowed' : 'pointer', minHeight: T.tapMinHeight }}>
                Skip
              </button>
              <button type="button" data-testid="quicktag-undo" disabled={busy || index === 0}
                      onClick={undo}
                      style={{ flex: 1, padding: '12px 16px', borderRadius: T.radiusButton,
                               border: `1px solid ${P.border}`, backgroundColor: P.white,
                               color: index === 0 ? P.light : P.mid,
                               fontSize: T.type.base, fontWeight: 600,
                               cursor: (busy || index === 0) ? 'not-allowed' : 'pointer',
                               minHeight: T.tapMinHeight }}>
                Back
              </button>
            </div>

            {/* Names what Back will actually do, because "Back" alone reads as navigation and this
                one steps through a deck. Only shown when the previous photo was ASSIGNED — that is
                the case where the user might want to change their mind. */}
            {index > 0 && assigned[deck[index - 1]?.id] && (
              <p data-testid="quicktag-undo-hint"
                 style={{ margin: `${T.space.xs}px 0 0`, fontSize: T.type.xs, color: P.light, textAlign: 'center' }}>
                Back reopens the previous photo — you can assign it somewhere else.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
