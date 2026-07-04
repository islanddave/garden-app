// src/lib/whatsNew.js — V4-WHATSNEW-001 ambient unread indicator for the /releases page.
// Last-seen version is localStorage-only (non-critical, ephemeral): cross-device sync is
// deferred to V4-WHATSNEW-002 per the Cross-Device State Principle expedient carve-out.
// Pure helpers + a cross-instance "seen" event so the header dot + More-tab dot clear together.
const KEY = 'garden.releasesSeenVersion'
export const SEEN_EVENT = 'garden:whatsnew-seen'

// Numeric-dotted semver compare (releases use v1-3 dotted integers).
export function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

// Unseen ONLY when a prior seen version exists and the latest is newer. First run (no stored
// seen) is NOT unseen — the caller writes the current version so only genuinely-new releases dot.
export function isUnseen(latestVersion, seenVersion) {
  if (!latestVersion) return false
  if (seenVersion == null || seenVersion === '') return false
  return cmpVersion(latestVersion, seenVersion) > 0
}

export function readSeen() {
  try { return localStorage.getItem(KEY) } catch { return null }
}

export function writeSeen(v) {
  if (!v) return
  try {
    localStorage.setItem(KEY, String(v))
    if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new Event(SEEN_EVENT))
  } catch { /* private-mode / SSR: ignore */ }
}
