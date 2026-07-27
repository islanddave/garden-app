// useAppUpdate — BUG-STALECLIENT-001. Two independent staleness signals feed one affordance:
// (1) UPDATE_WAITING_EVENT from registerSW.js — a new SW is parked in `waiting` (its
//     detail.apply() posts SKIP_WAITING; the guarded controllerchange→reload completes the swap).
// (2) A bounded /releases.json probe — the running bundle's baked version is older than the
//     newest release, i.e. this client is on a stale shell even if no waiting SW is visible
//     (the case where SW update fetches fail silently on a flaky network path to the CDN).
// Probe is no-store (never answered by SW or HTTP cache), 8s-bounded so it can never hang,
// throttled so visibility flapping doesn't hammer the CDN. All failures are swallowed — this
// hook must never degrade the app; no signal simply means no banner.
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
        .then(() => fetchFn('/releases.json', { cache: 'no-store', signal: controller ? controller.signal : undefined }))
        .then((r) => { if (!r || !r.ok) throw new Error('probe failed'); return r.json() })
        .then((d) => {
          const latest = Array.isArray(d) && d[0] && d[0].version ? String(d[0].version) : null
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
