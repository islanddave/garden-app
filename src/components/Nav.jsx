import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { P } from '../lib/constants.js'

export default function Nav() {
  const { user, profile, signOut } = useAuth()
  const navigate = useNavigate()

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
      <Link to="/" style={{ color: P.cream, textDecoration: 'none', fontWeight: 700, fontSize: '1.05rem', letterSpacing: '0.3px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        🌿 Garden
      </Link>
      <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
        {user ? (
          <>
            <Link to="/dashboard"  style={navLinkStyle}>Dashboard</Link>
            <Link to="/locations"  style={navLinkStyle}>Locations</Link>
            <Link to="/tasks"      style={navLinkStyle}>Tasks</Link>
            <Link to="/projects"   style={navLinkStyle}>Projects</Link>
            <span style={{ color: P.cream, opacity: 0.65, fontSize: '0.85rem' }}>
              {profile?.display_name ?? ''}
            </span>
            <button onClick={handleSignOut} style={navBtnStyle}>Sign out</button>
          </>
        ) : (
          <Link to="/login" style={navLinkStyle}>Sign in</Link>
        )}
      </div>
    </nav>
  )
}

const navLinkStyle = { color: P.cream, textDecoration: 'none', fontSize: '0.9rem', opacity: 0.9 }
const navBtnStyle = { background: 'none', border: `1px solid rgba(248,245,240,0.4)`, color: P.cream, padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85rem' }
