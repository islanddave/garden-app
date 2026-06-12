// Service-worker registration + stale-PWA self-heal (V3-CACHE-001).
// Inoculates against the stale-SW sign-in blip / zoomed-out stale-install class
// (vigilant-trusting-hawking incident, L-106): a deploy lands while the app is open
// or installed, and the client keeps running an old shell/chunks until manually cleared.
//
// Self-heal = two parts:
//   1. registration.update() on resume (visibilitychange→visible, pageshow/bfcache restore)
//      forces the browser to re-check /sw.js so a new deploy's SW installs promptly.
//   2. A guarded controllerchange→reload-once: when a NEW sw takes control of an
//      ALREADY-controlled page (i.e. a real update), reload one time to pick up fresh
//      assets. Guarded so a brand-new first install (clients.claim with no prior
//      controller) does NOT reload, and the refreshing flag prevents a reload loop.
//
// Deps are injectable for unit testing (no real SW support needed in jsdom).

export function registerServiceWorker(opts = {}) {
  const {
    nav = (typeof navigator !== 'undefined' ? navigator : undefined),
    win = (typeof window !== 'undefined' ? window : undefined),
    doc = (typeof document !== 'undefined' ? document : undefined),
    swUrl = '/sw.js',
    reload = () => { try { win && win.location && win.location.reload() } catch { /* noop */ } },
  } = opts

  const noop = () => {}
  if (!nav || !('serviceWorker' in nav)) return noop

  const sw = nav.serviceWorker
  // Snapshot controller state at boot. A page that already has a controller and then
  // sees controllerchange has been UPDATED; a page with no controller seeing
  // controllerchange is just the FIRST install claiming it — must not reload.
  const hadController = !!sw.controller
  let refreshing = false
  let registration = null

  const onControllerChange = () => {
    if (!hadController || refreshing) return
    refreshing = true
    reload()
  }

  const checkForUpdate = () => {
    if (!registration || typeof registration.update !== 'function') return
    if (doc && doc.visibilityState && doc.visibilityState !== 'visible') return
    Promise.resolve().then(() => registration.update()).catch(noop)
  }

  const onVisibility = () => { if (!doc || doc.visibilityState === 'visible') checkForUpdate() }
  const onPageShow = () => checkForUpdate()

  const start = () => {
    Promise.resolve()
      .then(() => sw.register(swUrl))
      .then((reg) => { registration = reg })
      .catch(noop)
  }

  try { sw.addEventListener('controllerchange', onControllerChange) } catch { /* noop */ }

  if (win) {
    if (doc && doc.readyState === 'complete') start()
    else win.addEventListener('load', start, { once: true })
    if (doc) doc.addEventListener('visibilitychange', onVisibility)
    win.addEventListener('pageshow', onPageShow)
  } else {
    start()
  }

  return () => {
    try { sw.removeEventListener('controllerchange', onControllerChange) } catch { /* noop */ }
    if (doc) doc.removeEventListener('visibilitychange', onVisibility)
    if (win) win.removeEventListener('pageshow', onPageShow)
  }
}
