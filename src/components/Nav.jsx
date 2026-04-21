import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useZone } from '../context/ZoneContext.jsx'
import { P } from '../lib/constants.js'

export default function Nav() {
  const { user, profile, signOut } = useAuth()
  const { activeZone } = useZone()
  const navigate   = useNavigate()
  const location   = useLocation()

  async function handleSignOut() {
    await signOut()
    navigate('/')
  }

  return (
    <nav style={{
      backgroundColor: P.green,
      padding: '0 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: '52px',
      position: 'sticky',
      top: 0,
      zIndex: 100,
    }}>
      {/* Logo / Home */}
      <Link to="/" style={{ color: P.cream, textDecoration: 'none', fontWeight: 700, fontSize: '1.05rem', letterSpacing: '0.3px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        🌿 Garden
      </Link>

      {/* Right side */}
      <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
        {user ? (
          <>
            <Link to="/dashboard"  style={navLinkStyle}>Dashboard</Link>
            <Link to="/log" style={{
              ...navLinkStyle,
              backgroundColor: 'rgba(248,245,240,0.15)',
              border: '1px solid rgba(248,245,240,0.35)',
              padding: '4px 12px',
              borderRadius: 6,
              fontWeight: 600,
            }}>+ Log</Link>
            <Link to="/locations"  style={navLinkStyle}>Locations</Link>
            <Link to="/tasks"      style={navLinkStyle}>Tasks</Link>
            <Link to="/inventory"  style={navLinkStyle}>Inventory</Link>
            <Link to="/projects"   style={navLinkStyle}>Projects</Link>
            {/* Zone indicator — tap to change zone */}
            <Link
              to={`/zone?from=${encodeURIComponent(location.pathname)}`}
              style={{
                ...navLinkStyle,
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                backgroundColor: activeZone ? 'rgba(248,245,240,0.15)' : 'transparent',
                border: `1px solid ${activeZone ? 'rgba(248,245,240,0.4)' : 'rgba(248,245,240,0.2)'}`,
                padding: '3px 10px',
                borderRadius: '12px',
                fontSize: '0.82rem',
                fontWeight: activeZone ? 600 : 400,
              }}
            >
              📍 {activeZone ? activeZone.name : 'Everywhere'}
            </Link>
            <span style={{ color: P.cream, opacity: 0.65, fontSize: '0.85rem' }}>
              {profile?.display_name ?? ''}
            </span>
            <button onClick={handleSignOut} style={navBtnStyle}>
              Sign out
            </button>
          </>
        ) : (
          <Link to="/login" style={navLinkStyle}>Sign in</Link>
        )}
      </div>
    </nav>
  )
}

const navLinkStyle = {
  color: P.cream,
  textDecoration: 'none',
  fontSize: '0.9rem',
  opacity: 0.9,
}

const navBtnStyle = {
  background: 'none',
  border: `1px solid rgba(248,245,240,0.4)`,
  color: P.cream,
  padding: '4px 12px',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '0.85rem',
}
