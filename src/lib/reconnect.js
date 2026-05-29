/**
 * src/lib/reconnect.js
 *
 * Bite 4 of Post-V2 UX overhaul Increment 2: reconnect signal.
 *
 * Wires `window.online` / `window.offline` events so a caller can re-poll
 * or retry queued items when the device comes back online. Used by Bite 6
 * to drain pending handoffs.
 *
 * NO Background Sync API — that path is iOS-broken (the registration is
 * silently rejected even when the service-worker scope is correct). Online
 * events are the contract.
 *
 * Defensive against environments without `window` (jsdom tests can polyfill;
 * server-side rendering: no-op).
 */

/**
 * Subscribe to reconnect events. Returns an unsubscribe function.
 *
 * @param {() => void} callback  fired when window.online dispatches
 * @returns {() => void} unsubscribe
 */
export function onReconnect(callback) {
  if (typeof callback !== 'function') return () => {}
  if (typeof window === 'undefined') return () => {}
  const handler = () => { try { callback() } catch {} }
  window.addEventListener('online', handler)
  return () => {
    try { window.removeEventListener('online', handler) } catch {}
  }
}

/**
 * Current best-guess of online status. Returns true if navigator.onLine is
 * true OR if navigator is unavailable (assume online — fail-open for the
 * reconnect signal since we'd rather try-and-fail than not try at all).
 */
export function isOnline() {
  try {
    if (typeof navigator === 'undefined') return true
    if (typeof navigator.onLine !== 'boolean') return true
    return navigator.onLine
  } catch {
    return true
  }
}
