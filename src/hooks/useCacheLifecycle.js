// src/hooks/useCacheLifecycle.js — V4-IMGCACHE-002 D-2. The lifecycle half of the image-list cache:
// B3 boot-warm and B5 resume-revalidate. D-1 shipped the store and the read hook; on its own the cache
// only fills as a side effect of visiting a surface, and never refreshes while the app sits open.
//
// WHY B5 MATTERS AFTER D-1 (this is the regression D-1 quietly introduced):
//   PhotoImg seeds its proactive-remint clock from the initialUrl it is handed at mount, on the
//   assumption that URL "came from a recent list fetch" (PhotoImg.jsx _seed). D-1 made that assumption
//   false — a cache-served list can be arbitrarily old, so a photo can mount with an already-expired
//   presign stamped as fresh, skip the proactive re-mint, render the dead URL, 403, and only then heal
//   reactively. Visible as a flash. The wake revalidate re-dates the entry so a LATER mount is seeded
//   from a recent fetch instead of an arbitrarily old cached list.
//
//   ⚠ CORRECTION (2026-07-31, crucible): an earlier version of this comment claimed the wake revalidate
//   "pushes fresh URLs into already-mounted <img>s through PhotoImg's initialUrl-change adoption path."
//   That is FALSE, and the falsehood was seeding wrong impact analyses. revalidate() does
//   `data = _sameExceptUrls(cur.data, list) ? cur.data : list` (dataCache.js), so a response that
//   differs ONLY in presigned URLs keeps the PRIOR data reference — the fresh URLs are discarded, the
//   snapshot stays Object.is-equal, nothing re-renders, and initialUrl never changes. That is
//   deliberate and correct (it is what stops a foreground refresh re-downloading the visible
//   screenful) and is pinned by cacheLifecycle.test.jsx "a revalidate returning the same rows with
//   fresh presigns keeps the data ref". Already-mounted images are healed by PhotoImg's OWN wake
//   listener, not by this one. What a list revalidate actually delivers is MEMBERSHIP change plus a
//   refreshed `at` — do not build a value case on URL propagation.
//
// Deliberately NOT done here: threading the cache entry's real age into PhotoImg as an `initialUrlAt`
// prop. That is the correct root fix but it reopens the frozen A1 prop contract across ~13 adopted
// sites.
//
// Everything below is a no-op when IMAGE_LIST_CACHE_ENABLED is off — D-2 must degrade exactly like
// D-1 does, back to plain per-mount fetches.
import { useCallback, useEffect, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'
import * as cache from '../lib/dataCache.js'
import { IMAGE_LIST_CACHE_ENABLED } from '../lib/featureFlags.js'
import { onReconnect } from '../lib/reconnect.js'

// Paths worth warming at boot. ONLY globally-knowable keys belong here: per-planting and per-location
// photo paths depend on a route param nobody has navigated to yet, so warming them would be guesswork
// that costs a request and usually misses.
export const BOOT_WARM_PATHS = ['/api/photos']

// Foreground revalidate is gated on entry age. Below this, a wake is treated as an app-switch glance
// and skipped: visibilitychange fires on every alt-tab, and an ungated version would refetch every
// watched photo list constantly. Above it, the list is old enough that both its membership and its
// 900s presigns are worth refreshing. Chosen under the presign TTL so a resumed tab gets fresh URLs
// BEFORE they expire rather than after.
export const RESUME_MIN_AGE_MS = 5 * 60 * 1000

export function useCacheLifecycle(sub) {
  const { fetch } = useApiFetch()
  const fetchRef = useRef(fetch); fetchRef.current = fetch

  // B3 — boot-warm, once per resolved identity. Gated on `sub` for the same reason useCachedFetch is:
  // nothing may be cached under an absent sub, or a later user could read the previous bucket.
  useEffect(() => {
    if (!IMAGE_LIST_CACHE_ENABLED || !sub) return
    for (const path of BOOT_WARM_PATHS) {
      cache.warm(
        cache.keyFor(sub, path),
        () => fetchRef.current(path).then((d) => (Array.isArray(d) ? d : (d ?? []))),
      )
    }
  }, [sub])

  // B5 — revalidate watched keys on foreground / bfcache restore / Chromium resume. Same three
  // listeners PhotoImg uses, so the list refresh and the per-image proactive re-mint wake together.
  useEffect(() => {
    if (!IMAGE_LIST_CACHE_ENABLED) return
    const onWake = () => {
      if (document.visibilityState === 'hidden') return
      cache.revalidateLive(RESUME_MIN_AGE_MS)
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('pageshow', onWake)
    document.addEventListener('resume', onWake)
    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('pageshow', onWake)
      document.removeEventListener('resume', onWake)
    }
  }, [])

  // B6 — revalidate on reconnect, with the age gate DELIBERATELY BYPASSED (minAgeMs 0).
  //
  // The asymmetry vs B5 is the whole point. visibilitychange is effectively level-triggered — it
  // fires on every alt-tab — so it needs the 5-minute gate or it refetches constantly. `online` is
  // edge-triggered and rare, so gating it re-creates the exact no-op it exists to fix: a failed
  // revalidate never writes `at` (dataCache.js commits `at` only on the SUCCESS branch), so after a
  // 30s outage the entry still carries its last SUCCESSFUL timestamp — age 90s < 300000ms — and
  // RESUME_MIN_AGE_MS would skip precisely the keys that just failed. The data isn't old; the fetch
  // failed. Reusing onWake here would have shipped 3 lines of placebo.
  //
  // ⚠ THAT PREMISE WAS ONLY HALF TRUE UNTIL SW-STALEAPI-001 (2026-07-31, crucible + boss-technical).
  // An offline API fetch does not reject: every /api/* route lives on the Lambda origin and is in the
  // SW's API_CACHE, so public/sw.js answered it from cache as a plain 200. dataCache took the SUCCESS
  // branch and DID write `at` — so an offline failure looked like a fresh fetch, and the B5 gate above
  // then suppressed the next real wake revalidate for a full 5 minutes. B6 masked how bad this was
  // (reconnect ignores the gate), but a wake without an `online` edge — the common outdoor case, where
  // the radio never formally dropped — got nothing. The SW now stamps X-From-Cache, api.js marks the
  // parsed value, and dataCache commits such a response WITHOUT touching `at`. The paragraph above is
  // true again for both flavours of failure; do not re-derive it from the code without that marker in
  // place.
  //
  // No visibilityState guard either: a reconnect while hidden should still refetch, and the cost is
  // bounded at ≤3 requests (the cache holds only photo-list keys).
  //
  // Uses onReconnect() rather than a raw addEventListener('online') — it is the repo's reconnect
  // contract (already shipped in FieldCapture) and carries the SSR + throw guards.
  //
  // KNOWN LIMIT, accepted not fixed: revalidateLive skips any key with a live inFlight, and apiFetch
  // bounds requests at 15s. If `online` fires while a request from the dying connection is still
  // hanging, that key is skipped and not retried until the next wake. Fixing it means cancelling
  // stalled in-flights, which is a dataCache change with its own blast radius.
  useEffect(() => {
    if (!IMAGE_LIST_CACHE_ENABLED) return
    return onReconnect(() => cache.revalidateLive(0))
  }, [])
}

// B4 hook-point. Returns the number of watched keys refreshed. Still has no non-test callers.
//
// ⛔ PULL-TO-REFRESH IS DECIDED — DO NOT BUILD IT. (2026-07-31, 6-panel crucible + boss-technical.)
// Global PTR, photo-scoped PTR, and a "Refresh" row in the BottomNav More menu were all REJECTED.
// The reasons, so this is not re-litigated from zero:
//   · Chrome-on-Android's NATIVE pull-to-refresh is live today (the app sets no global
//     overscroll-behavior) and does a full network-first shell reload. A custom PTR must SUPPRESS
//     it, i.e. consume the one gesture that performs a full recovery and replace it with a 3-key
//     partial refresh. The user cannot then get the full reload back.
//   · This cache covers exactly 3 photo-list keys. Today / Garden / Dashboard / Harvests /
//     Inventory / Findings / Collection / Feed each run their own per-mount fetch and are
//     untouched — a global-looking gesture would change nothing visible on the screens users pull.
//   · A "Refresh" row would collide with UpdateBanner's existing global control of the same name
//     and different meaning (apply the waiting SW + reload).
//   · Suppressing native PTR inline on <body> is silently undone by Sheet's scroll-lock restore,
//     which writes the SHORTHAND overscrollBehavior — open+close any sheet and both gestures are
//     live at once.
//
// RE-OPEN GATE — reconsider ONLY if ALL FIVE hold. Each is one command. If any is false, stop.
//   G1 coverage:    `grep -rl useCachedFetch src/pages src/components | grep -v __tests__` ≥ 8 (today 3)
//   G2 testability: playwright or puppeteer in devDependencies AND ≥1 touch-gesture spec in CI.
//                   jsdom cannot compute overscroll-behavior/touch-action, stubs scrollTo, and has
//                   no touch pipeline — PTR's defining behavior is unassertable today.
//   G3 host frame:  `grep -rl PageShell src/pages | wc -l` ≥ 35 of 44 (today 0)
//   G4 primitive:   refreshAll contains no _store.delete (done) AND an outcome-reporting variant
//                   exists whose result distinguishes all-success from all-failure.
//   G5 demand:      Dave asked, or a reach-for-refresh behavior is documented. G1–G4 are necessary,
//                   never sufficient.
//
// Also rejected: making this promise-returning. revalidate()'s exec attaches both handlers inline so
// it ALWAYS fulfills — a Promise.all over those resolves identically whether every fetch succeeded or
// every one failed, so a spinner timed on it would report success 100% of the time. An honest version
// is a NEW refreshAllSettled() over promises that actually reject; do not change invalidate()'s
// contract to get there (it reaches invalidatePrefix → useUploadPhoto + PhotoLibrary).
export function useRefreshAll() {
  return useCallback(() => (IMAGE_LIST_CACHE_ENABLED ? cache.refreshAll() : 0), [])
}
