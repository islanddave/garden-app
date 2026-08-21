import { useState, useRef, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'

// V4-IGSHARE-001 — post selected garden photos to Facebook and/or Instagram in ONE compose action.
//
// WHY A COMBINED HOOK RATHER THAN CALLING useShareToFacebook TWICE: the interesting state is not
// "did it work" but PARTIAL failure. Facebook and Instagram are independent endpoints that fail
// independently, and the one thing this must never do is report success when only one landed, or
// double-post the one that already succeeded when the user retries.
//
// PARTIAL-FAILURE SAFETY rests on two things working together:
//   1. ONE client_request_id shared by both targets and held across retries. It is cleared only when
//      every attempted target has succeeded — never on error (cf. useShareToFacebook).
//   2. The server's replay guard is scoped BY TARGET (share_log ... AND target = 'instagram'), so
//      the same id posted to both is two independent idempotency keys, not a collision.
// Retry then skips targets already in 'success' — and even if a future edit stops skipping them,
// (2) makes the re-send a replay rather than a duplicate. Belt and braces, deliberately.
//
// Instagram cannot delete published media through the API (verified 2026-08-21: DELETE -> code 10).
// A mistaken IG post is removable only by hand in the Instagram app, which is why the sheet states
// the targets plainly before posting rather than defaulting silently.

// Instagram's caption ceiling is far below Facebook's 5000. When both targets are selected the
// STRICTER limit governs, or the user writes 3000 characters, Facebook accepts it, and Instagram
// rejects the whole post after the Facebook one is already public and irreversible.
export const FB_CAPTION_MAX = 5000
export const IG_CAPTION_MAX = 2200
export const IG_MAX_HASHTAGS = 30
export const IG_MAX_MENTIONS = 20

export function captionLimitFor(targets) {
  return targets?.instagram ? IG_CAPTION_MAX : FB_CAPTION_MAX
}

// Mirrors lambda/facebook-share/instagram.js countHashtags/countMentions. Kept in sync deliberately
// so the composer can warn BEFORE a post rather than surfacing a server rejection after Facebook has
// already gone out.
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

const TARGETS = [
  { key: 'facebook', path: '/api/share/facebook', label: 'Facebook', disabledCode: 'facebook_sharing_disabled' },
  { key: 'instagram', path: '/api/share/instagram', label: 'Instagram', disabledCode: 'instagram_sharing_disabled' },
]

const blank = () => ({ facebook: null, instagram: null })

export function useShareToSocial() {
  const { fetch: apiFetch } = useApiFetch()
  const [state, setState] = useState('idle')      // idle|posting|success|partial|error
  const [perTarget, setPerTarget] = useState(blank)  // key -> { state, result?, error?, code? }
  const requestIdRef = useRef(null)

  const newRequestId = () =>
    globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.round(Math.random() * 1e9)}`

  const share = useCallback(async (photoIds, caption, targets) => {
    if (!Array.isArray(photoIds) || photoIds.length === 0) return null
    const wanted = TARGETS.filter((t) => targets?.[t.key])
    if (wanted.length === 0) return null

    if (!requestIdRef.current) requestIdRef.current = newRequestId()
    const requestId = requestIdRef.current
    const trimmed = caption?.trim() ? caption.trim() : null

    setState('posting')
    // Preserve prior successes across a retry; only re-attempt what has not landed.
    setPerTarget((prev) => {
      const next = { ...prev }
      for (const t of wanted) if (next[t.key]?.state !== 'success') next[t.key] = { state: 'posting' }
      return next
    })

    const pending = wanted.filter((t) => perTarget[t.key]?.state !== 'success')

    // Sequential, not Promise.all: these are non-idempotent external publishes, and a shared 429 or
    // dead token should stop the second rather than fire both into the same wall. Order is stable so
    // the user always sees Facebook resolve first.
    const outcomes = {}
    for (const t of pending) {
      try {
        const res = await apiFetch(t.path, {
          method: 'POST',
          body: JSON.stringify({ photo_ids: photoIds, caption: trimmed, client_request_id: requestId }),
        })
        outcomes[t.key] = { state: 'success', result: res }
      } catch (err) {
        const code = err?.body?.error
        const kind = err?.status === 403 ? 'forbidden'
          : code === 'facebook_token_invalid' ? 'token_invalid'
            : code === t.disabledCode ? 'disabled'
              : code === 'ig_not_configured' ? 'not_configured'
                : 'error'
        outcomes[t.key] = {
          state: kind,
          code,
          error: err?.body?.message || err?.message || `${t.label} post failed.`,
        }
      }
    }

    const merged = { ...perTarget, ...outcomes }
    for (const t of wanted) if (perTarget[t.key]?.state === 'success') merged[t.key] = perTarget[t.key]
    setPerTarget(merged)

    const attempted = wanted.map((t) => merged[t.key])
    const okCount = attempted.filter((r) => r?.state === 'success').length
    const overall = okCount === attempted.length ? 'success' : okCount > 0 ? 'partial' : 'error'
    setState(overall)

    // Clear the id ONLY when nothing is left to retry. Holding it is what makes a retry replay
    // instead of double-post.
    if (overall === 'success') requestIdRef.current = null

    return { overall, perTarget: merged }
  }, [apiFetch, perTarget])

  const reset = useCallback(() => {
    setState('idle')
    setPerTarget(blank())
    requestIdRef.current = null
  }, [])

  return { state, perTarget, share, reset }
}
