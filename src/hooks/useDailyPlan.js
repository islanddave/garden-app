// useDailyPlan — fetch hook for GET /api/daily-plan (DRG-TODAY-002 read model).
// Contract: { data, loading, refreshing, seedPending, error, reload, refresh }
//   data: { schema_version, plan_date, generated_at, has_plan, plan } | null
//     plan (when has_plan): { weather, hydrology, substrate, counts,
//                             water_due[], no_history[], fertilize[], pest[], cold[], dormant[] }
// Mirrors useFindings (load-counter guards against out-of-order responses).
//
// DRG-INTRADAY-002 — TWO fetch modes, because they have opposite failure requirements.
//
// `reload` (INITIAL) is unchanged, byte-for-byte in behaviour: it sets `loading`, clears `error`, and
// is what the mount effect and an includeHousehold toggle call. Today.jsx gates the whole plan block
// on `!loading && !error`, so this mode is allowed to blank the screen — there is nothing on it yet.
//
// `refresh` (REVALIDATE) is the intraday path, and it must NEVER blank the screen. Calling `reload`
// on focus/visibilitychange was the original DRG-INTRADAY-002 proposal and it is a full teardown: it
// sets loading=true, Today.jsx then unmounts <CareNeeded>, and every piece of in-memory list state
// dies with it — grouping mode, manual expand/collapse, the "Show N more" state, an open bulk sheet
// and its hand-checked subset, in-flight pending rows, and the scroll position of a ~200-row list the
// user is physically walking. So `refresh` holds `data` and reports through `refreshing` instead.
//
// STALE ROWS BEAT BLANK ROWS. On a refresh failure we keep the last good plan and do NOT set `error`
// — the same rule src/lib/useAmbientBandFetch.js:18-20 already applies, for the same reason: this app
// treats rural dead zones as normal operating conditions, and replacing a complete, still-actionable
// watering list with a red one-line string because one revalidation timed out is a strictly worse
// answer than showing slightly older truth. `error` stays reserved for the never-loaded case.
//
// The in-flight guard is a ref, not state, so it cannot cause a render or go stale in a closure
// (house pattern — TodayBand.jsx:48, useAmbientBandFetch.js:48). It matters here because Android
// fires BOTH `focus` and `visibilitychange` on a single wake, which without it is two concurrent
// fetches per wake.
//
// BUG-PLANNOREVALIDATE-001 (2026-09-13) — the listeners the block above describes DID NOT EXIST.
// `refresh` was exported and called by NOBODY: Today.jsx destructured only { data, loading, error },
// and neither it nor this hook registered `focus` or `visibilitychange`. So the plan was fetched once
// per Today mount and never revalidated — leave the PWA open on Today and resume hours later and you
// were reading whatever was current when you opened it. Every other piece of DRG-INTRADAY-002 shipped
// (the two fetch modes, the coalescing ref, stale-beats-blank, the stable `refresh` identity); only
// the registration was missing, which is why it was invisible — nothing was broken, a thing simply
// never ran. Found while making the daily-plan cron hourly: 16 extra server-side generations a day
// buy nothing if the client never asks for them again.
//
// The listeners live HERE, not in Today.jsx, because `refresh`'s identity is deliberately stabilised
// in this file (see hasDataRef above) so registration survives a successful fetch. A consumer wiring
// its own listener would re-derive that guarantee and eventually get it wrong.
//
// BUG-TODAYHOUSEHOLDRELOADDROP-001 (2026-09-28) — the in-flight guard coalesced EVERY call, including
// one asking a different question. Today asks with includeHousehold = showOthers && canShowOthers, and
// on a cold roster (launch or sign-in, toggle saved ON) the members land while the first plan request
// is still open: the reload that flip asked for hit the guard and was dropped, and since `run` closes
// over includeHousehold nothing asked again. Today showed the toggle ON over "No one else has care
// needs today." until the next wake. Now a settling request compares the question it asked (fetch +
// includeHousehold) with the one the latest commit asks, and if they differ ONE trailing run asks the
// current one. The same question still coalesces: the Android double wake, and StrictMode's double
// mount effect in dev, stay one request each, and a question changed and changed back mid-flight is
// already answered by the open request. The trailing run never blanks a plan on screen: it is a
// refresh once a plan has been shown (so STALE ROWS BEAT BLANK ROWS covers its failure), and an
// initial load when none has.
//
// V5-TODAYREDESIGN-001 S2 — an OPT-IN `seed` (plan-v2 §6.3), absent for every existing caller (Today.jsx,
// TodayReasoning.jsx), which therefore behave exactly as before. A caller passing `seed` (the signed-in
// user's id) gets the module-level last good plan for the same user + question on a remount, when that
// plan is TODAY's: it paints at once with `loading` false, and the mount fetch runs as a REFRESH (loading
// never flips on, a failure keeps the seeded plan). So Back to the redesigned Today paints the page it
// left, under the page-scroll manager's restore, instead of a "Loading…" frame. Another user never reads
// it (keyed by id), yesterday's plan is never painted as today's, and a successful fetch replaces it.
//
// `seedPending` (review 4160.2 IMPORTANT-2, V5-TODAYREDESIGN-001 integration 2): true from a SEEDED mount until its
// first fetch settles. A seed is the plan as read BEFORE the page was left, so a watering logged elsewhere meanwhile
// (a planting's own Water, then Back) is still due in it; a caller holds its write controls over that window. False
// on every unseeded mount, so the existing callers never see it change.
import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'
import { todayLocalISO } from '../lib/dateLocal.js'

// Floor between wake-triggered revalidations. `focus` is noisier than it looks on Android — a
// dismissed keyboard or a permission sheet fires it — and the in-flight ref only coalesces
// CONCURRENT wakes, not a rapid sequence of settled ones. 60s is two orders of magnitude below the
// hourly generation cadence, so this costs nothing in freshness and removes the app-switch storm.
// Deliberately NOT applied to `refresh` itself: an explicit caller asked, and gets a fetch.
const REVALIDATE_MIN_MS = 60_000

// The seed store: last good envelope per user + question. Module scope so it outlives the page's unmount.
const lastGood = new Map()
const seedKeyOf = (seed, includeHousehold) => (typeof seed === 'string' && seed ? `${seed}|${includeHousehold ? 'household' : 'own'}` : null)
function readSeed(seed, includeHousehold) {
  const k = seedKeyOf(seed, includeHousehold)
  const d = k ? lastGood.get(k) : null
  return d && d.plan_date === todayLocalISO() ? d : null
}
// Test seam, as __resetPrefsFlight: module state outlives a test case.
export function __resetDailyPlanSeed() { lastGood.clear() }

export function useDailyPlan({ includeHousehold = false, seed } = {}) {
  const { fetch } = useApiFetch()
  const [seeded] = useState(() => readSeed(seed, includeHousehold))
  const [data, setData] = useState(seeded)
  const [loading, setLoading] = useState(!seeded)
  const [refreshing, setRefreshing] = useState(false)
  const [seedPending, setSeedPending] = useState(!!seeded)
  const [error, setError] = useState(null)
  const loadCounterRef = useRef(0)
  const inflightRef = useRef(false)
  // When the last fetch SETTLED (success or failure), for the REVALIDATE_MIN_MS floor. Stamped on
  // settle rather than on start so a run of failures in a dead zone cannot busy-loop the radio.
  const lastSettledAtRef = useRef(0)
  // Tracks "we have shown a real plan at least once" WITHOUT reading `data` in the callback, which
  // would put `data` in the useCallback deps and change `refresh`'s identity on every successful
  // fetch — re-registering the focus/visibility listeners each time.
  const hasDataRef = useRef(!!seeded)
  // BUG-TODAYHOUSEHOLDRELOADDROP-001 — the question the latest commit asks (its fetch + includeHousehold)
  // and the `run` that asks it; null once unmounted, so a request settling after that starts nothing.
  const latestRef = useRef(null)
  // S2 seed: whether this mount painted a seed (its first fetch is then a refresh), and whose store a good
  // answer refreshes. A ref, so a user id landing after mount never changes `run` and never re-fetches.
  const seededRef = useRef(!!seeded)
  const seedRef = useRef(seed)
  seedRef.current = seed

  const run = useCallback(async (isRefresh) => {
    // Coalesce: a second wake while one request is open is a no-op, not a competing chain. A call
    // asking a DIFFERENT question is not lost here: the finally below asks it once this one settles.
    if (inflightRef.current) return
    inflightRef.current = true
    const my = ++loadCounterRef.current
    if (isRefresh) setRefreshing(true)
    else { setLoading(true); setError(null) }
    try {
      const d = await fetch(includeHousehold ? '/api/daily-plan?include=household' : '/api/daily-plan')
      if (loadCounterRef.current !== my) return
      setData(d)
      hasDataRef.current = true
      setError(null)
      const sk = seedKeyOf(seedRef.current, includeHousehold)
      if (sk && d) lastGood.set(sk, d)
    } catch (err) {
      if (loadCounterRef.current !== my) return
      // Only an initial load — or a refresh that has never had data to fall back on — may surface an
      // error. A failed revalidation over a good plan is silent by design (see header).
      if (!isRefresh || !hasDataRef.current) setError(err?.message ?? 'Failed to load your plan')
    } finally {
      if (loadCounterRef.current === my) { setLoading(false); setRefreshing(false); setSeedPending(false) }
      lastSettledAtRef.current = Date.now()
      inflightRef.current = false
      // BUG-TODAYHOUSEHOLDRELOADDROP-001 — the question changed while this request was open. ONE trailing
      // run, with the latest commit's args: a refresh if a plan has been shown, else an initial load.
      const latest = latestRef.current
      if (latest && (latest.fetch !== fetch || latest.includeHousehold !== includeHousehold)) latest.run(hasDataRef.current)
    }
  }, [fetch, includeHousehold])

  // Layout, not passive: set at commit, so a request settling before the passive effects flush still
  // sees the new question (and the reload effect below then finds it in flight and coalesces).
  useLayoutEffect(() => {
    latestRef.current = { fetch, includeHousehold, run }
    return () => { latestRef.current = null }
  }, [fetch, includeHousehold, run])

  const reload  = useCallback(() => run(false), [run])
  const refresh = useCallback(() => run(true),  [run])

  useEffect(() => {
    // A seeded mount revalidates instead of loading: the seed is already on screen and must not blank.
    if (seededRef.current) { seededRef.current = false; run(true); return }
    reload()
  }, [reload, run])

  // BUG-PLANNOREVALIDATE-001 — the missing half of DRG-INTRADAY-002. Both events, because Android
  // fires them inconsistently: `visibilitychange` on app switch, `focus` on window re-focus within
  // the app, and frequently both on one wake (which inflightRef coalesces).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onWake = () => {
      // A `visibilitychange` also fires when going AWAY. Only a wake should revalidate.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (Date.now() - lastSettledAtRef.current < REVALIDATE_MIN_MS) return
      refresh()
    }
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [refresh])

  return { data, loading, refreshing, seedPending, error, reload, refresh }
}
