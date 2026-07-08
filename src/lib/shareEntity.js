// V4-FBSHARE-001 — one Web Share entry point for events + plantings. On mobile the OS share
// sheet natively includes Facebook (and everything else the device has) with NO Facebook SDK.
// Falls back to copying the link on desktops without Web Share, and is an inert no-op if neither
// exists. Returns 'shared' | 'copied' | 'noop'. Must be called from a user gesture.
//
// PRIVACY NOTE: callers pass window.location.href, which is a Clerk-gated app URL — a recipient
// without access hits the login wall. A genuinely public link needs a public surface (today only
// project-level /garden/:slug gated on is_public). Exposing a public per-planting/per-event link
// is tracked separately (V4-SHARE-001 / V4-PHOTOSHARE-001); this util only surfaces the share
// affordance consistently, matching the existing planting share (HeroPhoto).
export async function shareEntity({ title, url } = {}) {
  const link = url || (typeof window !== 'undefined' ? window.location.href : '')
  if (!link) return 'noop'
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: title || 'My garden', url: link })
      return 'shared'
    } catch {
      // user cancelled the sheet or share failed — do NOT silently fall through to clipboard
      return 'noop'
    }
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(link)
      return 'copied'
    }
  } catch { /* clipboard blocked — inert */ }
  return 'noop'
}
