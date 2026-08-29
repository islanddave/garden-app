// failPhotoLoad — "this <img> fails to load", for suites that are not ABOUT the CORS retry.
//
// WHY THIS EXISTS. With PHOTO_CORS_CACHE_ENABLED on, a cross-origin photo is first requested in CORS
// mode, and PhotoImg's handleError absorbs the first error to retry the SAME url with the attribute
// removed (PhotoImg.jsx:234-241) — deliberately, so a refused CORS request is never mistaken for a
// missing photo. A single `fireEvent.error` therefore no longer reaches the heal / degrade / terminal
// path: it spends the CORS attempt and nothing else. That is correct product behaviour, so the ~40
// call sites across 13 suites that mean "the image failed" have to say so in a way that survives it.
//
// WHAT IT DOES NOT DO — it is not a way to make red go green. It detects the absorbed CORS attempt by
// its SIGNATURE rather than by reading the flag: a NEW DOM node carrying the SAME src. Only the CORS
// retry produces that pair, because only it changes PhotoImg's `key` without changing `src`
// (PhotoImg.jsx:365). Every other outcome is distinguishable — an ordinary heal keeps the same node
// (the key does not change) and only swaps src later, asynchronously; a degrade arrives with a
// different src; a terminal render has no <img> at all. So with the flag OFF, or on a same-origin
// src, or once the process-wide latch has tripped, `after === first` and this fires exactly one
// error, byte-identically to the bare fireEvent.error it replaces. It re-arms in neither direction.
//
// The CORS control flow itself is NOT tested through this helper — PhotoImg.cors.test.jsx owns it and
// drives raw fireEvent.error calls precisely so that it, and only it, reds if the retry stops
// happening. Keep it that way: a suite that asserts on crossOrigin should not be using this.
//
// Takes a GETTER, not an element: the retry remounts the <img>, so a captured node is detached by the
// time the second error is due. Passing the node would silently fire at nothing.
//
// DO NOT CALL THIS INSIDE an outer `await act(async () => …)`. RTL's fireEvent is itself act()-wrapped,
// but nesting defers React's commit to the OUTER scope's exit, so the re-query below would still see
// the pre-retry DOM and the second error would never be fired — a test that then fails for a reason
// that looks like a product bug. That case throws rather than under-firing; call it directly and let
// the waitFor that follows do the awaiting.
import { fireEvent } from '@testing-library/react'

export function failPhotoLoad(getImg) {
  if (typeof getImg !== 'function') {
    throw new Error('failPhotoLoad: pass a getter, e.g. () => container.querySelector("img") — the CORS retry remounts the element')
  }
  const first = getImg()
  if (!first) throw new Error('failPhotoLoad: expected an <img> to fail, found none')
  const src = first.getAttribute('src')
  // Read BEFORE firing: the attribute is what says a CORS attempt is in play at all. Absent means the
  // flag is off, the src is same-origin, or the latch already tripped — one error IS the whole failure.
  const corsAttempt = first.getAttribute('crossorigin') === 'anonymous'
  fireEvent.error(first)
  if (!corsAttempt) return
  const after = getImg()
  if (!after || after === first || after.getAttribute('src') !== src) {
    throw new Error(
      'failPhotoLoad: a crossOrigin <img> errored but PhotoImg did not re-render the same src without ' +
      'the attribute. Either the CORS retry regressed (PhotoImg.jsx handleError / the key at :365 — ' +
      'PhotoImg.cors.test.jsx should be red too), or this call is nested inside an outer act(async …) ' +
      'that has deferred the commit.',
    )
  }
  fireEvent.error(after)
}
