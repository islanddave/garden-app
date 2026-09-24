import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth } from './AuthContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { usePrefs } from './PrefsContext.jsx'
import { saveMorePins } from '../lib/notificationPrefsClient.js'
import { TAB_REGISTRY, resolveBarLayout } from '../lib/navConfig.js'
import { MORE_PINS_MAX_SHOWN, MORE_PINS_MAX_STORED, MORE_PIN_ID_RE, drawnPinIds, resolvePins } from '../lib/moreRegistry.js'
import { onReconnect } from '../lib/reconnect.js'

// NavPrefsContext — V5-NAVCUSTOM-001. A person's tab bar and More-menu pins.
// Design: project-state/design-navcustom-V100-20260924.md §8; contract: _navcustom-build-20260924/CONTRACT.md.
//
// A PROVIDER, NOT BARE HOOKS, for three reasons that bare hooks cannot meet:
//   1. ONE STATE, TWO CONSUMERS. BottomNav draws the bar and AdminConfig edits it, both mounted at
//      once. The editor's Save must re-lay the bar at once; two hooks with their own useState would
//      each hold a private copy and the bar would not move until the next launch.
//   2. A PIN SAVE MUST OUTLIVE THE SHEET. Sheet unmounts its content on every close, so a save that
//      resolved into the sheet would resolve into nothing — and its rollback would be lost.
//   3. ONE OWNER FOR THE RETRY. The `online` listener and the launch re-send must run once, not once
//      per consumer, or a reconnect would send the same list N times.
// It sits directly under PrefsProvider and reads it; it adds no request of its own at boot.
//
// PER PERSON (D4, Dave 2026-09-24). Both values live on the caller's user_notification_prefs row
// (bar_layout, more_pins), keyed by the Clerk sub. Nothing here is global: this replaces the retired
// AppConfigProvider, whose one boot GET is gone with it.
//
// THE LAUNCH CACHES ARE CACHES OF SERVER STATE, not a store of record (precedent: clientPrefs.js).
// They are read SYNCHRONOUSLY so the first paint draws this person's bar rather than the shipped one,
// and they are in CLIENT_PREF_KEYS so sign-out clears them on a shared phone.
//   nav.barLayout.v1        { userId, layout: <raw server bar_layout>, canEdit: <last can_edit_bar> }
//   nav.morePins.v1         { userId, pins: <the pin list as last shown, unknown ids included> }
//   nav.morePins.pending.v1 <userId> while the server has not confirmed that person's list
// EVERY CACHE CARRIES ITS OWNER (the Clerk sub), and one stamped for anybody else — or not stamped at
// all — is NO cache. Sign-out's clearClientPrefs() is not the only way a session ends: an expired or
// revoked Clerk session never runs it, and the next person to sign in on the same phone would
// otherwise draw the previous person's bar, see their "Edit tab bar" door, and — worst — have the
// previous person's pending pin list PATCHed onto their own row with their own token.
//
// THE BAR NEVER RE-LAYS ITSELF OUT UNDER A THUMB. First paint uses the cache. When prefs land the
// cache is rewritten, but the new value is applied at once ONLY if there was no cache at launch (a
// first launch after sign-in); otherwise it takes effect from the next launch. The one other way the
// bar moves mid-session is the person's own Save in the editor (applyLayout). Jen's bar therefore
// never shifts while she is using it — and, per D4, never because of Dave at all.
//
// PINS ARE OPTIMISTIC AND DURABLE. A tap changes the button at once and marks the list pending
// BEFORE the request goes out, so an app closed mid-save re-sends at the next launch. The save's
// answer decides the rest: ok → confirmed; status 0 or 5xx (never reached / server trouble) → kept
// and pending, re-sent on the `online` event and at launch; 4xx (refused) → rolled back to the last
// server-confirmed list, reported as 'error'. Unknown ids ride along in every save (moreRegistry.js).
// No toast, banner or dot for any of it (Reward UX / ADHD rules): the row's own button is the signal.
//
// A PREFS BODY THAT IS NOT FRESH NEVER OVERWRITES WHAT THIS SESSION KNOWS (QA IMPORTANT-2, reg M5).
//   - A body the service worker served from its cache (marked FROM_CACHE by fetchNotificationPrefs)
//     may predate a pin or a Save this device already made. It may say who can edit — the best answer
//     on hand — and nothing else: pins, the pin cache and the bar cache all stand.
//   - Once this person's own Save has run (applyLayout) the bar is theirs for the session, exactly as
//     `touched` makes the pins theirs: a later landing — including the editor's own re-read, which can
//     join a GET that left BEFORE the save — never rewrites the bar cache.
//   - Pins are saved as a WHOLE list, so a session that has never learned the server's list (no owned
//     cache, no fresh read yet) cannot save one: a tap then answers 'not-loaded' rather than overwrite
//     the server's pins with a list built from nothing — AND GOES TO GET THE LIST (QA RE-1). Prefs are
//     otherwise read once per identity, so without that re-read a failed or SW-served boot read left
//     pinning impossible until the next cold start, which on a backgrounded PWA can be days. The refused
//     tap and the `online` event both re-read while the list is unknown; the prefs client's single-
//     flight latch folds them into any read already in flight, and the next tap after a fresh landing
//     saves on top of the server's list.

export const BAR_LAYOUT_CACHE_KEY = 'nav.barLayout.v1'
export const MORE_PINS_CACHE_KEY = 'nav.morePins.v1'
export const MORE_PINS_PENDING_KEY = 'nav.morePins.pending.v1'

// api.js's SW offline-cache marker, read through the global Symbol registry rather than by importing
// isFromCache — the dependency-free seam dataCache.js and HarvestExportSheet.jsx already use.
const FROM_CACHE = Symbol.for('garden-app.fromCache')
const servedFromCache = (v) => !!v && typeof v === 'object' && v[FROM_CACHE] === true

// try/catch per the house convention (clientPrefs.js): an unavailable or throwing localStorage
// degrades to "no cache", never to an error on the nav's render path.
function readJson(key) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return undefined
    const s = localStorage.getItem(key)
    return s == null ? undefined : JSON.parse(s)
  } catch { return undefined }
}
function writeJson(key, value) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return
    if (value === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch { /* unavailable/denied — the cache is an optimisation, the server is the record */ }
}

// The writers: every write stamps the owner. `pending` is the owner's sub, never a bare `true`.
const writeBarCache = (userId, layout, canEdit) => writeJson(BAR_LAYOUT_CACHE_KEY, { userId, layout: layout ?? null, canEdit: canEdit === true })
const writePinsCache = (userId, pins) => writeJson(MORE_PINS_CACHE_KEY, { userId, pins })
const writePending = (userId, on) => writeJson(MORE_PINS_PENDING_KEY, on ? userId : undefined)

// A cache entry counts only if it is an object stamped with THIS person's sub. A legacy unstamped
// shape (a bare array of pins, `{layout, canEdit}`, `true`) and another person's stamp both fail here,
// and both mean "no cache": the shipped first paint, no editor door, and this person's own server
// value applied at once when it lands.
const ownedBy = (value, userId) =>
  !!userId && !!value && typeof value === 'object' && !Array.isArray(value) && value.userId === userId

// Everything the first paint needs, read synchronously. A malformed or foreign cache is NO cache: it
// cannot make the launch worse than a first launch.
//
// `touched` is the pins' session rule: once this person has changed their pins in this session (or
// launched with a change still pending), the local list is the authority until the next launch, and
// a later prefs read never overwrites it. That closes the race where a GET issued BEFORE a pin's
// PATCH lands AFTER it and quietly un-pins what was just pinned. Another device's change therefore
// arrives at the next launch — the same "read at boot" rule every other pref here follows.
function readLaunch(userId) {
  const bar = readJson(BAR_LAYOUT_CACHE_KEY)
  const hadBarCache = ownedBy(bar, userId) && Object.hasOwn(bar, 'layout')
  const pinsCache = readJson(MORE_PINS_CACHE_KEY)
  const hadPinsCache = ownedBy(pinsCache, userId) && Array.isArray(pinsCache.pins)
  // Pending only for THIS person's own list: another person's unsent list is never re-sent.
  const pending = hadPinsCache && readJson(MORE_PINS_PENDING_KEY) === userId
  return {
    epoch: {},
    userId,
    hadBarCache,
    barRaw: hadBarCache ? bar.layout : null,
    barAdopted: false,
    barTouched: false,              // this person's own Save ran this session (applyLayout)
    cachedCanEdit: hadBarCache && bar.canEdit === true,
    serverCanEdit: null,
    pins: hadPinsCache ? resolvePins(pinsCache.pins) : [],
    pinsKnown: hadPinsCache,        // an owned cache, or a fresh read this session: a list to save FROM
    confirmed: null,
    pending,
    touched: pending,
  }
}

const rowsOf = (keys) => keys.map(key => ({ ...TAB_REGISTRY[key], key }))

// No provider (isolated component tests, public pages): the shipped bar, no pins, no editor. The same
// answer a first launch gives before prefs land.
const SHIPPED = resolveBarLayout(null)
const DEFAULT = {
  layout: SHIPPED, bar: rowsOf(SHIPPED.bar), moved: [], canEditBar: false, applyLayout: () => {},
  pins: [], isPinned: () => false, togglePin: async () => 'error', pending: false,
}
const NavPrefsContext = createContext(DEFAULT)

export function NavPrefsProvider({ children }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const { prefs, prefsLoaded, refreshPrefs } = usePrefs()
  const { getToken } = useApiFetch()
  // Read at call time, never captured — same reasoning as PrefsProvider's tokenRef.
  const tokenRef = useRef(getToken)
  tokenRef.current = getToken

  const [s, setS] = useState(() => readLaunch(userId))
  // `live` mirrors `s` SYNCHRONOUSLY, so two taps in one frame build on each other rather than both
  // on the pre-tap list. Every mutation goes through commit().
  const live = useRef(s)
  const landed = useRef(undefined)   // the prefs object last folded in
  const seq = useRef(0)              // monotonic save counter; only the latest save's answer applies
  const settled = useRef(0)

  // A different person. Sign-out normally cleared the caches (CLIENT_PREF_KEYS), but an expired or
  // revoked session never runs sign-out — which is why readLaunch accepts only entries stamped with
  // the NEW person's sub, and treats the previous person's leftovers as no cache at all. The prefs
  // object on hand belongs to the previous person — mark it as seen so it is never folded into the new
  // session. Derived-state-on-key-change, done during render so no child ever draws the previous
  // person's bar.
  if (s.userId !== userId) {
    const next = readLaunch(userId)
    live.current = next
    landed.current = prefs
    settled.current = seq.current   // the previous person's saves are abandoned, not in flight
    setS(next)
  }

  const commit = useCallback((patch) => {
    const next = { ...live.current, ...patch }
    live.current = next
    setS(next)
    return next
  }, [])

  // Send `list` and settle it. Returns the save result, or null if a newer save or a new session has
  // superseded this one (its answer no longer describes what is on screen).
  const sendPins = useCallback(async (list, before) => {
    const mine = ++seq.current
    const epoch = live.current.epoch
    const res = await saveMorePins({ getToken: tokenRef.current, ids: list })
    if (mine !== seq.current || epoch !== live.current.epoch) return null
    settled.current = mine
    const owner = live.current.userId
    if (res.ok) {
      writePending(owner, false)
      commit({ confirmed: list, pending: false })
    } else if (res.status > 0 && res.status < 500) {
      // Refused. Back to what the server last confirmed. If it has not answered this session, back to
      // what was on screen before this change — and let the next prefs read decide (touched=false).
      const known = live.current.confirmed
      const back = known ?? before
      writePinsCache(owner, back)
      writePending(owner, false)
      commit({ pins: back, pending: false, touched: known != null })
    }
    // status 0 / 5xx: keep the list and the pending flag; the online event or the next launch retries.
    return res
  }, [commit])

  // Re-send a pending list. A no-op while any save is in flight — its answer settles the list.
  const resend = useCallback(() => {
    const cur = live.current
    if (!cur.userId || !cur.pending || settled.current !== seq.current) return
    sendPins(cur.pins, cur.confirmed ?? cur.pins)
  }, [sendPins])

  // While this session has never learned the server's pin list, go and get it (QA RE-1). Prefs are
  // otherwise read once per identity. refreshPrefs goes through fetchNotificationPrefs, whose
  // single-flight latch joins any read already in flight, so repeated triggers cost one request.
  const learnPins = useCallback(() => {
    const cur = live.current
    if (cur.userId && !cur.pinsKnown) refreshPrefs()
  }, [refreshPrefs])

  // Launch re-send, once per session; on every reconnect, re-send and — if still unknown — re-read.
  useEffect(() => { resend() }, [s.epoch, resend])
  useEffect(() => onReconnect(() => { resend(); learnPins() }), [resend, learnPins])

  // Fold in each NEW prefs object, once. A failed read (null) changes nothing: the caches stand.
  useEffect(() => {
    if (!userId || !prefsLoaded || !prefs || prefs === landed.current) return
    landed.current = prefs
    const cur = live.current
    const serverCanEdit = prefs.can_edit_bar === true
    // Served from the SW's cache: not fresh. Who-may-edit only; pins and both caches stand.
    if (servedFromCache(prefs)) { commit({ serverCanEdit }); return }
    const barRaw = prefs.bar_layout ?? null
    const patch = { serverCanEdit, pinsKnown: true }
    // After this person's own Save, the bar (and its cache) are theirs until the next launch.
    if (!cur.barTouched) {
      writeBarCache(cur.userId, barRaw, serverCanEdit)
      // First launch after sign-in: nothing was drawn from a cache, so apply at once. Otherwise the
      // cache now holds the new value and the NEXT launch draws it.
      if (!cur.hadBarCache && !cur.barAdopted) Object.assign(patch, { barRaw, barAdopted: true })
    }
    const server = resolvePins(prefs.more_pins)
    if (!cur.touched) {
      // Nothing local to protect: the server's list is the list.
      writePinsCache(cur.userId, server)
      Object.assign(patch, { pins: server, confirmed: server })
    } else if (cur.confirmed == null) {
      // A local change is pending: keep it on screen, remember the server's copy as the rollback
      // target, and re-send (resend no-ops if the launch re-send is still in flight).
      patch.confirmed = server
    }
    commit(patch)
    resend()
  }, [prefs, prefsLoaded, userId, commit, resend])

  const layout = useMemo(() => resolveBarLayout(s.barRaw), [s.barRaw])
  const canEditBar = s.serverCanEdit ?? s.cachedCanEdit

  // The editor's own Save: applies at once (the only mid-session re-layout) and becomes the cache.
  const applyLayout = useCallback((raw) => {
    const cur = live.current
    if (cur.userId) writeBarCache(cur.userId, raw, cur.serverCanEdit ?? cur.cachedCanEdit)
    commit({ barRaw: raw ?? null, barAdopted: true, barTouched: true })
  }, [commit])

  // → 'pinned' | 'unpinned' | 'full' | 'not-loaded' | 'error'. The button changes before this resolves.
  const togglePin = useCallback(async (id) => {
    if (typeof id !== 'string' || !MORE_PIN_ID_RE.test(id)) return 'error'
    const cur = live.current
    // Nobody signed in: there is no row to save to and no owner to stamp a cache with.
    if (!cur.userId) return 'error'
    // The list is saved WHOLE. Until this session knows the server's list — an owned launch cache, or
    // a fresh read — a save would replace the person's real pins with a list built from nothing. So
    // this tap saves nothing, says so in its own words, and sends for the list.
    if (!cur.pinsKnown) { learnPins(); return 'not-loaded' }
    const wasPinned = cur.pins.includes(id)
    if (!wasPinned) {
      const moved = resolveBarLayout(cur.barRaw).moved
      if (drawnPinIds(cur.pins, { moved }).length >= MORE_PINS_MAX_SHOWN) return 'full'
      if (cur.pins.length >= MORE_PINS_MAX_STORED) return 'full'
    }
    const next = wasPinned ? cur.pins.filter(p => p !== id) : [...cur.pins, id]
    writePinsCache(cur.userId, next)
    writePending(cur.userId, true)
    commit({ pins: next, pending: true, touched: true })
    const res = await sendPins(next, cur.pins)
    if (res && !res.ok && res.status > 0 && res.status < 500) return 'error'
    return wasPinned ? 'unpinned' : 'pinned'
  }, [commit, sendPins, learnPins])

  const isPinned = useCallback((id) => s.pins.includes(id), [s.pins])

  const value = useMemo(() => ({
    layout, bar: rowsOf(layout.bar), moved: layout.moved, canEditBar, applyLayout,
    pins: s.pins, isPinned, togglePin, pending: s.pending,
  }), [layout, canEditBar, applyLayout, s.pins, isPinned, togglePin, s.pending])

  return <NavPrefsContext.Provider value={value}>{children}</NavPrefsContext.Provider>
}

// Non-throwing, like usePrefs: with no provider these return the shipped bar and no pins.
export function useNavLayout() {
  const { layout, bar, moved, canEditBar, applyLayout } = useContext(NavPrefsContext)
  return { layout, bar, moved, canEditBar, applyLayout }
}

export function useMorePins() {
  const { pins, isPinned, togglePin, pending } = useContext(NavPrefsContext)
  return { pins, isPinned, togglePin, pending }
}
