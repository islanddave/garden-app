import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth } from './AuthContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { fetchAppConfig } from '../lib/appConfigClient.js'
import { TAB_REGISTRY, resolveNavTabs } from '../lib/navConfig.js'

// AppConfigContext — V5-ADMINCENTER-001. The app-level read of public.app_config.
// Design: project-state/design-admincentre-V100-20260908.md §3/§4, as amended by the V101 delta.
//
// WHY THIS IS NOT PrefsContext. It was, until Dave ruled on 2026-09-08 that nav_tabs is GLOBAL —
// one nav order for the installation, not one per person. PrefsProvider reads
// public.user_notification_prefs, which is keyed by created_by; a per-user row cannot hold an
// installation-wide fact, and a provider that served both scopes would be the same category error
// as a route that served both. So the two live side by side and neither one imports the other.
//
// THE ORIGIN IS FREE, THE REQUEST IS NOT — say which. This is a second GET at boot, but to the same
// already-connected origin PrefsProvider and BottomNavDot are using, on a new rawPath of the same
// Lambda: no new preconnect (the budget is closed at four and bootPaint.static.test.js asserts it),
// no new hostname, no additional cold start. What it does add is one request. That is inherent to
// the global ruling — the config no longer travels inside the per-user prefs payload — and it is
// paid on an origin that is warm by the time the nav renders.
//
// "READ ONCE AT BOOT, EFFECTIVE ON REFRESH" — the row's own words, both halves satisfied
// structurally. Once at boot: this effect, keyed on identity, over a single-flighted fetch. On
// refresh: sw.js:258-262 routes Lambda-origin GETs networkFirst with a 12s bound, so a config change
// is picked up on the next cold start with nothing further to build. The trap the design records
// (§4), so nobody re-opens it: an installed PWA has no reliable refresh TRIGGER for a change that
// does not move __APP_VERSION__, so a config edit takes effect the next time the app starts rather
// than on a prompt. Fine for nav layout; must NOT be generalised to config whose staleness would be
// harmful. `refreshAppConfig` exists so the admin centre can re-read after its own save — a
// deliberate second read on one surface, not a poll.
const DEFAULT = { appConfig: null, appConfigLoaded: false, refreshAppConfig: async () => null }
const AppConfigContext = createContext(DEFAULT)

export function AppConfigProvider({ children }) {
  const { user } = useAuth()
  const { getToken } = useApiFetch()
  const [appConfig, setAppConfig] = useState(null)
  const [appConfigLoaded, setAppConfigLoaded] = useState(false)

  // getToken lives in a ref and is NOT an effect dependency — load-bearing, not tidy. useApiFetch
  // returns a fresh object literal every render, so an effect keyed on it re-runs whenever anything
  // above re-renders: this provider sets its own state on completion, which re-renders, which
  // re-fires the effect, which is a second boot read of the route. Keying on the user's id rather
  // than the user OBJECT closes the same hole from the other side. The ref is not a staleness risk —
  // it is read at call time, never captured.
  const tokenRef = useRef(getToken)
  tokenRef.current = getToken
  const userId = user?.id ?? null

  const refreshAppConfig = useCallback(async () => {
    const next = await fetchAppConfig({ getToken: tokenRef.current })
    setAppConfig(next)
    setAppConfigLoaded(true)
    return next
  }, [])

  useEffect(() => {
    let on = true
    if (!userId) { setAppConfig(null); setAppConfigLoaded(false); return }
    fetchAppConfig({ getToken: tokenRef.current })
      .then(c => { if (on) { setAppConfig(c); setAppConfigLoaded(true) } })
      // fetchAppConfig never throws, so this arm is belt-and-braces — but a provider that could
      // reject would take the whole app down through the shell boundary, and nav layout is not worth
      // that. A failed read leaves appConfig null, which resolveNavTabs reads as the shipped default.
      .catch(() => { if (on) setAppConfigLoaded(true) })
    return () => { on = false }
  }, [userId])

  const value = useMemo(
    () => ({ appConfig, appConfigLoaded, refreshAppConfig }),
    [appConfig, appConfigLoaded, refreshAppConfig],
  )
  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>
}

// Non-throwing, exactly like useFavorites and usePrefs: a component rendered without a provider
// (isolated component tests, the public share pages) gets "no config read yet", not a crash. For the
// nav that is the correct answer anyway — no config means the shipped bar.
export function useAppConfig() {
  return useContext(AppConfigContext)
}

// useNavTabs — the tab bar's rows, config-ordered. Returns tab OBJECTS in render order.
//
// Every failure mode collapses to one branch: a null config, an absent app_config row, a failed GET,
// an offline boot and a malformed stored value all resolve to DEFAULT_NAV_TABS inside resolveNavTabs.
// That is why BottomNav needs no loading state — it renders the shipped bar until config says
// otherwise, which is also what it renders if config never arrives.
export function useNavTabs() {
  const { appConfig } = useAppConfig()
  return useMemo(() => resolveNavTabs(appConfig?.nav_tabs).map(k => TAB_REGISTRY[k]), [appConfig])
}
