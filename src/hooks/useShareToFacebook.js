import { useState, useRef, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'
import { shareSlotKey, acquireRequestId, releaseRequestId } from '../lib/shareIdempotency.js'

// V4-FBSHARE-001 — post selected garden photos to the "Gardens at Mathews" Facebook Page via the
// admin-only POST /api/share/facebook (Graph byte-upload; NOT the OS share sheet in lib/shareEntity.js).
//
// State machine: idle -> posting -> success | error | forbidden | token_invalid | disabled | timeout.
//   forbidden      = server 403 (not the page admin) — the UI, not the client, learns this (the app
//                    convention is server-gated ADMIN_CLERK_SUBS, no client admin list; cf. GardenActivity).
//   token_invalid  = FB Page token dead/expired (needs the re-auth runbook).
//   disabled       = kill switch FB_SHARE_ENABLED is off.
//   timeout        = we stopped waiting BEFORE the server did. Distinct from `error` on purpose —
//                    see SHARE_TIMEOUT_MS below. The post may be live; retry replays, it does not
//                    duplicate.
//
// SHARE_TIMEOUT_MS — why this call opts out of the 15s app default.
// The Lambda's own budget is 180s (verified live: garden-facebook-share Timeout=180). A Function URL
// is NOT cancelled when the client disconnects, so aborting at 15s does not stop the post — it only
// stops us WATCHING it. The user then sees "failed" for a post that is on the Page, and retries.
// That is the exact sequence that double-posts. Waiting past the server's own self-termination means
// the outcome we report is the outcome that happened. 185s is 180s plus enough margin for the
// response to come back off the wire.
export const SHARE_TIMEOUT_MS = 185_000

// client_request_id survives a RELOAD, not just a re-render — see src/lib/shareIdempotency.js. It is
// held both in a ref (same-tab retry) and in storage keyed by the post's content (retry after the
// PWA reloads), and released only on a confirmed success so a deliberate repost still posts.
export function useShareToFacebook() {
  const { fetch: apiFetch } = useApiFetch()
  const [state, setState] = useState('idle')
  const [result, setResult] = useState(null)   // { post_group_id, post_id, media, permalink? }
  const [error, setError] = useState(null)
  const requestIdRef = useRef(null)
  const slotRef = useRef(null)

  const share = useCallback(async (photoIds, caption) => {
    if (!Array.isArray(photoIds) || photoIds.length === 0) return null

    // Resolve the slot from THIS attempt's content every call: a retry with the same photos and
    // caption resolves the same slot (and so the same id) even on a cold start after a reload.
    const slot = shareSlotKey({ target: 'facebook', photoIds, caption })
    if (slotRef.current !== slot) requestIdRef.current = null
    slotRef.current = slot
    if (!requestIdRef.current) requestIdRef.current = acquireRequestId(slot)

    setState('posting')
    setError(null)
    try {
      const res = await apiFetch('/api/share/facebook', {
        method: 'POST',
        timeoutMs: SHARE_TIMEOUT_MS,
        body: JSON.stringify({
          photo_ids: photoIds,
          caption: caption?.trim() ? caption.trim() : null,
          client_request_id: requestIdRef.current,
        }),
      })
      setResult(res)
      setState('success')
      releaseRequestId(slot)        // a fresh attempt gets a fresh id
      requestIdRef.current = null
      slotRef.current = null
      return res
    } catch (err) {
      const code = err?.body?.error
      if (err?.status === 403) setState('forbidden')
      else if (code === 'facebook_token_invalid') setState('token_invalid')
      else if (code === 'facebook_sharing_disabled') setState('disabled')
      else if (err?.timeout) setState('timeout')
      else setState('error')
      setError(
        err?.timeout
          ? 'This is taking longer than expected. The post may still have gone through — check the Page before trying again. Retrying is safe: it will not post twice.'
          : (err?.body?.message || err?.message || 'Sharing failed. Please try again.')
      )
      // keep requestIdRef AND the stored slot so a retry — including one after a reload — replays
      // idempotently instead of creating a second post.
      throw err
    }
  }, [apiFetch])

  const reset = useCallback(() => {
    setState('idle')
    setError(null)
    setResult(null)
    // Deliberately does NOT release the stored slot: reset() is a UI dismissal, not a confirmation
    // that nothing was posted. Dropping the id here would hand the next attempt a fresh one and
    // reopen the double-post hole. The slot ages out on its own TTL.
    requestIdRef.current = null
    slotRef.current = null
  }, [])

  return { state, result, error, share, reset }
}
