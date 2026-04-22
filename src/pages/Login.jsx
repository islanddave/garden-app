import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { P } from '../lib/constants.js'

export default function Login() {
  const { signInWithGoogle } = useAuth()
  const [searchParams]       = useSearchParams()

  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  // Set by AuthContext when a valid Google account isn't in our allowlist
  const notAuthorized = searchParams.get('error') === 'not_authorized'

  async function handleGoogleSignIn() {
    setError(null)
    setLoading(true)
    const { error } = await signInWithGoogle()
    if (error) {
      setError('Sign-in failed. Please try again.')
      setLoading(false)
    }
    // On success, browser is redirected to Google — no further action here.
    // After Google auth, the callback hits /auth/callback where AuthContext
    // handles session setup and allowlist enforcement.
  }

  return (
    <div style={{
      minHeight: '100dvh',
      backgroundColor: P.cream,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
    }}>
      <div style={{ width: '100%', maxWidth: '380px' }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>🌿</div>
          <h1 style={{ color: P.green, fontSize: '1.4rem', fontWeight: 700, margin: 0 }}>
            Garden Tracker
          </h1>
          <p style={{ color: P.light, marginTop: '6px', fontSize: '0.875rem', margin: '6px 0 0' }}>
            Dave &amp; Jen · Conway, MA
          </p>
        </div>

        {/* Card */}
        <div style={{
          backgroundColor: P.white,
          border: `1px solid ${P.border}`,
          borderRadius: '10px',
          padding: '28px',
        }}>

          {/* Not-authorized message (set by AuthContext after allowlist rejection) */}
          {notAuthorized && (
            <div style={errorBannerStyle}>
              Access not granted. This is a private garden app.
            </div>
          )}

          {/* Runtime error (e.g. OAuth initiation failure) */}
          {error && (
            <div style={errorBannerStyle}>
              {error}
            </div>
          )}

          <p style={{
            color: P.mid,
            fontSize: '0.9rem',
            textAlign: 'center',
            marginTop: 0,
            marginBottom: '20px',
          }}>
            Sign in to manage your garden.
          </p>

          <button
            onClick={handleGoogleSignIn}
            disabled={loading}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              backgroundColor: loading ? '#f5f5f5' : P.white,
              color: '#3c4043',
              border: `1px solid ${P.border}`,
              borderRadius: '6px',
              padding: '11px',
              fontSize: '1rem',
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'background-color 0.15s',
              boxShadow: loading ? 'none' : '0 1px 3px rgba(0,0,0,0.08)',
            }}
          >
            {!loading && <GoogleLogo />}
            {loading ? 'Redirecting to Google…' : 'Sign in with Google'}
          </button>

        </div>
      </div>
    </div>
  )
}

// ---- Google "G" logo SVG ----
function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0
        14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94
        c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59
        l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6
        c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-3.59-13.46-8.91l-7.98 6.19
        C6.51 42.62 14.62 48 24 48z"/>
      <path fill="none" d="M0 0h48v48H0z"/>
    </svg>
  )
}

// ---- Styles ----
const errorBannerStyle = {
  backgroundColor: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '6px',
  padding: '10px 14px',
  marginBottom: '18px',
  fontSize: '0.875rem',
  color: '#7a2a10',
}
