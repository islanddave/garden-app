import React, { useState, useEffect } from 'react'
import { P } from '../lib/constants.js'
import PhotoImg from './PhotoImg.jsx'
import { useShareToFacebook } from '../hooks/useShareToFacebook.js'
import { useDismissable } from '../context/DismissRegistry.jsx'
import { LAYER } from '../lib/dismissLayers.js'

// V4-FBSHARE-001 — compose + post sheet for sharing photos to the "Gardens at Mathews" FB Page.
// Reused for single-photo (from the tag modal) and multi-select (from the selection bar). The bytes
// are uploaded server-side; nothing here touches is_public. Bottom-sheet layout keeps the Post button
// in the thumb zone.
const HASHTAG = '#GardensAtMathews'
const MAX_CAPTION = 5000
// The three states that REPLACE the composer with <Blocked>. Named once because the reload-gate
// predicate below and the render branch have to agree on "is the caption still on screen".
const BLOCKED_STATES = ['forbidden', 'token_invalid', 'disabled']

// Props:
//   - open, photos, onClose, onPosted
//   - onDirtyChange(bool)  optional; fires on every clean↔dirty flip of the caption
export default function FacebookShareSheet({ open, photos = [], onClose, onPosted, onDirtyChange }) {
  const { state, result, error, share, reset } = useShareToFacebook()
  const [caption, setCaption] = useState('')

  // Fresh composer every time the sheet opens.
  useEffect(() => {
    if (open) { reset(); setCaption('') }
  }, [open, reset])

  const done = state === 'success'
  const blocked = BLOCKED_STATES.includes(state)
  // Whether the caption is still live, authored, and unsent — i.e. whether a service-worker reload
  // would DESTROY something. Up to 5000 chars of free text that exists nowhere but this state.
  //
  // Reported out rather than derived: `caption` is internal and the sheet is opened by a page that
  // holds the reload gate, so PhotoLibrary cannot see this without being told (V4-DIRTYGUARDSWEEP-001,
  // same shape as MicCaptureButton's onRecordingChange).
  //
  // `open &&` IS load-bearing, and for the OPPOSITE reason to PhotoLibrary's staged file, which is
  // deliberately NOT gated on its form being visible: there the blob survives a collapse and comes
  // back on re-open, so releasing would drop a live hold. Here the effect above wipes the caption on
  // every open, so a dismissed draft is ALREADY unreachable — holding for it would wedge updates over
  // text the user cannot get back to (BUG-STALECLIENT-001's shape). A test pins both halves: the hold
  // releases on close, AND the text really is gone on re-open.
  //
  // `!done` because a posted caption is saved, not unsaved — nothing clears `caption` on success, so
  // without this term the Success screen would hold a deploy until someone tapped Done. `!blocked`
  // for the same unreachability reason as `open`: those screens replace the composer and only offer
  // Close, so the caption is gone either way. `posting` and `error` deliberately stay dirty — the
  // composer is still on screen with the text in it, and `error` offers Retry.
  //
  // Truthiness, not a seed comparison: this composer has no seed to differ from (`useState('')` +
  // the reset above), so trimmed-non-empty IS "differs from what the sheet put there". The `+ #tag`
  // button counts — it writes into the authored field, and unlike the pickers PhotoLibrary excludes,
  // there is no separate control to redo it from.
  const dirty = !!(open && !done && !blocked && caption.trim())
  useEffect(() => {
    if (!onDirtyChange) return
    onDirtyChange(dirty)
    // Release on unmount. PhotoLibrary renders this sheet unconditionally so only the page's own
    // unmount reaches here (and its gate effect releases the key anyway), but a future caller that
    // mounts it conditionally would otherwise strand a permanent hold in the parent.
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  // V4-BACKNAV-001 Slice 2 — this surface had NO Escape handler at all, so registering ADDS
  // Escape-to-close. `busy: posting` is load-bearing: this is the one surface in the app with a
  // non-idempotent in-flight action (a Facebook post), and it already disabled its Close button
  // while posting. blockOnBusy makes Escape respect the same rule.
  //
  // V4-DIRTYGUARDREST-001 — the dirty half, which Slice 2 left off. The predicate above already
  // existed (it feeds the parent's reload gate) but was never handed to the arbiter, so up to 5000
  // characters of composed caption — the largest single body of unsaved typing left in the app, and
  // one with no draft stash of any kind — were discarded outright by Escape and by Android Back.
  //
  // THREE registration fields, not one. `dirty` because the arbiter cannot see the caption;
  // `confirmOnDirty` because per-entry opt-in is what makes the global switch safe (dismissLayers.js
  // :74-81); and `armsBack` because WITHOUT IT NOTHING ARMS. Nothing else is open when this sheet is
  // up — PhotoModal's Share button clears the modal before opening it — so hasArmable() is false, no
  // marker is pushed, and Back leaves /photos entirely with the caption on it. That reads in a test
  // exactly like a working guard, which is why the Back suite asserts armed() before every gesture.
  // Membership is safe by Sheet's own test: onClose is setShareOpen(false) and onPosted is
  // exitSelectMode() — this sheet closes IN PLACE and never navigates.
  const { registered, isTopmost, requestDismiss } = useDismissable({
    open, onDismiss: onClose, dirty, busy: state === 'posting', layer: LAYER.OVERLAY,
    armsBack: true,
    confirmOnDirty: true,
    confirmTitle: 'Discard this caption?',
    confirmBody: 'This has not been posted yet. What you typed will be lost, and reopening the sheet starts a blank caption.',
  })
  void registered

  if (!open) return null

  const count = photos.length
  const posting = state === 'posting'
  const closable = !posting

  async function handlePost() {
    try {
      const res = await share(photos.map((p) => p.id), caption)
      if (res) onPosted?.(res)
    } catch { /* state renders the error */ }
  }
  function addHashtag() {
    setCaption((c) => (c.includes(HASHTAG) ? c : (c.trim() ? `${c.trim()} ${HASHTAG}` : HASHTAG)))
  }

  const overlay = {
    position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.72)',
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
  }
  const panel = {
    backgroundColor: P.white, borderRadius: '16px 16px 0 0', width: '100%', maxWidth: 520,
    maxHeight: '92dvh', overflow: 'auto', display: 'flex', flexDirection: 'column',
    paddingBottom: 'env(safe-area-inset-bottom)',
  }

  // EVERY exit below routes through the arbiter, so there is exactly ONE dismissal mechanism on this
  // surface to break. Leaving the backdrop or the ✕ on the raw onClose would make the two most
  // reachable exits the ones that still discard silently, and would hand a mutation test a second
  // suppressor to hide behind. Provably inert wherever the confirm does not apply: requestDismiss
  // falls back to onClose when the entry is not dirty, not opted in, or unregistered — which is the
  // whole of the Success and Blocked arms, where `dirty` is false by construction.
  return (
    <div role="dialog" aria-label="Share to Facebook" aria-modal={isTopmost ? 'true' : undefined} style={overlay}
      onClick={(e) => { if (e.target === e.currentTarget && closable) requestDismiss() }}>
      <div style={panel}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px 8px' }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: P.green }}>
            Share to Gardens at Mathews
          </h2>
          <button type="button" aria-label="Close" onClick={() => closable && requestDismiss()} disabled={!closable}
            style={{ background: 'none', border: 'none', fontSize: '1.1rem', color: P.mid, cursor: closable ? 'pointer' : 'default', padding: 4 }}>✕</button>
        </div>

        {done ? (
          <Success result={result} onClose={requestDismiss} />
        ) : blocked ? (
          <Blocked state={state} message={error} onClose={requestDismiss} />
        ) : (
          <div style={{ padding: '4px 18px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ margin: 0, fontSize: '0.82rem', color: P.light }}>
              {count === 1 ? 'This photo' : `${count} photos`} will be posted publicly to your Facebook Page.
            </p>

            {/* Thumbnails */}
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
              {photos.map((p) => (
                <div key={p.id} style={{ flex: '0 0 auto', width: 64, height: 64, borderRadius: 8, overflow: 'hidden', background: P.photoPlaceholder, border: `1px solid ${P.border}` }}>
                  {p.view_url && <PhotoImg photoId={p.id} initialUrl={p.view_url} fallback="none" alt={p.caption ?? 'Selected photo'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                </div>
              ))}
            </div>

            {/* Caption */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                <label htmlFor="fb-caption" style={{ fontSize: '0.77rem', fontWeight: 700, color: P.mid, letterSpacing: '0.4px', textTransform: 'uppercase' }}>Caption</label>
                <button type="button" onClick={addHashtag} disabled={posting}
                  style={{ background: 'none', border: 'none', color: P.green, fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', padding: 0 }}>
                  + {HASHTAG}
                </button>
              </div>
              <textarea id="fb-caption" value={caption} maxLength={MAX_CAPTION} disabled={posting}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Say something about these photos…"
                style={{ width: '100%', minHeight: 90, padding: '10px 12px', border: `1px solid ${P.border}`, borderRadius: 8, fontSize: '0.9rem', fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' }} />
            </div>

            {/* `timeout` is a DIFFERENT outcome from `error` and must not be styled or worded as a
                failure: we stopped waiting before the server did, so the post may well be live.
                Gating this banner on 'error' alone left the timeout state rendering nothing at all —
                a dismissed spinner and no explanation. */}
            {(state === 'error' || state === 'timeout') && (
              <div role="alert" style={{ background: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 8, padding: '10px 14px', fontSize: '0.82rem', color: P.bannerInk }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" onClick={() => closable && requestDismiss()} disabled={!closable}
                style={{ flex: '0 0 auto', background: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 8, padding: '12px 20px', fontSize: '0.9rem', fontWeight: 600, cursor: closable ? 'pointer' : 'default' }}>
                Cancel
              </button>
              <button type="button" onClick={handlePost} disabled={posting || count === 0}
                style={{ flex: 1, background: posting ? P.light : P.green, color: P.white, border: 'none', borderRadius: 8, padding: '12px 20px', fontSize: '0.92rem', fontWeight: 700, cursor: posting ? 'default' : 'pointer' }}>
                {posting ? 'Posting…'
                  : state === 'error' ? 'Retry'
                  : state === 'timeout' ? 'Try again'
                  : `Post to Facebook${count > 1 ? ` (${count})` : ''}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Success({ result, onClose }) {
  const link = result?.permalink || (result?.post_id ? `https://www.facebook.com/${result.post_id}` : null)
  return (
    <div style={{ padding: '8px 18px 22px', textAlign: 'center' }}>
      <div style={{ fontSize: '2.2rem', marginBottom: 8 }}>✅</div>
      <p style={{ margin: '0 0 4px', fontWeight: 700, color: P.dark, fontSize: '0.98rem' }}>Posted to Facebook</p>
      <p style={{ margin: '0 0 16px', fontSize: '0.84rem', color: P.mid }}>Your photos are live on the Gardens at Mathews page.</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        {link && (
          <a href={link} target="_blank" rel="noopener noreferrer"
            style={{ background: P.green, color: P.white, borderRadius: 8, padding: '11px 20px', fontSize: '0.9rem', fontWeight: 700, textDecoration: 'none' }}>
            View on Facebook
          </a>
        )}
        <button type="button" onClick={onClose}
          style={{ background: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 8, padding: '11px 20px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer' }}>
          Done
        </button>
      </div>
    </div>
  )
}

function Blocked({ state, message, onClose }) {
  const copy = {
    forbidden: 'Only the page admin can post to Facebook.',
    token_invalid: 'Facebook needs to be reconnected before posting. The Page access token has expired.',
    disabled: 'Facebook sharing is turned off right now.',
  }[state]
  return (
    <div style={{ padding: '8px 18px 22px', textAlign: 'center' }}>
      <div style={{ fontSize: '2rem', marginBottom: 8 }}>🔒</div>
      <p style={{ margin: '0 0 4px', fontWeight: 700, color: P.dark, fontSize: '0.95rem' }}>Can’t post right now</p>
      <p style={{ margin: '0 0 16px', fontSize: '0.84rem', color: P.mid }}>{copy || message}</p>
      <button type="button" onClick={onClose}
        style={{ background: P.green, color: P.white, border: 'none', borderRadius: 8, padding: '11px 24px', fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer' }}>
        Close
      </button>
    </div>
  )
}
