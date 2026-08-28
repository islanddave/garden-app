import { useState, useRef, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'
import { shareSlotKey, acquireRequestId, releaseRequestId } from '../lib/shareIdempotency.js'
import { SHARE_TIMEOUT_MS } from './useShareToFacebook.js'

// V4-IGSHARE-001 — post selected garden photos to Facebook and/or Instagram in ONE compose action.
//
// WHY A COMBINED HOOK RATHER THAN CALLING useShareToFacebook TWICE: the interesting state is not
// "did it work" but PARTIAL failure. Facebook and Instagram are independent endpoints that fail
// independently, and the one thing this must never do is report success when only one landed, or
// double-post the one that already succeeded when the user retries.
//
// ── This is a REBUILD of the version rescued from lane-igtrack-20260821, not a port of it ──
//
// That version held its client_request_id in a useRef and used the app's default 15s fetch timeout.
// Both are the exact defects the 2026-08-28 hardening pass removed from useShareToFacebook, and
// together they are not two bugs but one loop:
//
//   the client gives up at 15s -> the Lambda keeps running to its 180s budget (a Function URL is NOT
//   cancelled by client disconnect) and posts anyway -> the user is shown a failure for a post that
//   is live -> they reload the PWA -> the useRef key is GONE -> retry mints a fresh id -> the
//   server's replay lookup misses -> the same photos post to the public surface a SECOND time.
//
// So the timeout manufactures the failure and the ref guarantees the retry duplicates. Landing the
// rescued hook as written would have reintroduced both into a path that, on Instagram, CANNOT be
// undone: a mistaken IG post is not deletable through the API (verified 2026-08-21, DELETE -> code
// 10) and must be removed by hand in the app.
//
// ── Idempotency: ONE SLOT PER TARGET ──
//
// The rescued lane shared a single client_request_id across both targets and relied on the server
// scoping its replay query by target. That works, and it has one property this scheme lacks: if a
// future edit stopped skipping already-succeeded targets, a re-send would replay rather than
// duplicate.
//
// This uses a per-target slot instead — shareSlotKey already takes `target` — because the shared-id
// scheme takes something away that the project has already decided it will not give up. Its id is
// released only when EVERY attempted target has succeeded, so a partial failure pins the id: post to
// both, Instagram fails, and Dave can no longer make a deliberate second Facebook post of those
// photos until the 24h TTL expires. That is the same "a deterministic key replays forever" trap the
// storage design rejected on purpose (see src/lib/shareIdempotency.js). Per-target slots release
// independently, so one stuck target never holds another hostage.
//
// The cross-target protection is not lost, it moved to the server, which is the better place for it:
// both replay queries are scoped by target (lambda/facebook-share/index.js), so a Facebook row can
// never answer an Instagram lookup regardless of what key scheme any client invents.

// Instagram's caption ceiling is far below Facebook's. When both targets are selected the STRICTER
// limit governs — otherwise the user writes 3000 characters, Facebook accepts it, and Instagram
// rejects the whole post AFTER the Facebook one is already public and irreversible.
export const FB_CAPTION_MAX = 5000
export const IG_CAPTION_MAX = 2200
export const IG_MAX_HASHTAGS = 30
export const IG_MAX_MENTIONS = 20

export function captionLimitFor(targets) {
  return targets?.instagram ? IG_CAPTION_MAX : FB_CAPTION_MAX
}

// Mirrors lambda/facebook-share/instagram.js countHashtags/countMentions. Duplicated deliberately —
// the Lambda's module cannot be imported into the browser bundle — and pinned by a test that reads
// both files, so the two cannot drift silently. Warning BEFORE a post beats surfacing a server
// rejection after Facebook has already gone out.
export function countHashtags(caption) {
  if (!caption) return 0
  return (caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length
}
export function countMentions(caption) {
  if (!caption) return 0
  return (caption.match(/(^|\s)@[\p{L}\p{N}_.]+/gu) || []).length
}

// Client-side pre-flight for the selected targets. Returns [] when postable.
export function validateForTargets(caption, targets) {
  const errs = []
  if (!targets?.facebook && !targets?.instagram) errs.push('Choose at least one place to post.')
  if (targets?.instagram && caption) {
    if (caption.length > IG_CAPTION_MAX) errs.push(`Instagram captions are limited to ${IG_CAPTION_MAX} characters.`)
    if (countHashtags(caption) > IG_MAX_HASHTAGS) errs.push(`Instagram allows at most ${IG_MAX_HASHTAGS} hashtags.`)
    if (countMentions(caption) > IG_MAX_MENTIONS) errs.push(`Instagram allows at most ${IG_MAX_MENTIONS} @-mentions.`)
  }
  return errs
}

export const TARGETS = [
  { key: 'facebook', path: '/api/share/facebook', label: 'Facebook', disabledCode: 'facebook_sharing_disabled' },
  { key: 'instagram', path: '/api/share/instagram', label: 'Instagram', disabledCode: 'instagram_sharing_disabled' },
]

const blank = () => ({ facebook: null, instagram: null })

// A target's outcome from a thrown api.js error. `timeout` is kept DISTINCT from `error` for the
// reason in the header: it means we stopped watching before the server stopped working, so the post
// may well be live. Reporting it as a failure is what sends the user round the double-post loop.
function classify(err, target) {
  if (err?.timeout) return 'timeout'
  if (err?.status === 403) return 'forbidden'
  const code = err?.body?.error
  if (code === 'facebook_token_invalid') return 'token_invalid'
  if (code === target.disabledCode) return 'disabled'
  if (code === 'ig_not_configured') return 'not_configured'
  if (code === 'content_blocked') return 'content_blocked'
  return 'error'
}

function messageFor(kind, err, target) {
  if (kind === 'timeout') {
    return `This is taking longer than expected. The ${target.label} post may still have gone through — check before trying again. Retrying is safe: it will not post twice.`
  }
  if (kind === 'content_blocked') {
    return err?.body?.message || 'That post looks like it contains location details, so it was not sent.'
  }
  return err?.body?.message || err?.message || `${target.label} post failed.`
}

export function useShareToSocial() {
  const { fetch: apiFetch } = useApiFetch()
  const [state, setState] = useState('idle')        // idle|posting|success|partial|error
  const [perTarget, setPerTarget] = useState(blank) // key -> { state, result?, error?, code? }
  // Same-tab fast path. Storage is the durable source; this only avoids re-reading it mid-session.
  const slotIdsRef = useRef({})

  // The REF is the source of truth for "which targets have already landed"; the state above is its
  // render mirror. This is not belt-and-braces — a ref is the only thing that can answer that
  // question synchronously inside share().
  //
  // The rescued lane read `perTarget` from the callback closure, which is the value from the last
  // render. The obvious repair — read it through a setPerTarget(prev => …) updater instead — is ALSO
  // wrong and fails the same test: React does not run that updater at the call site, it runs it when
  // it processes the update, so anything read out of it is still stale two lines later. Both
  // versions re-send a target that already succeeded, which on Instagram is an undeletable duplicate.
  const perTargetRef = useRef(blank())
  const commit = useCallback((next) => { perTargetRef.current = next; setPerTarget(next) }, [])

  const share = useCallback(async (photoIds, caption, targets) => {
    if (!Array.isArray(photoIds) || photoIds.length === 0) return null
    const wanted = TARGETS.filter((t) => targets?.[t.key])
    if (wanted.length === 0) return null

    const trimmed = caption?.trim() ? caption.trim() : null

    const current = perTargetRef.current
    const marked = { ...current }
    for (const t of wanted) if (marked[t.key]?.state !== 'success') marked[t.key] = { state: 'posting' }
    commit(marked)
    setState('posting')

    // Skip targets that already landed. Belt: the server's per-target replay guard would make a
    // re-send a replay anyway — but a skipped call cannot be rate-limited, cannot fail, and cannot
    // depend on the server having been given a key at all.
    const pending = wanted.filter((t) => current[t.key]?.state !== 'success')

    // Sequential, not Promise.all: these are non-idempotent external publishes, and a shared 429 or
    // a dead token should stop the second rather than fire both into the same wall. Order is stable
    // so the user always sees Facebook resolve first.
    const outcomes = {}
    for (const t of pending) {
      // Resolve this target's slot from THIS attempt's content, every call. A retry with the same
      // photos and caption resolves the same slot — and therefore the same id — even on a cold start
      // after the PWA reloaded.
      const slot = shareSlotKey({ target: t.key, photoIds, caption })
      if (slotIdsRef.current[t.key]?.slot !== slot) delete slotIdsRef.current[t.key]
      if (!slotIdsRef.current[t.key]) slotIdsRef.current[t.key] = { slot, id: acquireRequestId(slot) }
      const requestId = slotIdsRef.current[t.key].id

      try {
        const res = await apiFetch(t.path, {
          method: 'POST',
          timeoutMs: SHARE_TIMEOUT_MS,
          body: JSON.stringify({ photo_ids: photoIds, caption: trimmed, client_request_id: requestId }),
        })
        outcomes[t.key] = { state: 'success', result: res }
        // Released ONLY on a confirmed success, and only for THIS target, so a deliberate repost of
        // the same photos later mints a new id and genuinely posts again.
        releaseRequestId(slot)
        delete slotIdsRef.current[t.key]
      } catch (err) {
        const kind = classify(err, t)
        outcomes[t.key] = { state: kind, code: err?.body?.error, error: messageFor(kind, err, t) }
        // Slot deliberately RETAINED — including on timeout, which is the case it exists for.
      }
    }

    const merged = { ...marked, ...outcomes }
    commit(merged)

    const attempted = wanted.map((t) => merged[t.key])
    const okCount = attempted.filter((r) => r?.state === 'success').length
    const overall = okCount === attempted.length ? 'success' : okCount > 0 ? 'partial' : 'error'
    setState(overall)

    return { overall, perTarget: merged }
  }, [apiFetch, commit])

  const reset = useCallback(() => {
    setState('idle')
    commit(blank())
    // Deliberately does NOT release stored slots: reset() is a UI dismissal, not a confirmation that
    // nothing was posted. Dropping the ids here would hand the next attempt fresh ones and reopen
    // the double-post hole. Slots age out on their own 24h TTL.
    slotIdsRef.current = {}
  }, [commit])

  return { state, perTarget, share, reset }
}
