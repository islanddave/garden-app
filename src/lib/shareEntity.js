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
// V4-COMPOSEPOST-001 — `text` support. On Chrome Android navigator.share({ text }) hands the body
// straight into the Facebook / Business Suite composer, replacing copy -> app-switch -> long-press
// -> paste with a single tap. A text share deliberately omits the app URL: appending a Clerk-gated
// link would drop a login wall into the middle of a public post. Meta's prefill restriction
// (Developer Policies 5.6.2.d) does not reach an OS share sheet the user drives.
//
// V4-HARVPOSTPHOTOS-001 — `files` support. Chrome Android accepts { text, files } in one share, which
// is what lets the harvest post carry its own photos instead of Dave re-adding them by hand. Files are
// attached ONLY when navigator.canShare says the payload is shareable; when it does not, the text
// share proceeds unchanged. A caption is never dropped to make room for pictures.
//
// CALL SYNCHRONOUSLY FROM THE CLICK HANDLER. Chrome Android drops transient user activation across
// an `await`, so building the string and sharing afterwards makes BOTH navigator.share and the
// clipboard fallback reject silently. Callers must already hold the text when they invoke this.
// The same applies to `files`: they must be FETCHED ALREADY, not fetched inside the handler.

// Capability probe. Exported so a caller can tell Dave what will happen BEFORE he taps, rather than
// discovering it afterwards — canShare is the only honest answer (feature detection on navigator.share
// alone is true on desktops that reject every file payload), and it needs the real Files to judge.
export function canShareFiles(files) {
  const list = (Array.isArray(files) ? files : []).filter(Boolean)
  if (!list.length) return false
  if (typeof navigator === 'undefined') return false
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false
  // canShare throws on some payload shapes rather than returning false; a throw is a "no".
  try { return navigator.canShare({ files: list }) === true } catch { return false }
}

export async function shareEntity({ title, url, text, files } = {}) {
  // A caller that passed `text` at all is doing a text share, even if the string turns out empty.
  // Without this distinction an empty compose box would silently fall back to sharing the current
  // Clerk-gated page URL — the opposite of doing nothing.
  const wantsText = typeof text === 'string'
  const body = wantsText ? text.trim() : ''
  const link = url || (wantsText ? '' : (typeof window !== 'undefined' ? window.location.href : ''))
  const attach = canShareFiles(files) ? files.filter(Boolean) : []
  if (!link && !body && !attach.length) return 'noop'

  const payload = body
    ? { ...(title ? { title } : {}), text: body, ...(url ? { url } : {}) }
    : (link ? { title: title || 'My garden', url: link } : {})
  // Added only when non-empty, so a caller that passes no files sends the byte-identical payload it
  // sent before this change.
  if (attach.length) payload.files = attach

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share(payload)
      return 'shared'
    } catch {
      // user cancelled the sheet or share failed — do NOT silently fall through to clipboard
      return 'noop'
    }
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      // Files have no clipboard equivalent here and are dropped; the WORDS still land, which is the
      // one thing that must never be lost. The caller has already told Dave photos won't attach.
      await navigator.clipboard.writeText(body || link)
      return 'copied'
    }
  } catch { /* clipboard blocked — inert */ }
  return 'noop'
}
