import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { P } from '../lib/constants.js'

// BottomNav — 5-tab mobile navigation
// More sheet: Photos, Inventory, Favorites. Plants added in P-session when route exists.

const TABS = [
  { to: '/dashboard', label: 'Dashboard', icon: '🏠' },
  { to: '/projects',  label: 'Projects',  icon: '🌱' },
  { to: '/log',       label: '+Log',      icon: '+',  highlight: true },
  { to: '/locations', label: 'Locations', icon: '📍' },
]

const MORE_ITEMS = [
  { to: '/photos',    label: 'Photos',    icon: '📷' },
  { to: '/inventory', label: 'Inventory', icon: '📦' },
  { to: '/favorites', label: 'Favorites', icon: '★'  },
]

export default function BottomNav() {
  const location  = useLocation()
  const [showMore, setShowMore] = useState(false)

  function isActive(path) {
    return location.pathname === path || location.pathname.startsWith(path + '/')
  }

  const moreActive = MORE_ITEMS.some(i => isActive(i.to))

  return (
    <>
      {showMore && (
        <div onClick={() => setShowMore(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 90, backgroundColor: 'rgba(0,0,0,0.3)' }}
        />
      )}

      {showMore && (
        <div style={{
          position: 'fixed',
          bottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom))',
          left: 0, right: 0,
          backgroundColor: P.white,
          borderRadius: '16px 16px 0 0',
          boxShadow: '0 -4px 20px rgba(0,0,0,0.14)',
          zIndex: 100,
          paddingTop: 8, paddingBottom: 4,
        }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: P.border, margin: '0 auto 12px' }} />
          {MORE_ITEMS.map(item => (
            <Link key={item.to} to={item.to} onClick={() => setShowMore(false)}
              style={{
                display: 'flex', alignItems: 'center', gap: 16,
                padding: '14px 24px',
                textDecoration: 'none',
                color: isActive(item.to) ? P.green : P.dark,
                fontSize: '1rem', fontWeight: isActive(item.to) ? 700 : 500,
                backgroundColor: isActive(item.to) ? P.greenPale : 'transparent',
              }}
            >
              <span style={{ fontSize: '1.4rem' }}>{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </div>
      )}

      <nav aria-label="Main navigation" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        height: 'var(--bottom-nav-height)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        backgroundColor: P.white,
        borderTop: `1px solid ${P.border}`,
        display: 'flex', alignItems: 'stretch',
        zIndex: 100,
      }}>
        {TABS.map(tab => {
          const active = isActive(tab.to)
          if (tab.highlight) return (
            <Link key={tab.to} to={tab.to} aria-label="Log an event"
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', gap: 2 }}>
              <span style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 44, height: 44, backgroundColor: P.green, borderRadius: '50%',
                color: '#fff', fontSize: '1.5rem', fontWeight: 700,
                boxShadow: '0 2px 8px rgba(45,106,79,0.35)', marginTop: -10,
              }}>+</span>
              <span style={{ fontSize: '0.62rem', color: active ? P.green : P.light, fontWeight: active ? 700 : 400, marginTop: 1 }}>{tab.label}</span>
            </Link>
          )
          return (
            <Link key={tab.to} to={tab.to}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', gap: 2, color: active ? P.green : P.light }}>
              <span style={{ fontSize: '1.25rem', lineHeight: 1 }}>{tab.icon}</span>
              <span style={{ fontSize: '0.62rem', fontWeight: active ? 700 : 400 }}>{tab.label}</span>
            </Link>
          )
        })}

        <button onClick={() => setShowMore(s => !s)}
          aria-expanded={showMore} aria-label="More navigation options"
          style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 2, background: 'none', border: 'none', cursor: 'pointer',
            color: (showMore || moreActive) ? P.green : P.light, padding: 0,
          }}>
          <span style={{ fontSize: '1.25rem', lineHeight: 1, letterSpacing: '-1px' }}>•••</span>
          <span style={{ fontSize: '0.62rem', fontWeight: (showMore || moreActive) ? 700 : 400 }}>More</span>
        </button>
      </nav>
    </>
  )
}
