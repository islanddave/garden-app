import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import Breadcrumb from '../components/Breadcrumb.jsx'

// DEFERRED:
//   - Sub-location list (children of this location) → V2
//   - Edit/delete actions → V2 (currently managed from Locations list page)
//   - Full hierarchy breadcrumb (Space → Zone → Area → ...) → V2

function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>{children}</div>
    </div>
  )
}

function Spinner() {
  return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div>
}

export default function LocationDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { fetch } = useApiFetch()
  const [location, setLocation] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let mounted = true
    fetch('/api/locations/' + id)
      .then(data => {
        if (!mounted) return
        setLocation(data)
        setLoading(false)
      })
      .catch(e => {
        if (!mounted) return
        setError(e.message ?? 'Location not found')
        setLoading(false)
      })
    return () => { mounted = false }
  }, [id, fetch])

  if (loading) return <Shell><Spinner /></Shell>
  if (error) return (
    <Shell>
      <p style={{ color: 'crimson', marginBottom: 12 }}>{error}</p>
      <button onClick={() => navigate('/locations')} style={{ cursor: 'pointer' }}>← Locations</button>
    </Shell>
  )

  return (
    <Shell>
      <Breadcrumb path={[{ label: 'Home', href: '/dashboard' }, { label: location.name, href: null }]} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, gap: 16 }}>
        <div>
          <h1 style={{ margin: '0 0 6px', color: P.green, fontSize: '1.4rem', fontWeight: 700 }}>
            {location.name}
          </h1>
          {location.level != null && (
            <span style={{
              fontSize: '0.75rem', color: P.light,
              backgroundColor: '#eee', borderRadius: 12,
              padding: '3px 10px', display: 'inline-block',
            }}>
              Level {location.level}
            </span>
          )}
        </div>
        <button
          onClick={() => navigate('/locations')}
          style={{ background: 'none', border: 'none', color: P.green, cursor: 'pointer', fontSize: '0.9rem', padding: 0 }}
        >
          ← All locations
        </button>
      </div>

      {location.notes && (
        <div style={{
          background: '#fff', border: `1px solid ${P.sage}`,
          borderRadius: 10, padding: '14px 18px', marginBottom: 20,
          fontSize: '0.9rem', color: P.dark, lineHeight: 1.6,
        }}>
          {location.notes}
        </div>
      )}

      <div style={{
        background: '#fff', border: `1px solid ${P.sage}`,
        borderRadius: 10, padding: '14px 18px',
        fontSize: '0.87rem', color: P.dark,
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px' }}>
          {location.slug && (
            <>
              <span style={{ color: P.light }}>Slug</span>
              <span>{location.slug}</span>
            </>
          )}
          {location.is_active != null && (
            <>
              <span style={{ color: P.light }}>Status</span>
              <span>{location.is_active ? 'Active' : 'Inactive'}</span>
            </>
          )}
          {location.sort_order != null && (
            <>
              <span style={{ color: P.light }}>Sort order</span>
              <span>{location.sort_order}</span>
            </>
          )}
        </div>
      </div>
    </Shell>
  )
}
