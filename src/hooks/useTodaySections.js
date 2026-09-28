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
// S2 ships the mirror ONLY (Simplify 4): the server column user_notification_prefs.today_sections is S7's,
// and until it exists a PATCH carrying it is a guaranteed 400. `pending` + `markSent` are the seam S7's
// sender uses — it sends the dirty entries ALONE (never batched: a pre-S7 Lambda's 400 would drop anything
// riding with them) and clears exactly the keys a 200 confirmed; a 400 or a network failure leaves them
// dirty for the next visit start.
//
// READ PRECEDENCE, per key: a dirty mirror entry > the server's (prefs.today_sections, IGNORED when the
// service worker served the body from its cache — a days-old body must not overrule a fresh choice) > the
// mirror's > nothing (closed). A version other than 1, on either side, reads as nothing. The PAGE reads this
// ONCE, at the visit's ready point (useTodayVisit): a server answer that lands later waits for the next
// visit, so a late prefs read never rearranges the page under a thumb.
import { useCallback, useMemo, useState } from 'react'
import { isFromCache } from '../lib/api.js'

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

export function useTodaySections({ userId, prefs } = {}) {
  const key = sectionsKey(userId)
  const [state, setState] = useState(() => ({ key, mirror: readMirror(key) }))
  // Another person (or the user id landing after first render): that person's mirror, never the last one's.
  let current = state
  if (state.key !== key) { current = { key, mirror: readMirror(key) }; setState(current) }
  const { mirror } = current
  const server = useMemo(() => serverSections(prefs), [prefs])

  const resolve = useCallback((section) => resolveSection(section, mirror, server), [mirror, server])

  // An explicit tap. Re-reads storage first, so another tab's taps on this device are never overwritten.
  const remember = useCallback((section, entry) => {
    if (!validEntry(entry)) return
    const next = withEntry(readMirror(key) || mirror, section, entry)
    writeMirror(key, next)
    setState({ key, mirror: next })
  }, [key, mirror])

  // S7's sender: the server confirmed these keys, so they stop overruling its answer.
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
