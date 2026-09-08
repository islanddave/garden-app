import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth } from './AuthContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { fetchNotificationPrefs } from '../lib/notificationPrefsClient.js'

// PrefsContext — V5-ADMINCENTER-001. The app-level, once-at-boot read of user_notification_prefs.
// Design: project-state/design-admincentre-V100-20260908.md §3, §4.
//
// PER-USER, AND ONLY PER-USER. This provider held useNavTabs until Dave ruled on 2026-09-08 that the
// nav order is GLOBAL — one order for the installation, not one per person. The nav config moved to
// AppConfigContext over public.app_config; user_notification_prefs is keyed by created_by and cannot
// express an installation-wide fact. Do not route a global setting back through here: the table's
// key is the reason, not convention.
//
// WHY A PROVIDER AND NOT ANOTHER fetch(). GET /api/notifications/prefs is this app's per-user
// cross-device preference store (~10 columns of pure UI state live on it) and it had EIGHT
// independent callers each fetching on their own mount, three of them in the same frame on /today —
// inside the boot window three consecutive perf rows were spent clearing, against a measured 1,706ms
// cold start (warmOrigins.js:3-5). Dedup lives in fetchNotificationPrefs itself (single flight), so
// this provider's boot read JOINS whatever those callers have already started rather than becoming a
// ninth. That collapse is a net improvement to the boot path, which is why the provider pays for
// itself independently of the row that introduced it.
//
// "READ ONCE AT BOOT, EFFECTIVE ON REFRESH" — both halves satisfied structurally. Once at boot: this
// effect, keyed on identity. On refresh: sw.js:258-262 routes Lambda-origin GETs networkFirst with a
// 12s bound. `refreshPrefs` exists so a surface can re-read immediately after its own save; it is a
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
