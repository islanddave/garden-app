/**
 * src/lib/durableStorage.js
 *
 * Bite 4 of Post-V2 UX overhaul Increment 2: durable storage prompt.
 *
 * Wraps navigator.storage.persist() and navigator.storage.persisted(). Used
 * by FieldCapture on first-mount per Concept B spec: request persistence
 * install-early (not on the first mic tap) so iOS Safari has the strongest
 * incentive to retain the IndexedDB store under quota pressure.
 *
 * iOS Safari notes:
 *   - persist() returns true on user-engaged origins (PWA installed, frequent
 *     visits, bookmarked) and false otherwise.
 *   - Without persist(), iOS may evict the IndexedDB store under quota pressure
 *     without warning.
 *   - There is no API to inspect WHY persist() returned false.
 *
 * All functions are defensive: missing navigator.storage / non-Promise return
 * / throws are caught and reported via the returned object rather than thrown.
 */

/**
 * Probe whether the origin currently has persistent storage. Returns:
 *   { supported: false }                          if API unavailable
 *   { supported: true, persistent: boolean }      otherwise
 */
export async function isPersistent() {
  try {
    if (typeof navigator === 'undefined') return { supported: false }
    if (!navigator.storage || typeof navigator.storage.persisted !== 'function') {
      return { supported: false }
    }
    const persistent = await navigator.storage.persisted()
    return { supported: true, persistent: !!persistent }
  } catch {
    return { supported: false }
  }
}

/**
 * Request persistent storage. Returns:
 *   { supported: false }                          if API unavailable
 *   { supported: true, granted: boolean }         otherwise
 *
 * Already-persistent origins short-circuit to { supported: true, granted: true }
 * without re-prompting.
 */
export async function requestPersistence() {
  const probe = await isPersistent()
  if (!probe.supported) return { supported: false }
  if (probe.persistent) return { supported: true, granted: true }
  try {
    const granted = await navigator.storage.persist()
    return { supported: true, granted: !!granted }
  } catch {
    return { supported: true, granted: false }
  }
}

/**
 * Estimate of storage usage and quota. Returns:
 *   { supported: false }                                       if API unavailable
 *   { supported: true, usage: bytes, quota: bytes }            otherwise
 */
export async function getQuotaEstimate() {
  try {
    if (typeof navigator === 'undefined') return { supported: false }
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
      return { supported: false }
    }
    const est = await navigator.storage.estimate()
    return {
      supported: true,
      usage: typeof est.usage === 'number' ? est.usage : null,
      quota: typeof est.quota === 'number' ? est.quota : null,
    }
  } catch {
    return { supported: false }
  }
}
