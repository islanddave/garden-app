import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useZone } from '../context/ZoneContext.jsx'
import { P } from '../lib/constants.js'

// TopBar — sticky top bar replacing Nav.jsx
// Displays: app name ("Gardens at Mathews Ridge"), zone pill, More menu (username + sign out).
// Page title is provisionally the app name; route-level metadata planned for APP-a.
// Tasks are hidden from all nav in V1.

export default function TopBar() {
  const { user, profile, signOut } = useAuth()
  const { activeZone }             = useZone()
  const location                   = useLocation()
  const navigate                   = useNavigate()
  const [menuOpen, setMenuOpen]    = useState(false)

  async function handleSignOut() {
    setMenuOpen(false)
    await signOut()
    navigate('/', { replace: true })
  }

  return (
    <header style={{
      backgroundColor: P.green,
      paddingLeft: 16,
      paddingRight: 16,
      paddingTop: 'env(safe-area-inset-top)',
      height: '52px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      position: 'sticky',
      top: 0,
      zIndex: 80,
      boxSizing: 'border-box',
    }}>

      {/* App name / home link */}
      <Link
        to={user ? '/dashboard' : '/'}
        style={{
          color: P.cream,
          textDecoration: 'none',
          fontWeight: 700,
          fontSize: '0.95rem',
          letterSpacing: '0.2px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '55%',
          flexShrink: 1,
        }}
      >
        Gardens at Mathews Ridge
      </Link>

      {/* Right side controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>

        {/* Zone pill — authenticated only */}
        {user && (
          <Link
            to={`/zone?from=${encodeURIComponent(location.pathname)}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              color: P.cream,
              textDecoration: 'none',
              backgroundColor: 'rgba(248,245,240,0.15)',
              border: '1px solid rgba(248,245,240,0.3)',
              borderRadius: 20,
              padding: '4px 10px',
              fontSize: '0.78rem',
              fontWeight: activeZone ? 600 : 400,
              whiteSpace: 'nowrap',
            }}
          >
            📍 {activeZone ? activeZone.name : 'Everywhere'}
          </Link>
        )}

        {/* More dropdown — authenticated only */}
        {user && (
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setMenuOpen(s => !s)}
              aria-expanded={menuOpen}
              aria-label="More options"
              style={{
                backgroundColor: 'rgba(248,245,240,0.15)',
                border: '1px solid rgba(248,245,240,0.3)',
                color: P.cream,
                borderRadius: 6,
                padding: '5px 12px',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: 600,
              }}
            >
              More
            </button>

            {menuOpen && (
              <>
                {/* Click-away backdrop */}
                <div
                  onClick={() => setMenuOpen(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 79 }}
                />
                {/* Dropdown card */}
                <div style={{
                  position: 'absolute',
                  top: 'calc(100% + 8px)',
                  right: 0,
                  backgroundColor: P.white,
                  borderRadius: 10,
                  boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                  minWidth: 190,
                  zIndex: 80,
                  overflow: 'hidden',
                }}>
                  {/* Username row */}
                  <div style={{
                    padding: '12px 16px',
                    borderBottom: `1px solid ${P.border}`,
                    fontSize: '0.82rem',
                    color: P.light,
                  }}>
                    {profile?.display_name || profile?.email || 'Signed in'}
                  </div>

                  {/* Sign out */}
                  <button
                    onClick={handleSignOut}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '12px 16px',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      color: P.dark,
                      fontFamily: 'inherit',
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Sign in — unauthenticated only */}
        {!user && (
          <Link
            to="/login"
            style={{
              color: P.cream,
              textDecoration: 'none',
              fontSize: '0.9rem',
              opacity: 0.9,
            }}
          >
            Sign in
          </Link>
        )}
      </div>
    </header>
  )
}
