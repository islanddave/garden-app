// needsCareStore — the two tab-scoped stores the redesigned Needs care keeps (V5-TODAYREDESIGN-001 S4;
// plan-v2 §2.1 Layer 2 "day-scoped, visit-independent"). sessionStorage, like the visit record: they belong
// to this tab, never outlive it, and sign-out scrubs both families (clientPrefs.js CLIENT_SESSION_KEY_PREFIXES).
//
//   'today-logged:<user>:<plan_date>'  row keys logged today and not undone. A Back remount paints from the
//        last good plan (useDailyPlan's seed) before the refetch lands, and that plan still calls those rows
//        due: without this the done work reappears live under Dave's thumb and a second tap logs it twice
//        (§6.3). Written as each write lands, un-written on Undo; other days are pruned on write.
//        CONFIRMED logs only: a key goes in when its POST has answered, never before.
//   'today-filters:<user>'  the task and spot chip selection {plan_date, tasks, spots}, per session (§2.6).
//        A new plan day starts with no filter; spots no longer on the list are dropped on read.
//
// And two IN MEMORY, at module scope (review 4162.1 IMPORTANT-A, re-cut after its pre-promote pass):
//   claims  per today-logged key, the row keys a write has taken and whose POST has not answered. A claim is a
//        promise only this page's JavaScript can keep, so it lives exactly as long as that JavaScript: a Back
//        remount shares the module and leaves the claimed rows out (a run still posting is never offered again);
//        a full reload drops the module, and what was never sent is due again. In sessionStorage a claim outlived
//        the only code that could send or release it, and hid a plant nobody logged for the rest of the plan day.
//   runs    per run id: still going, or ended with a result no mounted list has taken yet. A run outlives the
//        page that started it (keepalive); its result is parked here until the list now on screen takes it.
// Every change to the store, the claims or the runs raises one signal (subscribeLogged / loggedVersion), so a
// release reaches whatever list is mounted — not only the next one to mount.
const LOGGED = 'today-logged:'
const FILTERS = 'today-filters:'
const enc = (s) => encodeURIComponent(String(s))
const NONE = new Set()

const claims = new Map()
const runs = new Map()
const subs = new Set()
let version = 0
const changed = () => { version++; for (const fn of [...subs]) fn() }
export const subscribeLogged = (fn) => { subs.add(fn); return () => { subs.delete(fn) } }
export const loggedVersion = () => version
// Test seam, as useDailyPlan's __resetDailyPlanSeed: module state outlives a test case.
export function __resetTodayLogged() { claims.clear(); runs.clear(); version++ }

export const loggedKey = (userId, planDate) => (userId && planDate ? LOGGED + enc(userId) + ':' + enc(planDate) : null)

export function readLogged(key) {
  if (!key) return new Set()
  try { const v = JSON.parse(sessionStorage.getItem(key) || '[]'); return new Set(Array.isArray(v) ? v.filter((k) => typeof k === 'string') : []) } catch { return new Set() }
}

function writeLogged(key, set) {
  if (!key) return
  try {
    if (set.size) sessionStorage.setItem(key, JSON.stringify([...set]))
    else sessionStorage.removeItem(key)
    const day = key.slice(LOGGED.length).split(':')[1]
    const stale = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(LOGGED) && k.slice(LOGGED.length).split(':')[1] !== day) stale.push(k)
    }
    for (const k of stale) sessionStorage.removeItem(k)
  } catch { /* storage blocked: the refetch's done annotation still hides them, one round trip later */ }
}

export function addLogged(key, keys) {
  const s = readLogged(key)
  let added = false
  for (const k of keys) if (!s.has(k)) { s.add(k); added = true }
  if (added) { writeLogged(key, s); changed() }
}

export function removeLogged(key, keys) {
  const s = readLogged(key)
  let removed = false
  for (const k of keys) if (s.delete(k)) removed = true
  if (removed) { writeLogged(key, s); changed() }
}

// ── claims: taken, not yet answered ───────────────────────────────────────────────────────────────────────
export const claimedKeys = (key) => claims.get(key) || NONE

export function claimKeys(key, keys) {
  if (!key || !keys.length) return
  const s = new Set(claims.get(key))
  for (const k of keys) s.add(k)
  claims.set(key, s)
  changed()
}

function unclaim(key, keys) {
  const cur = claims.get(key)
  if (!cur) return false
  const s = new Set(cur)
  let dropped = false
  for (const k of keys) if (s.delete(k)) dropped = true
  if (!dropped) return false
  if (s.size) claims.set(key, s); else claims.delete(key)
  return true
}

// The POST failed (or was never sent): the row is due again, on whatever list is mounted.
export function releaseKeys(key, keys) { if (unclaim(key, keys)) changed() }

// The POST answered: the claim becomes a log, stored before the claim goes — no reader sees the key in neither.
// No signal per landing: a list that left the key out as a claim leaves it out as a log, so nothing it draws moves.
// One when the key's last claim is answered, for what counts the store ("N logged today").
export function confirmKeys(key, keys) {
  if (!key || !keys.length) return
  const s = readLogged(key)
  let added = false
  for (const k of keys) if (!s.has(k)) { s.add(k); added = true }
  if (added) writeLogged(key, s)
  if (unclaim(key, keys) ? !claims.has(key) : added) changed()
}

// ── runs: going, or ended and waiting for a mounted list ──────────────────────────────────────────────────
export function runStart(id) { runs.set(id, { going: true }); changed() }
// `result` is kept for a list to take (a run that ended with its own list unmounted); none = forget the run.
export function runEnd(id, result) {
  if (result) runs.set(id, { going: false, ...result }); else runs.delete(id)
  changed()
}
export const runGoing = (id) => !!runs.get(id)?.going
export function runTake(id) {
  const r = runs.get(id)
  if (!r || r.going) return null
  runs.delete(id)
  return r
}
// Ended runs parked for one list (Protect, which keeps no batch on the record for a run to be found by).
export const runsEnded = (list) => [...runs].filter(([, r]) => !r.going && r.list === list)

export const filtersKey = (userId) => (userId ? FILTERS + enc(userId) : null)

export function readFilters(key, planDate) {
  if (!key) return { tasks: [], spots: [] }
  try {
    const v = JSON.parse(sessionStorage.getItem(key) || 'null')
    if (!v || v.plan_date !== planDate) return { tasks: [], spots: [] }
    return { tasks: Array.isArray(v.tasks) ? v.tasks : [], spots: Array.isArray(v.spots) ? v.spots : [] }
  } catch { return { tasks: [], spots: [] } }
}

export function writeFilters(key, planDate, { tasks, spots }) {
  if (!key) return
  try { sessionStorage.setItem(key, JSON.stringify({ plan_date: planDate, tasks: [...tasks], spots: [...spots] })) } catch { /* per-session nicety only */ }
}
