import { saveTodaySkipped } from '../../lib/notificationPrefsClient.js'

// careStore — the Today care list's MODULE-SCOPE state: the page's one skip set, the Undo veto set and
// the queued server sync. Moved verbatim out of CareNeeded.jsx (V5-TODAYREDESIGN-001 S1) so every list
// that shows care — V1's two CareNeeded instances, and the V2 Today after them — reads and writes the
// SAME set. Nothing here is React: a list subscribes through useSyncExternalStore (useCareActions.js),
// and an Undo raised by a toast that outlives Today writes here directly.

export function todayLocalISO() {
  const d = new Date()
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

// Per-day suppress set (suppress-for-today). V4-TODAYLOC-002 / V4-USERPREFS-001 closed the two
// halves this comment used to defer.
//
// localStorage, NOT sessionStorage. The row was filed as a CROSS-DEVICE gap, but sessionStorage
// made it a same-device one too: the set died with the tab, so skipping a watering row in the
// garden and coming back minutes later showed it again. That is the failure Dave actually
// reported. localStorage is the offline-durable local layer; the server sync below is the
// cross-device one. Still keyed by date, so it self-empties on a new day exactly as before.
//
// LOCAL IS AUTHORITATIVE ON WRITE, ALWAYS. Every skip lands here first and synchronously — the
// server call is fire-and-forget after the fact. A skip made standing in a dead spot in the garden
// must behave identically to one made on wifi.
//
// ONE SET PER PAGE, NOT ONE PER LIST (BUG-TODAYHOUSEHOLDSKIPCLOBBER-001). Today mounts a CareNeeded
// for Dave's own care and another for the rest of the household, and both write this one key and the
// one per-user server column. Each list used to keep the set in its own React state, read once at
// mount, and write THAT whole — so a skip in one list erased the other list's skips from storage and
// from the server, and the erased plant came back on the next visit. A list mounted later (the
// household toggle) also held a stale copy that re-published a skip Dave had since undone.
//
// So the set lives here, at module scope, and every list reads it through useSyncExternalStore
// (subscribeSkipped/skippedSnapshot). Every write starts from the shared set (readSkipped), and
// writeSkipped notifies every mounted list, so the two lists agree on screen without a reload — and an
// Undo raised by a list that has since unmounted still repaints the list now on screen. Chosen over
// "re-read storage before each write" because that fixes the stored set but leaves each list's screen
// state private, so a plant in both lists, or an Undo after a remount, still disagrees until reload.
//
// localStorage stays the durable copy and the snapshot re-reads it on every render, so anything that
// changes the key outside this module (sign-out's clearClientPrefs, a test) is picked up on each list's
// NEXT render — not at once: nothing notifies the lists of a change they did not make. The only thing
// held in memory alone is a write localStorage refused (quota, blocked storage): it stays visible, as
// the old per-list state did, until storage changes under it or the LAST list unmounts (not any list:
// the household toggle unmounts one while the other stays up) — the reset in subscribeSkipped, which
// also keeps it from outliving the session into the next sign-in.
export function skipKeyName() { return 'today-skipped:' + todayLocalISO() }
function storedSkipRaw(name) {
  try { return localStorage.getItem(name) } catch { return null }
}
const NO_SKIP_MEM = Object.freeze({ name: null, raw: null, set: new Set() })
let skipMem = NO_SKIP_MEM
const skipListeners = new Set()
// The useSyncExternalStore snapshot. Must return the SAME Set while nothing changed (React re-renders
// forever otherwise) and a NEW one on any change (React drops the update otherwise), so it is keyed on
// the raw stored string. Treat the result as frozen: callers that edit take readSkipped()'s copy.
export function skippedSnapshot() {
  const name = skipKeyName()
  const raw = storedSkipRaw(name)
  if (skipMem.name === name && skipMem.raw === raw) return skipMem.set
  let set
  try { set = new Set(JSON.parse(raw || '[]')) } catch { set = new Set() }
  skipMem = { name, raw, set }
  return set
}
export function subscribeSkipped(fn) {
  skipListeners.add(fn)
  return () => {
    skipListeners.delete(fn)
    if (skipListeners.size === 0) skipMem = NO_SKIP_MEM
  }
}
// A private copy of the shared set — the only thing a write may start from.
export function readSkipped() { return new Set(skippedSnapshot()) }
export function writeSkipped(set) {
  const name = skipKeyName()
  let raw = JSON.stringify([...set])
  // Refused: remember what storage still holds, so the snapshot keeps this set only until that changes.
  try { localStorage.setItem(name, raw) } catch { raw = storedSkipRaw(name) }
  skipMem = { name, raw, set }
  for (const fn of [...skipListeners]) fn()
}

// BUG-TODAYSKIPNOUNDO-001 — keys UN-skipped on this device today, i.e. Skip's Undo.
//
// The mount-time merge (useCareActions) UNIONS the server's set into the local one. While the set
// could only grow within a day, a union could never be wrong. With Undo it can: undo a skip while the
// server still holds the older snapshot — the Undo's own sync failed in a dead spot, lost the race with
// the skip's sync, or has not landed when Today remounts a second later — and the union puts the key
// straight back, silently hiding the plant again after Dave undid it. A key in this set is never
// re-added from the server today. Same date-keyed, self-expiring shape as the skip set above.
export function unskipKeyName() { return 'today-unskipped:' + todayLocalISO() }
export function readUnskipped() {
  try { return new Set(JSON.parse(localStorage.getItem(unskipKeyName()) || '[]')) }
  catch { return new Set() }
}
export function writeUnskipped(set) {
  try { localStorage.setItem(unskipKeyName(), JSON.stringify([...set])) } catch { return }
}

// ONE server sync per Undo tap (BUG-TODAYSKIPNOUNDO-001 review). A coalesced skip toast's Undo runs
// every accumulated handler in one synchronous loop (ToastContext's onUndo), and each handler used to
// fire its own whole-set PATCH. Concurrent, fire-and-forget and keepalive: arrival order decided the
// server snapshot, and at the live set size (~10 KB a body) a handful of them overrun the 64 KiB
// keepalive quota, so the one carrying the correct final set was the likeliest to be refused. Every
// handler now only asks for a sync; the first ask queues a microtask, which runs after the last
// handler in that loop and sends the shared set (above) as it then stands.
//
// Module scope, never component state: the toast outlives Today, so this has to fire with Today
// unmounted. Both CareNeeded instances on the household lens share the one localStorage key and the
// one signed-in user, so one flush serves both.
let unskipSyncQueued = false
let unskipSyncGetToken = null
export function queueUnskipSync(getToken) {
  unskipSyncGetToken = getToken
  if (unskipSyncQueued) return
  unskipSyncQueued = true
  queueMicrotask(() => {
    unskipSyncQueued = false
    const gt = unskipSyncGetToken
    unskipSyncGetToken = null
    saveTodaySkipped({ getToken: gt, date: todayLocalISO(), keys: [...readSkipped()] })
  })
}

// Skip every key in `keys` (any iterable of row keys) with ONE local write and ONE server sync — a
// row's Skip is this with one key, and plan-v2's "Not today" is this with a whole spot. Nothing to
// skip: nothing written, nothing sent.
//
// From the shared set as it stands now, never from a copy a list holds: the household list writes the
// same key and the same server column (BUG-TODAYHOUSEHOLDSKIPCLOBBER-001).
export function skipMany(keys, getToken) {
  const list = [...keys]
  if (!list.length) return
  const n = readSkipped()
  for (const k of list) n.add(k)
  writeSkipped(n)
  // V4-TODAYLOC-002 — fire-and-forget cross-device sync, AFTER the local write. Deliberately
  // not awaited and deliberately not error-handled here: saveTodaySkipped never throws and the
  // skip is already applied locally, so a dead network costs nothing but the sync. Sends the
  // WHOLE set rather than a delta — the column is a snapshot, the set is small, and a
  // last-write-wins snapshot cannot half-apply the way an append protocol can drop one entry.
  saveTodaySkipped({ getToken, date: todayLocalISO(), keys: [...n] })
  // Skipping again after an Undo is a fresh decision, so this device stops vetoing the key on merge.
  const u = readUnskipped()
  let vetoLifted = false
  for (const k of list) if (u.delete(k)) vetoLifted = true
  if (vetoLifted) writeUnskipped(u)
}

// BUG-TODAYSKIPNOUNDO-001 — Skip's Undo, for every key in `keys`. Same order as skipMany: the local
// write first and synchronously, then the fire-and-forget sync, which still sends the WHOLE set (the
// column is a snapshot) — but queued, so a coalesced Undo of N skips sends ONE sync, not N
// (queueUnskipSync). Each undone key joins the veto set above, so a stale server snapshot cannot
// re-hide it today.
//
// Writes the SHARED set directly, never through React state, on purpose: the toast layer lives at the
// app root and outlives Today, so this has to be true whether or not any list is still mounted —
// localStorage is what the next mount reads, and writeSkipped repaints whichever lists ARE mounted.
export function unskipMany(keys, getToken) {
  const list = [...keys]
  if (!list.length) return
  const n = readSkipped()
  for (const k of list) n.delete(k)
  writeSkipped(n)
  const u = readUnskipped()
  for (const k of list) u.add(k)
  writeUnskipped(u)
  queueUnskipSync(getToken)
}
