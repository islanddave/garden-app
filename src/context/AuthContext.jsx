import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setLoading(false)
      if (session?.user) fetchProfile(session.user.id)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        setUser(session?.user ?? null)
        if (!session?.user) { setProfile(null); setLoading(false); return }
        if (event === 'SIGNED_IN') {
          checkAllowlist(session.user.id)
        } else {
          fetchProfile(session.user.id)
        }
      }
    )
    return () => subscription.unsubscribe()
  }, [])

  async function checkAllowlist(userId) {
    try {
      const { data: prof, error } = await supabase
        .from('profiles').select('id, display_name, avatar_url').eq('id', userId).single()
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
    }
  }

  async function fetchProfile(userId) {
    try {
      const { data } = await supabase
        .from('profiles').select('id, display_name, avatar_url').eq('id', userId).single()
      setProfile(data)
    } catch (e) {
      console.warn('fetchProfile error:', e)
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
