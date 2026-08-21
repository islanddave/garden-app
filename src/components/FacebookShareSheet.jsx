import React, { useState, useEffect } from 'react'
import { P } from '../lib/constants.js'
import PhotoImg from './PhotoImg.jsx'
import { useShareToSocial, captionLimitFor, validateForTargets } from '../hooks/useShareToSocial.js'
import { useDismissable } from '../context/DismissRegistry.jsx'
import { LAYER } from '../lib/dismissLayers.js'

// V4-FBSHARE-001 + V4-IGSHARE-001 — compose + post sheet for sharing photos to the "Gardens at
// Mathews" Facebook Page and/or @gardensatmathews on Instagram, in ONE compose action. Reused for
// single-photo (from the tag modal) and multi-select (from the selection bar). Bytes are uploaded
// server-side; nothing here touches is_public.
//
// FILE NAME IS NOW SLIGHTLY STALE (it also does Instagram). Kept deliberately: renaming would churn
// src/__tests__/layerMatchesPaint.test.js, which pins this path against its z-index layer, plus the
// component test file and PhotoLibrary's import — real risk for a cosmetic gain on a surface that is
// still dark. Rename when the feature is live and the tests are being touched anyway.
//
// INSTAGRAM DEFAULTS OFF, ON PURPOSE. IG_SHARE_ENABLED is unset in prod, so the endpoint 503s.
// Defaulting the toggle on would make every post report a partial failure while looking like a bug
// in the composer. Flip the default when the server flag goes on.
const HASHTAG = '#GardensAtMathews'
// The three per-target states that mean "cannot post at all", as opposed to "try again". When EVERY
// attempted target is in one of these, the composer is replaced by <Blocked>.
const BLOCKED_KINDS = ['forbidden', 'token_invalid', 'disabled', 'not_configured']

// MODULE CONSTANT, not an inline literal — this is load-bearing, not tidiness. The open-effect below
// runs setTargets(DEFAULT_TARGETS) with `reset` in its dep array. A fresh {…} each time is never
// reference-equal, so React cannot bail out of the state update: it re-renders, and if `reset` is
// ever unstable the effect re-fires and the component spins until the heap dies. That is not
// hypothetical — an inline literal here exhausted a 4GB Node heap and took DismissRegistrySlice2's
// 11 tests down with it, reported as "collected, 0 run". A shared reference makes the update a
// genuine no-op and the loop unreachable regardless of `reset`'s identity.
const DEFAULT_TARGETS = { facebook: true, instagram: false }

// Props:
//   - open, photos, onClose, onPosted
//   - onDirtyChange(bool)  optional; fires on every clean↔dirty flip of the caption
export default function FacebookShareSheet({ open, photos = [], onClose, onPosted, onDirtyChange }) {
  const { state, perTarget, share, reset } = useShareToSocial()
  const [caption, setCaption] = useState('')
  const [targets, setTargets] = useState(DEFAULT_TARGETS)

  // Fresh composer every time the sheet opens.
  useEffect(() => {
    if (open) { reset(); setCaption(''); setTargets(DEFAULT_TARGETS) }
  }, [open, reset])

  const posting = state === 'posting'
  const done = state === 'success'
  const partial = state === 'partial'

  // "Blocked" only when nothing is retryable: every target we actually attempted came back with a
  // cannot-post reason. A single blocked target alongside a success is `partial`, which KEEPS the
  // composer so the good one is not hidden behind a lock screen.
  const attempted = Object.entries(perTarget).filter(([, r]) => r)
  const blocked = state === 'error' && attempted.length > 0 &&
    attempted.every(([, r]) => BLOCKED_KINDS.includes(r.state))

  const limit = captionLimitFor(targets)
  const preflight = validateForTargets(caption, targets)

  // Whether the caption is still live, authored, and unsent — i.e. whether a service-worker reload
  // would DESTROY something. Free text that exists nowhere but this state.
  //
  // `open &&` IS load-bearing: the effect above wipes the caption on every open, so a dismissed
  // draft is ALREADY unreachable — holding for it would wedge updates over text the user cannot get
  // back to. `!done` because a posted caption is saved, not unsaved. `!blocked` for the same
  // unreachability reason as `open`: that screen replaces the composer and only offers Close.
  // `posting`, `error` and `partial` deliberately stay dirty — the composer is still on screen with
  // the text in it, and both offer Retry.
  const dirty = !!(open && !done && !blocked && caption.trim())
  useEffect(() => {
    if (!onDirtyChange) return
    onDirtyChange(dirty)
    // Release on unmount so a future conditional caller cannot strand a permanent hold.
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  // `busy: posting` is load-bearing: these are non-idempotent external publishes, so Escape must
  // respect the same rule the Close button does.
  const { registered, isTopmost } = useDismissable({ open, onDismiss: onClose, busy: posting, layer: LAYER.OVERLAY })
  void registered

  if (!open) return null

  const count = photos.length
  const closable = !posting
  const nothingSelected = !targets.facebook && !targets.instagram
  const targetLabel = targets.facebook && targets.instagram ? 'Facebook & Instagram'
    : targets.instagram ? 'Instagram' : 'Facebook'

  async function handlePost() {
    if (preflight.length > 0) return
    try {
      const res = await share(photos.map((p) => p.id), caption, targets)
      // Spread the Facebook result so the long-standing onPosted({ post_id }) contract still holds
      // for any caller reading it, while carrying the new per-target detail alongside.
      if (res?.overall === 'success') onPosted?.({ ...(res.perTarget.facebook?.result ?? {}), ...res })
    } catch { /* per-target state renders the error */ }
  }
  function addHashtag() {
    setCaption((c) => (c.includes(HASHTAG) ? c : (c.trim() ? `${c.trim()} ${HASHTAG}` : HASHTAG)))
  }
  const toggle = (k) => setTargets((t) => ({ ...t, [k]: !t[k] }))

  const overlay = {
    position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.72)',
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
  }
  const panel = {
    backgroundColor: P.white, borderRadius: '16px 16px 0 0', width: '100%', maxWidth: 520,
    maxHeight: '92dvh', overflow: 'auto', display: 'flex', flexDirection: 'column',
    paddingBottom: 'env(safe-area-inset-bottom)',
  }

  return (
    <div role="dialog" aria-label="Share photos" aria-modal={isTopmost ? 'true' : undefined} style={overlay}
      onClick={(e) => { if (e.target === e.currentTarget && closable) onClose() }}>
      <div style={panel}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px 8px' }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: P.green }}>
            Share to Gardens at Mathews
          </h2>
          <button type="button" aria-label="Close" onClick={() => closable && onClose()} disabled={!closable}
            style={{ background: 'none', border: 'none', fontSize: '1.1rem', color: P.mid, cursor: closable ? 'pointer' : 'default', padding: 4 }}>✕</button>
        </div>

        {done ? (
          <Success perTarget={perTarget} onClose={onClose} />
        ) : blocked ? (
          <Blocked perTarget={perTarget} onClose={onClose} />
        ) : (
          <div style={{ padding: '4px 18px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ margin: 0, fontSize: '0.82rem', color: P.light }}>
              {count === 1 ? 'This photo' : `${count} photos`} will be posted publicly to {targetLabel}.
            </p>

            {/* Target picker */}
            <div>
              <span style={{ display: 'block', fontSize: '0.77rem', fontWeight: 700, color: P.mid, letterSpacing: '0.4px', textTransform: 'uppercase', marginBottom: 6 }}>
                Post to
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <TargetPill label="Facebook" on={targets.facebook} disabled={posting}
                  result={perTarget.facebook} onClick={() => toggle('facebook')} />
                <TargetPill label="Instagram" on={targets.instagram} disabled={posting}
                  result={perTarget.instagram} onClick={() => toggle('instagram')} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
              {photos.map((p) => (
                <div key={p.id} style={{ flex: '0 0 auto', width: 64, height: 64, borderRadius: 8, overflow: 'hidden', background: P.photoPlaceholder, border: `1px solid ${P.border}` }}>
                  {p.view_url && <PhotoImg photoId={p.id} initialUrl={p.view_url} fallback="none" alt={p.caption ?? 'Selected photo'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                </div>
              ))}
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                <label htmlFor="fb-caption" style={{ fontSize: '0.77rem', fontWeight: 700, color: P.mid, letterSpacing: '0.4px', textTransform: 'uppercase' }}>Caption</label>
                <button type="button" onClick={addHashtag} disabled={posting}
                  style={{ background: 'none', border: 'none', color: P.green, fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', padding: 0 }}>
                  + {HASHTAG}
                </button>
              </div>
              <textarea id="fb-caption" value={caption} maxLength={limit} disabled={posting}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Say something about these photos…"
                style={{ width: '100%', minHeight: 90, padding: '10px 12px', border: `1px solid ${P.border}`, borderRadius: 8, fontSize: '0.9rem', fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' }} />
              {targets.instagram && (
                <p style={{ margin: '4px 0 0', fontSize: '0.72rem', color: P.light }}>
                  {caption.length}/{limit} — Instagram’s limit applies.
                </p>
              )}
            </div>

            {preflight.length > 0 && caption.trim() && (
              <div role="alert" style={{ background: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 8, padding: '10px 14px', fontSize: '0.82rem', color: P.bannerInk }}>
                {preflight.join(' ')}
              </div>
            )}

            {(state === 'error' || partial) && (
              <div role="alert" style={{ background: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 8, padding: '10px 14px', fontSize: '0.82rem', color: P.bannerInk }}>
                {partial && <strong style={{ display: 'block', marginBottom: 4 }}>Only part of this went out.</strong>}
                {attempted.filter(([, r]) => r.state !== 'success').map(([k, r]) => (
                  <div key={k}>{k === 'facebook' ? 'Facebook' : 'Instagram'}: {r.error}</div>
                ))}
                {partial && <div style={{ marginTop: 4 }}>Retrying will not repost what already succeeded.</div>}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" onClick={() => closable && onClose()} disabled={!closable}
                style={{ flex: '0 0 auto', background: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 8, padding: '12px 20px', fontSize: '0.9rem', fontWeight: 600, cursor: closable ? 'pointer' : 'default' }}>
                Cancel
              </button>
              <button type="button" onClick={handlePost}
                disabled={posting || count === 0 || nothingSelected || preflight.length > 0}
                style={{ flex: 1, background: posting || nothingSelected ? P.light : P.green, color: P.white, border: 'none', borderRadius: 8, padding: '12px 20px', fontSize: '0.92rem', fontWeight: 700, cursor: posting ? 'default' : 'pointer' }}>
                {posting ? 'Posting…'
                  : (state === 'error' || partial) ? 'Retry'
                    : `Post to ${targetLabel}${count > 1 ? ` (${count})` : ''}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TargetPill({ label, on, disabled, result, onClick }) {
  const ok = result?.state === 'success'
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} disabled={disabled || ok}
      style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        background: on ? P.green : 'transparent', color: on ? P.white : P.mid,
        border: `1px solid ${on ? P.green : P.border}`, borderRadius: 8, padding: '10px 12px',
        fontSize: '0.85rem', fontWeight: 700, cursor: disabled || ok ? 'default' : 'pointer',
      }}>
      {ok ? '✓ ' : ''}{label}
    </button>
  )
}

function Success({ perTarget, onClose }) {
  const fb = perTarget.facebook?.result
  const ig = perTarget.instagram?.result
  const fbLink = fb?.permalink || (fb?.post_id ? `https://www.facebook.com/${fb.post_id}` : null)
  const igLink = ig?.permalink || null
  const both = !!fb && !!ig
  return (
    <div style={{ padding: '8px 18px 22px', textAlign: 'center' }}>
      <div style={{ fontSize: '2.2rem', marginBottom: 8 }}>✅</div>
      <p style={{ margin: '0 0 4px', fontWeight: 700, color: P.dark, fontSize: '0.98rem' }}>
        {both ? 'Posted to Facebook and Instagram' : fb ? 'Posted to Facebook' : 'Posted to Instagram'}
      </p>
      <p style={{ margin: '0 0 16px', fontSize: '0.84rem', color: P.mid }}>Your photos are live.</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
        {fbLink && (
          <a href={fbLink} target="_blank" rel="noopener noreferrer"
            style={{ background: P.green, color: P.white, borderRadius: 8, padding: '11px 20px', fontSize: '0.9rem', fontWeight: 700, textDecoration: 'none' }}>
            View on Facebook
          </a>
        )}
        {igLink && (
          <a href={igLink} target="_blank" rel="noopener noreferrer"
            style={{ background: P.green, color: P.white, borderRadius: 8, padding: '11px 20px', fontSize: '0.9rem', fontWeight: 700, textDecoration: 'none' }}>
            View on Instagram
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

function Blocked({ perTarget, onClose }) {
  const copy = {
    forbidden: 'Only the page admin can post.',
    token_invalid: 'Facebook needs to be reconnected before posting. The Page access token has expired.',
    disabled: 'Sharing is turned off right now.',
    not_configured: 'No Instagram business account is linked yet.',
  }
  const lines = Object.entries(perTarget).filter(([, r]) => r).map(([k, r]) =>
    `${k === 'facebook' ? 'Facebook' : 'Instagram'}: ${copy[r.state] || r.error}`)
  return (
    <div style={{ padding: '8px 18px 22px', textAlign: 'center' }}>
      <div style={{ fontSize: '2rem', marginBottom: 8 }}>🔒</div>
      <p style={{ margin: '0 0 4px', fontWeight: 700, color: P.dark, fontSize: '0.95rem' }}>Can’t post right now</p>
      {lines.map((l) => (
        <p key={l} style={{ margin: '0 0 6px', fontSize: '0.84rem', color: P.mid }}>{l}</p>
      ))}
      <button type="button" onClick={onClose}
        style={{ marginTop: 10, background: P.green, color: P.white, border: 'none', borderRadius: 8, padding: '11px 24px', fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer' }}>
        Close
      </button>
    </div>
  )
}
