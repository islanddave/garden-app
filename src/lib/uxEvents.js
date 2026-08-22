// Fire-and-forget M1 success-metric telemetry (Post-V2 UX Overhaul — Increment 0).
// Spec: success-metric-instrumentation-spec-V001-20260522.1620.md §2 (M1 tap-count).
//
// HARD RULE: telemetry must NEVER block, delay, or throw into a user flow. Every send is
// best-effort and swallows all errors. If VITE_API_UX_EVENTS is unset (not yet provisioned)
// it is a silent no-op. clerk_sub is attached server-side from the verified JWT — the client
// only sends the bearer token, never an identity claim.

import { useCallback, useRef } from 'react'
import { useApiFetch } from './api.js'

// The M1 flows (must match the Lambda's server-side ALLOWED_FLOWS allowlist).
// V3-NAV-001 (Lane C / PR2): OPEN_PLANTING is a NEW step fired when the dedicated
// PlantingDetail page mounts ("opened a planting detail"). It does NOT replace
// REACH_PLANTING, which still fires on project load ("viewed a project containing
// plantings") for one release so the funnel keeps a continuous signal during cutover.
// Temporary double-signal is intentional — reconcile after both are visible in the funnel.
// If the Lambda allowlist hasn't added 'open_planting' yet, sendUxEvent is a silent no-op
// (server drops unknown flows), so this is safe to ship ahead of the server allowlist.
// V4-PHOTOUPLOADINSTR-001: the comment above was right and its consequence was worse than "safe to
// ship ahead of the server allowlist". `open_planting` shipped here 2026-06-03 and was NEVER added
// to the Lambda, so it recorded ZERO rows in 2.5 months while PlantingDetail replaced ProjectDetail
// as the way in — the funnel did not double-signal, it handed over to a flow that was being dropped.
// Both are in ALLOWED_FLOWS now, and ux-events.flowLockstep.test.js fails if this object ever again
// carries a value the server does not accept. Add flows in PAIRS, or the guard will tell you.
export const FLOWS = {
  LOG_WATERING: 'log_watering',
  REACH_PLANTING: 'reach_planting',
  OPEN_PLANTING: 'open_planting',
  CREATE_PROJECT: 'create_project',
  PHOTO_UPLOAD: 'photo_upload',
  VOICE_INPUT: 'voice_input',
}

const UX_BASE = (import.meta.env.VITE_API_UX_EVENTS ?? '').replace(/\/$/, '')

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'sid-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// One id per browser tab session — taps-to-completion is computed per (session_id, flow_id).
export function getSessionId() {
  try {
    const k = 'ux_session_id'
    let v = sessionStorage.getItem(k)
    if (!v) { v = uuid(); sessionStorage.setItem(k, v) }
    return v
  } catch {
    return 'ephemeral'
  }
}

// Low-level beacon. Resolves a token via getToken, POSTs, swallows ALL errors. Never rejects.
export async function sendUxEvent(getToken, { flowId, stepIndex = 0, stepName = null, tapCount = null, meta = null }) {
  if (!UX_BASE) return // endpoint not provisioned yet — no-op
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return
    const payload = {
      flow_id: flowId,
      session_id: getSessionId(),
      step_index: stepIndex,
      step_name: stepName,
      tap_count: tapCount,
      client_ts: new Date().toISOString(),
      meta,
    }
    await fetch(`${UX_BASE}/api/ux-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      keepalive: true, // survive a navigation that fires right after `complete`
    })
  } catch {
    // telemetry must never affect UX — swallow
  }
}

// React hook: a per-flow tap counter + step/complete recorders.
//   tap()                       — increment the interaction counter for this flow instance
//   step(index, name, meta)     — emit an intermediate step event
//   complete(meta)              — emit the completion event carrying the tap count
//   reset()                     — start a fresh flow instance (counter -> 0)
export function useUxFlow(flowId) {
  // Token comes from useApiFetch (which wraps Clerk's useAuth) so that component tests
  // mocking '../lib/api.js' automatically neutralize the Clerk dependency — no consumer
  // test needs a ClerkProvider just because it instruments a flow.
  const { getToken } = useApiFetch()
  const taps = useRef(0)
  const startedAt = useRef(Date.now())

  const tap = useCallback(() => { taps.current += 1 }, [])
  const reset = useCallback(() => { taps.current = 0; startedAt.current = Date.now() }, [])

  const step = useCallback((stepIndex, stepName, meta = null) => {
    sendUxEvent(getToken, { flowId, stepIndex, stepName, meta })
  }, [getToken, flowId])

  const complete = useCallback((meta = null) => {
    const elapsed_ms = Date.now() - startedAt.current
    sendUxEvent(getToken, {
      flowId,
      stepIndex: 99,
      stepName: 'complete',
      tapCount: taps.current,
      meta: { ...(meta ?? {}), elapsed_ms },
    })
  }, [getToken, flowId])

  return { tap, reset, step, complete }
}
