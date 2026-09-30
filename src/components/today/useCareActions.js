import { useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore } from 'react'
import { NEED_LABEL, MOISTURE_CHECK_EVENT, candidateRows } from '../../lib/careNeeded.js'
import { fetchNotificationPrefs, readTodaySkipped } from '../../lib/notificationPrefsClient.js'
import {
  todayLocalISO, subscribeSkipped, skippedSnapshot, readSkipped, writeSkipped, readUnskipped,
  skipMany, unskipMany,
} from './careStore.js'

// useCareActions — one care list's state and write paths, moved out of CareNeeded.jsx
// (V5-TODAYREDESIGN-001 S1) so the V2 Today and the household list can share them. A MOVE, not a
// rewrite: CareNeeded is the first consumer and behaves exactly as it did.
//
// Owns, per mounted list: the optimistic fades (`logged`), the in-flight guards (pendingKeys,
// writeInFlightRef, bulkInFlightRef, bulkProgress), this list's view of the page's one skip set
// (careStore.js) and its once-per-mount server merge, and the one-tap / moist / skip / bulk writes
// with their undo. Does not own which rows exist (careNeeded.js buildCareNeeded — the caller passes
// them as `allRows`) or how they are laid out (the caller).
//
// One-tap log goes through the IDENTICAL Log-form write path (POST /api/events) so the events Lambda
// side effects (critter award + entity_memory.next_water_at) fire; undo soft-deletes.
//
// Arguments: `allRows` = buildCareNeeded(plan); `bedWait` = bedWaitActive(plan); `planDate` = the plan
// envelope's plan_date; `fetch`/`getToken` = useApiFetch()'s; `toast` = useOptionalToast(); `announce`
// writes the caller's polite live region; `onBulkEnd` runs where a bulk run ends or finds nothing to
// log (V1 closes its chooser sheet there).

const NOOP = () => {}

// `eventType` overrides the row's primary type — the moisture check posts through this same body so
// the two writes cannot drift in shape. Omitted => the row's own mapped type, as before.
export function eventBody(row, eventType) {
  return {
    project_id: row.projectId, event_type: eventType || row.eventType, event_date: todayLocalISO(),
    plant_id: row.plantingId, is_public: true, has_photo: false,
    notes: null, private_notes: null, quantity: null, metadata: null,
  }
}

export function useCareActions({ allRows, bedWait, planDate, fetch, getToken, toast, announce, onBulkEnd = NOOP }) {
  // Optimistic local drop (V3-TODAYDONE parity): row key -> event_date of the write that faded it.
  const [logged, setLogged] = useState(() => new Map())
  const [pendingKeys, setPendingKeys] = useState(() => new Set())
  // The page's one skip set (BUG-TODAYHOUSEHOLDSKIPCLOBBER-001), shared with the household list.
  const skipped = useSyncExternalStore(subscribeSkipped, skippedSnapshot)

  // V4-TODAYLOC-002 — pull the other device's skips in once on mount, UNIONED into the local set.
  //
  // UNION, NOT REPLACE, and the direction matters. Replacing local with server would erase a skip
  // made moments ago offline on this phone the instant a stale server value arrived. Union is also
  // the correct merge for what this set actually is: within a single day it only ever grows, and
  // the two devices are both appending to it. The cost of union is that an un-skip cannot
  // propagate.
  //
  // BUG-TODAYSKIPNOUNDO-001 added the un-skip (Skip's Undo) and revisited this merge, as the note
  // that stood here asked. On THIS device an undone key is vetoed (readUnskipped), so a stale server
  // snapshot cannot re-hide a plant Dave just brought back. ACROSS devices it still cannot propagate:
  // a second device that already pulled the key keeps it, and its next skip re-publishes it. Fixing
  // that needs tombstones on the server — a wire change — and the set is per user, so it only bites
  // someone who skips on one device and undoes on another.
  //
  // Writes the merged set back to localStorage so the union survives the next cold start even if
  // the network is gone by then. Best-effort throughout: fetchNotificationPrefs never throws and
  // returns null on env-unset/unauth/failure, in which case the local set simply stands.
  //
  // Merges into the SHARED set as it stands when the response lands (BUG-TODAYHOUSEHOLDSKIPCLOBBER-001),
  // never into a copy taken at mount: both lists run this, the responses land in either order, and a
  // merge of a stale copy wrote over a skip the other list made while this response was in flight.
  useEffect(() => {
    let alive = true
    ;(async () => {
      const prefs = await fetchNotificationPrefs({ getToken })
      if (!alive || !prefs) return
      const remote = readTodaySkipped(prefs, todayLocalISO())
      if (remote.length === 0) return
      const unskipped = readUnskipped()
      const merged = readSkipped()
      let added = false
      for (const k of remote) if (!merged.has(k) && !unskipped.has(k)) { merged.add(k); added = true }
      if (added) writeSkipped(merged)     // nothing new: no write, no re-render
    })()
    return () => { alive = false }
  }, [getToken])

  // BUG-TODAYGROUPREORDER-001 — A NEW PLAN DAY IS A NEW VISIT: the `logged` half of the reset (the
  // caller resets its own layout on the same render). A PWA left open on Today overnight takes the
  // morning's plan through a wake refetch into this same mounted list, and yesterday's `logged` set,
  // which hides a row by planting+need, hid today's due rows for every planting logged yesterday.
  //
  // Reset IN PLACE, never by remounting. A `key={plan_date}` remount was tried and threw away the
  // in-flight write guards (pendingKeys, writeInFlightRef, bulkInFlightRef, bulkProgress): a Log or a
  // "Log all watering" still in flight when the morning plan landed came back live on the rebuilt
  // list, and a second tap logged it twice. So those are left alone here: a write in flight keeps its
  // guard and fades its row, in the new day's list, when it lands.
  //
  // A fade is kept when its write is dated the NEW plan day. That is a log made after midnight on the
  // list still showing yesterday's plan — the morning wake's refetch in flight, the write landing
  // first, the refetched plan read before the write committed and so still calling the row due.
  // Dropping that fade put the row back, live, and a second tap logged it twice (measured: 2 POSTs,
  // both dated the new day). Same rule the read path stamps `done` by: event_date is the plan day.
  // A key still pending is kept too; today that is none, because a write fades its row in the same
  // batch that clears its pending mark — it is there for the day a fade is made before the await.
  //
  // Derived state during render (NavPrefsContext's derived-state-on-key-change): the render that sees
  // the new date queues the reset, and the re-render React runs straight after reads it.
  const [day, setDay] = useState(planDate)
  if (day !== planDate) {
    setDay(planDate)
    setLogged(prev => new Map([...prev].filter(([k, on]) => on === planDate || pendingKeys.has(k))))
  }

  const [bulkProgress, setBulkProgress] = useState(null)  // { done, total } during fan-out

  const rows = useMemo(
    () => allRows.filter(r => !logged.has(r.key) && !skipped.has(r.key)),
    [allRows, logged, skipped],
  )

  const setPending = useCallback((key, on) => {
    setPendingKeys(prev => { const n = new Set(prev); if (on) n.add(key); else n.delete(key); return n })
  }, [])

  // In-flight write keys, as a REF rather than from `pendingKeys`.
  //
  // BUG-MOISTURECHECKNOBUTTON-001 forced this: the row now carries TWO controls that write an event
  // (Water and Moist), and both of their handlers close over the same un-flushed `pendingKeys`. Two
  // taps landing in one React batch — a thumb on a phone, or a finger that catches both — therefore
  // both pass a state-only guard and both POST, producing a watering AND a "still moist" for one
  // gesture, of which the undo toast can reverse only the first. The `disabled` attribute closes
  // nothing here either: it is applied by the very render that has not flushed.
  //
  // Shared across BOTH handlers deliberately. A per-handler ref would still let Water and Moist
  // race each other, which is the case this row newly makes reachable.
  const writeInFlightRef = useRef(new Set())

  // BUG-TODAYGROUPREORDER-001 — a fade carries the event_date of the write that made it, as [key, on]
  // pairs. The new-day reset reads it (above). So does Undo: it un-fades only the fade its OWN event
  // made, so yesterday's toast, tapped after the same row was logged again today, deletes yesterday's
  // event and leaves today's fade alone — un-fading it put a logged row back, live, to be logged twice.
  const fade = useCallback((pairs) => setLogged(prev => {
    const n = new Map(prev)
    for (const [k, on] of pairs) n.set(k, on)
    return n
  }), [])
  const unfade = useCallback((pairs) => setLogged(prev => {
    let n = null
    for (const [k, on] of pairs) if (prev.get(k) === on) { n = n || new Map(prev); n.delete(k) }
    return n || prev
  }), [])

  // One-tap: await-then-fade. On failure restore the row + error toast (never fade-and-forget — L-104).
  const logRow = useCallback(async (row) => {
    if (writeInFlightRef.current.has(row.key) || pendingKeys.has(row.key)) return
    writeInFlightRef.current.add(row.key)
    setPending(row.key, true)
    try {
      const body = eventBody(row)
      const res = await fetch('/api/events', { method: 'POST', body: JSON.stringify(body) })
      const id = res && res.id
      const mine = [[row.key, body.event_date]]
      fade(mine)
      const remaining = rows.length - 1
      announce('Logged ' + NEED_LABEL[row.need] + ' for ' + row.name + ' — ' + remaining + ' remaining')
      toast.showUndo({
        message: 'Logged ' + NEED_LABEL[row.need] + ' for ' + row.name,
        // Rapid one-tap logging DOWN a list is the dominant interaction on this surface, so these
        // coalesce rather than stack: repeat taps of the same care action merge into a single toast
        // ("Logged Water for 12 plants") whose one Undo reverses every tap in the run — the same
        // shape runBulk below has always produced. Keyed by eventType so a Water run and a Feed run
        // stay separate statements instead of collapsing into one wrong count.
        group: 'care-log-' + row.eventType,
        groupMessage: (n) => 'Logged ' + NEED_LABEL[row.need] + ' for ' + n + ' plants',
        onUndo: async () => {
          // WS-A5: only un-fade the row once the DELETE is confirmed. A failed undo must KEEP the
          // row hidden — re-surfacing it lets it be re-logged as a duplicate (L-104). A 404 means
          // the event is already gone, so re-surfacing is safe there.
          if (!id) { unfade(mine); return }
          try {
            await fetch('/api/events/' + id, { method: 'DELETE' })
            unfade(mine)
          } catch (e) {
            if (e?.status === 404) {
              unfade(mine)
            } else {
              toast.show({ message: 'Couldn’t undo — the log is still saved', tone: 'error' })
            }
          }
        },
      })
    } catch {
      toast.show({ message: 'Couldn’t log — tap to retry', tone: 'error' })
    } finally {
      writeInFlightRef.current.delete(row.key)
      setPending(row.key, false)
    }
  }, [fetch, toast, pendingKeys, rows.length, setPending, announce, fade, unfade])

  // BUG-MOISTURECHECKNOBUTTON-001 — the same await-then-fade + undo contract logRow has, pointed at
  // moisture_check instead of the row's primary type. Identical shape on purpose: a failed write
  // restores the row and toasts (never fade-and-forget — L-104), and undo soft-deletes the event.
  // The toast GROUP key is the event type, so a run of moisture checks coalesces into its own
  // statement instead of being counted into "Logged Water for N plants".
  //
  // Zero reward is deliberately NOT asserted here. It is a property of the TYPE, applied server-side
  // in lambda/events/index.js — the flat grant, both recomputes and the critter award all sit behind
  // isRewardedEventType (see NON_REWARD_EVENT_TYPES in lib/eventTypes.js). The client's entire
  // obligation is to post the right event_type through the ordinary single-event path and fire
  // nothing else; re-implementing the exclusion here would just be a second place to drift.
  //
  // Guarded by the SHARED writeInFlightRef above, not by `pendingKeys` — see the note there for why
  // a state-only guard (and `disabled`) cannot close a same-batch double-tap.
  const moistRow = useCallback(async (row) => {
    if (writeInFlightRef.current.has(row.key) || pendingKeys.has(row.key)) return
    writeInFlightRef.current.add(row.key)
    setPending(row.key, true)
    try {
      const body = eventBody(row, MOISTURE_CHECK_EVENT)
      const res = await fetch('/api/events', { method: 'POST', body: JSON.stringify(body) })
      const id = res && res.id
      const mine = [[row.key, body.event_date]]
      fade(mine)
      const remaining = rows.length - 1
      announce('Checked ' + row.name + ' — still moist. ' + remaining + ' remaining')
      toast.showUndo({
        message: 'Checked ' + row.name + ' — still moist',
        group: 'care-log-' + MOISTURE_CHECK_EVENT,
        groupMessage: (n) => 'Checked ' + n + ' plants — still moist',
        onUndo: async () => {
          if (!id) { unfade(mine); return }
          try {
            await fetch('/api/events/' + id, { method: 'DELETE' })
            unfade(mine)
          } catch (e) {
            if (e?.status === 404) {
              unfade(mine)
            } else {
              toast.show({ message: 'Couldn’t undo — the check is still saved', tone: 'error' })
            }
          }
        },
      })
    } catch {
      toast.show({ message: 'Couldn’t save that — tap to retry', tone: 'error' })
    } finally {
      writeInFlightRef.current.delete(row.key)
      setPending(row.key, false)
    }
  }, [fetch, toast, pendingKeys, rows.length, setPending, announce, fade, unfade])

  // BUG-TODAYSKIPNOUNDO-001 — Skip's Undo, through the shared set (careStore.unskipMany): the local
  // write first and synchronously, then ONE queued sync however many Undos a coalesced toast runs.
  //
  // Never through a state updater, on purpose. The toast layer lives at the app root and outlives
  // Today: skip, tap into the planting, tap Undo, and this list has unmounted — a state updater would
  // never run, and the plant would stay skipped while the toast claimed otherwise. localStorage is
  // what the next mount reads, so writing it directly is what makes the Undo true whether or not the
  // list is still mounted. writeSkipped then repaints whichever lists ARE mounted — including one that
  // remounted after this toast was raised, which a repaint of this instance's own state never reached
  // (BUG-TODAYHOUSEHOLDSKIPCLOBBER-001).
  const unskipRow = useCallback((row) => {
    unskipMany([row.key], getToken)
    announce(row.name + ' is back on today’s list')
  }, [announce, getToken])

  const skipRow = useCallback((row) => {
    // One key through the shared set: local write, whole-set sync, veto lifted (careStore.skipMany).
    skipMany([row.key], getToken)
    announce('Skipped ' + row.name + ' for today')
    // BUG-TODAYSKIPNOUNDO-001 — the visible undo logging always had. Skip was the one action on this
    // row with no way back, and it is the one that silently drops a plant from today's list; the
    // announce() above is screen-reader-only. Coalesces like the log toast, under its own group, so a
    // run of skips reads "Skipped 3 plants for today" and never merges into a watering count.
    //
    // LOW priority: when the three-toast cap is hit, this one goes before any log Undo. A log toast
    // can hold a whole coalesced run of events; a skip records none. The trade, stated so it stays a
    // decision: an evicted skip toast leaves no way to un-skip that row until tomorrow, because this
    // toast is the only un-skip there is.
    toast.showUndo({
      message: 'Skipped ' + row.name + ' for today',
      group: 'care-skip',
      groupMessage: (n) => 'Skipped ' + n + ' plants for today',
      priority: 'low',
      onUndo: () => unskipRow(row),
    })
  }, [announce, getToken, toast, unskipRow])

  // Bulk: the candidate set for an event_type = visible rows of that type, MINUS in-ground beds when
  // bed-wait is active (watering only) — careNeeded.js candidateRows. Client-side fan-out of single
  // POSTs. Best-effort; aggregate undo.
  //
  // WHY NOT POST /api/events/batch (re-checked 2026-09-24, BUG-RUNBULKPARTIALUNDO-001). This comment
  // used to say the batch endpoint "cannot name this id-subset"; that is stale — scope.type 'ids' names
  // one exactly. The fan-out stays for three reasons that ARE current; revisit them together:
  //   · moisture_check (the overwintering rows' bulk) is in BATCH_EXCLUDED_TYPES by design — a 400.
  //   · under 'ids' ONE planting closed since the plan ran (this list is a cron snapshot) 409s the
  //     WHOLE tap and writes nothing, where this path logs the rest.
  //   · a batch is ONE reward action (lambda/events/batchSideEffects.js, Decision 1); this is N. Moving
  //     it changes what a Today bulk earns — Dave's call, not a transport swap.
  const candidatesFor = useCallback((etype) => candidateRows(rows, etype, { bedWait }), [rows, bedWait])

  // BUG-RUNBULKPARTIALUNDO-001 — the whole fan-out's in-flight guard, as a REF for the reason
  // writeInFlightRef above spells out: `disabled={!!bulkProgress}` is applied by the render that has
  // not flushed, so two bulk taps landing in one React batch (the pill and a section header, or one
  // button twice) both start a fan-out and every row in it is logged twice.
  const bulkInFlightRef = useRef(false)

  // V5-TODAYREDESIGN-001 S4 — the V2 run (plan-v2 §6.7 as cut by §13 Simplify 1 + SF12). Taken only when
  // the caller passes `opts`; V1 never does, so its run below is untouched. Differences, each on purpose:
  //   · `keys` are the caller's own candidate set, used as given (only rows still on the list, of this
  //     type). V2 decides bed-wait PER GROUP (D7: Outside only), so re-filtering here by the list-wide
  //     `bedWait` would drop a covered group's beds from its own Water all.
  //   · `concurrency` POSTs in flight (4), each `keepalive` so a run survives the page going away.
  //   · `excludeInFlight`: keys already being written — a one-tap Water, another run — are left out
  //     and reported, instead of the V1 whole-run guard dropping the second tap (BUG-BULKDOUBLELOGINFLIGHT-001).
  //     Every claimed key sits in writeInFlightRef until ITS post settles, so logRow/moistRow refuse it too.
  //   · `bodyEventType` posts that type instead of the row's own (Moist on a water row; `cover` for S5).
  //   · no toast and no announce: V2 keeps its Undo on the done line and speaks through its own status
  //     region (§11.1 C2). The result is returned — created {id,key,on}, failed keys, excluded keys.
  //   · each row fades as its own post lands, dated by its write (the new-day rule above), so a run cut
  //     short leaves exactly the landed rows faded. Nothing is persisted: the plan read re-derives done-ness.
  //   · `onClaim(keys)` runs once, with the run's targets, before the first POST; `onRelease(keys)` with each key
  //     whose POST failed (review 4162.1 IMPORTANT-A). writeInFlightRef is this mounted list's own, so a run that
  //     outlives it (keepalive, the page left) is invisible to the next mount — the caller persists the claim.
  const runBulkV2 = useCallback(async (etype, keys, opts) => {
    const conc = Math.max(1, Math.floor(Number(opts.concurrency) || 1))
    const want = keys instanceof Set ? keys : new Set(keys)
    const excluded = []
    const targets = rows.filter(r => {
      if (!want.has(r.key) || r.eventType !== etype) return false
      if (opts.excludeInFlight && (writeInFlightRef.current.has(r.key) || pendingKeys.has(r.key))) { excluded.push(r.key); return false }
      return true
    })
    const created = [], failed = []
    if (!targets.length) return { created, failed, excluded, total: 0 }
    for (const r of targets) writeInFlightRef.current.add(r.key)
    setPendingKeys(prev => { const n = new Set(prev); for (const r of targets) n.add(r.key); return n })
    if (typeof opts.onClaim === 'function') opts.onClaim(targets.map(r => r.key))
    const onRelease = typeof opts.onRelease === 'function' ? opts.onRelease : NOOP
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : NOOP
    let next = 0, settled = 0
    const worker = async () => {
      while (next < targets.length) {
        const row = targets[next++]
        const body = eventBody(row, opts.bodyEventType)
        try {
          const res = await fetch('/api/events', { method: 'POST', body: JSON.stringify(body), keepalive: true })
          const made = { id: (res && res.id) || null, key: row.key, on: body.event_date }
          created.push(made)
          fade([[made.key, made.on]])
        } catch { failed.push(row.key); onRelease([row.key]) }
        writeInFlightRef.current.delete(row.key)
        setPending(row.key, false)
        onProgress({ done: ++settled, total: targets.length })
      }
    }
    await Promise.all(Array.from({ length: Math.min(conc, targets.length) }, worker))
    return { created, failed, excluded, total: targets.length }
  }, [rows, pendingKeys, fetch, fade, setPending])

  // V2's Undo for a run (SF12): DELETE each created id, at most `concurrency` in flight, and un-fade only
  // what is confirmed gone (a 404 is gone). An id-less write cannot be deleted, so it stays faded and is
  // reported with the failures — the WS-A5 rule the V1 undo keeps: never re-surface a row whose log may
  // still stand.
  const undoMany = useCallback(async (created, { concurrency = 4 } = {}) => {
    const list = Array.isArray(created) ? created : []
    const undone = [], failed = []
    let next = 0
    const worker = async () => {
      while (next < list.length) {
        const c = list[next++]
        if (!c || !c.id) { if (c) failed.push(c); continue }
        try { await fetch('/api/events/' + c.id, { method: 'DELETE', keepalive: true }); undone.push(c) }
        catch (e) { if (e?.status === 404) undone.push(c); else failed.push(c) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), list.length) }, worker))
    if (undone.length) unfade(undone.map(c => [c.key, c.on]))
    return { undone, failed }
  }, [fetch, unfade])

  // `opts` is the V2 seam: present = the V2 run above; absent (every V1 call) = the V1 run below.
  const runBulk = useCallback(async (etype, keys, opts) => {
    if (opts) return runBulkV2(etype, keys, opts)
    if (bulkInFlightRef.current) return
    const targets = candidatesFor(etype).filter(r => keys.has(r.key))
    if (!targets.length) { onBulkEnd(); return }
    bulkInFlightRef.current = true
    try {
      setBulkProgress({ done: 0, total: targets.length })
      const created = []   // { id, key, on } per successfully-created row (id known = undoable)
      let failures = 0
      for (let i = 0; i < targets.length; i++) {
        const row = targets[i]
        try {
          const body = eventBody(row)
          const res = await fetch('/api/events', { method: 'POST', body: JSON.stringify(body) })
          created.push({ id: (res && res.id) || null, key: row.key, on: body.event_date })
        } catch { failures++ }
        setBulkProgress({ done: i + 1, total: targets.length })
      }
      const doneKeys = created.map(c => c.key)
      if (doneKeys.length) fade(created.map(c => [c.key, c.on]))
      onBulkEnd(); setBulkProgress(null)
      const okMsg = 'Logged ' + doneKeys.length + (failures ? ' — ' + failures + ' failed' : '')
      announce(okMsg)
      // BUG-RUNBULKPARTIALUNDO-001 — undo whatever LANDED, failures or not. The undo used to be offered
      // only when nothing failed, so one blip in a 60-row run left the 59 that did log with no way back.
      // The failed rows never joined `logged`, so they are still on the list to retry, and the message
      // carries the failure count. Only a run where nothing landed keeps the bare error toast.
      if (!created.length) toast.show({ message: okMsg, tone: 'error' })
      else toast.showUndo({
        message: okMsg,
        // WS-A5: await each DELETE; only un-fade rows whose delete is confirmed (or 404 = already
        // gone). Rows we can't confirm stay hidden, so a failed undo can't re-surface → re-log a dup.
        onUndo: async () => {
          const undone = []
          await Promise.all(created.map(async c => {
            if (!c.id) return
            try { await fetch('/api/events/' + c.id, { method: 'DELETE' }); undone.push(c) }
            catch (e) { if (e?.status === 404) undone.push(c) }
          }))
          if (undone.length) unfade(undone.map(c => [c.key, c.on]))
          if (undone.length < created.length) {
            toast.show({ message: 'Couldn’t undo ' + (created.length - undone.length) + ' of ' + created.length + ' — those logs are still saved', tone: 'error' })
          }
        },
      })
    } finally {
      bulkInFlightRef.current = false
    }
  }, [fetch, toast, candidatesFor, announce, fade, unfade, onBulkEnd, runBulkV2])

  return {
    logged, skipped, rows, pendingKeys, writeInFlightRef, bulkInFlightRef, bulkProgress, setBulkProgress,
    candidatesFor, logRow, moistRow, skipRow, unskipRow, runBulk, undoMany,
  }
}
