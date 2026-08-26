// useAppUpdate — BUG-STALECLIENT-001. Two independent staleness signals feed one affordance:
// (1) UPDATE_WAITING_EVENT from registerSW.js — a new SW is parked in `waiting` (its
//     detail.apply() posts SKIP_WAITING; the guarded controllerchange→reload completes the swap).
// (2) A bounded /releases-latest.json probe — the running bundle's baked version is older than the
//     newest release, i.e. this client is on a stale shell even if no waiting SW is visible
//     (the case where SW update fetches fail silently on a flaky network path to the CDN).
// Probe is no-store (never answered by SW or HTTP cache), 8s-bounded so it can never hang,
// throttled so visibility flapping doesn't hammer the CDN. All failures are swallowed — this
// hook must never degrade the app; no signal simply means no banner.
//
// V4-PERFTHEMEA-001 — WHY -latest AND NOT releases.json. This probe reads ONE field. releases.json
// is the full 106-release history at 141,722 B / ~45 KB gzip, and because the probe is (correctly)
// no-store it was re-downloaded in full on every load AND on every visibilitychange past the 60s
// throttle — measured at ~88% of the app's entire warm-load byte budget, to learn a version string.
// public/releases-latest.json is releases.json[0] alone (~1.7 KB / ~0.9 KB gzip). Both files are
// written by scripts/add-release.mjs in one step and CI asserts they agree
// (scripts/check-release-version.py check C), so the probe cannot read a version the history
// disagrees with. The Release Notes page still reads the full file, on visit.
//
// no-store IS NOT NEGOTIABLE ON EITHER FILE. The win here is that the payload got small, not that
// it became cacheable — a cacheable version probe is how BUG-STALECLIENT-002 (clients stranded on
// an old bundle) comes back.
//
// A MISSING -latest FAILS SILENTLY, WHICH IS WHY CI AND SMOKE GUARD IT. CloudFront maps 404 to
// 200 /index.html on this distribution, so an absent object returns the HTML shell with r.ok true;
// r.json() then throws and the catch below swallows it — no banner, no error, indefinitely.
// scripts/smoke-prod.py checks the DEPLOYED /releases-latest.json head version on every promote so
// that failure is loud at deploy time instead of silent on Dave's phone. Do not "harden" this by
// falling back to /releases.json: a silent fallback would restore the 45 KB forever and look fine.
import { useCallback, useEffect, useRef, useState } from 'react'
import { UPDATE_WAITING_EVENT } from '../lib/registerSW.js'
import { cmpVersion } from '../lib/whatsNew.js'

const APP_VERSION = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null) || '0.0.0'
export const VERSION_PROBE_TIMEOUT_MS = 8000
export const VERSION_PROBE_MIN_INTERVAL_MS = 60000

export function useAppUpdate(opts = {}) {
  const {
    fetchFn = (typeof fetch !== 'undefined' ? (...a) => fetch(...a) : null),
    doc = (typeof document !== 'undefined' ? document : null),
    win = (typeof window !== 'undefined' ? window : null),
    reload = () => { try { if (win && win.location) win.location.reload() } catch { /* noop */ } },
    appVersion = APP_VERSION,
  } = opts

  // { version: string|null } — non-null state means an update is available.
  const [update, setUpdate] = useState(null)
  const applyRef = useRef(null)
  const lastProbe = useRef(0)
  const optsRef = useRef({ fetchFn, doc, win, appVersion })
  optsRef.current = { fetchFn, doc, win, appVersion }

  useEffect(() => {
    const { fetchFn, doc, win, appVersion } = optsRef.current
    if (!win) return undefined

    const onWaiting = (e) => {
      const apply = e && e.detail && typeof e.detail.apply === 'function' ? e.detail.apply : null
      if (apply) applyRef.current = apply
      // Keep any version the shell probe already learned; a waiting SW alone has no number.
      setUpdate((u) => u || { version: null })
    }
    win.addEventListener(UPDATE_WAITING_EVENT, onWaiting)

    const probe = () => {
      if (!fetchFn) return
      const now = Date.now()
      if (now - lastProbe.current < VERSION_PROBE_MIN_INTERVAL_MS) return
      lastProbe.current = now
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), VERSION_PROBE_TIMEOUT_MS) : null
      Promise.resolve()
        .then(() => fetchFn('/releases-latest.json', { cache: 'no-store', signal: controller ? controller.signal : undefined }))
        .then((r) => { if (!r || !r.ok) throw new Error('probe failed'); return r.json() })
        .then((d) => {
          // Single object, not the array releases.json holds. Shape-checked rather than trusted:
          // the 404→200-HTML mapping means a non-JSON body is a live possibility here.
          const latest = d && typeof d === 'object' && !Array.isArray(d) && d.version ? String(d.version) : null
          if (latest && cmpVersion(latest, appVersion) > 0) setUpdate({ version: latest })
        })
        .catch(() => { /* offline/hung CDN path: no signal, no banner */ })
        .then(() => { if (timer) clearTimeout(timer) })
    }

    probe()
    const onVis = () => { if (!doc || doc.visibilityState === 'visible') probe() }
    if (doc) doc.addEventListener('visibilitychange', onVis)
    return () => {
      win.removeEventListener(UPDATE_WAITING_EVENT, onWaiting)
      if (doc) doc.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  const apply = useCallback(() => {
    if (applyRef.current) {
      try { applyRef.current() } catch { /* noop */ }
      // The SKIP_WAITING → activate → controllerchange → reload chain normally lands in well
      // under a second; if the waiting worker died or activation wedges, force the reload —
      // navigation is network-first, so a plain reload also picks up a fresh shell.
      setTimeout(reload, 2500)
    } else {
      reload()
    }
  }, [reload])

  return { update, apply }
}
