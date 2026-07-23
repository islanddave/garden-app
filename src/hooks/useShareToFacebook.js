import { useState, useRef, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'

// V4-FBSHARE-001 — post selected garden photos to the "Gardens at Mathews" Facebook Page via the
// admin-only POST /api/share/facebook (Graph byte-upload; NOT the OS share sheet in lib/shareEntity.js).
//
// State machine: idle -> posting -> success | error | forbidden | token_invalid | disabled.
//   forbidden      = server 403 (not the page admin) — the UI, not the client, learns this (the app
//                    convention is server-gated ADMIN_CLERK_SUBS, no client admin list; cf. GardenActivity).
//   token_invalid  = FB Page token dead/expired (needs the re-auth runbook).
//   disabled       = kill switch FB_SHARE_ENABLED is off.
//
// client_request_id persists ACROSS RETRIES and clears ONLY on success/reset. The Graph API has no
// idempotency key, so a retry after a lost response would double-post; the same client_request_id
// makes the server replay the already-created post instead. Do not regenerate it on error.
export function useShareToFacebook() {
  const { fetch: apiFetch } = useApiFetch()
  const [state, setState] = useState('idle')
  const [result, setResult] = useState(null)   // { post_group_id, post_id, media, permalink? }
  const [error, setError] = useState(null)
  const requestIdRef = useRef(null)

  const newRequestId = () =>
    globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.round(Math.random() * 1e9)}`

  const share = useCallback(async (photoIds, caption) => {
    if (!Array.isArray(photoIds) || photoIds.length === 0) return null
    if (!requestIdRef.current) requestIdRef.current = newRequestId()
    setState('posting')
    setError(null)
    try {
      const res = await apiFetch('/api/share/facebook', {
        method: 'POST',
        body: JSON.stringify({
          photo_ids: photoIds,
          caption: caption?.trim() ? caption.trim() : null,
          client_request_id: requestIdRef.current,
        }),
      })
      setResult(res)
      setState('success')
      requestIdRef.current = null   // a fresh attempt gets a fresh id
      return res
    } catch (err) {
      const code = err?.body?.error
      if (err?.status === 403) setState('forbidden')
      else if (code === 'facebook_token_invalid') setState('token_invalid')
      else if (code === 'facebook_sharing_disabled') setState('disabled')
      else setState('error')
      setError(err?.body?.message || err?.message || 'Sharing failed. Please try again.')
      // keep requestIdRef so a retry replays idempotently
      throw err
    }
  }, [apiFetch])

  const reset = useCallback(() => {
    setState('idle')
    setError(null)
    setResult(null)
    requestIdRef.current = null
  }, [])

  return { state, result, error, share, reset }
}
