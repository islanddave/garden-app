import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'

const TYPE_META = {
  project:        { label: 'Projects',  icon: '🌱', link: i => `/projects/${i.id}` },
  location:       { label: 'Locations', icon: '📍', link: () => `/locations` },
  inventory_item: { label: 'Inventory', icon: '📦', link: i => `/inventory/${i.id}` },
  plant:          { label: 'Plants',    icon: '🌿', link: () => `/plants` },
}

export default function Favorites() {
  const { fetch } = useApiFetch()
  const [sections, setSections] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  const load = useCallback(async () => {
    try {
      // Parallel: favorites list + entity data for Lambda-backed types
      const [favs, allProjects, allLocations] = await Promise.all([
        fetch('/api/favorites'),
        fetch('/api/projects'),
        fetch('/api/locations'),
      ])

      if (!favs?.length) { setSections([]); setLoading(false); return }

      // Group favorites by entity_type
      const byType = {}
      ;(favs ?? []).forEach(f => {
        if (!byType[f.entity_type]) byType[f.entity_type] = []
        byType[f.entity_type].push(f.entity_id)
      })

      const resolvedSections = []

      // Projects — cross-reference with Lambda result
      if (byType.project) {
        const items = (allProjects ?? []).filter(p => byType.project.includes(p.id))
        if (items.length) resolvedSections.push({ type: 'project', items })
      }

      // Locations — cross-reference with Lambda result
      if (byType.location) {
        const items = (allLocations ?? []).filter(l => byType.location.includes(l.id))
        if (items.length) resolvedSections.push({ type: 'location', items })
      }

      // TODO DB-MIGRATE-INVENTORY: wire when /api/inventory Lambda deployed
      // TODO DB-MIGRATE-PLANTS: wire when /api/plants supports batch-by-ids

      setSections(resolvedSections)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [fetch])

  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ padding: '48px 20px', textAlign: 'center', color: P.mid }}>Loading…</div>
  if (error)   return <div style={{ padding: '48px 20px', textAlign: 'center', color: P.terra }}>Error: {error}</div>

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '32px 20px' }}>
        <h1 style={{ color: P.green, fontSize: '1.4rem', fontWeight: 700, margin: '0 0 24px' }}>
          ★ Favorites
        </h1>
        {sections.length === 0 ? (
          <div style={{
            backgroundColor: P.white, border: `1px solid ${P.border}`,
            borderRadius: '10px', padding: '40px 20px',
            textAlign: 'center', color: P.light, fontSize: '0.95rem',
          }}>
            No favorites yet. Tap ☆ on any project, location, plant, or inventory item to save it here.
          </div>
        ) : sections.map(({ type, items }) => {
          const meta = TYPE_META[type]
          return (
            <section key={type} style={{ marginBottom: '28px' }}>
              <h2 style={{ fontSize: '0.8rem', fontWeight: 700, color: P.mid, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>
                {meta.icon} {meta.label}
              </h2>
              {items.map(item => (
                <Link key={item.id} to={meta.link(item)} style={{ textDecoration: 'none' }}>
                  <div style={{
                    backgroundColor: P.white, border: `1px solid ${P.border}`,
                    borderRadius: '8px', padding: '14px 16px', marginBottom: '8px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer',
                  }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = P.greenLight}
                    onMouseLeave={e => e.currentTarget.style.borderColor = P.border}
                  >
                    <div>
                      <span style={{ fontWeight: 600, color: P.green }}>{item.name}</span>
                      {item.variety && <span style={{ fontSize: '0.8rem', color: P.light, marginLeft: 6 }}>{item.variety}</span>}
                    </div>
                    {item.status && <span style={{ fontSize: '0.75rem', color: P.light }}>{item.status}</span>}
                  </div>
                </Link>
              ))}
            </section>
          )
        })}
      </div>
    </div>
  )
}
