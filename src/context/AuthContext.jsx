import { createContext, useContext, useEffect } from 'react'
import { useUser, useClerk } from '@clerk/react'
import { invalidateAll as invalidateDataCache } from '../lib/dataCache.js'
import { useCacheLifecycle } from '../hooks/useCacheLifecycle.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const { user: clerkUser, isSignedIn, isLoaded } = useUser()
  const clerk = useClerk()
  const { signOut: clerkSignOut } = clerk

  const user = isSignedIn ? clerkUser : null
  const loading = !isLoaded
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
        redirectUrlComplete: `${window.location.origin}/dashboard`,
      })
      return { error: null }
    } catch (err) {
      return { error: err }
    }
  }

  async function signOut() {
    await clerkSignOut()
  }


  return (
    <AuthContext.Provider value={{ user, profile, loading, signInWithGoogle, signOut }}>
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
  return useContext(AuthContext) ?? { user: null, profile: null, loading: false }
}
