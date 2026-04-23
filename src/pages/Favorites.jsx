import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { supabase } from '../lib/supabase.js'
import { P } from '../lib/constants.js'

const TYPE_META = {
  project:        { label: 'Projects',  icon: '🌱', link: i => `/projects/${i.id}` },
  location:       { label: 'Locations', icon: '📍', link: () => `/locations` },
  inventory_item: { label: 'Inventory', icon: '📦', link: i => `/inventory/${i.id}` },
}

export default function Favorites() {
  const { user } = useAuth()
  const [sections, setSections] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  useEffect(() => { if (user) load() }, [user])

  async function load() {
    try {
      const { data: favs, error: fErr } = await supabase
        .from('favorites')
        .select('entity_type, entity_id')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
      if (fErr) throw fErr
      if (!favs?.length) { setSections([]); return }

      const byType = {}
      favs.forEach(f => {
        if (!byType[f.entity_type]) byType[f.entity_type] = []
        byType[f.entity_type].push(f.entity_id)
      })

      const results = await Promise.all([
        byType.project && supabase
          .from('plant_projects').select('id, name, status')
          .in('id', byType.project).is('deleted_at', null)
          .then(({ data }) => ({ type: 'project', items: data ?? [] })),
        byType.location && supabase
          .from('locations').select('id, name, type_label')
          .in('id', byType.location)
          .then(({ data }) => ({ type: 'location', items: data ?? [] })),
        byType.inventory_item && supabase
          .from('inventory_items').select('id, name, type, status')
          .in('id', byType.inventory_item).is('deleted_at', null)
          .then(({ data }) => ({ type: 'inventory_item', items: data ?? [] })),
      ].filter(Boolean))

      setSections(results.filter(r => r.items.length > 0))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

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
            No favorites yet. Tap ☆ on any project, location, or inventory item to save it here.
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
                    <span style={{ fontWeight: 600, color: P.green }}>{item.name}</span>
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
