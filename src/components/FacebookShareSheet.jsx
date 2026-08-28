import React, { useState, useEffect } from 'react'
import { P } from '../lib/constants.js'
import PhotoImg from './PhotoImg.jsx'
import { useShareToSocial, TARGETS, captionLimitFor, validateForTargets } from '../hooks/useShareToSocial.js'
import { useDismissable } from '../context/DismissRegistry.jsx'
import { LAYER } from '../lib/dismissLayers.js'

// V4-FBSHARE-001 / V4-IGSHARE-001 — compose + post sheet for sharing photos to "Gardens at Mathews"
// on Facebook and/or Instagram. Reused for single-photo (from the tag modal) and multi-select (from
// the selection bar). The bytes are uploaded server-side; nothing here touches is_public. Bottom-sheet
// layout keeps the Post button in the thumb zone.
//
// INSTAGRAM IS OFF BY DEFAULT, and that is a safety default rather than a UI preference. A Facebook
// post can be deleted; an Instagram post CANNOT be removed through the API (verified 2026-08-21,
// DELETE -> code 10) and has to be deleted by hand in the app. A destination that cannot be undone
// should be chosen deliberately every time, not inherited from the last session.
const HASHTAG = '#GardensAtMathews'
// The three states that REPLACE the composer with <Blocked>. Named once because the reload-gate
// predicate below and the render branch have to agree on "is the caption still on screen".
const BLOCKED_STATES = ['forbidden', 'token_invalid', 'disabled', 'not_configured']

// The destination selection every open starts from. A frozen module constant so that re-applying it
// is an Object.is no-op and React can bail out of the re-render — see the effect that uses it.
const DEFAULT_TARGETS = Object.freeze({ facebook: true, instagram: false })

// Human sentence for a set of target keys: "Facebook", "Instagram", "Facebook and Instagram".
function namesOf(keys) {
  const labels = TARGETS.filter((t) => keys.includes(t.key)).map((t) => t.label)
  return labels.length === 2 ? `${labels[0]} and ${labels[1]}` : (labels[0] ?? '')
}

// Props:
//   - open, photos, onClose, onPosted
//   - onDirtyChange(bool)  optional; fires on every clean↔dirty flip of the caption
export default function FacebookShareSheet({ open, photos = [], onClose, onPosted, onDirtyChange }) {
  const { state, perTarget, share, reset } = useShareToSocial()
  const [caption, setCaption] = useState('')
  const [targets, setTargets] = useState(DEFAULT_TARGETS)

  // Fresh composer every time the sheet opens — including the destinations. See the header: an
  // Instagram post cannot be withdrawn through the API, so the selection must not be sticky.
  //
  // DEFAULT_TARGETS is a module CONSTANT, not an inline literal, and that is load-bearing rather
  // than tidiness. This effect is keyed [open, reset], so it re-runs whenever `reset` changes
  // identity. Every setState here must therefore be a NO-OP on a second run, or the effect feeds
  // itself: React bails out of a re-render when the next state is Object.is-equal to the current
  // one, which `setCaption('')` satisfies for free — and an inline `{ facebook: true, ... }` never
  // does, because it is a fresh object every time. Written inline it spun render -> new object ->
  // render until the heap died (an OOM, not a hang: the worker is killed and the run reports
  // "Worker exited unexpectedly" with no failing test). The real hook's `reset` is useCallback-
  // stable so production never reached it, but a component that loops infinitely whenever a
  // dependency is unstable is one refactor away from doing it for real.
  useEffect(() => {
    if (open) { reset(); setCaption(''); setTargets(DEFAULT_TARGETS) }
  }, [open, reset])

  const selectedKeys = TARGETS.filter((t) => targets[t.key]).map((t) => t.key)
  const attempted = selectedKeys.map((k) => perTarget[k]).filter(Boolean)
  const landed = TARGETS.filter((t) => perTarget[t.key]?.state === 'success').map((t) => t.key)

  const done = state === 'success'
  // <Blocked> REPLACES the composer, so it may only fire when there is nothing left to compose FOR:
  // every attempted target refused, and none landed. One blocked target alongside a success is a
  // PARTIAL — the composer has to stay up, because the un-landed target can still be retried and
  // because replacing it would silently discard a caption that is now half-published.
  const blocked = attempted.length > 0
    && landed.length === 0
    && attempted.every((r) => BLOCKED_STATES.includes(r?.state))
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

  const preflight = validateForTargets(caption, targets)
  const captionMax = captionLimitFor(targets)
  // Targets still to attempt. After a partial this is the un-landed set, which is what the Post
  // button must name — offering "Retry" over both would read as though it re-sends the live one.
  const remaining = selectedKeys.filter((k) => perTarget[k]?.state !== 'success')
  // Targets that were attempted and did not land, each with its own message.
  const failures = TARGETS
    .filter((t) => selectedKeys.includes(t.key))
    .map((t) => ({ key: t.key, label: t.label, entry: perTarget[t.key] }))
    .filter(({ entry }) => entry && entry.state !== 'success' && entry.state !== 'posting')
  const allTimedOut = failures.length > 0 && failures.every(({ entry }) => entry.state === 'timeout')

  async function handlePost() {
    if (preflight.length) return
    try {
      const res = await share(photos.map((p) => p.id), caption, targets)
      // Only a clean sweep closes the sheet. On a partial the composer stays so the failed target
      // can be retried — reporting "posted" to the page while Instagram never went out is the
      // silent half-success this whole path is built to avoid.
      if (res?.overall === 'success') onPosted?.(res)
    } catch { /* state renders the error */ }
  }
  function toggleTarget(key) {
    // A target that already landed cannot be switched off and re-sent. Its slot is released on
    // success, so a re-send would mint a fresh id and genuinely post again — a duplicate, not a replay.
    if (perTarget[key]?.state === 'success') return
    setTargets((t) => ({ ...t, [key]: !t[key] }))
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
    <div role="dialog" aria-label="Share photos" aria-modal={isTopmost ? 'true' : undefined} style={overlay}
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
          <Success landed={landed} perTarget={perTarget} onClose={requestDismiss} />
        ) : blocked ? (
          <Blocked entry={attempted[0]} onClose={requestDismiss} />
        ) : (
          <div style={{ padding: '4px 18px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ margin: 0, fontSize: '0.82rem', color: P.light }}>
              {count === 1 ? 'This photo' : `${count} photos`} will be posted publicly
              {selectedKeys.length ? ` to ${namesOf(selectedKeys)}.` : '.'}
            </p>

            {/* Destinations. Instagram starts OFF every time — see the header. */}
            <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', gap: 16 }}>
              <legend style={{ fontSize: '0.77rem', fontWeight: 700, color: P.mid, letterSpacing: '0.4px', textTransform: 'uppercase', padding: 0, marginBottom: 6 }}>
                Post to
              </legend>
              {TARGETS.map((t) => {
                const entry = perTarget[t.key]
                const isDone = entry?.state === 'success'
                return (
                  <label key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.88rem', color: isDone ? P.light : P.dark, cursor: isDone || posting ? 'default' : 'pointer' }}>
                    <input type="checkbox" checked={!!targets[t.key]} disabled={posting || isDone}
                      onChange={() => toggleTarget(t.key)} />
                    {/* "posted" goes in the TEXT, not on an aria-label pinned to the tick. A bare
                        <span> has no role that can hold an accessible name, so aria-label there is
                        dropped by the a11y gate and by assistive tech alike — the state would have
                        been announced to nobody. A checked+disabled checkbox reads as "checked,
                        dimmed", which does not say "this one already went out". */}
                    {isDone ? `${t.label} — posted` : t.label}
                    {isDone && <span aria-hidden="true" style={{ color: P.green }}>✓</span>}
                  </label>
                )
              })}
            </fieldset>

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
              <textarea id="fb-caption" value={caption} maxLength={captionMax} disabled={posting}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Say something about these photos…"
                style={{ width: '100%', minHeight: 90, padding: '10px 12px', border: `1px solid ${P.border}`, borderRadius: 8, fontSize: '0.9rem', fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' }} />
            </div>

            {/* `timeout` is a DIFFERENT outcome from `error` and must not be styled or worded as a
                failure: we stopped waiting before the server did, so the post may well be live.
                Gating this banner on 'error' alone left the timeout state rendering nothing at all —
                a dismissed spinner and no explanation. */}
            {/* A PARTIAL is the outcome this banner exists for. One line per target that did not
                land, each naming its own target — a single merged message cannot say which surface
                is live and which is not, and that is the only fact the user needs in order to act.
                A landed target is shown too, so "Facebook is already up" is never implied by silence.

                `timeout` is a DIFFERENT outcome from `error` and must not be worded as a failure:
                we stopped waiting before the server did, so the post may well be live. Gating this
                on 'error' alone left the timeout state rendering nothing at all — a dismissed
                spinner and no explanation. */}
            {failures.length > 0 && (
              <div role="alert" style={{ background: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 8, padding: '10px 14px', fontSize: '0.82rem', color: P.bannerInk, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {landed.length > 0 && (
                  <p style={{ margin: 0, fontWeight: 700 }}>Posted to {namesOf(landed)}. The rest did not go out:</p>
                )}
                {failures.map(({ key, label, entry }) => (
                  <p key={key} style={{ margin: 0 }}>
                    {selectedKeys.length > 1 || landed.length > 0 ? <strong>{label}: </strong> : null}{entry.error}
                  </p>
                ))}
              </div>
            )}

            {preflight.length > 0 && (
              <div role="alert" style={{ background: P.alert, border: `1px solid ${P.alertBorder}`, borderRadius: 8, padding: '10px 14px', fontSize: '0.82rem', color: P.bannerInk }}>
                {preflight.map((m) => <p key={m} style={{ margin: 0 }}>{m}</p>)}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" onClick={() => closable && requestDismiss()} disabled={!closable}
                style={{ flex: '0 0 auto', background: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 8, padding: '12px 20px', fontSize: '0.9rem', fontWeight: 600, cursor: closable ? 'pointer' : 'default' }}>
                Cancel
              </button>
              <button type="button" onClick={handlePost} disabled={posting || count === 0 || preflight.length > 0}
                style={{ flex: 1, background: (posting || preflight.length) ? P.light : P.green, color: P.white, border: 'none', borderRadius: 8, padding: '12px 20px', fontSize: '0.92rem', fontWeight: 700, cursor: posting ? 'default' : 'pointer' }}>
                {posting ? 'Posting…'
                  : allTimedOut ? 'Try again'
                  : failures.length > 0 ? `Retry ${namesOf(remaining)}`
                  : `Post to ${namesOf(selectedKeys)}${count > 1 ? ` (${count})` : ''}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// One "View on …" link per landed target. Facebook can synthesise a URL from the post id; Instagram
// cannot — its media id is not addressable as a web URL — so an IG link appears only when the server
// returned a real permalink. A fabricated IG link would 404 on the one surface the user cannot fix
// by hand, so it is omitted rather than guessed.
function linkFor(key, result) {
  if (!result) return null
  if (result.permalink) return result.permalink
  if (key === 'facebook' && result.post_id) return `https://www.facebook.com/${result.post_id}`
  return null
}

function Success({ landed, perTarget, onClose }) {
  const links = landed
    .map((key) => ({ key, label: TARGETS.find((t) => t.key === key)?.label ?? key, href: linkFor(key, perTarget[key]?.result) }))
    .filter((l) => l.href)
  return (
    <div style={{ padding: '8px 18px 22px', textAlign: 'center' }}>
      <div style={{ fontSize: '2.2rem', marginBottom: 8 }}>✅</div>
      <p style={{ margin: '0 0 4px', fontWeight: 700, color: P.dark, fontSize: '0.98rem' }}>Posted to {namesOf(landed)}</p>
      <p style={{ margin: '0 0 16px', fontSize: '0.84rem', color: P.mid }}>Your photos are live on the Gardens at Mathews {landed.length > 1 ? 'accounts' : 'page'}.</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
        {links.map(({ key, label, href }) => (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer"
            style={{ background: P.green, color: P.white, borderRadius: 8, padding: '11px 20px', fontSize: '0.9rem', fontWeight: 700, textDecoration: 'none' }}>
            View on {label}
          </a>
        ))}
        <button type="button" onClick={onClose}
          style={{ background: 'transparent', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 8, padding: '11px 20px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer' }}>
          Done
        </button>
      </div>
    </div>
  )
}

function Blocked({ entry, onClose }) {
  const message = entry?.error
  const copy = {
    forbidden: 'Only the page admin can post to Facebook.',
    token_invalid: 'Facebook needs to be reconnected before posting. The Page access token has expired.',
    disabled: 'Sharing is turned off right now.',
    not_configured: 'Instagram is not connected yet, so there is nowhere to post.',
  }[entry?.state]
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
