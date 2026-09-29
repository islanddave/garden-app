// needsCareStore — the two tab-scoped stores the redesigned Needs care keeps (V5-TODAYREDESIGN-001 S4;
// plan-v2 §2.1 Layer 2 "day-scoped, visit-independent"). sessionStorage, like the visit record: they belong
// to this tab, never outlive it, and sign-out scrubs both families (clientPrefs.js CLIENT_SESSION_KEY_PREFIXES).
//
//   'today-logged:<user>:<plan_date>'  row keys logged today and not undone. A Back remount paints from the
//        last good plan (useDailyPlan's seed) before the refetch lands, and that plan still calls those rows
//        due: without this the done work reappears live under Dave's thumb and a second tap logs it twice
//        (§6.3). Written as each write lands, un-written on Undo; other days are pruned on write.
//   'today-filters:<user>'  the task and spot chip selection {plan_date, tasks, spots}, per session (§2.6).
//        A new plan day starts with no filter; spots no longer on the list are dropped on read.
const LOGGED = 'today-logged:'
const FILTERS = 'today-filters:'
const enc = (s) => encodeURIComponent(String(s))

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
  let changed = false
  for (const k of keys) if (!s.has(k)) { s.add(k); changed = true }
  if (changed) writeLogged(key, s)
}

export function removeLogged(key, keys) {
  const s = readLogged(key)
  let changed = false
  for (const k of keys) if (s.delete(k)) changed = true
  if (changed) writeLogged(key, s)
}

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
