import { createContext, useContext } from 'react'
import { useUser, useClerk } from '@clerk/react'

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
