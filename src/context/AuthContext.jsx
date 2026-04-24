import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const AuthContext = createContext(null)

// Access control: a user must have a row in public.profiles to enter the app.
// Add/remove rows in profiles to grant/revoke access. No trigger auto-creates rows.

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!session?.user) { setUser(null); setProfile(null); setLoading(false); return }
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
          checkAllowlist(session.user)
        }
      }
    )
    return () => subscription.unsubscribe()
  }, [])

  async function checkAllowlist(authUser) {
    setUser(authUser)  // optimistic — nav appears immediately
    try {
      const { data: prof, error } = await supabase
        .from('profiles').select('id, display_name, avatar_url').eq('id', authUser.id).single()
      if (error || !prof) {
        setUser(null); setProfile(null)
        await supabase.auth.signOut()
        window.location.replace('/login?error=not_authorized')
        return
      }
      setProfile(prof)
    } catch (e) {
      setUser(null); setProfile(null)
      await supabase.auth.signOut()
      window.location.replace('/login?error=not_authorized')
    } finally {
      setLoading(false)
    }
  }

  async function signInWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    return { error }
  }

  async function signOut() {
    setUser(null); setProfile(null)
    await supabase.auth.signOut()
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

