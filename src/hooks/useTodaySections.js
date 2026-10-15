// useTodaySections — the redesigned Today's REMEMBERED open/closed state, Layer 1 (plan-v2 §2.1; §13 MF1,
// Simplify 4). V5-TODAYREDESIGN-001 S2.
//
// WRITTEN ONLY BY AN EXPLICIT HEADER TAP. Expand/Collapse all, a chip jump and an auto-open trigger are the
// VISIT's (useTodayVisit.js) and never land here, so nothing the page decides on its own is ever remembered
// as Dave's choice.
//
// ENTRY: { open: bool, at: 'YYYY-MM-DD', ack?: { t?, r? } } per section key (protect headsup care harvest
// putup resting hh-<member8>). `open` is remembered across days; an `ack` (a close made while a trigger
// had the section open) is DATE-SCOPED — it holds only while `at` is the plan day (MF1), and the trigger
// module (S5) is what reads it.
//
// THE MIRROR, localStorage 'today-sections:<user>' = { v:1, s:{…entries}, dirty:[keys] }. Every tap lands
// here first and is marked dirty: the local copy is authoritative until the server has confirmed it.
//
// S7 — THE SENDER (this hook, given `getToken`). A tap's entry goes to the server at once:
// PATCH /api/notifications/prefs { today_sections: { v:1, <dirty key>: entry, … } }, ALONE (never batched: a
// pre-S7 Lambda's 400, or the S7 Lambda's 409 while its database lacks the column, would drop anything riding
// with it), keepalive. The server merges per top-level key, so only dirty entries are sent. One request at a
// time; taps made while one is on the wire go together in the next. A 200 clears exactly the keys whose entry is
// still what was sent (sectionsWire confirmedKeys); a 4xx, 5xx or network failure leaves them dirty, and every
// mount — a visit start, or a return to Today — sends what is still dirty. Nothing else sends: Expand/Collapse
// all, a chip jump and a trigger never mark an entry dirty, so they never reach the server.
//
// READ PRECEDENCE, per key: a dirty mirror entry > the server's (prefs.today_sections, IGNORED when the
// service worker served the body from its cache — a days-old body must not overrule a fresh choice — and, per
// section, when the body was read before this device's own confirmed save of that section:
// notificationPrefsClient sectionPredatesSave) > the mirror's > nothing (closed). A version other than 1, on
// either side, reads as nothing. The PAGE reads this ONCE, at the visit's ready point (useTodayVisit): a server
// answer that lands later waits for the next visit, so a late prefs read never rearranges the page under a thumb.
// Cross-device merge rule in full: migrations/v5-todaysections-001/README-BUILD.md.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isFromCache } from '../lib/api.js'
import { saveTodaySections, sectionPredatesSave } from '../lib/notificationPrefsClient.js'
import { pendingBody, confirmedKeys } from '../lib/todayV2/sectionsWire.js'

export const SECTIONS_PREFIX = 'today-sections:'
const V = 1
const DAY = /^\d{4}-\d{2}-\d{2}$/

export function sectionsKey(userId) {
  return userId ? SECTIONS_PREFIX + encodeURIComponent(String(userId)) : null
}

export function validEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.open !== 'boolean' || typeof e.at !== 'string' || !DAY.test(e.at)) return false
  return e.ack == null || typeof e.ack === 'object'
}

// -> { s, dirty } | null (absent, unreadable, or another version: the mirror does not exist).
export function readMirror(key) {
  if (!key) return null
  try {
    const m = JSON.parse(localStorage.getItem(key) || 'null')
    if (!m || m.v !== V || !m.s || typeof m.s !== 'object') return null
    const s = {}
    for (const [k, e] of Object.entries(m.s)) if (validEntry(e)) s[k] = e
    const dirty = Array.isArray(m.dirty) ? m.dirty.filter((k) => typeof k === 'string' && s[k]) : []
    return { s, dirty }
  } catch { return null }
}

export function writeMirror(key, mirror) {
  if (!key || !mirror) return
  try { localStorage.setItem(key, JSON.stringify({ v: V, s: mirror.s, dirty: mirror.dirty })) } catch { /* full or blocked: the visit still holds the tap */ }
}

// The server's entries, or null: absent (pre-S7), another version, or a service-worker cache body.
export function serverSections(prefs) {
  if (!prefs || isFromCache(prefs)) return null
  const t = prefs.today_sections
  if (!t || typeof t !== 'object' || t.v !== V) return null
  const out = {}
  for (const [k, e] of Object.entries(t)) if (k !== 'v' && validEntry(e)) out[k] = e
  return out
}

export function resolveSection(key, mirror, server) {
  const mine = mirror?.s?.[key]
  if (mine && mirror.dirty.includes(key)) return mine
  if (server && server[key]) return server[key]
  return mine || null
}

export function withEntry(mirror, key, entry) {
  const base = mirror || { s: {}, dirty: [] }
  return { s: { ...base.s, [key]: entry }, dirty: base.dirty.includes(key) ? base.dirty : [...base.dirty, key] }
}

export function useTodaySections({ userId, prefs, getToken } = {}) {
  const key = sectionsKey(userId)
  const [state, setState] = useState(() => ({ key, mirror: readMirror(key) }))
  // Another person (or the user id landing after first render): that person's mirror, never the last one's.
  let current = state
  if (state.key !== key) { current = { key, mirror: readMirror(key) }; setState(current) }
  const { mirror } = current
  const server = useMemo(() => serverSections(prefs), [prefs])

  // Per section, the server's entry counts only when the body was read after this device's last confirmed save
  // of that section (asked at call time: a save confirmed after the body arrived changes the answer).
  const resolve = useCallback((section) => resolveSection(section, mirror, sectionPredatesSave(prefs, section) ? null : server), [mirror, server, prefs])

  // S7: the sender. Refs, so a send in flight survives re-renders and its answer lands on the mirror it was for.
  const tokenRef = useRef(getToken)
  tokenRef.current = getToken
  const keyRef = useRef(key)
  keyRef.current = key
  const flight = useRef({ busy: false, again: false })
  const send = useCallback(async () => {
    const k = key
    const f = flight.current
    if (!k || typeof tokenRef.current !== 'function') return
    if (f.busy) { f.again = true; return }
    f.busy = true
    try {
      do {
        f.again = false
        const body = pendingBody(readMirror(k))
        if (!body) break
        const res = await saveTodaySections({ getToken: tokenRef.current, sections: body })
        if (!res?.ok) break                     // kept dirty: the next visit start sends it again
        const cur = readMirror(k)
        const done = confirmedKeys(cur, body)
        if (cur && done.length) {
          const next = { s: cur.s, dirty: cur.dirty.filter((d) => !done.includes(d)) }
          writeMirror(k, next)
          if (keyRef.current === k) setState({ key: k, mirror: next })
        }
      } while (f.again)
    } finally {
      f.busy = false
    }
  }, [key])

  // Every mount (and a change of person) sends what an earlier visit left dirty.
  useEffect(() => { send() }, [send])

  // An explicit tap. Re-reads storage first, so another tab's taps on this device are never overwritten.
  const remember = useCallback((section, entry) => {
    if (!validEntry(entry)) return
    const next = withEntry(readMirror(key) || mirror, section, entry)
    writeMirror(key, next)
    setState({ key, mirror: next })
    send()
  }, [key, mirror, send])

  // The server confirmed these keys, so they stop overruling its answer. (The sender above clears its own;
  // kept for a caller that confirms by other means.)
  const markSent = useCallback((sections) => {
    const cur = readMirror(key) || mirror
    if (!cur) return
    const drop = new Set(sections)
    const next = { s: cur.s, dirty: cur.dirty.filter((k) => !drop.has(k)) }
    writeMirror(key, next)
    setState({ key, mirror: next })
  }, [key, mirror])

  const pending = useMemo(() => (mirror ? Object.fromEntries(mirror.dirty.map((k) => [k, mirror.s[k]])) : {}), [mirror])

  return { mirrorExists: !!mirror, resolve, remember, markSent, pending }
}
