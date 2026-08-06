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

export default function FacebookShareSheet({ open, photos = [], onClose, onPosted }) {
  const { state, result, error, share, reset } = useShareToFacebook()
  const [caption, setCaption] = useState('')

  // Fresh composer every time the sheet opens.
  useEffect(() => {
    if (open) { reset(); setCaption('') }
  }, [open, reset])

  // V4-BACKNAV-001 Slice 2 — this surface had NO Escape handler at all, so registering ADDS
  // Escape-to-close. `busy: posting` is load-bearing: this is the one surface in the app with a
  // non-idempotent in-flight action (a Facebook post), and it already disabled its Close button
  // while posting. blockOnBusy makes Escape respect the same rule.
  const { registered, isTopmost } = useDismissable({ open, onDismiss: onClose, busy: state === 'posting', layer: LAYER.DIALOG })
  void registered

  if (!open) return null

  const count = photos.length
  const posting = state === 'posting'
  const done = state === 'success'
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

  return (
    <div role="dialog" aria-label="Share to Facebook" aria-modal={isTopmost ? 'true' : undefined} style={overlay}
      onClick={(e) => { if (e.target === e.currentTarget && closable) onClose() }}>
      <div style={panel}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px 8px' }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: P.green }}>
            Share to Gardens at Mathews
          </h2>
          <button type="button" aria-label="Close" onClick={() => closable && onClose()} disabled={!closable}
            style={{ background: 'none', border: 'none', fontSize: '1.1rem', color: P.mid, cursor: closable ? 'pointer' : 'default', padding: 4 }}>✕</button>
        </div>

        {done ? (
          <Success result={result} onClose={onClose} />
        ) : state === 'forbidden' || state === 'token_invalid' || state === 'disabled' ? (
          <Blocked state={state} message={error} onClose={onClose} />
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

            {state === 'error' && (
              <div role="alert" style={{ background: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 8, padding: '10px 14px', fontSize: '0.82rem', color: P.bannerInk }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" onClick={() => closable && onClose()} disabled={!closable}
                style={{ flex: '0 0 auto', background: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 8, padding: '12px 20px', fontSize: '0.9rem', fontWeight: 600, cursor: closable ? 'pointer' : 'default' }}>
                Cancel
              </button>
              <button type="button" onClick={handlePost} disabled={posting || count === 0}
                style={{ flex: 1, background: posting ? P.light : P.green, color: P.white, border: 'none', borderRadius: 8, padding: '12px 20px', fontSize: '0.92rem', fontWeight: 700, cursor: posting ? 'default' : 'pointer' }}>
                {posting ? 'Posting…' : state === 'error' ? 'Retry' : `Post to Facebook${count > 1 ? ` (${count})` : ''}`}
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
