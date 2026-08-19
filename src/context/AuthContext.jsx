// The DEFAULT React import is required to render this provider under vitest: the unit run falls
// back to the CLASSIC JSX transform (React.createElement), so a file that relies on the automatic
// runtime throws "React is not defined" the moment a test mounts it. Every other rendered .jsx in
// src/ already carries it; this one never did because nothing had mounted it until
// clientPrefs.test.jsx. Inert in the production build, which uses the automatic runtime.
import React, { createContext, useContext, useEffect, useState } from 'react'
import { useUser, useClerk } from '@clerk/react'
import { invalidateAll as invalidateDataCache } from '../lib/dataCache.js'
import { useCacheLifecycle } from '../hooks/useCacheLifecycle.js'
import { clearClientPrefs } from '../lib/clientPrefs.js'
import { POST_LOGIN_ROUTE } from '../lib/constants.js'

const AuthContext = createContext(null)

// V4-COLDSTART-001 — the ceiling on the boot wait.
//
// 10 000 ms is Clerk's own number, not a tuned one: `@clerk/shared/dist/getToken.mjs:29-36` races
// its ready-promise against exactly this and rejects with
// ClerkRuntimeError('Timeout waiting for Clerk to load.', { code: 'clerk_runtime_load_timeout' }).
// The app cannot use that helper (it wants a standalone Clerk instance, and `useUser` — not
// getToken — is what the render gate reads), so the same bound is re-implemented here against the
// hook. Matching the value means an app-level give-up can never fire BEFORE the library's own.
//
// It is a BACKSTOP, not the main path: a failed hot-load emits status 'error' within a second or so
// and is caught by the status arm below. This covers the pathological case the status event cannot —
// a captive portal or a black-holed TCP connect where nothing ever settles and nothing ever throws.
// Measured reference for the healthy path: isLoaded at t=3376 ms on a real cold boot (bootPaint
// test header), so 10 s leaves ~3x headroom before a working sign-in could be cut short.
export const CLERK_LOAD_TIMEOUT_MS = 10000

export function AuthProvider({ children }) {
  const { user: clerkUser, isSignedIn, isLoaded } = useUser()
  const clerk = useClerk()
  const { signOut: clerkSignOut } = clerk

  const user = isSignedIn ? clerkUser : null
  const loading = !isLoaded

  // V4-COLDSTART-001 — the bounded wait, and the third identity state it produces.
  //
  // THE HANG. clerk-js is hot-loaded from Clerk's CDN. Offline that load fails; IsomorphicClerk
  // emits status 'error' and then RETURNS without calling emitLoaded (@clerk/react's ClerkProvider
  // chunk, the catch around getClerkJsEntryChunk + clerk.load), so `clerk.loaded` stays false,
  // useUser() keeps returning isLoaded:false (@clerk/shared react useUser: `user === undefined`
  // ⇒ isLoaded:false), and `loading` above is true FOREVER. The render gate downstream paints a
  // boot skeleton for as long as that holds: no error, no recovery, no way out but force-stopping
  // the app. Dave gardens in rural dead zones on Chrome Android, so it is a routine condition.
  //
  // `unknown` is deliberately a SUBSET of `loading`, never a replacement for it. Two consequences,
  // both load-bearing:
  //   • every consumer that only knows the boolean keeps withholding exactly as it does today, so
  //     this cannot leak by omission — the only surface that changes is the one explicitly taught
  //     about `identity` (App.jsx's AppShell).
  //   • an unresolved identity can never take the signed-OUT branch. Collapsing them would redirect
  //     to /login, which is useless offline and reads as "you got signed out" — which is false.
  //
  // It is also NOT sticky: `identity` is recomputed from isLoaded on every render, so a Clerk that
  // finally resolves at t=12s takes the normal path and the notice disappears on its own. That is
  // why a timeout here cannot truncate a working sign-in — there is no expired flag to clear.
  const [waitExpired, setWaitExpired] = useState(false)
  useEffect(() => {
    if (isLoaded) return undefined
    const timer = setTimeout(() => setWaitExpired(true), CLERK_LOAD_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [isLoaded])

  // `clerk.status` is reactive despite `useClerk()` returning a stable instance: ClerkContextProvider
  // re-memoises the context value on clerkStatus (@clerk/shared react, `useMemo(..., [props.clerkStatus])`),
  // so a status change re-renders consumers. Compared against 'error' specifically — 'loading' is the
  // healthy boot state and treating anything-not-'ready' as unknown would fire on every cold start.
  const clerkFailed = clerk?.status === 'error'
  const identity = !loading
    ? (user ? 'signed-in' : 'signed-out')
    : (waitExpired || clerkFailed) ? 'unknown' : 'pending'

  const profile = clerkUser ? {
    id: clerkUser.id,
    display_name: clerkUser.fullName || clerkUser.firstName || clerkUser.emailAddresses?.[0]?.emailAddress || '',
    avatar_url: clerkUser.imageUrl || null,
  } : null

  // V4-IMGCACHE-001 D-1: on any identity change, evict the whole in-heap data cache so a soft
  // sign-out (no page reload) or an in-place sub switch can never leave one identity's cached lists
  // resident for the next. The identity-scoped key already prevents cross-read; this is the eviction
  // half (memory + retention hygiene). A boot transition (null → sub) is a no-op on an empty cache.
  const userId = user?.id ?? null
  useEffect(() => { invalidateDataCache() }, [userId])

  // V4-IMGCACHE-002 D-2: boot-warm + foreground revalidate. Called AFTER the eviction effect above so
  // the hook ordering guarantees eviction runs first on an identity change — a warm that ran before it
  // would have its freshly-written entry immediately cleared.
  useCacheLifecycle(userId)

  async function signInWithGoogle() {
    try {
      await clerk.client.signIn.authenticateWithRedirect({
        strategy: 'oauth_google',
        redirectUrl: `${window.location.origin}/auth/callback`,
        redirectUrlComplete: `${window.location.origin}${POST_LOGIN_ROUTE}`,
      })
      return { error: null }
    } catch (err) {
      return { error: err }
    }
  }

  // V4-RANKCLEAR-001 — the ONE sign-out funnel in the app (BottomNav's confirm row is its only
  // caller), so the client-preference clear belongs here rather than at the call site.
  //
  // BEFORE the await, deliberately. Clerk's signOut may navigate, and anything after the await is
  // therefore not guaranteed to run — which would leave the leak in place on exactly the paths that
  // matter. The cost of the other ordering is that a FAILED sign-out also resets these prefs; they
  // are presentation-only and rebuild from normal use within days, so that is the cheaper failure.
  async function signOut() {
    clearClientPrefs()
    await clerkSignOut()
  }


  return (
    <AuthContext.Provider value={{ user, profile, loading, identity, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

// Non-throwing selector for optional consumers (e.g. page-level lenses) so a component that only
// wants the current-user profile does not hard-require an <AuthProvider> in unit tests. In the real
// app the provider is always mounted; without it this returns a null profile (feature no-ops).
export function useAuthOptional() {
  return useContext(AuthContext) ?? { user: null, profile: null, loading: false, identity: 'signed-out' }
}
