// src/pages/SpaceDetail.jsx — V4-SPACEPHOTO-001 Lane C. The Space's identity surface.
//
// "Space" is the property itself — the single `spaces` row ("Gardens at Mathews Ridge") that
// plants.workspace_id points at and the nightly daily-plan reads weather coords from. It sits
// ABOVE the six level-0 location ZONES (Deck/Drive/House/Pasture/Stable/Yard), so this is NOT
// /locations under another name. Until now the Space had no user-facing surface at all.
//
// Whole file is gated by SPACE_PHOTOS_ENABLED — App.jsx does not register the routes when it is
// false, so nothing here mounts and no space request is ever issued (photos.space_id /
// spaces.featured_photo_id do not exist in prod yet).
//
// The space id is DISCOVERED, not configured: /space mounts with no route param and the id-free
// GET /api/photos/space-hero resolves the caller's own household space server-side, returning the
// id every other surface here is keyed on. /space/:spaceId still works and still wins. Three
// outcomes, three distinct renders — a resolved space, a 200 that resolved NO space (empty state,
// never an error), and a genuine failure (error + Retry). See lib/spaceId.js.
//
// Deliberately NOT inheriting LocationDetail's gallery debt (crucible plan §5): a real empty
// state, an error state that is distinguishable from "no photos", an ErrorBoundary around the
// gallery, and an AbortController on the hero read so fast space-switching cannot clobber it.
// Nothing is added to TopChrome — V4-APPBAR-003 stripped the header to brand + search only.
import React, { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useOptionalToast } from '../context/ToastContext.jsx'
import { resolveSpaceId, spaceHeroPath, isPinnedFeatured } from '../lib/spaceId.js'
import { P, T } from '../lib/tokens.js'
import ErrorBoundary from '../components/ErrorBoundary.jsx'
import PhotosWall from '../components/PhotosWall.jsx'
import PhotoUpload from '../components/PhotoUpload.jsx'
import SpaceHero from '../components/SpaceHero.jsx'
import SpaceAttachPicker from '../components/SpaceAttachPicker.jsx'
import Spinner from '../components/forms/Spinner.jsx'

const cardStyle = {
  background: P.white, border: `1px solid ${P.sage}`,
  borderRadius: 10, padding: '14px 18px',
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 0 32px' }}>{children}</div>
    </div>
  )
}

// role is a prop, not a constant: an empty state is a status, never an alert. Announcing "your
// household has no space yet" with assertive urgency is the same category error the endpoint's
// 200-not-404 fixes on the wire.
function Notice({ tone = 'alert', role = 'alert', testId, title, body, onRetry, retryLabel = 'Retry' }) {
  const border = tone === 'alert' ? P.alertBorder : P.border
  return (
    <div role={role} data-testid={testId} style={{ margin: '16px 20px', padding: '18px 20px', textAlign: 'center',
      background: tone === 'alert' ? P.alert : P.white, border: `1px solid ${border}`, borderRadius: 10 }}>
      <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: P.dark }}>{title}</p>
      <p style={{ margin: '6px 0 0', fontSize: '0.84rem', color: P.mid, lineHeight: 1.5 }}>{body}</p>
      {onRetry && (
        <button type="button" onClick={onRetry}
          style={{ marginTop: 14, minHeight: 44, padding: '8px 18px', fontSize: '0.85rem',
            borderRadius: 8, border: `1px solid ${border}`, background: P.white, color: P.dark, cursor: 'pointer' }}>
          {retryLabel}
        </button>
      )}
    </div>
  )
}

export default function SpaceDetail() {
  const { spaceId: routeParam } = useParams()
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()

  const [hero, setHero] = useState(null)
  const [heroLoading, setHeroLoading] = useState(true)
  const [heroError, setHeroError] = useState(null)
  const [heroTick, setHeroTick] = useState(0)
  const [savingFeatured, setSavingFeatured] = useState(null)   // photo id in flight
  const [galleryTick, setGalleryTick] = useState(0)            // remounts the wall after an upload
  const [pickerOpen, setPickerOpen] = useState(false)          // batch-attach sheet

  // The hero read is also the DISCOVERY read: with no route param it hits the id-free form, which
  // resolves the caller's own household space server-side and returns its id. So the id is not
  // known until this resolves — everything downstream keys off `spaceId` below, not the param.
  //
  // AbortController, NOT a bare `.then` (crucible §5): switching spaces fast must not let a slow
  // first response overwrite a newer one. An error is kept as an ERROR — never collapsed into
  // "no hero", which is what makes LocationDetail's `.catch(() => setPhotos([]))` indefensible.
  useEffect(() => {
    const ac = new AbortController()
    setHeroLoading(true)
    setHeroError(null)
    fetch(spaceHeroPath(routeParam), { signal: ac.signal })
      .then((d) => {
        if (ac.signal.aborted) return
        setHero(d ?? null)
        setHeroLoading(false)
      })
      .catch((e) => {
        if (ac.signal.aborted) return
        setHeroError(e ?? new Error('Failed to load this space'))
        setHeroLoading(false)
      })
    return () => ac.abort()
  }, [fetch, routeParam, heroTick])

  const spaceId = resolveSpaceId(routeParam, hero)

  // Set-featured — the PlantingDetail.setFeatured grammar: in-flight lock (a single savingFeatured
  // id disables every control), no-op guard, optimistic local patch, ambient operational toast.
  //
  // The guard is isPinnedFeatured, NOT `photo.id === hero.featured_photo_id`. An id match with
  // featured_is_explicit false means the server is showing its newest-photo FALLBACK, so the
  // designation was never persisted — suppressing the PUT there is the silently-reverting bug: the
  // tap does nothing, nothing is written, and the next upload takes the hero over. A soft-deleted
  // designation also reads false on purpose, so re-tapping re-persists it.
  const setFeatured = useCallback(async (photo) => {
    if (!photo?.id || !spaceId || savingFeatured) return
    if (isPinnedFeatured(hero, photo.id)) return
    setSavingFeatured(photo.id)
    try {
      const updated = await fetch(`/api/photos/space-featured/${spaceId}`, {
        method: 'PUT', body: JSON.stringify({ photo_id: photo.id }),
      })
      setHero((prev) => ({
        ...(prev ?? { space_id: spaceId }),
        featured_photo_id: updated?.featured_photo_id ?? photo.id,
        featured_photo_view_url: updated?.featured_photo_view_url ?? photo.view_url ?? null,
        // The PUT wrote spaces.featured_photo_id, so the designation is now explicit by
        // definition. Without this the control would stay re-tappable against a persisted hero.
        featured_is_explicit: true,
      }))
      toast?.show?.({ message: 'Featured photo updated', tone: 'success' })
    } catch {
      toast?.show?.({ message: "Couldn't set featured photo", tone: 'error' })
    } finally {
      setSavingFeatured(null)
    }
  }, [fetch, spaceId, savingFeatured, hero, toast])

  const name = hero?.name || 'Your space'
  const featuredUrl = hero?.featured_photo_view_url ?? null
  // A 200 that resolved no space at all. NOT an error and never rendered as one: the id-free form
  // answers 200 with a null-valued body when the household owns no space, precisely so this reads
  // as an empty state. Distinguished from the loading and error branches, and from "a space with
  // no photos yet" (which HAS an id and renders the full surface with its own empty states).
  const noSpace = !heroLoading && !heroError && !spaceId

  return (
    <Shell>
      {heroLoading ? (
        <div style={{ padding: '48px 0' }}><Spinner block /></div>
      ) : heroError ? (
        <Notice
          title="Couldn’t load this space"
          body={heroError?.status === 404
            ? 'That space isn’t there — it may have been removed, or the link may be wrong.'
            : (heroError?.status == null || heroError.status >= 500)
              ? 'The photo service had a problem — usually temporary. Please retry.'
              : 'Something went wrong loading your space.'}
          onRetry={() => setHeroTick((t) => t + 1)}
        />
      ) : noSpace ? (
        <Notice
          tone="plain"
          role="status"
          testId="space-none"
          title="No space yet"
          body="Your garden doesn’t have a space set up yet. Once it does, its photos and feature photo show up here."
        />
      ) : (
        <SpaceHero
          name={name}
          subtitle="Your whole garden"
          src={featuredUrl}
          photoId={hero?.featured_photo_id}
          emptyState={<HeroEmpty />}
        />
      )}

      {/* Everything below needs a resolved id — the gallery read, the upload linkage and the
          featured PUT are all keyed on it. Withheld until there is one, so no request can be built
          from a null id. Also withheld when the hero FAILED: a 404 there means the id names a space
          that is unknown or not the caller's, and a gallery read plus an upload control aimed at it
          would only 400. Note this is NOT gated on heroLoading — with a route param the id is known
          up front, so the gallery still loads in parallel with the hero. */}
      {spaceId && !heroError && (
      <div style={{ padding: '20px 20px 0' }}>
        <h2 style={{ margin: '0 0 12px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>
          Space photos
        </h2>
        <div style={cardStyle}>
          <p style={{ margin: '0 0 12px', fontSize: '0.85rem', color: P.mid }}>
            Photos of the whole place — the wide shots that show {name} as it is, not any one bed.
          </p>
          {/* keyPrefix stays 'standalone': lambda/photos/uploadKeyPolicy.js UPLOAD_KEY_PREFIXES is a
              CLOSED allowlist with no 'spaces' entry, so a spaces/<id>/… storage key 403s. The
              space attachment travels in the POST body via `linkage`, which is the documented
              parent path (`POST /api/photos` accepts space_id) and needs no key-policy change. */}
          {/* V4-SPACECLIENTGAP-001: onUploadComplete bumps BOTH ticks. The gallery tick alone left
              the hero stale in the case that matters most — the FIRST upload to an empty space. The
              POST path calls autoPromoteFeatured, which fills a NULL spaces.featured_photo_id, so
              the server has a hero the instant that upload lands; without re-reading it the page
              kept rendering HeroEmpty ("No feature photo yet") over a space that now HAS one, until
              a remount. Cheap by construction: heroTick is already the Retry lever's effect
              dependency, so this reuses that read rather than adding a second path. */}
          <PhotoUpload
            keyPrefix="standalone"
            linkage={{ space_id: spaceId }}
            errorMode="surface"
            onUploadComplete={() => { setGalleryTick((t) => t + 1); setHeroTick((t) => t + 1) }}
            inputId={`space-photo-${spaceId}`}
          />
          {/* V4-SPACECLIENTGAP-001: the ATTACH entry point. Until this shipped, the only way a photo
              could acquire a space_id was to be uploaded here — 981 photos already existed with
              nowhere to say "that one is the property". Separate control, not a mode on the upload
              button, because they are different acts: one creates a photo, one files an existing
              one. */}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            data-testid="space-attach-open"
            style={{ marginTop: 10, width: '100%', minHeight: T.buttonMinHeight, borderRadius: 8,
              border: `1px solid ${P.green}`, background: P.white, color: P.green,
              fontSize: '0.86rem', fontWeight: 700, cursor: 'pointer' }}>
            Add existing photos
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          {/* ErrorBoundary around the GALLERY specifically (crucible §5): a render fault in the
              wall must not take the hero and the upload control down with it. */}
          <ErrorBoundary
            scope="space-gallery"
            fallback={(err, retry) => (
              <Notice
                title="Couldn’t show these photos"
                body="The gallery hit a rendering problem. Your photos are safe."
                onRetry={() => { retry(); setGalleryTick((t) => t + 1) }}
              />
            )}
          >
            <PhotosWall
              key={galleryTick}
              path={`/api/photos?space_id=${spaceId}`}
              testId="space-photo-wall"
              ariaLabelPrefix={`${name} photos from`}
              empty={<GalleryEmpty name={name} />}
              renderTileFooter={(photo) => (
                <FeaturedControl
                  photo={photo}
                  isFeatured={isPinnedFeatured(hero, photo.id)}
                  saving={savingFeatured}
                  onSet={setFeatured}
                />
              )}
            />
          </ErrorBoundary>
        </div>
      </div>
      )}

      {/* Mounted only with a resolved id — every PUT it issues is keyed on it, same rule as the
          gallery above. On a fully-successful batch the sheet closes and BOTH ticks fire: the wall
          must re-read (new members) and so must the hero (its membership predicate means a newly
          attached photo can now legitimately become the fallback hero on a space that had none).
          A PARTIAL failure leaves the sheet open and still refreshes the wall — the ones that DID
          land are real and hiding them until a full success would misreport the state. */}
      {pickerOpen && spaceId && !heroError && (
        <SpaceAttachPicker
          spaceId={spaceId}
          spaceName={name}
          onClose={() => setPickerOpen(false)}
          onAttached={({ attached, failed, done }) => {
            if (attached > 0) {
              setGalleryTick((t) => t + 1)
              setHeroTick((t) => t + 1)
            }
            if (done) {
              setPickerOpen(false)
              toast?.show?.({
                message: `${attached} ${attached === 1 ? 'photo' : 'photos'} added to ${name}`,
                tone: 'success',
              })
            } else if (attached > 0) {
              toast?.show?.({ message: `${attached} added, ${failed} couldn’t be`, tone: 'error' })
            }
          }}
        />
      )}
    </Shell>
  )
}

// Hero slot content when the space has no feature photo. A prompt, not a blank box.
function HeroEmpty() {
  return (
    <>
      <p style={{ margin: 0, color: P.mid, fontSize: '0.95rem', fontWeight: 700 }}>
        No feature photo yet
      </p>
      <p style={{ margin: 0, color: P.light, fontSize: '0.82rem', textAlign: 'center', maxWidth: 260 }}>
        Add a wide shot below, then pick it as your feature photo.
      </p>
    </>
  )
}

// Gallery empty state — the crucible's #1 surface-quality complaint was a blank area under a
// heading. This says what belongs here and what happens next.
function GalleryEmpty({ name }) {
  return (
    <div data-testid="space-gallery-empty"
      style={{ textAlign: 'center', padding: '36px 20px', background: P.white,
        border: `1px solid ${P.border}`, borderRadius: 10 }}>
      <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: P.mid }}>
        No photos of {name} yet
      </p>
      <p style={{ margin: '6px 0 0', fontSize: '0.82rem', color: P.light, lineHeight: 1.5 }}>
        Take or choose a photo above. The first one becomes your feature photo, and you can swap it
        for a better one any time.
      </p>
    </div>
  )
}

// Per-photo set-featured control. Same two-state shape as PlantingDetail: a static ★ Featured
// label, a button on every other photo, all disabled while one is in flight.
//
// `isFeatured` is the PINNED test, not an id match. The photo the server is merely falling back to
// therefore keeps a live button — which is correct and load-bearing: it is not featured yet, and
// tapping it is the only way to persist it. A static ★ there would be the silently-reverting bug
// wearing a checkmark.
//
// V4-SPACECLIENTGAP-001 sizing: this was a 0.7rem borderless text button with `padding: 0`, so its
// hit box was the ~14px line box — well under the 44px floor and the frozen T.buttonMinHeight of 48
// (formStyles.js:28). It sits directly under a photo tile in a 3-up grid, i.e. exactly the
// thumb-reach target that most needs the floor. The FEATURED branch stays a non-interactive <div>
// and is deliberately NOT padded to 48: it is a status label, not a tap target, and giving it a
// button-sized box would imply it does something. Only the interactive branch grows.
function FeaturedControl({ photo, isFeatured, saving, onSet }) {
  if (isFeatured) {
    return (
      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: P.gold, minHeight: 20, display: 'flex', alignItems: 'center' }}>★ Featured</div>
    )
  }
  return (
    <button type="button" onClick={() => onSet(photo)} disabled={saving != null}
      aria-label={`Set as feature photo${photo.caption ? `: ${photo.caption}` : ''}`}
      style={{ fontSize: '0.72rem', fontWeight: 600, color: P.green, background: 'transparent',
        border: 'none', width: '100%', minHeight: T.buttonMinHeight, padding: '4px 2px',
        display: 'flex', alignItems: 'center', textAlign: 'left', lineHeight: 1.25,
        cursor: saving != null ? 'not-allowed' : 'pointer' }}>
      {saving === photo.id ? 'Setting…' : 'Set as feature photo'}
    </button>
  )
}
