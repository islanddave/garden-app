import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth } from './AuthContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { fetchNotificationPrefs } from '../lib/notificationPrefsClient.js'
import { TAB_REGISTRY, resolveNavTabs } from '../lib/navConfig.js'

// PrefsContext — V5-ADMINCENTER-001. The app-level read of user_notification_prefs.
// Design: project-state/design-admincentre-V100-20260908.md §3, §4.
//
// WHY A PROVIDER AND NOT ANOTHER fetch(). GET /api/notifications/prefs is already this app's
// per-user cross-device preference store (~10 columns of pure UI state live on it), so nav config
// belongs there rather than behind a new endpoint — a new Lambda costs a measured ~1.7s cold start
// plus a 167-696ms handshake on an origin that CANNOT be preconnected, because the preconnect budget
// is closed at four and bootPaint.static.test.js asserts the set (warmOrigins.js:57-62). The prefs
// origin is the SAME function BottomNavDot already calls on mount, so this read adds zero
// connections. What it must not add is another uncoordinated request: dedup lives in
// fetchNotificationPrefs itself (single flight), so this provider's boot read JOINS whatever the
// eight existing callers have already started rather than becoming a ninth.
//
// "READ ONCE AT BOOT, EFFECTIVE ON REFRESH" — the row's own words, and both halves are satisfied
// structurally. Once at boot: this effect, keyed on identity. On refresh: sw.js:258-262 routes
// Lambda-origin GETs networkFirst with a 12s bound, so a config change is picked up on the next cold
// start with nothing further to build. Note the trap recorded in the design (§4) so nobody re-opens
// it: an installed PWA has no reliable refresh TRIGGER for a change that does not move
// __APP_VERSION__, so a config edit takes effect the next time the app starts, not on a prompt. That
// is fine for nav layout and must not be generalised to config whose staleness would be harmful.
// `refreshPrefs` exists so the admin centre can re-read immediately after its own save; it is a
// deliberate second read on one surface, not a poll.
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

// useNavTabs — the tab bar's rows, config-ordered. Returns tab OBJECTS in render order.
//
// Every failure mode collapses to one branch: null prefs, a missing column, a failed GET, an offline
// boot and a malformed value all resolve to DEFAULT_NAV_TABS inside resolveNavTabs. That is why
// BottomNav needs no loading state — it renders the shipped bar until config says otherwise, which
// is also what it renders if config never arrives.
export function useNavTabs() {
  const { prefs } = usePrefs()
  return useMemo(() => resolveNavTabs(prefs?.nav_tabs).map(k => TAB_REGISTRY[k]), [prefs])
}
