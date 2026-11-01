import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth } from './AuthContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { fetchNotificationPrefs } from '../lib/notificationPrefsClient.js'

// PrefsContext — the app-level, once-at-boot read of user_notification_prefs.
//
// PER-USER, AND ONLY PER-USER. user_notification_prefs is keyed by created_by, so nothing
// installation-wide belongs here — the table's key is the reason, not convention. The bar
// (bar_layout), the More pins (more_pins) and the editor flag (can_edit_bar, computed per request,
// never stored) ride this provider's one read; NavPrefsContext, directly beneath it, turns them
// into the bar, the pins and their launch caches.
//
// WHY A PROVIDER AND NOT ANOTHER fetch(). GET /api/notifications/prefs is this app's per-user
// cross-device preference store (pure UI state) and several components each fetched it on their
// own mount, some in the same frame on /today, spending the boot window's network budget. Dedup
// lives in fetchNotificationPrefs itself (single flight), so this provider's boot read JOINS
// whatever those callers have already started rather than becoming another.
//
// "READ ONCE AT BOOT, EFFECTIVE ON REFRESH" — both halves satisfied structurally. Once at boot: this
// effect, keyed on identity. On refresh: the service worker routes Lambda-origin GETs networkFirst
// with a bound. `refreshPrefs` exists so a surface can re-read immediately after its own save; it is a
// deliberate second read, not a poll.
const DEFAULT = { prefs: null, prefsLoaded: false, refreshPrefs: async () => null }
const PrefsContext = createContext(DEFAULT)

export function PrefsProvider({ children }) {
  const { user } = useAuth()
  const { getToken } = useApiFetch()
  const [prefs, setPrefs] = useState(null)
  const [prefsLoaded, setPrefsLoaded] = useState(false)

  // getToken lives in a ref and is NOT an effect dependency, and that is load-bearing rather than
  // tidy. useApiFetch returns a fresh object literal on every render, so an effect keyed on
  // `getToken` re-runs whenever anything above re-renders — this provider set its own state on
  // completion, which re-rendered, which re-fired the effect, which is a SECOND boot read of the
  // route this row exists to stop fanning out. (Caught by BottomNav.navConfig.test.jsx's
  // "one read, not nine" case, which is why that case counts calls rather than asserting a value.)
  // Keying on the user's id instead of the user OBJECT closes the same hole from the other side.
  // The ref is not a staleness risk: it is read at call time, never captured.
  const tokenRef = useRef(getToken)
  tokenRef.current = getToken
  const userId = user?.id ?? null

  const refreshPrefs = useCallback(async () => {
    const next = await fetchNotificationPrefs({ getToken: tokenRef.current })
    setPrefs(next)
    setPrefsLoaded(true)
    return next
  }, [])

  useEffect(() => {
    let on = true
    if (!userId) { setPrefs(null); setPrefsLoaded(false); return }
    fetchNotificationPrefs({ getToken: tokenRef.current })
      .then(p => { if (on) { setPrefs(p); setPrefsLoaded(true) } })
      // fetchNotificationPrefs never throws, so this arm is belt-and-braces — but a provider that
      // could reject would take the whole app down through the shell boundary, and prefs are not
      // worth that. A failed read leaves prefs null, which every consumer reads as "unset".
      .catch(() => { if (on) setPrefsLoaded(true) })
    return () => { on = false }
  }, [userId])

  const value = useMemo(() => ({ prefs, prefsLoaded, refreshPrefs }), [prefs, prefsLoaded, refreshPrefs])
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>
}

// Non-throwing, exactly like useFavorites: a component rendered without a provider (isolated
// component tests, the public share pages) gets "no prefs read yet", not a crash. For the nav that
// is the correct answer anyway — no config means the shipped bar.
export function usePrefs() {
  return useContext(PrefsContext)
}
