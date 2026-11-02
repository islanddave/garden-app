// useDailyPlan — fetch hook for GET /api/daily-plan.
// Contract: { data, loading, refreshing, seedPending, error, reload, refresh }
//   data: { schema_version, plan_date, generated_at, has_plan, plan } | null
//     plan (when has_plan): { weather, hydrology, substrate, counts,
//                             water_due[], no_history[], fertilize[], pest[], cold[], dormant[] }
// Mirrors useFindings (load-counter guards against out-of-order responses).
//
// TWO fetch modes, because they have opposite failure requirements.
//
// `reload` (INITIAL) sets `loading`, clears `error`, and is what the mount effect and an
// includeHousehold change call. It never clears `data`; what `loading` hides is each consumer's call.
// src/pages/TodayV2.jsx shows its loading/error region only while it has no plan yet
// (`!data && (loading || error)`) and counts `!loading` toward its ready point;
// src/components/findings/TodayReasoning.jsx renders nothing while `loading`. So this mode is allowed
// to blank a consumer that gates on `loading` — there is nothing on it yet.
//
// `refresh` (REVALIDATE) is the intraday path, and it must NEVER blank the screen. Calling `reload`
// on focus/visibilitychange would set loading=true, which tears down whatever a consumer gates on
// `loading` (TodayReasoning unmounts its card), and any in-memory list state held under such a gate
// dies with it — grouping mode, manual expand/collapse, the "Show N more" state, an open bulk sheet
// and its hand-checked subset, in-flight pending rows, and the scroll position of a ~200-row list the
// user is physically walking. So `refresh` holds `data` and reports through `refreshing` instead.
//
// STALE ROWS BEAT BLANK ROWS. On a refresh failure we keep the last good plan and do NOT set `error`
// — the same rule src/lib/useAmbientBandFetch.js applies, for the same reason: this app
// treats rural dead zones as normal operating conditions, and replacing a complete, still-actionable
// watering list with a red one-line string because one revalidation timed out is a strictly worse
// answer than showing slightly older truth. `error` stays reserved for the never-loaded case.
//
// The in-flight guard is a ref, not state, so it cannot cause a render or go stale in a closure
// (house pattern, as in TodayBand.jsx and useAmbientBandFetch.js). It matters here because Android
// fires BOTH `focus` and `visibilitychange` on a single wake, which without it is two concurrent
// fetches per wake.
//
// The wake listeners (`focus`, `visibilitychange`) are registered by this hook, so a plan left open
// on Today and resumed hours later is revalidated: the server regenerates the plan hourly, which
// buys nothing if the client never asks for it again.
//
// The listeners live HERE, not in the consumer (TodayV2.jsx), because `refresh`'s identity is deliberately stabilised
// in this file (see hasDataRef below) so registration survives a successful fetch. A consumer wiring
// its own listener would re-derive that guarantee and eventually get it wrong.
//
// The in-flight guard must not coalesce a call asking a DIFFERENT question. A caller's
// includeHousehold can flip while the first plan request is still open (derived from a roster that
// lands late, e.g. showOthers && canShowOthers on a cold launch or sign-in; TodayV2 passes a constant
// `true` today, so useDailyPlan.trailingRun.test.jsx is what pins this): the reload that flip asks
// for hits the guard, and since `run` closes over includeHousehold nothing would ask again — the
// page would show the old question's answer until the next wake. So a
// settling request compares the question it asked (fetch + includeHousehold) with the one the
// latest commit asks, and if they differ ONE trailing run asks the current one. The same question still coalesces: the Android double wake, and StrictMode's double
// mount effect in dev, stay one request each, and a question changed and changed back mid-flight is
// already answered by the open request. The trailing run never blanks a plan on screen: it is a
// refresh once a plan has been shown (so STALE ROWS BEAT BLANK ROWS covers its failure), and an
// initial load when none has.
//
// An OPT-IN `seed`, absent for callers that do not pass it (TodayReasoning.jsx), which
// therefore get no seeding. A caller passing `seed` (TodayV2.jsx passes the signed-in user's id) gets the module-level last good plan for the same user + question on a remount, when that
// plan is TODAY's: it paints at once with `loading` false, and the mount fetch runs as a REFRESH (loading
// never flips on, a failure keeps the seeded plan). So Back to the redesigned Today paints the page it
// left, under the page-scroll manager's restore, instead of a "Loading…" frame. Another user never reads
// it (keyed by id), yesterday's plan is never painted as today's, and a successful fetch replaces it.
//
// `seedPending`: true from a SEEDED mount until its first fetch settles. A seed is the plan as read
// BEFORE the page was left, so a watering logged elsewhere meanwhile (a planting's own Water, then
// Back) is still due in it; a caller holds its write controls over that window. False on every
// unseeded mount.
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
  // The question the latest commit asks (its fetch + includeHousehold)
  // and the `run` that asks it; null once unmounted, so a request settling after that starts nothing.
  const latestRef = useRef(null)
  // Seed: whether this mount painted a seed (its first fetch is then a refresh), and whose store a good
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
      // The question changed while this request was open. ONE trailing
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

  // Wake revalidation. Both events, because Android
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
