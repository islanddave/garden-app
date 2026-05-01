import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P, PROJECT_STATUS_MAP } from '../lib/constants.js'
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

function StatusBadge({ status }) {
  const map = PROJECT_STATUS_MAP[status] ?? { label: status, emoji: '' }
  return (
    <span style={{
      fontSize: '0.72rem',
      background: P.greenPale,
      color: P.green,
      borderRadius: 10,
      padding: '2px 8px',
      fontWeight: 600,
      flexShrink: 0,
    }}>
      {map.emoji ? `${map.emoji} ${map.label}` : map.label}
    </span>
  )
}

function ContentsSection({ locationId, fetch }) {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    fetch('/api/projects?location_id=' + locationId)
      .then(data => {
        if (!mounted) return
        setProjects(Array.isArray(data) ? data : [])
        setLoading(false)
      })
      .catch(() => {
        if (!mounted) return
        setLoading(false)
      })
    return () => { mounted = false }
  }, [locationId, fetch])

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ margin: '0 0 12px', fontSize: '1rem', fontWeight: 700, color: P.dark }}>
        At this location
      </h2>

      {loading ? (
        <div style={{
          background: '#fff', border: `1px solid ${P.sage ?? P.border}`,
          borderRadius: 10, padding: '14px 18px',
          fontSize: '0.87rem', color: P.light,
        }}>
          Loading contents…
        </div>
      ) : projects.length === 0 ? (
        <div style={{
          background: '#fff', border: `1px solid ${P.border}`,
          borderRadius: 10, padding: '32px 20px',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '1.5rem', marginBottom: 10 }}>🌿</div>
          <div style={{ fontSize: '0.93rem', fontWeight: 600, color: P.dark, marginBottom: 6 }}>
            Nothing here yet
          </div>
          <div style={{ fontSize: '0.84rem', color: P.light, marginBottom: 16, maxWidth: 320, margin: '0 auto 16px' }}>
            When you assign a project to this location, it will appear here.
          </div>
          <Link
            to="/projects/new"
            style={{
              display: 'inline-block',
              background: P.green, color: '#fff',
              borderRadius: 6, padding: '9px 18px',
              fontSize: '0.875rem', fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Create a project
          </Link>
        </div>
      ) : (
        <div style={{
          background: '#fff', border: `1px solid ${P.border}`,
          borderRadius: 10, overflow: 'hidden',
        }}>
          {projects.map((proj, i) => (
            <Link
              key={proj.id}
              to={`/projects/${proj.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '12px 16px',
                borderTop: i > 0 ? `1px solid ${P.border}` : 'none',
                textDecoration: 'none',
                color: P.dark,
              }}
            >
              <span style={{ flex: 1, fontWeight: 500, fontSize: '0.9rem', minWidth: 0 }}>
                {proj.name}
              </span>
              {proj.status && <StatusBadge status={proj.status} />}
              {proj.plant_count > 0 && (
                <span style={{ fontSize: '0.78rem', color: P.light, flexShrink: 0 }}>
                  {proj.plant_count} {proj.plant_count === 1 ? 'plant' : 'plants'}
                </span>
              )}
              <span style={{ fontSize: '0.8rem', color: P.border, flexShrink: 0 }}>›</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
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
          background: '#fff', border: `1px solid ${P.sage ?? P.border}`,
          borderRadius: 10, padding: '14px 18px', marginBottom: 20,
          fontSize: '0.9rem', color: P.dark, lineHeight: 1.6,
        }}>
          {location.notes}
        </div>
      )}

      <div style={{
        background: '#fff', border: `1px solid ${P.sage ?? P.border}`,
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

      <ContentsSection locationId={id} fetch={fetch} />
    </Shell>
  )
}
